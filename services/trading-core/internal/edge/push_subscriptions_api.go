package edge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// pushSubscriptionsPath es la ruta de alta, baja y listado de suscripciones.
	pushSubscriptionsPath = "/api/push/subscriptions"

	// maxPushBodyBytes acota los cuerpos JSON de las mutaciones push.
	maxPushBodyBytes = 8 << 10
	// pushDefaultTTL es la vigencia aplicada cuando el handler no configura TTL.
	pushDefaultTTL = 30 * 24 * time.Hour
	// pushStoreTimeout limita cada operación contra el almacén.
	pushStoreTimeout = 5 * time.Second

	pushMinEndpointLen = 10
	pushMaxEndpointLen = 2048
	pushMinP256DHLen   = 20
	pushMaxP256DHLen   = 300
	pushMinAuthLen     = 8
	pushMaxAuthLen     = 200
	pushMaxLabelRunes  = 80
)

// Subscription es una suscripción Web Push ya validada. Los instantes se
// expresan en milisegundos Unix. Las claves p256dh y auth nunca se serializan
// en una respuesta HTTP.
type Subscription struct {
	Endpoint  string
	P256DH    string
	Auth      string
	Label     string
	CreatedAt int64
	UpdatedAt int64
	ExpiresAt int64
}

// PushStore persiste suscripciones Web Push sin enviar notificaciones.
type PushStore interface {
	Upsert(ctx context.Context, subscription Subscription) error
	Delete(ctx context.Context, endpoint string) (bool, error)
	List(ctx context.Context) ([]Subscription, error)
}

// PostgresPushStore implementa PushStore sobre shadow.push_subscriptions con
// SQL parametrizado. No realiza llamadas de red ni envía push.
type PostgresPushStore struct {
	Pool *pgxpool.Pool
}

var _ PushStore = (*PostgresPushStore)(nil)

// Upsert guarda o reemplaza una suscripción por endpoint. La primera inserción
// fija created_at; un conflicto actualiza claves, etiqueta, updated_at y
// expires_at sin tocar created_at.
func (store *PostgresPushStore) Upsert(
	ctx context.Context,
	subscription Subscription,
) error {
	if store == nil || store.Pool == nil {
		return errors.New("edge: push store sin pool")
	}
	_, err := store.Pool.Exec(ctx, `
		INSERT INTO shadow.push_subscriptions
			(endpoint, p256dh, auth, label, created_at, updated_at, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (endpoint) DO UPDATE
		SET p256dh = EXCLUDED.p256dh,
		    auth = EXCLUDED.auth,
		    label = EXCLUDED.label,
		    updated_at = EXCLUDED.updated_at,
		    expires_at = EXCLUDED.expires_at`,
		subscription.Endpoint, subscription.P256DH, subscription.Auth,
		subscription.Label, subscription.CreatedAt, subscription.UpdatedAt,
		subscription.ExpiresAt,
	)
	if err != nil {
		return fmt.Errorf("edge: guardar suscripción push: %w", err)
	}
	return nil
}

// Delete elimina una suscripción por endpoint. Devuelve true si existía.
func (store *PostgresPushStore) Delete(
	ctx context.Context,
	endpoint string,
) (bool, error) {
	if store == nil || store.Pool == nil {
		return false, errors.New("edge: push store sin pool")
	}
	tag, err := store.Pool.Exec(ctx, `
		DELETE FROM shadow.push_subscriptions
		WHERE endpoint = $1`, endpoint)
	if err != nil {
		return false, fmt.Errorf("edge: eliminar suscripción push: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}

// List devuelve todas las suscripciones ordenadas por endpoint. La purga de
// filas expiradas queda fuera de este handler: aquí solo se guardan y listan
// endpoints, sin enviar push.
func (store *PostgresPushStore) List(ctx context.Context) ([]Subscription, error) {
	if store == nil || store.Pool == nil {
		return nil, errors.New("edge: push store sin pool")
	}
	rows, err := store.Pool.Query(ctx, `
		SELECT endpoint, p256dh, auth, label, created_at, updated_at, expires_at
		FROM shadow.push_subscriptions
		ORDER BY endpoint`)
	if err != nil {
		return nil, fmt.Errorf("edge: listar suscripciones push: %w", err)
	}
	defer rows.Close()

	subscriptions := make([]Subscription, 0)
	for rows.Next() {
		var subscription Subscription
		if err := rows.Scan(
			&subscription.Endpoint, &subscription.P256DH,
			&subscription.Auth, &subscription.Label,
			&subscription.CreatedAt, &subscription.UpdatedAt,
			&subscription.ExpiresAt,
		); err != nil {
			return nil, fmt.Errorf("edge: leer suscripción push: %w", err)
		}
		subscriptions = append(subscriptions, subscription)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("edge: listar suscripciones push: %w", err)
	}
	return subscriptions, nil
}

// PushSubscriptionsAPI administra las suscripciones Web Push del navegador.
// No envía notificaciones ni expone las claves de cifrado.
//
// Rutas:
//
//	GET    /api/push/subscriptions  cantidad y endpoints suscritos
//	POST   /api/push/subscriptions  alta o renovación de una suscripción
//	DELETE /api/push/subscriptions  baja por endpoint
//	GET    /api/push/public-key     clave VAPID pública
//
// Todas exigen cookie de sesión. Las mutaciones exigen además Origin permitido
// y CSRF de doble envío. Cualquier otra ruta responde 404 y un método no
// admitido responde 405 con Allow.
type PushSubscriptionsAPI struct {
	Sessions      *SessionManager
	Store         PushStore
	TrustedOrigin string
	Now           func() time.Time
	PublicKey     string
	TTL           time.Duration
}

type pushSubscriptionKeys struct {
	P256DH string `json:"p256dh"`
	Auth   string `json:"auth"`
}

// pushSubscriptionRequest admite el objeto estándar de PushSubscription
// ({endpoint, expirationTime, keys}) y también claves planas p256dh/auth.
type pushSubscriptionRequest struct {
	Endpoint string                `json:"endpoint"`
	P256DH   string                `json:"p256dh"`
	Auth     string                `json:"auth"`
	Label    string                `json:"label"`
	Keys     *pushSubscriptionKeys `json:"keys"`
}

type pushDeleteRequest struct {
	Endpoint string `json:"endpoint"`
}

type pushSubscriptionData struct {
	Endpoint string `json:"endpoint"`
}

type pushSubscriptionEnvelope struct {
	Data pushSubscriptionData `json:"data"`
}

type pushSubscriptionsData struct {
	Count     int      `json:"count"`
	Endpoints []string `json:"endpoints"`
}

type pushSubscriptionsEnvelope struct {
	Data pushSubscriptionsData `json:"data"`
}

type pushPublicKeyEnvelope struct {
	Data pushPublicKeyResponse `json:"data"`
}

func (api *PushSubscriptionsAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")

	switch r.URL.Path {
	case pushSubscriptionsPath:
		switch r.Method {
		case http.MethodGet:
			api.listSubscriptions(w, r)
		case http.MethodPost:
			api.createSubscription(w, r)
		case http.MethodDelete:
			api.deleteSubscription(w, r)
		default:
			w.Header().Set("Allow", "GET, POST, DELETE")
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
		}
	case pushPublicKeyPath:
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
			return
		}
		api.publicKey(w, r)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
	}
}

// createSubscription valida y guarda una suscripción. La respuesta solo
// devuelve el endpoint; las claves nunca salen del almacén.
func (api *PushSubscriptionsAPI) createSubscription(w http.ResponseWriter, r *http.Request) {
	cookie, ok := api.authenticated(r)
	if !ok {
		writePushUnauthenticated(w)
		return
	}
	if !api.mutationAllowed(w, r, cookie) {
		return
	}

	var request pushSubscriptionRequest
	if !decodePushBody(w, r, &request) {
		return
	}
	subscription, ok := buildPushSubscription(request, api.now(), api.ttl())
	if !ok {
		writePushInvalid(w)
		return
	}
	if api.Store == nil {
		writePushUnavailable(w)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), pushStoreTimeout)
	defer cancel()
	if err := api.Store.Upsert(ctx, subscription); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "No se pudo guardar la suscripción."})
		return
	}

	writeJSON(w, http.StatusCreated, pushSubscriptionEnvelope{
		Data: pushSubscriptionData{Endpoint: subscription.Endpoint},
	})
}

// deleteSubscription elimina la suscripción indicada. Un endpoint ausente en
// el almacén produce 404; un body inválido, 400.
func (api *PushSubscriptionsAPI) deleteSubscription(w http.ResponseWriter, r *http.Request) {
	cookie, ok := api.authenticated(r)
	if !ok {
		writePushUnauthenticated(w)
		return
	}
	if !api.mutationAllowed(w, r, cookie) {
		return
	}

	var request pushDeleteRequest
	if !decodePushBody(w, r, &request) {
		return
	}
	if !validPushEndpoint(request.Endpoint) {
		writePushInvalid(w)
		return
	}
	if api.Store == nil {
		writePushUnavailable(w)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), pushStoreTimeout)
	defer cancel()
	found, err := api.Store.Delete(ctx, request.Endpoint)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "No se pudo eliminar la suscripción."})
		return
	}
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "Suscripción no encontrada."})
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// listSubscriptions devuelve la cantidad y los endpoints suscritos, sin claves.
func (api *PushSubscriptionsAPI) listSubscriptions(w http.ResponseWriter, r *http.Request) {
	if _, ok := api.authenticated(r); !ok {
		writePushUnauthenticated(w)
		return
	}
	if api.Store == nil {
		writePushUnavailable(w)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), pushStoreTimeout)
	defer cancel()
	subscriptions, err := api.Store.List(ctx)
	if err != nil {
		writePushUnavailable(w)
		return
	}

	endpoints := make([]string, 0, len(subscriptions))
	for _, subscription := range subscriptions {
		endpoints = append(endpoints, subscription.Endpoint)
	}
	sort.Strings(endpoints)
	writeJSON(w, http.StatusOK, pushSubscriptionsEnvelope{
		Data: pushSubscriptionsData{Count: len(endpoints), Endpoints: endpoints},
	})
}

// publicKey publica la clave VAPID pública. Sin clave configurada responde 503
// para mantener push deshabilitado sin exponer detalles.
func (api *PushSubscriptionsAPI) publicKey(w http.ResponseWriter, r *http.Request) {
	if _, ok := api.authenticated(r); !ok {
		writePushUnauthenticated(w)
		return
	}
	key := strings.TrimSpace(api.PublicKey)
	if key == "" {
		writePushUnavailable(w)
		return
	}
	writeJSON(w, http.StatusOK, pushPublicKeyEnvelope{
		Data: pushPublicKeyResponse{PublicKey: key},
	})
}

// authenticated valida la cookie de sesión con el reloj configurado. Un
// SessionManager nil produce 401.
func (api *PushSubscriptionsAPI) authenticated(r *http.Request) (string, bool) {
	if api.Sessions == nil {
		return "", false
	}
	cookie, err := r.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		return "", false
	}
	if _, err := api.Sessions.Verify(cookie.Value, api.now()); err != nil {
		return "", false
	}
	return cookie.Value, true
}

// mutationAllowed exige el Origin configurado (o same-origin) y el CSRF ligado
// a la sesión. Ambos fallos comparten respuesta para no distinguir la causa.
func (api *PushSubscriptionsAPI) mutationAllowed(
	w http.ResponseWriter,
	r *http.Request,
	cookie string,
) bool {
	if !edgeOriginAllowed(r, api.TrustedOrigin) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "CSRF inválido."})
		return false
	}
	csrf := requestCSRFToken(r)
	if csrf == "" || api.Sessions == nil ||
		!api.Sessions.ValidateCSRF(cookie, csrf, api.now()) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "CSRF inválido."})
		return false
	}
	return true
}

func (api *PushSubscriptionsAPI) now() time.Time {
	if api.Now != nil {
		return api.Now()
	}
	return time.Now()
}

func (api *PushSubscriptionsAPI) ttl() time.Duration {
	if api.TTL > 0 {
		return api.TTL
	}
	return pushDefaultTTL
}

// buildPushSubscription combina claves anidadas o planas, valida rangos y fija
// los instantes en milisegundos. La expiración siempre la decide el servidor.
func buildPushSubscription(
	request pushSubscriptionRequest,
	now time.Time,
	ttl time.Duration,
) (Subscription, bool) {
	endpoint := request.Endpoint
	if !validPushEndpoint(endpoint) {
		return Subscription{}, false
	}

	p256dh, auth := request.P256DH, request.Auth
	if request.Keys != nil {
		if request.Keys.P256DH != "" {
			p256dh = request.Keys.P256DH
		}
		if request.Keys.Auth != "" {
			auth = request.Keys.Auth
		}
	}
	if len(p256dh) < pushMinP256DHLen || len(p256dh) > pushMaxP256DHLen {
		return Subscription{}, false
	}
	if len(auth) < pushMinAuthLen || len(auth) > pushMaxAuthLen {
		return Subscription{}, false
	}

	label := strings.TrimSpace(request.Label)
	if utf8.RuneCountInString(label) > pushMaxLabelRunes {
		return Subscription{}, false
	}
	if ttl <= 0 {
		ttl = pushDefaultTTL
	}

	createdAt := now.UnixMilli()
	return Subscription{
		Endpoint:  endpoint,
		P256DH:    p256dh,
		Auth:      auth,
		Label:     label,
		CreatedAt: createdAt,
		UpdatedAt: createdAt,
		ExpiresAt: now.Add(ttl).UnixMilli(),
	}, true
}

// validPushEndpoint exige una URL absoluta http/https de 10..2048 bytes, sin
// espacios en los extremos y con host.
func validPushEndpoint(endpoint string) bool {
	if len(endpoint) < pushMinEndpointLen || len(endpoint) > pushMaxEndpointLen {
		return false
	}
	if strings.TrimSpace(endpoint) != endpoint {
		return false
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" {
		return false
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https":
		return true
	default:
		return false
	}
}

// decodePushBody acota el cuerpo a 8 KiB, decodifica un único objeto JSON y
// rechaza datos extra. No expone el contenido recibido en los errores.
func decodePushBody(w http.ResponseWriter, r *http.Request, target any) bool {
	body := http.MaxBytesReader(w, r.Body, maxPushBodyBytes)
	defer body.Close()

	decoder := json.NewDecoder(body)
	if err := decoder.Decode(target); err != nil {
		writePushBodyError(w, err)
		return false
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			err = errors.New("edge: cuerpo JSON con datos extra")
		}
		writePushBodyError(w, err)
		return false
	}
	return true
}

func writePushBodyError(w http.ResponseWriter, err error) {
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "Cuerpo demasiado grande."})
		return
	}
	writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Solicitud inválida."})
}

func writePushUnauthenticated(w http.ResponseWriter) {
	writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Autenticación requerida."})
}

func writePushInvalid(w http.ResponseWriter) {
	writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Suscripción inválida."})
}

func writePushUnavailable(w http.ResponseWriter) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
}
