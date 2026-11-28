package notifier

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	// pushSubscriptionsPath es la única ruta gestionada por PushAPI.
	pushSubscriptionsPath = "/push/subscriptions"
	// maxPushSubscriptionBody acota el cuerpo JSON de las mutaciones.
	maxPushSubscriptionBody = 8 << 10
	// pushSubscriptionTTL es la vigencia aplicada al registrar una suscripción.
	pushSubscriptionTTL = 24 * time.Hour
	// pushSubscriptionsAllow lista los métodos aceptados por la ruta.
	pushSubscriptionsAllow = "GET, POST, DELETE"
)

// PushSubscriptionStore es el almacenamiento usado por PushAPI. No envía push:
// sólo persiste, elimina, lista y cuenta suscripciones.
type PushSubscriptionStore interface {
	Upsert(ctx context.Context, subscription PushSubscription, now, expiresAt time.Time) error
	Delete(ctx context.Context, endpoint string) (bool, error)
	List(ctx context.Context, now time.Time, limit int) ([]PushSubscription, error)
	Count(ctx context.Context, now time.Time) (int, error)
}

// PushAPI expone el alta y la baja de suscripciones Web Push. Las mutaciones
// exigen X-Notifier-Token cuando InternalToken está configurado; GET sólo
// devuelve el conteo y nunca expone endpoints ni claves. No registra valores
// de suscripción en logs.
type PushAPI struct {
	Store         PushSubscriptionStore
	InternalToken string
	// Now permite inyectar un reloj en pruebas. Si es nil se usa time.Now.
	Now func() time.Time
}

var _ http.Handler = (*PushAPI)(nil)

// ServeHTTP enruta la ruta de suscripciones. Rutas desconocidas responden 404
// y métodos no soportados 405, siempre en JSON.
func (api *PushAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != pushSubscriptionsPath {
		writePushJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
		return
	}

	switch r.Method {
	case http.MethodPost:
		api.post(w, r)
	case http.MethodDelete:
		api.delete(w, r)
	case http.MethodGet:
		api.get(w, r)
	default:
		writePushJSON(w, http.StatusMethodNotAllowed, map[string]string{
			"status": "method_not_allowed",
		}, pushSubscriptionsAllow)
	}
}

// post valida y registra una suscripción durante 24 horas. Sólo el endpoint y
// las claves se guardan; la respuesta no los repite.
func (api *PushAPI) post(w http.ResponseWriter, r *http.Request) {
	if !api.authorized(r) {
		writePushJSON(w, http.StatusUnauthorized, map[string]string{
			"status": "unauthorized",
		})
		return
	}
	if api.Store == nil {
		writePushJSON(w, http.StatusServiceUnavailable, map[string]string{
			"status": "not_configured",
		})
		return
	}

	var subscription PushSubscription
	if !decodePushJSON(w, r, &subscription) {
		return
	}
	if err := subscription.Validate(); err != nil {
		writePushJSON(w, http.StatusBadRequest, map[string]string{
			"status": "invalid_subscription",
			"error":  err.Error(),
		})
		return
	}

	now := api.now()
	if err := api.Store.Upsert(r.Context(), subscription, now,
		now.Add(pushSubscriptionTTL)); err != nil {
		writePushJSON(w, http.StatusInternalServerError, map[string]string{
			"status": "internal_error",
		})
		return
	}
	writePushJSON(w, http.StatusAccepted, map[string]string{"status": "accepted"})
}

// delete elimina una suscripción por endpoint, recibido en el cuerpo JSON
// {"endpoint":"..."} o en la query. No expone el endpoint en la respuesta.
func (api *PushAPI) delete(w http.ResponseWriter, r *http.Request) {
	if !api.authorized(r) {
		writePushJSON(w, http.StatusUnauthorized, map[string]string{
			"status": "unauthorized",
		})
		return
	}
	if api.Store == nil {
		writePushJSON(w, http.StatusServiceUnavailable, map[string]string{
			"status": "not_configured",
		})
		return
	}

	endpoint, ok := pushDeleteEndpoint(w, r)
	if !ok {
		return
	}
	if endpoint == "" {
		writePushJSON(w, http.StatusBadRequest, map[string]string{
			"status": "invalid_endpoint",
		})
		return
	}

	deleted, err := api.Store.Delete(r.Context(), endpoint)
	if err != nil {
		writePushJSON(w, http.StatusInternalServerError, map[string]string{
			"status": "internal_error",
		})
		return
	}
	if !deleted {
		writePushJSON(w, http.StatusNotFound, map[string]string{
			"status": "not_found",
		})
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

// get devuelve sólo el número de suscripciones vigentes. No lista endpoints ni
// claves, por lo que la respuesta es segura sin autenticación.
func (api *PushAPI) get(w http.ResponseWriter, r *http.Request) {
	if api.Store == nil {
		writePushJSON(w, http.StatusServiceUnavailable, map[string]string{
			"status": "not_configured",
		})
		return
	}
	count, err := api.Store.Count(r.Context(), api.now())
	if err != nil {
		writePushJSON(w, http.StatusInternalServerError, map[string]string{
			"status": "internal_error",
		})
		return
	}
	writePushJSON(w, http.StatusOK, struct {
		Count int `json:"count"`
	}{Count: count})
}

// authorized exige X-Notifier-Token cuando hay token interno configurado. La
// comparación es constante en tiempo. Sin token configurado no hay auth.
func (api *PushAPI) authorized(r *http.Request) bool {
	if api.InternalToken == "" {
		return true
	}
	provided := r.Header.Get("X-Notifier-Token")
	return subtle.ConstantTimeCompare([]byte(provided), []byte(api.InternalToken)) == 1
}

// now devuelve el reloj del handler o time.Now si no se inyectó uno.
func (api *PushAPI) now() time.Time {
	if api.Now != nil {
		return api.Now()
	}
	return time.Now()
}

// pushDeleteEndpoint extrae el endpoint del cuerpo JSON o, si no aparece en el
// cuerpo, de la query. Devuelve ok=false cuando ya escribió una respuesta de
// error.
func pushDeleteEndpoint(w http.ResponseWriter, r *http.Request) (string, bool) {
	var request struct {
		Endpoint string `json:"endpoint"`
	}
	ok := decodePushOptionalJSON(w, r, &request)
	if !ok {
		return "", false
	}
	endpoint := strings.TrimSpace(request.Endpoint)
	if endpoint == "" {
		endpoint = strings.TrimSpace(r.URL.Query().Get("endpoint"))
	}
	return endpoint, true
}

// decodePushJSON decodifica un único objeto JSON acotado a 8 KiB. Escribe 413
// o 400 si el cuerpo es demasiado grande, inválido o contiene datos extra.
func decodePushJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	body := http.MaxBytesReader(w, r.Body, maxPushSubscriptionBody)
	defer body.Close() //nolint:errcheck

	decoder := json.NewDecoder(body)
	if err := decoder.Decode(target); err != nil {
		writePushDecodeError(w, err)
		return false
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		writePushDecodeError(w, err)
		return false
	}
	return true
}

// decodePushOptionalJSON es como decodePushJSON pero acepta un cuerpo vacío,
// que deja target intacto y devuelve true. Escribe 413 o 400 si el cuerpo no
// es válido.
func decodePushOptionalJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	body := http.MaxBytesReader(w, r.Body, maxPushSubscriptionBody)
	defer body.Close() //nolint:errcheck

	decoder := json.NewDecoder(body)
	if err := decoder.Decode(target); err != nil {
		if errors.Is(err, io.EOF) {
			return true
		}
		writePushDecodeError(w, err)
		return false
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		writePushDecodeError(w, err)
		return false
	}
	return true
}

// writePushDecodeError distingue el límite de tamaño de un JSON inválido. Los
// mensajes no incluyen el contenido recibido.
func writePushDecodeError(w http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writePushJSON(w, http.StatusRequestEntityTooLarge, map[string]string{
			"status": "payload_too_large",
		})
		return
	}
	writePushJSON(w, http.StatusBadRequest, map[string]string{
		"status": "invalid_body",
	})
}

// writePushJSON escribe una respuesta JSON sin caché y, opcionalmente, fija la
// cabecera Allow de los 405.
func writePushJSON(w http.ResponseWriter, status int, payload any, allow ...string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if len(allow) > 0 {
		w.Header().Set("Allow", strings.Join(allow, ", "))
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
