// Adaptador de mutaciones de QvaPay deliberadamente deshabilitado por defecto.
//
// Su única finalidad es preparar el corte sin riesgo: expone Apply y Cancel,
// pero no ejecuta ninguna petición hasta que un operador llame a Enable durante
// un cutover explícito. No implementa paid, received, chat ni getUpdates.
package qvapay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

const (
	// MutationTimeout limita cada mutación completa: conexión, cabeceras y
	// cuerpo. Es mayor que DefaultTimeout porque una mutación no es idempotente
	// y no conviene reintentarla automáticamente.
	MutationTimeout = 25 * time.Second
	// MaxMutationResponseBytes es el tamaño máximo aceptado para una respuesta
	// correcta de mutación.
	MaxMutationResponseBytes int64 = 8 << 10
	// maxMutationErrorBytes acota el cuerpo conservado en MutationError.
	maxMutationErrorBytes int64 = 512
	// maxMutationAmountScale acota la búsqueda de la representación decimal
	// exacta de un importe. Los importes de QvaPay están muy por debajo.
	maxMutationAmountScale = 128
)

var (
	// ErrMutationsDisabled es el error devuelto mientras el adaptador no haya
	// sido habilitado explícitamente. No se realiza ninguna petición de red.
	ErrMutationsDisabled = errors.New("mutaciones QvaPay deshabilitadas")
	// ErrMissingToken impide enviar una mutación sin credenciales.
	ErrMissingToken = errors.New("token de QvaPay ausente")
	// ErrInvalidUUID rechaza identificadores que no tengan forma canónica de
	// UUID antes de construir cualquier ruta.
	ErrInvalidUUID = errors.New("UUID inválido")
)

// MutationResult es la respuesta aceptada de una mutación. El adaptador no
// interpreta el cuerpo: el llamador debe conciliar el estado remoto antes de
// confirmar el resultado.
type MutationResult struct {
	// StatusCode es el código HTTP 2xx de la respuesta.
	StatusCode int
	// Body es el cuerpo JSON crudo, vacío cuando QvaPay no devuelve cuerpo.
	Body json.RawMessage
}

// MutationError representa un rechazo HTTP no 2xx de una mutación. El cuerpo
// está truncado y con el token redactado; nunca contiene credenciales.
type MutationError struct {
	Status     int
	RetryAfter time.Duration
	Body       string
}

// Error implementa error.
func (e *MutationError) Error() string {
	if strings.TrimSpace(e.Body) == "" {
		return fmt.Sprintf("QvaPay rechazó la mutación con %d", e.Status)
	}
	return fmt.Sprintf("QvaPay rechazó la mutación con %d: %s", e.Status, e.Body)
}

// MutationClient es el adaptador de mutaciones de QvaPay. Se puede usar
// concurrentemente siempre que Enabled se modifique solo con Enable/Disable.
//
// El valor por defecto es deshabilitado. Solo debe habilitarse durante un
// cutover explícito, después de completar la verificación operativa del
// transporte de lectura y de la conciliación.
type MutationClient struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
	Enabled bool

	mu sync.RWMutex
}

// NewMutationClient construye un adaptador deshabilitado. No valida la URL ni
// el token todavía: mientras esté deshabilitado no se usa ninguno de los dos.
func NewMutationClient(baseURL, token string) *MutationClient {
	return &MutationClient{
		BaseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		Token:   token,
		HTTP: &http.Client{
			Timeout:       MutationTimeout,
			CheckRedirect: checkNoMutationRedirect,
		},
		Enabled: false,
	}
}

// Enable habilita las mutaciones. Solo debe llamarse en un cutover explícito.
// Usa el mutex para que el cambio sea seguro entre goroutines; no se debe
// escribir Enabled directamente después de publicar el cliente.
func (c *MutationClient) Enable() {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.Enabled = true
	c.mu.Unlock()
}

// Disable vuelve a dejar el adaptador en su estado seguro por defecto.
func (c *MutationClient) Disable() {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.Enabled = false
	c.mu.Unlock()
}

// Apply solicita POST /p2p/{uuid}/apply. Si amount es nil no envía cuerpo; en
// caso contrario envía {"amount":"..."} como string decimal exacto.
func (c *MutationClient) Apply(ctx context.Context, offerUUID string, amount *decimal.Value) (MutationResult, error) {
	if !c.mutationsEnabled() {
		return MutationResult{}, ErrMutationsDisabled
	}
	if strings.TrimSpace(c.Token) == "" {
		return MutationResult{}, ErrMissingToken
	}

	endpoint, err := mutationEndpoint(c.BaseURL, offerUUID, "apply", "")
	if err != nil {
		return MutationResult{}, err
	}

	var body io.Reader
	hasBody := false
	if amount != nil {
		text, err := mutationAmountText(*amount)
		if err != nil {
			return MutationResult{}, err
		}
		payload, err := json.Marshal(struct {
			Amount string `json:"amount"`
		}{Amount: text})
		if err != nil {
			return MutationResult{}, fmt.Errorf("no se pudo codificar el importe de la mutación: %w", err)
		}
		body = bytes.NewReader(payload)
		hasBody = true
	}

	return c.doMutation(ctx, endpoint, body, hasBody)
}

// Cancel solicita POST /p2p/{uuid}/cancel. Si order no está vacío se valida
// como UUID y se añade como query `order`.
func (c *MutationClient) Cancel(ctx context.Context, offerUUID, order string) (MutationResult, error) {
	if !c.mutationsEnabled() {
		return MutationResult{}, ErrMutationsDisabled
	}
	if strings.TrimSpace(c.Token) == "" {
		return MutationResult{}, ErrMissingToken
	}
	if order != "" && !isMutationUUID(order) {
		return MutationResult{}, fmt.Errorf("UUID de orden inválido: %w", ErrInvalidUUID)
	}

	endpoint, err := mutationEndpoint(c.BaseURL, offerUUID, "cancel", order)
	if err != nil {
		return MutationResult{}, err
	}

	return c.doMutation(ctx, endpoint, nil, false)
}

func (c *MutationClient) mutationsEnabled() bool {
	if c == nil {
		return false
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.Enabled
}

func (c *MutationClient) doMutation(ctx context.Context, endpoint string, body io.Reader, hasBody bool) (MutationResult, error) {
	requestCtx, cancel := context.WithTimeout(ctx, MutationTimeout)
	defer cancel()

	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, endpoint, body)
	if err != nil {
		return MutationResult{}, fmt.Errorf("no se pudo construir la petición de mutación: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+c.Token)
	request.Header.Set("Accept", "application/json")
	if hasBody {
		request.Header.Set("Content-Type", "application/json")
	}

	response, err := c.mutationHTTPClient().Do(request)
	if err != nil {
		return MutationResult{}, newConnectionError(err)
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(response.Body, maxMutationErrorBytes+1))
		if int64(len(raw)) > maxMutationErrorBytes {
			raw = raw[:maxMutationErrorBytes]
		}
		return MutationResult{}, &MutationError{
			Status:     response.StatusCode,
			RetryAfter: parseRetryAfter(response.Header.Get("Retry-After")),
			Body:       redactToken(string(raw), c.Token),
		}
	}

	raw, err := io.ReadAll(io.LimitReader(response.Body, MaxMutationResponseBytes+1))
	if err != nil {
		return MutationResult{}, newConnectionError(err)
	}
	if int64(len(raw)) > MaxMutationResponseBytes {
		return MutationResult{}, fmt.Errorf(
			"respuesta de mutación de QvaPay demasiado grande (máximo %d bytes)",
			MaxMutationResponseBytes,
		)
	}

	raw = bytes.TrimSpace(raw)
	if len(raw) > 0 && !json.Valid(raw) {
		return MutationResult{}, fmt.Errorf("respuesta JSON inválida de QvaPay")
	}

	result := MutationResult{StatusCode: response.StatusCode}
	if len(raw) > 0 {
		result.Body = append(json.RawMessage(nil), raw...)
	}
	return result, nil
}

func (c *MutationClient) mutationHTTPClient() *http.Client {
	if c.HTTP == nil {
		return &http.Client{
			Timeout:       MutationTimeout,
			CheckRedirect: checkNoMutationRedirect,
		}
	}
	clone := *c.HTTP
	clone.CheckRedirect = checkNoMutationRedirect
	if clone.Timeout <= 0 {
		clone.Timeout = MutationTimeout
	}
	return &clone
}

func checkNoMutationRedirect(*http.Request, []*http.Request) error {
	// No se siguen redirecciones: un POST reenviado podría duplicar una
	// mutación. La respuesta 3xx se trata como rechazo HTTP.
	return http.ErrUseLastResponse
}

func mutationEndpoint(baseURL, offerUUID, action, order string) (string, error) {
	if !isMutationUUID(offerUUID) {
		return "", fmt.Errorf("UUID de oferta inválido: %w", ErrInvalidUUID)
	}
	switch action {
	case "apply", "cancel":
	default:
		return "", fmt.Errorf("acción de mutación no permitida: %q", action)
	}

	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return "", fmt.Errorf("BaseURL de QvaPay inválida: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("BaseURL de QvaPay debe usar http o https")
	}
	if parsed.Host == "" {
		return "", fmt.Errorf("BaseURL de QvaPay sin host")
	}
	if parsed.User != nil {
		return "", fmt.Errorf("BaseURL de QvaPay no debe incluir credenciales")
	}
	if parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		return "", fmt.Errorf("BaseURL de QvaPay no debe incluir query ni fragmento")
	}

	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/p2p/" + offerUUID + "/" + action
	parsed.RawPath = ""
	if order != "" {
		parsed.RawQuery = url.Values{"order": []string{order}}.Encode()
	}
	return parsed.String(), nil
}

// isMutationUUID exige la forma canónica 8-4-4-4-12 en hexadecimal. QvaPay
// usa UUID estándar y esta comprobación evita rutas ambiguas o escapadas.
func isMutationUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index, char := range value {
		switch index {
		case 8, 13, 18, 23:
			if char != '-' {
				return false
			}
		default:
			if !isHexDigit(char) {
				return false
			}
		}
	}
	return true
}

func isHexDigit(char rune) bool {
	return char >= '0' && char <= '9' ||
		char >= 'a' && char <= 'f' ||
		char >= 'A' && char <= 'F'
}

func mutationAmountText(value decimal.Value) (string, error) {
	for scale := 0; scale <= maxMutationAmountScale; scale++ {
		formatted := value.Format(scale)
		parsed, err := decimal.Parse(formatted)
		if err == nil && parsed.Cmp(value) == 0 {
			return formatted, nil
		}
	}
	return "", fmt.Errorf("importe de mutación no representable como decimal finito")
}

func redactToken(text, token string) string {
	token = strings.TrimSpace(token)
	if token == "" || !strings.Contains(text, token) {
		return text
	}
	return strings.ReplaceAll(text, token, "[redacted]")
}
