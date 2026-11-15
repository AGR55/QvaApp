package edge

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	qvapayWebhookPath             = "/webhooks/qvapay/p2p-feed"
	qvapayWebhookSignatureHeader  = "X-QvaPay-Signature"
	qvapayWebhookMaxBodyBytes     = 1 << 20
	qvapayWebhookSignaturePrefix  = "sha256="
	qvapayWebhookSignatureHexSize = sha256.Size * 2
)

// FeedEventStore persiste los eventos del feed P2P de QvaPay. El
// identificador es idempotente: repetir el mismo event_key actualiza el
// registro en lugar de duplicarlo.
type FeedEventStore interface {
	Upsert(ctx context.Context, eventKey, event string, payload []byte, receivedAt int64) error
}

// PostgresFeedEventStore implementa FeedEventStore sobre
// shadow.qvapay_feed_events (migración 0017).
type PostgresFeedEventStore struct {
	Pool *pgxpool.Pool
}

var _ FeedEventStore = (*PostgresFeedEventStore)(nil)

// Upsert escribe el evento crudo recibido. El payload ya viene validado como
// JSON por el handler.
func (store *PostgresFeedEventStore) Upsert(
	ctx context.Context,
	eventKey, event string,
	payload []byte,
	receivedAt int64,
) error {
	if store == nil || store.Pool == nil {
		return errors.New("edge: feed event store sin pool")
	}
	_, err := store.Pool.Exec(ctx, `
		INSERT INTO shadow.qvapay_feed_events (event_key, event, payload_json, received_at)
		VALUES ($1, $2, $3::jsonb, $4)
		ON CONFLICT (event_key) DO UPDATE
		SET event = EXCLUDED.event,
			payload_json = EXCLUDED.payload_json,
			received_at = EXCLUDED.received_at`,
		eventKey, event, string(payload), receivedAt,
	)
	return err
}

// QvapayWebhookAPI recibe el feed P2P firmado por QvaPay.
//
// Ruta:
//
//	POST /webhooks/qvapay/p2p-feed
//
// Solo se acepta cuando Enabled está activo y Secret tiene valor. La firma es
// el HMAC-SHA256 hexadecimal del cuerpo crudo en X-QvaPay-Signature, con
// prefijo "sha256=" opcional. El cuerpo nunca se registra en logs y el secreto
// solo se usa para calcular la firma.
type QvapayWebhookAPI struct {
	Enabled bool
	Secret  string
	Store   FeedEventStore
	Now     func() time.Time
}

type qvapayWebhookEnvelope struct {
	Event string `json:"event"`
	Data  struct {
		ID   json.RawMessage `json:"id"`
		UUID json.RawMessage `json:"uuid"`
	} `json:"data"`
}

type qvapayWebhookResponse struct {
	OK       bool   `json:"ok"`
	Event    string `json:"event"`
	EventKey string `json:"eventKey"`
}

func (api *QvapayWebhookAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")

	if r.URL.Path != qvapayWebhookPath {
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
		return
	}
	if !api.Enabled {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "Webhook deshabilitado."})
		return
	}
	if api.Secret == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "Webhook sin secreto configurado."})
		return
	}

	body, ok := qvapayWebhookReadBody(w, r)
	if !ok {
		return
	}
	if !qvapayWebhookSignatureOK(api.Secret, body, r.Header.Get(qvapayWebhookSignatureHeader)) {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Firma inválida."})
		return
	}

	var envelope qvapayWebhookEnvelope
	if err := json.Unmarshal(body, &envelope); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Cuerpo JSON inválido."})
		return
	}
	event := strings.TrimSpace(envelope.Event)
	if event == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Evento inválido."})
		return
	}
	if api.Store == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "Almacén de eventos no disponible."})
		return
	}

	eventKey := qvapayWebhookEventKey(event, envelope, body)
	if err := api.Store.Upsert(r.Context(), eventKey, event, body, api.now().UnixMilli()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "No se pudo guardar el evento."})
		return
	}

	writeJSON(w, http.StatusAccepted, qvapayWebhookResponse{
		OK:       true,
		Event:    event,
		EventKey: eventKey,
	})
}

func (api *QvapayWebhookAPI) now() time.Time {
	if api.Now != nil {
		return api.Now()
	}
	return time.Now()
}

// qvapayWebhookReadBody limita la lectura a 1 MiB. Devuelve false cuando ya
// escribió la respuesta de error.
func qvapayWebhookReadBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, qvapayWebhookMaxBodyBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "Cuerpo demasiado grande."})
			return nil, false
		}
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Solicitud inválida."})
		return nil, false
	}
	return body, true
}

// qvapayWebhookSignatureOK valida la firma hexadecimal, admitiendo el prefijo
// "sha256=". La comparación es en tiempo constante.
func qvapayWebhookSignatureOK(secret string, body []byte, header string) bool {
	value := strings.TrimSpace(header)
	if len(value) >= len(qvapayWebhookSignaturePrefix) &&
		strings.EqualFold(value[:len(qvapayWebhookSignaturePrefix)], qvapayWebhookSignaturePrefix) {
		value = strings.TrimSpace(value[len(qvapayWebhookSignaturePrefix):])
	}
	if len(value) != qvapayWebhookSignatureHexSize {
		return false
	}
	provided, err := hex.DecodeString(value)
	if err != nil || len(provided) != sha256.Size {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hmac.Equal(mac.Sum(nil), provided)
}

// qvapayWebhookEventKey prefiere data.id, luego data.uuid y, como último
// recurso, el SHA-256 hexadecimal del cuerpo crudo.
func qvapayWebhookEventKey(event string, envelope qvapayWebhookEnvelope, body []byte) string {
	if id := qvapayWebhookKeyPart(envelope.Data.ID); id != "" {
		return event + ":" + id
	}
	if uuid := qvapayWebhookKeyPart(envelope.Data.UUID); uuid != "" {
		return event + ":" + uuid
	}
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// qvapayWebhookKeyPart normaliza un identificador JSON que puede venir como
// cadena o número. Los valores nulos o vacíos se descartan.
func qvapayWebhookKeyPart(raw json.RawMessage) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return ""
	}
	if strings.HasPrefix(trimmed, `"`) {
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			return ""
		}
		return strings.TrimSpace(value)
	}
	var number json.Number
	if err := json.Unmarshal(raw, &number); err != nil {
		return ""
	}
	return number.String()
}
