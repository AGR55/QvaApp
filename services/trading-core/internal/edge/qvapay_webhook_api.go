package edge

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
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

type FeedForwardEvent struct {
	EventKey string
	Payload  []byte
	Attempts int
}

type FeedForwardStore interface {
	UpsertAndEnqueue(ctx context.Context, eventKey, event string, payload []byte, receivedAt int64) error
	ClaimForward(ctx context.Context, now, leaseUntil int64) (FeedForwardEvent, bool, error)
	CompleteForward(ctx context.Context, eventKey string, deliveredAt int64) error
	RetryForward(ctx context.Context, eventKey string, availableAt int64, lastError string) error
}

// PostgresFeedEventStore implementa FeedEventStore sobre
// shadow.qvapay_feed_events (migración 0017) y su outbox (0018).
type PostgresFeedEventStore struct {
	Pool *pgxpool.Pool
}

var _ FeedEventStore = (*PostgresFeedEventStore)(nil)
var _ FeedForwardStore = (*PostgresFeedEventStore)(nil)

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

func (store *PostgresFeedEventStore) UpsertAndEnqueue(
	ctx context.Context,
	eventKey, event string,
	payload []byte,
	receivedAt int64,
) error {
	if store == nil || store.Pool == nil {
		return errors.New("edge: feed forward store sin pool")
	}
	tx, err := store.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `
		INSERT INTO shadow.qvapay_feed_events (event_key, event, payload_json, received_at)
		VALUES ($1, $2, $3::jsonb, $4)
		ON CONFLICT (event_key) DO UPDATE
		SET event = EXCLUDED.event, payload_json = EXCLUDED.payload_json,
			received_at = EXCLUDED.received_at`, eventKey, event, string(payload), receivedAt); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO shadow.qvapay_feed_forward_outbox
			(event_key, payload_json, available_at, created_at)
		VALUES ($1, $2::jsonb, $3, $3)
		ON CONFLICT (event_key) DO NOTHING`, eventKey, string(payload), receivedAt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (store *PostgresFeedEventStore) ClaimForward(
	ctx context.Context,
	now, leaseUntil int64,
) (FeedForwardEvent, bool, error) {
	if store == nil || store.Pool == nil {
		return FeedForwardEvent{}, false, errors.New("edge: feed forward store sin pool")
	}
	var event FeedForwardEvent
	err := store.Pool.QueryRow(ctx, `
		WITH next_event AS (
			SELECT event_key FROM shadow.qvapay_feed_forward_outbox
			WHERE delivered_at IS NULL AND available_at <= $1
				AND (claimed_until IS NULL OR claimed_until <= $1)
			ORDER BY available_at, created_at
			FOR UPDATE SKIP LOCKED
			LIMIT 1
		)
		UPDATE shadow.qvapay_feed_forward_outbox AS outbox
		SET claimed_until = $2, attempts = attempts + 1
		FROM next_event
		WHERE outbox.event_key = next_event.event_key
		RETURNING outbox.event_key, outbox.payload_json, outbox.attempts`, now, leaseUntil,
	).Scan(&event.EventKey, &event.Payload, &event.Attempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return FeedForwardEvent{}, false, nil
	}
	return event, err == nil, err
}

func (store *PostgresFeedEventStore) CompleteForward(ctx context.Context, eventKey string, deliveredAt int64) error {
	_, err := store.Pool.Exec(ctx, `
		UPDATE shadow.qvapay_feed_forward_outbox
		SET delivered_at = $2, claimed_until = NULL, last_error = ''
		WHERE event_key = $1 AND delivered_at IS NULL`, eventKey, deliveredAt)
	return err
}

func (store *PostgresFeedEventStore) RetryForward(ctx context.Context, eventKey string, availableAt int64, lastError string) error {
	if len(lastError) > 500 {
		lastError = lastError[:500]
	}
	_, err := store.Pool.Exec(ctx, `
		UPDATE shadow.qvapay_feed_forward_outbox
		SET available_at = $2, claimed_until = NULL, last_error = $3
		WHERE event_key = $1 AND delivered_at IS NULL`, eventKey, availableAt, lastError)
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
	Enabled      bool
	Secret       string
	Store        FeedEventStore
	Now          func() time.Time
	ForwardURL   string
	ForwardToken string
	ForwardQueue chan []byte
	ForwardStore FeedForwardStore
	ForwardHTTP  *http.Client
	Logger       *slog.Logger
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
	var persistErr error
	if api.ForwardURL != "" {
		forwardStore := api.ForwardStore
		if forwardStore == nil {
			forwardStore, _ = api.Store.(FeedForwardStore)
		}
		if forwardStore == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "Cola durable de reenvío no disponible."})
			return
		}
		persistErr = forwardStore.UpsertAndEnqueue(r.Context(), eventKey, event, body, api.now().UnixMilli())
	} else {
		persistErr = api.Store.Upsert(r.Context(), eventKey, event, body, api.now().UnixMilli())
	}
	if persistErr != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "No se pudo guardar el evento."})
		return
	}
	api.enqueueForward(body)

	writeJSON(w, http.StatusAccepted, qvapayWebhookResponse{
		OK:       true,
		Event:    event,
		EventKey: eventKey,
	})
}

// enqueueForward reenvía el cuerpo al hunter sin bloquear la respuesta a
// QvaPay. En modo durable el outbox conserva el evento aunque la señal
// en memoria no entre en la cola; el worker lo recoge en su siguiente ciclo.
func (api *QvapayWebhookAPI) enqueueForward(body []byte) {
	if api.ForwardURL == "" || api.ForwardQueue == nil {
		return
	}
	copied := append([]byte(nil), body...)
	select {
	case api.ForwardQueue <- copied:
	default:
		if api.Logger != nil {
			api.Logger.Warn("cola de reenvío del feed llena; evento omitido")
		}
	}
}

// RunForwarder envía los cuerpos del webhook al hunter para evaluación
// inmediata. Un fallo se registra y no bloquea el webhook.
func (api *QvapayWebhookAPI) RunForwarder(ctx context.Context) {
	if api.ForwardURL == "" || (api.ForwardStore == nil && api.ForwardQueue == nil) {
		return
	}
	if api.ForwardStore != nil {
		api.runDurableForwarder(ctx)
		return
	}
	client := api.ForwardHTTP
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Second}
	}
	for {
		select {
		case <-ctx.Done():
			return
		case body := <-api.ForwardQueue:
			request, err := http.NewRequestWithContext(ctx, http.MethodPost,
				api.ForwardURL, bytes.NewReader(body))
			if err != nil {
				continue
			}
			request.Header.Set("Content-Type", "application/json")
			if api.ForwardToken != "" {
				request.Header.Set("X-Hunter-Feed-Token", api.ForwardToken)
			}
			response, err := client.Do(request)
			if err != nil {
				if api.Logger != nil && ctx.Err() == nil {
					api.Logger.Warn("reenvío del feed al hunter falló", "error", err)
				}
				continue
			}
			_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
			response.Body.Close()
		}
	}
}

func (api *QvapayWebhookAPI) runDurableForwarder(ctx context.Context) {
	client := api.ForwardHTTP
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Second}
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-api.ForwardQueue:
		}
		for api.forwardOne(ctx, client) {
		}
	}
}

func (api *QvapayWebhookAPI) forwardOne(ctx context.Context, client *http.Client) bool {
	now := api.now().UnixMilli()
	claimCtx, cancelClaim := context.WithTimeout(ctx, 2*time.Second)
	item, found, err := api.ForwardStore.ClaimForward(claimCtx, now, now+30_000)
	cancelClaim()
	if err != nil {
		if api.Logger != nil && ctx.Err() == nil {
			api.Logger.Warn("reclamar webhook pendiente falló", "error", err)
		}
		return false
	}
	if !found {
		return false
	}
	requestCtx, cancelRequest := context.WithTimeout(ctx, 2*time.Second)
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, api.ForwardURL, bytes.NewReader(item.Payload))
	if err != nil {
		cancelRequest()
		api.retryForward(item, err.Error())
		return true
	}
	request.Header.Set("Content-Type", "application/json")
	if api.ForwardToken != "" {
		request.Header.Set("X-Hunter-Feed-Token", api.ForwardToken)
	}
	response, err := client.Do(request)
	if err == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		response.Body.Close()
		if response.StatusCode >= 200 && response.StatusCode < 300 {
			ackCtx, cancelAck := context.WithTimeout(ctx, 2*time.Second)
			err = api.ForwardStore.CompleteForward(ackCtx, item.EventKey, api.now().UnixMilli())
			cancelAck()
			if err == nil {
				cancelRequest()
				return true
			}
		}
		if err == nil {
			err = fmt.Errorf("hunter respondió %d", response.StatusCode)
		}
	}
	cancelRequest()
	api.retryForward(item, err.Error())
	return true
}

func (api *QvapayWebhookAPI) retryForward(item FeedForwardEvent, message string) {
	shift := item.Attempts - 1
	if shift < 0 {
		shift = 0
	}
	if shift > 8 {
		shift = 8
	}
	delay := time.Second * time.Duration(1<<shift)
	if delay > 5*time.Minute {
		delay = 5 * time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := api.ForwardStore.RetryForward(ctx, item.EventKey, api.now().Add(delay).UnixMilli(), message); err != nil && api.Logger != nil {
		api.Logger.Error("programar reintento de webhook falló", "event_key", item.EventKey, "error", err)
	}
	if api.Logger != nil {
		api.Logger.Warn("webhook se reintentará", "event_key", item.EventKey, "attempt", item.Attempts, "error", message)
	}
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
