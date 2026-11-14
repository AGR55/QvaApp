// Package qvapay implementa un cliente HTTP estrictamente de lectura para los
// endpoints de QvaPay que consume `src/qvapay.ts`.
//
// El cliente no expone login ni ninguna mutación: solo existe un método HTTP
// interno que emite GET y una lista cerrada de rutas permitidas. El token se
// envía en la cabecera Authorization y nunca se registra.
//
// En producción BaseURL debe usar https. Se acepta http únicamente para
// pruebas o para un servidor local de desarrollo.
package qvapay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

const (
	// DefaultTimeout limita cada lectura completa: conexión, cabeceras y cuerpo.
	DefaultTimeout = 5 * time.Second
	// MaxResponseBytes es el tamaño máximo aceptado para una respuesta correcta.
	MaxResponseBytes int64 = 8 << 20
	// maxErrorBodyBytes acota el cuerpo conservado en APIError.
	maxErrorBodyBytes int64 = 512
	// maxRedirects es el número máximo de redirecciones que se siguen.
	maxRedirects = 10
)

// Client es un cliente de lectura de QvaPay. Se puede usar concurrentemente.
//
// HTTP es inyectable para pruebas. Si es nil se usa un cliente con
// DefaultTimeout. En cualquier caso se fuerza una política de redirecciones que
// solo admite el mismo host y esquema, y se aplica DefaultTimeout por petición.
type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

// APIError representa una respuesta HTTP no 2xx de QvaPay.
type APIError struct {
	Status     int
	RetryAfter time.Duration
	Body       string
}

// Error implementa error.
func (e *APIError) Error() string {
	if strings.TrimSpace(e.Body) == "" {
		return fmt.Sprintf("QvaPay respondió %d", e.Status)
	}
	return fmt.Sprintf("QvaPay respondió %d: %s", e.Status, e.Body)
}

// ConnectionError representa un fallo de red o de tiempo de espera.
type ConnectionError struct {
	// Reason es "timeout" o "network".
	Reason string
	Err    error
}

// Error implementa error.
func (e *ConnectionError) Error() string {
	if e.Reason == "timeout" {
		return "QvaPay no respondió dentro del tiempo esperado"
	}
	return "No se pudo conectar con QvaPay"
}

// Unwrap permite inspeccionar el error subyacente.
func (e *ConnectionError) Unwrap() error { return e.Err }

// User es el perfil autenticado. Balance siempre queda informado.
type User struct {
	UUID      string        `json:"uuid"`
	Username  string        `json:"username"`
	Name      string        `json:"name"`
	Email     string        `json:"email"`
	Balance   decimal.Value `json:"balance"`
	Available decimal.Value `json:"available"`
}

// UnmarshalJSON acepta balance como número JSON o string decimal y conserva el
// fallback de `src/qvapay.ts` (balance, data.balance, available,
// data.available). Un perfil sin ningún saldo válido se rechaza.
func (u *User) UnmarshalJSON(data []byte) error {
	var raw struct {
		UUID      string `json:"uuid"`
		Username  string `json:"username"`
		Name      string `json:"name"`
		Email     string `json:"email"`
		Balance   any    `json:"balance"`
		Available any    `json:"available"`
		Data      *struct {
			Balance   any `json:"balance"`
			Available any `json:"available"`
		} `json:"data"`
	}
	if err := decodeJSON(data, &raw); err != nil {
		return err
	}

	var dataBalance, dataAvailable any
	if raw.Data != nil {
		dataBalance = raw.Data.Balance
		dataAvailable = raw.Data.Available
	}

	balance, ok := firstNonNegativeDecimal(
		raw.Balance,
		dataBalance,
		raw.Available,
		dataAvailable,
	)
	if !ok {
		return fmt.Errorf("QvaPay no devolvió un saldo reconocible")
	}

	available, ok := firstNonNegativeDecimal(raw.Available, dataAvailable)
	if !ok {
		available = decimal.Zero()
	}

	*u = User{
		UUID:      raw.UUID,
		Username:  raw.Username,
		Name:      raw.Name,
		Email:     raw.Email,
		Balance:   balance,
		Available: available,
	}
	return nil
}

// Offer es una oferta P2P. User y Peer se conservan como JSON crudo para no
// imponer un esquema a datos que el cliente solo reenvía o inspecciona.
type Offer struct {
	UUID            string          `json:"uuid"`
	Type            string          `json:"type"`
	Coin            string          `json:"coin"`
	Amount          decimal.Value   `json:"amount"`
	Receive         decimal.Value   `json:"receive"`
	Rate            decimal.Value   `json:"rate"`
	Status          string          `json:"status"`
	AvailableAmount decimal.Value   `json:"available_amount"`
	ReservedAmount  decimal.Value   `json:"reserved_amount"`
	User            json.RawMessage `json:"User"`
	Peer            json.RawMessage `json:"Peer"`
}

// UnmarshalJSON decodifica los decimales sin pasar por float64. Los campos
// decimales ausentes quedan en cero; los presentes pero inválidos son error.
func (o *Offer) UnmarshalJSON(data []byte) error {
	var raw struct {
		UUID            any             `json:"uuid"`
		Type            any             `json:"type"`
		Coin            any             `json:"coin"`
		Amount          any             `json:"amount"`
		Receive         any             `json:"receive"`
		Rate            any             `json:"rate"`
		Status          any             `json:"status"`
		AvailableAmount any             `json:"available_amount"`
		ReservedAmount  any             `json:"reserved_amount"`
		User            json.RawMessage `json:"User"`
		Peer            json.RawMessage `json:"Peer"`
	}
	if err := decodeJSON(data, &raw); err != nil {
		return err
	}

	amount, err := optionalDecimal("amount", raw.Amount)
	if err != nil {
		return err
	}
	receive, err := optionalDecimal("receive", raw.Receive)
	if err != nil {
		return err
	}
	rate, err := optionalDecimal("rate", raw.Rate)
	if err != nil {
		return err
	}
	available, err := optionalDecimal("available_amount", raw.AvailableAmount)
	if err != nil {
		return err
	}
	reserved, err := optionalDecimal("reserved_amount", raw.ReservedAmount)
	if err != nil {
		return err
	}

	*o = Offer{
		UUID:            scalarString(raw.UUID),
		Type:            scalarString(raw.Type),
		Coin:            scalarString(raw.Coin),
		Amount:          amount,
		Receive:         receive,
		Rate:            rate,
		Status:          scalarString(raw.Status),
		AvailableAmount: available,
		ReservedAmount:  reserved,
		User:            raw.User,
		Peer:            raw.Peer,
	}
	return nil
}

// Average es el resumen de un mercado P2P. Tolera campos adicionales.
type Average struct {
	Average     decimal.Value `json:"average"`
	AverageBuy  decimal.Value `json:"average_buy"`
	AverageSell decimal.Value `json:"average_sell"`
	MedianBuy   decimal.Value `json:"median_buy"`
	MedianSell  decimal.Value `json:"median_sell"`
	Count       int64         `json:"count"`
	UpdatedAt   string        `json:"updated_at"`
}

// UnmarshalJSON decodifica los promedios como decimales exactos.
func (a *Average) UnmarshalJSON(data []byte) error {
	var raw struct {
		Average     any    `json:"average"`
		AverageBuy  any    `json:"average_buy"`
		AverageSell any    `json:"average_sell"`
		MedianBuy   any    `json:"median_buy"`
		MedianSell  any    `json:"median_sell"`
		Count       any    `json:"count"`
		UpdatedAt   string `json:"updated_at"`
	}
	if err := decodeJSON(data, &raw); err != nil {
		return err
	}

	average, err := optionalNonNegativeDecimal("average", raw.Average)
	if err != nil {
		return err
	}
	averageBuy, err := optionalNonNegativeDecimal("average_buy", raw.AverageBuy)
	if err != nil {
		return err
	}
	averageSell, err := optionalNonNegativeDecimal("average_sell", raw.AverageSell)
	if err != nil {
		return err
	}
	medianBuy, err := optionalNonNegativeDecimal("median_buy", raw.MedianBuy)
	if err != nil {
		return err
	}
	medianSell, err := optionalNonNegativeDecimal("median_sell", raw.MedianSell)
	if err != nil {
		return err
	}

	var count int64
	if !isMissingNumber(raw.Count) {
		count, err = int64From(raw.Count)
		if err != nil {
			return fmt.Errorf("campo count: %w", err)
		}
		if count < 0 {
			return fmt.Errorf("campo count: no puede ser negativo")
		}
	}

	*a = Average{
		Average:     average,
		AverageBuy:  averageBuy,
		AverageSell: averageSell,
		MedianBuy:   medianBuy,
		MedianSell:  medianSell,
		Count:       count,
		UpdatedAt:   raw.UpdatedAt,
	}
	return nil
}

// Transaction es una transacción de QvaPay. Los objetos anidados se conservan
// como JSON crudo para tolerar variantes del proveedor.
type Transaction struct {
	UUID        string          `json:"uuid"`
	Amount      decimal.Value   `json:"amount"`
	Description string          `json:"description"`
	RemoteID    string          `json:"remote_id"`
	Status      string          `json:"status"`
	CreatedAt   string          `json:"created_at"`
	UpdatedAt   string          `json:"updated_at"`
	User        json.RawMessage `json:"User"`
	PaidBy      json.RawMessage `json:"PaidBy"`
	P2P         json.RawMessage `json:"P2P"`
	Wallet      json.RawMessage `json:"Wallet"`
}

// UnmarshalJSON valida el identificador y el importe, como el oráculo de
// `src/qvapay.ts`, y decodifica el importe de forma exacta.
func (t *Transaction) UnmarshalJSON(data []byte) error {
	var raw struct {
		UUID        string          `json:"uuid"`
		Amount      any             `json:"amount"`
		Description string          `json:"description"`
		RemoteID    string          `json:"remote_id"`
		Status      string          `json:"status"`
		CreatedAt   string          `json:"created_at"`
		UpdatedAt   string          `json:"updated_at"`
		User        json.RawMessage `json:"User"`
		UserLower   json.RawMessage `json:"user"`
		PaidBy      json.RawMessage `json:"PaidBy"`
		PaidByLower json.RawMessage `json:"paid_by"`
		P2P         json.RawMessage `json:"P2P"`
		P2PLower    json.RawMessage `json:"p2p"`
		Wallet      json.RawMessage `json:"Wallet"`
		WalletLower json.RawMessage `json:"wallet"`
	}
	if err := decodeJSON(data, &raw); err != nil {
		return err
	}
	if raw.UUID == "" {
		return fmt.Errorf("transacción de QvaPay sin identificador")
	}
	if isMissingNumber(raw.Amount) {
		return fmt.Errorf("transacción de QvaPay sin importe")
	}
	amount, err := decimalFrom(raw.Amount)
	if err != nil {
		return fmt.Errorf("importe de transacción: %w", err)
	}
	if amount.Sign() < 0 {
		return fmt.Errorf("importe de transacción negativo")
	}

	status := raw.Status
	if status == "" {
		status = "unknown"
	}

	*t = Transaction{
		UUID:        raw.UUID,
		Amount:      amount,
		Description: raw.Description,
		RemoteID:    raw.RemoteID,
		Status:      status,
		CreatedAt:   raw.CreatedAt,
		UpdatedAt:   raw.UpdatedAt,
		User:        firstRawMessage(raw.User, raw.UserLower),
		PaidBy:      firstRawMessage(raw.PaidBy, raw.PaidByLower),
		P2P:         firstRawMessage(raw.P2P, raw.P2PLower),
		Wallet:      firstRawMessage(raw.Wallet, raw.WalletLower),
	}
	return nil
}

// TransactionPage es una página de transacciones. Total es nil cuando QvaPay
// no devuelve un total utilizable.
type TransactionPage struct {
	Transactions []Transaction `json:"transactions"`
	Total        *int64        `json:"total,omitempty"`
}

// New construye un cliente de lectura y valida la URL base.
//
// BaseURL debe ser http o https y no puede incluir credenciales, query ni
// fragmento. Se elimina cualquier `/` final. Producción debe usar https; http
// queda reservado para pruebas y servidores locales.
func New(baseURL, token string) (*Client, error) {
	baseURL = strings.TrimSpace(baseURL)
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return nil, fmt.Errorf("BaseURL de QvaPay inválida: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("BaseURL de QvaPay debe usar http o https")
	}
	if parsed.Host == "" {
		return nil, fmt.Errorf("BaseURL de QvaPay sin host")
	}
	if parsed.User != nil {
		return nil, fmt.Errorf("BaseURL de QvaPay no debe incluir credenciales")
	}
	if parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		return nil, fmt.Errorf("BaseURL de QvaPay no debe incluir query ni fragmento")
	}

	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawPath = strings.TrimRight(parsed.RawPath, "/")

	return &Client{
		BaseURL: parsed.String(),
		Token:   token,
		HTTP:    newHTTPClient(),
	}, nil
}

// User lee GET /user.
func (c *Client) User(ctx context.Context) (User, error) {
	var user User
	if err := c.get(ctx, "/user", nil, &user); err != nil {
		return User{}, err
	}
	return user, nil
}

// Offers lee GET /p2p con los parámetros recibidos. Acepta que la lista venga
// en `data` o en `offers`, como hace `src/qvapay.ts`.
func (c *Client) Offers(ctx context.Context, params url.Values) ([]Offer, error) {
	var payload struct {
		Data   json.RawMessage `json:"data"`
		Offers json.RawMessage `json:"offers"`
	}
	if err := c.get(ctx, "/p2p", params, &payload); err != nil {
		return nil, err
	}
	return decodeOfferArray(payload.Data, payload.Offers)
}

// Offer lee GET /p2p/{uuid}. La respuesta debe incluir `p2p`.
func (c *Client) Offer(ctx context.Context, uuid string) (Offer, error) {
	path, err := offerPath(uuid)
	if err != nil {
		return Offer{}, err
	}

	var payload struct {
		P2P *Offer `json:"p2p"`
	}
	if err := c.get(ctx, path, nil, &payload); err != nil {
		return Offer{}, err
	}
	if payload.P2P == nil {
		return Offer{}, fmt.Errorf("QvaPay no devolvió la oferta solicitada")
	}
	return *payload.P2P, nil
}

// Averages lee GET /p2p/averages.
func (c *Client) Averages(ctx context.Context) (map[string]Average, error) {
	var averages map[string]Average
	if err := c.get(ctx, "/p2p/averages", nil, &averages); err != nil {
		return nil, err
	}
	if averages == nil {
		averages = map[string]Average{}
	}
	return averages, nil
}

// Transactions lee GET /transaction con paginación validada. El cliente impone
// status=paid, order=desc e include_total=true.
func (c *Client) Transactions(ctx context.Context, page, take int) (TransactionPage, error) {
	if take < 1 || take > 30 {
		return TransactionPage{}, fmt.Errorf("take debe estar entre 1 y 30")
	}
	if page < 1 {
		return TransactionPage{}, fmt.Errorf("page debe ser mayor o igual que 1")
	}

	query := url.Values{
		"take":          []string{strconv.Itoa(take)},
		"page":          []string{strconv.Itoa(page)},
		"status":        []string{"paid"},
		"order":         []string{"desc"},
		"include_total": []string{"true"},
	}

	var raw json.RawMessage
	if err := c.get(ctx, "/transaction", query, &raw); err != nil {
		return TransactionPage{}, err
	}
	return parseTransactionPage(raw)
}

// get es el único método HTTP del cliente. No acepta un verbo: siempre emite
// GET y solo admite las rutas de lectura conocidas. No registra el token.
func (c *Client) get(ctx context.Context, path string, query url.Values, out any) error {
	if !isAllowedReadPath(path) {
		return fmt.Errorf("ruta de lectura no permitida: %q", path)
	}

	base := strings.TrimRight(c.BaseURL, "/")
	if base == "" {
		return fmt.Errorf("BaseURL de QvaPay vacía")
	}
	endpoint, err := url.Parse(base + path)
	if err != nil {
		return fmt.Errorf("URL de QvaPay inválida: %w", err)
	}
	if endpoint.Scheme != "http" && endpoint.Scheme != "https" {
		return fmt.Errorf("URL de QvaPay debe usar http o https")
	}
	if endpoint.Host == "" {
		return fmt.Errorf("URL de QvaPay sin host")
	}
	if query != nil {
		endpoint.RawQuery = query.Encode()
	}

	requestCtx, cancel := context.WithTimeout(ctx, DefaultTimeout)
	defer cancel()

	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return fmt.Errorf("no se pudo construir la petición de lectura: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+c.Token)
	request.Header.Set("Accept", "application/json")

	httpClient := c.HTTP
	if httpClient == nil {
		httpClient = newHTTPClient()
	} else {
		clone := *httpClient
		clone.CheckRedirect = checkSameHostRedirect
		if clone.Timeout <= 0 {
			clone.Timeout = DefaultTimeout
		}
		httpClient = &clone
	}

	response, err := httpClient.Do(request)
	if err != nil {
		return newConnectionError(err)
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, maxErrorBodyBytes))
		return &APIError{
			Status:     response.StatusCode,
			RetryAfter: parseRetryAfter(response.Header.Get("Retry-After")),
			Body:       string(body),
		}
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, MaxResponseBytes+1))
	if err != nil {
		return newConnectionError(err)
	}
	if int64(len(body)) > MaxResponseBytes {
		return fmt.Errorf("respuesta de QvaPay demasiado grande (máximo %d bytes)", MaxResponseBytes)
	}
	if out == nil {
		return nil
	}
	if err := decodeJSON(body, out); err != nil {
		return fmt.Errorf("respuesta JSON inválida de QvaPay: %w", err)
	}
	return nil
}

func newHTTPClient() *http.Client {
	return &http.Client{
		Timeout:       DefaultTimeout,
		CheckRedirect: checkSameHostRedirect,
	}
}

// checkSameHostRedirect impide que una lectura derive hacia otro host o
// degrade https a http. Se permiten redirecciones dentro del mismo origen.
func checkSameHostRedirect(request *http.Request, via []*http.Request) error {
	if len(via) == 0 {
		return nil
	}
	if len(via) >= maxRedirects {
		return fmt.Errorf("demasiadas redirecciones")
	}
	origin := via[0].URL
	if !strings.EqualFold(request.URL.Host, origin.Host) {
		return fmt.Errorf("redirección a otro host rechazada")
	}
	if !strings.EqualFold(request.URL.Scheme, origin.Scheme) {
		return fmt.Errorf("redirección a otro esquema rechazada")
	}
	return nil
}

func newConnectionError(err error) error {
	reason := "network"
	var netErr net.Error
	if errors.Is(err, context.DeadlineExceeded) ||
		(errors.As(err, &netErr) && netErr.Timeout()) {
		reason = "timeout"
	}
	return &ConnectionError{Reason: reason, Err: err}
}

func parseRetryAfter(value string) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if seconds, err := strconv.ParseInt(value, 10, 64); err == nil {
		if seconds < 0 {
			return 0
		}
		return time.Duration(seconds) * time.Second
	}
	if when, err := http.ParseTime(value); err == nil {
		delay := time.Until(when)
		if delay < 0 {
			return 0
		}
		return delay
	}
	return 0
}

// isAllowedReadPath mantiene una lista cerrada de rutas. En particular impide
// rutas de mutación como /p2p/{uuid}/apply o /p2p/create.
func isAllowedReadPath(path string) bool {
	switch path {
	case "/user", "/p2p", "/p2p/averages", "/transaction":
		return true
	}

	const prefix = "/p2p/"
	if !strings.HasPrefix(path, prefix) {
		return false
	}
	rest := strings.TrimPrefix(path, prefix)
	if rest == "" || rest == "." || rest == ".." {
		return false
	}
	// Nombres reservados por la API de QvaPay. El listado usa /p2p y los
	// promedios /p2p/averages; create/apply/edit/cancel/... son mutaciones.
	switch strings.ToLower(rest) {
	case "averages", "create", "apply", "edit", "cancel", "paid", "received", "chat":
		return false
	}
	if strings.ContainsAny(rest, "/\\?#") {
		return false
	}
	lower := strings.ToLower(rest)
	if strings.Contains(lower, "%2f") || strings.Contains(lower, "%5c") {
		return false
	}
	return true
}

func offerPath(uuid string) (string, error) {
	if uuid == "" || uuid != strings.TrimSpace(uuid) {
		return "", fmt.Errorf("UUID de oferta inválido")
	}
	for _, char := range uuid {
		if char < 0x20 || char == 0x7f {
			return "", fmt.Errorf("UUID de oferta inválido")
		}
	}
	return "/p2p/" + url.PathEscape(uuid), nil
}

func decodeOfferArray(candidates ...json.RawMessage) ([]Offer, error) {
	for _, candidate := range candidates {
		trimmed := bytes.TrimSpace(candidate)
		if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
			continue
		}
		if trimmed[0] == '[' {
			return decodeOfferItems(trimmed, 0)
		}
		if trimmed[0] == '{' {
			var envelope struct {
				Data   json.RawMessage `json:"data"`
				Offers json.RawMessage `json:"offers"`
			}
			if err := decodeJSON(trimmed, &envelope); err != nil {
				return nil, fmt.Errorf("lista de ofertas de QvaPay inválida: %w", err)
			}
			if offers, err := decodeOfferArray(envelope.Data, envelope.Offers); err == nil && len(offers) > 0 {
				return offers, nil
			}
		}
	}
	return []Offer{}, nil
}

func decodeOfferItems(raw json.RawMessage, depth int) ([]Offer, error) {
	if depth > 3 {
		return nil, fmt.Errorf("lista de ofertas de QvaPay anidada demasiado")
	}
	var items []json.RawMessage
	if err := decodeJSON(raw, &items); err != nil {
		return nil, fmt.Errorf("lista de ofertas de QvaPay inválida: %w", err)
	}
	offers := make([]Offer, 0, len(items))
	for _, item := range items {
		trimmed := bytes.TrimSpace(item)
		if len(trimmed) == 0 {
			continue
		}
		var object map[string]json.RawMessage
		if err := decodeJSON(trimmed, &object); err != nil {
			return nil, fmt.Errorf("oferta de QvaPay inválida: %w", err)
		}
		if nested, ok := object["offers"]; ok {
			values, err := decodeOfferItems(nested, depth+1)
			if err != nil {
				return nil, err
			}
			offers = append(offers, values...)
			continue
		}
		var offer Offer
		if err := decodeJSON(trimmed, &offer); err != nil {
			return nil, fmt.Errorf("oferta de QvaPay inválida: %w", err)
		}
		offers = append(offers, offer)
	}
	return offers, nil
}

// scalarString acepta un texto o un objeto con tick/code/currency/name. La API
// real ha devuelto `coin` como objeto en algunas respuestas; el oráculo TS
// normaliza el tick.
func scalarString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case map[string]any:
		for _, key := range []string{"tick", "code", "currency", "name", "uuid"} {
			if text, ok := typed[key].(string); ok && strings.TrimSpace(text) != "" {
				return text
			}
		}
	}
	return ""
}

func parseTransactionPage(raw json.RawMessage) (TransactionPage, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return TransactionPage{}, fmt.Errorf("QvaPay devolvió una página de transacciones vacía")
	}

	if trimmed[0] == '[' {
		var transactions []Transaction
		if err := decodeJSON(trimmed, &transactions); err != nil {
			return TransactionPage{}, fmt.Errorf("listado de transacciones de QvaPay inválido: %w", err)
		}
		return TransactionPage{Transactions: transactions}, nil
	}

	var envelope struct {
		Transactions json.RawMessage `json:"transactions"`
		Total        any             `json:"total"`
	}
	if err := decodeJSON(trimmed, &envelope); err != nil {
		return TransactionPage{}, fmt.Errorf("listado de transacciones de QvaPay inválido: %w", err)
	}

	transactionsRaw := bytes.TrimSpace(envelope.Transactions)
	if len(transactionsRaw) == 0 || bytes.Equal(transactionsRaw, []byte("null")) || transactionsRaw[0] != '[' {
		return TransactionPage{}, fmt.Errorf("QvaPay devolvió un listado de transacciones inválido")
	}
	var transactions []Transaction
	if err := decodeJSON(transactionsRaw, &transactions); err != nil {
		return TransactionPage{}, fmt.Errorf("listado de transacciones de QvaPay inválido: %w", err)
	}

	page := TransactionPage{Transactions: transactions}
	if !isMissingNumber(envelope.Total) {
		if total, err := int64From(envelope.Total); err == nil && total >= 0 {
			page.Total = &total
		}
	}
	return page, nil
}

func decodeJSON(data []byte, out any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(out); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return fmt.Errorf("datos JSON adicionales")
		}
		return err
	}
	return nil
}

// decimalFrom convierte un valor ya decodificado a decimal exacto. Acepta
// json.Number (el formato normal con UseNumber), float64 y string. El float64
// solo se usa para recuperar una representación decimal; nunca para operar.
func decimalFrom(value any) (decimal.Value, error) {
	switch typed := value.(type) {
	case json.Number:
		return decimal.Parse(typed.String())
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return decimal.Value{}, fmt.Errorf("número no finito")
		}
		return decimal.Parse(strconv.FormatFloat(typed, 'g', -1, 64))
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return decimal.Value{}, fmt.Errorf("número vacío")
		}
		return decimal.Parse(text)
	default:
		return decimal.Value{}, fmt.Errorf("tipo numérico no soportado: %T", value)
	}
}

func optionalDecimal(field string, value any) (decimal.Value, error) {
	if isMissingNumber(value) {
		return decimal.Zero(), nil
	}
	parsed, err := decimalFrom(value)
	if err != nil {
		return decimal.Value{}, fmt.Errorf("campo %s: %w", field, err)
	}
	return parsed, nil
}

func optionalNonNegativeDecimal(field string, value any) (decimal.Value, error) {
	parsed, err := optionalDecimal(field, value)
	if err != nil {
		return decimal.Value{}, err
	}
	if parsed.Sign() < 0 {
		return decimal.Value{}, fmt.Errorf("campo %s: no puede ser negativo", field)
	}
	return parsed, nil
}

func firstNonNegativeDecimal(values ...any) (decimal.Value, bool) {
	for _, value := range values {
		if isMissingNumber(value) {
			continue
		}
		parsed, err := decimalFrom(value)
		if err != nil || parsed.Sign() < 0 {
			continue
		}
		return parsed, true
	}
	return decimal.Value{}, false
}

func int64From(value any) (int64, error) {
	parsed, err := decimalFrom(value)
	if err != nil {
		return 0, err
	}
	integer, ok := parsed.Int64()
	if !ok {
		return 0, fmt.Errorf("no es un entero")
	}
	return integer, nil
}

func isMissingNumber(value any) bool {
	if value == nil {
		return true
	}
	if text, ok := value.(string); ok && strings.TrimSpace(text) == "" {
		return true
	}
	return false
}

func firstRawMessage(primary, fallback json.RawMessage) json.RawMessage {
	if len(primary) > 0 && !bytes.Equal(bytes.TrimSpace(primary), []byte("null")) {
		return primary
	}
	if len(fallback) > 0 {
		return fallback
	}
	return primary
}
