package edge

// Superficie HTTP de mutaciones shadow. Ninguna ruta de este archivo llama a
// QvaPay ni mueve dinero: con Enabled=false todas responden 503 y, con la
// bandera activa, cada petición se limita a registrarse en shadow.mutation_events
// o shadow.chat_messages. La integración HTTP real se hace en cmd/edge.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/trading-core/internal/runtimeconfig"
)

const (
	// mutationsMaxBodyBytes acota cualquier cuerpo JSON de la superficie de
	// mutaciones. Un cuerpo mayor se rechaza sin cargarlo entero en memoria.
	mutationsMaxBodyBytes = 32 << 10
	// mutationsChatListLimit es el número de mensajes devuelto por el chat.
	mutationsChatListLimit = 100
	// mutationsMaxChatRunes replica el máximo del contrato del chat web/móvil.
	mutationsMaxChatRunes = 599

	// Mensajes literales del contrato HTTP. El primero es el que distingue la
	// bandera apagada de cualquier otro fallo.
	mutationsDisabledError = "Mutaciones deshabilitadas; requieren ventana de cutover."
	mutationsStorageError  = "Almacenamiento shadow no disponible."
	mutationsPaymentError  = "El pago asistido requiere QvaPay en vivo."
)

// MutationStore persiste la evidencia de las mutaciones y el chat shadow.
// CooperativeClient es el subconjunto del sincronizador que usan las
// mutaciones. La interfaz permite probar publicación y retirada sin red.
type CooperativeClient interface {
	Enabled() bool
	Publish(ctx context.Context, coin string, fiat, minimal, price float64) error
	Withdraw(ctx context.Context, coin string) error
	Refresh(ctx context.Context) error
}

// MarketConfigLoader carga la configuración vigente para tomar el precio de
// compra y el fiat del mercado.
type MarketConfigLoader interface {
	Load(ctx context.Context) (runtimeconfig.Config, int64, error)
}

type MutationStore interface {
	Record(ctx context.Context, action, target string, payload []byte, actor string, now int64) error
	SaveMessage(ctx context.Context, message ChatMessage) error
	ListMessages(ctx context.Context, operationUUID string, limit int) ([]ChatMessage, error)
}

// ChatMessage es un mensaje del chat sombra. OrderUUID y AttemptID pueden ir
// vacíos; el resto identifica el hilo y el intento de envío.
// LiveMutations ejecuta mutaciones reales contra QvaPay. Si es nil, el edge
// conserva el modo shadow y solo registra intenciones.
type LiveMutations interface {
	CreateOffer(ctx context.Context, payload map[string]any) (map[string]any, error)
	EditOffer(ctx context.Context, offerUUID string, payload map[string]any) error
	CancelOffer(ctx context.Context, offerUUID, order string) error
	MarkPaid(ctx context.Context, offerUUID, order, txID string) error
	ConfirmReceived(ctx context.Context, offerUUID, order string) error
}

// OperationRecord es la vista mínima de una operación local para aplicar
// acciones y contabilizar fiat.
type OperationRecord struct {
	UUID      string
	OfferType string
	Coin      string
	State     string
	OrderUUID string
	Amount    float64
	Receive   float64
	Rate      float64
}

// OperationStore lee y actualiza las operaciones locales.
type OperationStore interface {
	Get(ctx context.Context, uuid string) (OperationRecord, bool, error)
	SetState(ctx context.Context, uuid, state string, now int64) error
}

// FiatMover registra los movimientos fiat de una operación. Es idempotente por
// clave (orden o UUID de oferta).
type FiatMover interface {
	DebitOperation(ctx context.Context, operation OperationRecord, key, source string, now int64) error
	CreditOperation(ctx context.Context, operation OperationRecord, key, source string, now int64) error
	ReverseOperation(ctx context.Context, operation OperationRecord, key, source string, now int64) error
}

// LiveChat ejecuta el chat real de QvaPay. Si es nil, el chat es local.
type LiveChat interface {
	ListChat(ctx context.Context, operationUUID, order string) ([]ChatMessage, error)
	SendChat(ctx context.Context, operationUUID, order, message string) (ChatMessage, error)
}

type ChatMessage struct {
	ID            string `json:"id"`
	OperationUUID string `json:"operationUuid"`
	OrderUUID     string `json:"orderUuid"`
	Message       string `json:"message"`
	AttemptID     string `json:"attemptId"`
	Direction     string `json:"direction"`
	CreatedAt     int64  `json:"createdAt"`
}

// MutationsAPI expone el resto de la superficie HTTP del panel y de la app
// móvil en modo shadow. Enabled es false por defecto: mientras no exista una
// ventana de cutover, ninguna ruta muta ni registra nada.
//
// Las rutas web exigen cookie de sesión y, para los verbos que escriben, Origin
// permitido y CSRF de doble envío. Las móviles exigen Bearer de operador con
// scope read. Store nil responde 503. Now permite inyectar el reloj en pruebas.
type MutationsAPI struct {
	Enabled       bool
	Sessions      *SessionManager
	MobileAuth    *MobileAuthAPI
	Store         MutationStore
	Live          LiveMutations
	Chat          LiveChat
	Reconcile     *Reconciler
	Operations    OperationStore
	Fiat          FiatMover
	Cooperative   CooperativeClient
	Runtime       MarketConfigLoader
	Settings      SettingStore
	TrustedOrigin string
	Now           func() time.Time
}

// PostgresMutationStore implementa MutationStore sobre las tablas shadow de la
// migración 0017. Solo escribe evidencia: no toca el libro de operaciones ni
// ningún estado del monolito TS.
type PostgresMutationStore struct {
	Pool *pgxpool.Pool
}

var _ MutationStore = (*PostgresMutationStore)(nil)

// Record guarda un evento con un identificador nuevo. Un payload vacío o que no
// sea JSON se sustituye por un objeto vacío para no romper la columna jsonb.
func (store *PostgresMutationStore) Record(
	ctx context.Context,
	action, target string,
	payload []byte,
	actor string,
	now int64,
) error {
	if store == nil || store.Pool == nil {
		return errors.New("edge: mutation store sin pool")
	}
	payload = mutationPayload(payload)
	id, err := mobileAdminNewUUID()
	if err != nil {
		return err
	}
	_, err = store.Pool.Exec(ctx, `
		INSERT INTO shadow.mutation_events (id, action, target, payload_json, actor, created_at)
		VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
		id, action, target, string(payload), actor, now)
	return err
}

// SaveMessage persiste un mensaje del chat. Los campos opcionales vacíos se
// almacenan como NULL.
func (store *PostgresMutationStore) SaveMessage(ctx context.Context, message ChatMessage) error {
	if store == nil || store.Pool == nil {
		return errors.New("edge: mutation store sin pool")
	}
	_, err := store.Pool.Exec(ctx, `
		INSERT INTO shadow.chat_messages
			(id, operation_uuid, order_uuid, message, attempt_id, direction, created_at)
		VALUES ($1, $2, NULLIF($3, ''), $4, NULLIF($5, ''), $6, $7)`,
		message.ID, message.OperationUUID, message.OrderUUID, message.Message,
		message.AttemptID, message.Direction, message.CreatedAt)
	return err
}

// ListMessages devuelve los mensajes de una operación en orden cronológico. El
// límite se acota para que una petición no pueda pedir el hilo completo.
func (store *PostgresMutationStore) ListMessages(
	ctx context.Context,
	operationUUID string,
	limit int,
) ([]ChatMessage, error) {
	if store == nil || store.Pool == nil {
		return nil, errors.New("edge: mutation store sin pool")
	}
	if limit <= 0 {
		limit = mutationsChatListLimit
	}
	if limit > 200 {
		limit = 200
	}
	rows, err := store.Pool.Query(ctx, `
		SELECT id, operation_uuid, COALESCE(order_uuid, ''), message,
		       COALESCE(attempt_id, ''), direction, created_at
		FROM shadow.chat_messages
		WHERE operation_uuid = $1
		ORDER BY created_at ASC, id ASC
		LIMIT $2`, operationUUID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	messages := make([]ChatMessage, 0)
	for rows.Next() {
		var message ChatMessage
		if err := rows.Scan(
			&message.ID, &message.OperationUUID, &message.OrderUUID,
			&message.Message, &message.AttemptID, &message.Direction,
			&message.CreatedAt,
		); err != nil {
			return nil, err
		}
		messages = append(messages, message)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return messages, nil
}

// mutationKind identifica cada ruta reconocida antes de comprobar el método y
// la autenticación.
type mutationKind int

const (
	mutationContributionSet mutationKind = iota
	mutationContributionDelete
	mutationHuntingSet
	mutationCooperativeReconcile
	mutationExecutionsCheck
	mutationExecutionDistributed
	mutationOfferCreate
	mutationOfferUpdate
	mutationOfferDelete
	mutationRebalancePreview
	mutationRebalanceApply
	mutationOperationAction
	mutationWorkflowReconcile
	mutationBlockedPreview
	mutationBlockedApply
	mutationRecoveryCheck
	mutationRecoveryResolve
	mutationChatGet
	mutationChatSendStatus
	mutationChatImageGet
	mutationChatSend
	mutationChatMarkRead
	mutationChatImageSend
	mutationPaymentReceipt
	mutationPaymentPreview
)

// mutationRoute es la ruta resuelta. id es el uuid, moneda, intención o
// workflow; action solo se usa en /operations/{uuid}/{action}.
type mutationRoute struct {
	kind      mutationKind
	id        string
	action    string
	attemptID string
	messageID string
	mobile    bool
}

var mutationCoinPattern = regexp.MustCompile(`^[A-Z0-9_]{2,40}$`)

func (api *MutationsAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// La cabecera se fija antes de cualquier respuesta, incluido el 503 de la
	// bandera apagada.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")

	if !api.Enabled {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": mutationsDisabledError,
		})
		return
	}

	route, ok := mutationResolveRoute(r.URL.Path)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
		return
	}
	if !mutationRouteAllows(route.kind, r.Method) {
		w.Header().Set("Allow", mutationRouteAllow(route.kind))
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
		return
	}
	// La vista previa de pago siempre responde 503 y no necesita almacenamiento.
	if route.kind != mutationPaymentPreview && api.Store == nil {
		writeMutationStorageUnavailable(w)
		return
	}

	actor, ok := api.authorize(w, r, route)
	if !ok {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), statsTimeout)
	defer cancel()

	switch route.kind {
	case mutationContributionSet:
		api.setContribution(ctx, w, r, actor)
	case mutationContributionDelete:
		api.deleteContribution(ctx, w, r, route.id, actor)
	case mutationHuntingSet:
		api.setHunting(ctx, w, r, actor)
	case mutationCooperativeReconcile:
		api.cooperativeReconcile(ctx, w, r, actor)
	case mutationExecutionsCheck:
		api.executionsCheck(ctx, w, r, actor)
	case mutationExecutionDistributed:
		api.executionDistributed(ctx, w, r, route.id, actor)
	case mutationOfferCreate:
		api.createOffer(ctx, w, r, actor)
	case mutationOfferUpdate:
		if r.Method == http.MethodDelete {
			api.deleteOffer(ctx, w, r, route.id, actor)
			return
		}
		api.updateOffer(ctx, w, r, route.id, actor)
	case mutationOfferDelete:
		api.deleteOffer(ctx, w, r, route.id, actor)
	case mutationRebalancePreview:
		api.rebalancePreview(ctx, w, r, actor)
	case mutationRebalanceApply:
		api.rebalanceApply(ctx, w, r, actor)
	case mutationOperationAction:
		api.operationAction(ctx, w, r, route, actor)
	case mutationWorkflowReconcile:
		api.workflowReconcile(ctx, w, r, route.id, actor)
	case mutationBlockedPreview:
		api.blockedPreview(ctx, w, r, route.id, actor)
	case mutationBlockedApply:
		api.blockedApply(ctx, w, r, route.id, actor)
	case mutationRecoveryCheck:
		api.recoveryCheck(ctx, w, r, route.id, actor)
	case mutationRecoveryResolve:
		api.recoveryResolve(ctx, w, r, route.id, actor)
	case mutationChatGet:
		if r.Method == http.MethodPost {
			api.chatSend(ctx, w, r, route.id, actor)
			return
		}
		api.chatGet(ctx, w, r, route.id)
	case mutationChatSendStatus:
		api.chatSendStatus(w, route.attemptID)
	case mutationChatImageGet:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "Imagen no encontrada."})
	case mutationChatSend:
		api.chatSend(ctx, w, r, route.id, actor)
	case mutationChatMarkRead:
		api.chatMarkRead(ctx, w, r, route.id, actor)
	case mutationChatImageSend:
		api.chatImageSend(ctx, w, r, route.id, actor)
	case mutationPaymentReceipt:
		api.paymentReceipt(ctx, w, r, actor)
	case mutationPaymentPreview:
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": mutationsPaymentError})
	}
}

// authorize aplica el esquema web (cookie, Origin y CSRF) o el Bearer móvil.
// Devuelve el actor que se guarda en shadow.mutation_events.
func (api *MutationsAPI) authorize(
	w http.ResponseWriter,
	r *http.Request,
	route mutationRoute,
) (string, bool) {
	if route.mobile {
		if api.MobileAuth == nil {
			writeJSON(w, http.StatusUnauthorized, mobileAuthErrorResponse{
				Error: mobileOperatorCredentialError,
			})
			return "", false
		}
		if r.Method == http.MethodGet {
			if !api.MobileAuth.AuthorizeRead(w, r) {
				return "", false
			}
			return "mobile", true
		}
		operatorID, ok := api.MobileAuth.AuthorizeOperatorRead(w, r)
		if !ok {
			return "", false
		}
		if operatorID == "" {
			operatorID = "mobile"
		}
		return operatorID, true
	}

	cookie, ok := api.webSession(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Autenticación requerida."})
		return "", false
	}
	if r.Method != http.MethodGet {
		if !edgeOriginAllowed(r, api.TrustedOrigin) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "Origen de solicitud no autorizado."})
			return "", false
		}
		csrf := requestCSRFToken(r)
		if csrf == "" || api.Sessions == nil ||
			!api.Sessions.ValidateCSRF(cookie, csrf, api.now()) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "CSRF inválido."})
			return "", false
		}
	}
	return "panel", true
}

// webSession valida la cookie de sesión y devuelve su valor para el CSRF.
func (api *MutationsAPI) webSession(r *http.Request) (string, bool) {
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

// mutationResolveRoute reconoce las rutas de la superficie. La comprobación del
// método se hace después para poder responder 405 con Allow.
func mutationResolveRoute(path string) (mutationRoute, bool) {
	switch path {
	case "/api/cooperative-network/contributions":
		return mutationRoute{kind: mutationContributionSet}, true
	case "/api/cooperative-network/hunting":
		return mutationRoute{kind: mutationHuntingSet}, true
	case "/api/cooperative-network/reconcile":
		return mutationRoute{kind: mutationCooperativeReconcile}, true
	case "/api/cooperative-network/executions/check":
		return mutationRoute{kind: mutationExecutionsCheck}, true
	case "/api/offers":
		return mutationRoute{kind: mutationOfferCreate}, true
	case "/api/offers/rebalance/preview":
		return mutationRoute{kind: mutationRebalancePreview}, true
	case "/api/offers/rebalance/apply":
		return mutationRoute{kind: mutationRebalanceApply}, true
	case "/api/mobile/payment-receipts":
		return mutationRoute{kind: mutationPaymentReceipt, mobile: true}, true
	}

	if coin, ok := mutationSingleSegment(path, "/api/cooperative-network/contributions/"); ok {
		return mutationRoute{kind: mutationContributionDelete, id: coin}, true
	}
	if uuid, ok := mutationSuffixSegment(
		path, "/api/cooperative-network/executions/", "/distributed",
	); ok {
		return mutationRoute{kind: mutationExecutionDistributed, id: uuid}, true
	}
	if uuid, ok := mutationSingleSegment(path, "/api/offers/"); ok {
		return mutationRoute{kind: mutationOfferUpdate, id: uuid}, true
	}
	if uuid, ok := mutationSuffixSegment(path, "/api/workflows/", "/reconcile"); ok {
		return mutationRoute{kind: mutationWorkflowReconcile, id: uuid}, true
	}
	if uuid, action, ok := mutationTwoSegments(path, "/api/blocked-offers/"); ok {
		switch action {
		case "preview":
			return mutationRoute{kind: mutationBlockedPreview, id: uuid}, true
		case "apply":
			return mutationRoute{kind: mutationBlockedApply, id: uuid}, true
		}
		return mutationRoute{}, false
	}
	if intentID, action, ok := mutationTwoSegments(path, "/api/recovery/"); ok {
		switch action {
		case "check":
			return mutationRoute{kind: mutationRecoveryCheck, id: intentID}, true
		case "resolve":
			return mutationRoute{kind: mutationRecoveryResolve, id: intentID}, true
		}
		return mutationRoute{}, false
	}
	if route, ok := mutationOperationRoute(path, "/api/operations/", false); ok {
		return route, true
	}
	if route, ok := mutationOperationRoute(path, "/api/mobile/operations/", true); ok {
		return route, true
	}
	return mutationRoute{}, false
}

// mutationOperationRoute reconoce el chat y las acciones de operación para el
// prefijo web o móvil. El pedido de pago móvil se resuelve antes que la acción
// genérica para que GET no termine en un 405.
func mutationOperationRoute(path, prefix string, mobile bool) (mutationRoute, bool) {
	rest, ok := strings.CutPrefix(path, prefix)
	if !ok || rest == "" {
		return mutationRoute{}, false
	}
	parts := strings.Split(rest, "/")
	if len(parts) == 0 || !mutationIDValid(parts[0]) {
		return mutationRoute{}, false
	}
	uuid := parts[0]

	switch {
	case len(parts) == 2 && parts[1] == "chat":
		return mutationRoute{kind: mutationChatGet, id: uuid, mobile: mobile}, true
	case len(parts) == 4 && parts[1] == "chat" && parts[2] == "sends":
		if !mutationIDValid(parts[3]) {
			return mutationRoute{}, false
		}
		return mutationRoute{
			kind: mutationChatSendStatus, id: uuid, attemptID: parts[3], mobile: mobile,
		}, true
	case len(parts) == 4 && parts[1] == "chat" && parts[2] == "images":
		if !mutationIDValid(parts[3]) {
			return mutationRoute{}, false
		}
		return mutationRoute{
			kind: mutationChatImageGet, id: uuid, messageID: parts[3], mobile: mobile,
		}, true
	case len(parts) == 3 && parts[1] == "chat" && parts[2] == "read":
		return mutationRoute{kind: mutationChatMarkRead, id: uuid, mobile: mobile}, true
	case len(parts) == 3 && parts[1] == "chat" && parts[2] == "images":
		return mutationRoute{kind: mutationChatImageSend, id: uuid, mobile: mobile}, true
	case len(parts) == 2 && parts[1] == "payment-preview":
		if !mobile {
			return mutationRoute{}, false
		}
		return mutationRoute{kind: mutationPaymentPreview, id: uuid, mobile: true}, true
	case len(parts) == 2 && parts[1] != "":
		return mutationRoute{
			kind: mutationOperationAction, id: uuid, action: parts[1], mobile: mobile,
		}, true
	}
	return mutationRoute{}, false
}

// mutationSingleSegment devuelve el único segmento que sigue a prefix.
func mutationSingleSegment(path, prefix string) (string, bool) {
	rest, ok := strings.CutPrefix(path, prefix)
	if !ok || !mutationIDValid(rest) || strings.Contains(rest, "/") {
		return "", false
	}
	return rest, true
}

// mutationSuffixSegment reconoce prefix + id + suffix con un id sin barras.
func mutationSuffixSegment(path, prefix, suffix string) (string, bool) {
	rest, ok := strings.CutPrefix(path, prefix)
	if !ok {
		return "", false
	}
	id, ok := strings.CutSuffix(rest, suffix)
	if !ok || !mutationIDValid(id) || strings.Contains(id, "/") {
		return "", false
	}
	return id, true
}

// mutationTwoSegments reconoce prefix + primer + segundo con ambos no vacíos.
func mutationTwoSegments(path, prefix string) (string, string, bool) {
	rest, ok := strings.CutPrefix(path, prefix)
	if !ok || rest == "" {
		return "", "", false
	}
	first, second, ok := strings.Cut(rest, "/")
	if !ok || !mutationIDValid(first) || !mutationIDValid(second) ||
		strings.Contains(second, "/") {
		return "", "", false
	}
	return first, second, true
}

// mutationIDValid acota un identificador de ruta sin permitir segmentos vacíos,
// puntos ni valores desmesurados.
func mutationIDValid(value string) bool {
	if value == "" || value == "." || value == ".." {
		return false
	}
	return utf8.RuneCountInString(value) <= 200
}

func mutationRouteAllows(kind mutationKind, method string) bool {
	switch kind {
	case mutationContributionSet, mutationHuntingSet:
		return method == http.MethodPut
	case mutationContributionDelete, mutationOfferDelete:
		return method == http.MethodDelete
	case mutationOfferUpdate:
		return method == http.MethodPut || method == http.MethodDelete
	case mutationChatGet:
		return method == http.MethodGet || method == http.MethodPost
	case mutationChatSendStatus, mutationChatImageGet, mutationPaymentPreview:
		return method == http.MethodGet
	default:
		return method == http.MethodPost
	}
}

func mutationRouteAllow(kind mutationKind) string {
	switch kind {
	case mutationContributionSet, mutationHuntingSet:
		return http.MethodPut
	case mutationContributionDelete, mutationOfferDelete:
		return http.MethodDelete
	case mutationOfferUpdate:
		return "PUT, DELETE"
	case mutationChatGet:
		return "GET, POST"
	case mutationChatSendStatus, mutationChatImageGet, mutationPaymentPreview:
		return http.MethodGet
	default:
		return http.MethodPost
	}
}

func (api *MutationsAPI) now() time.Time {
	if api.Now != nil {
		return api.Now()
	}
	return time.Now()
}

// record persiste un evento. Si falla, responde 503 antes de que el handler
// escriba un éxito que no quedó registrado.
func (api *MutationsAPI) record(
	ctx context.Context,
	w http.ResponseWriter,
	action, target string,
	payload []byte,
	actor string,
) bool {
	if api.Store == nil {
		writeMutationStorageUnavailable(w)
		return false
	}
	payload = mutationPayload(payload)
	if err := api.Store.Record(ctx, action, target, payload, actor, api.now().UnixMilli()); err != nil {
		writeMutationStorageUnavailable(w)
		return false
	}
	return true
}

func writeMutationStorageUnavailable(w http.ResponseWriter) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": mutationsStorageError})
}

func writeMutationNoContent(w http.ResponseWriter) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusNoContent)
}

// mutationReadBody lee el cuerpo acotado. Un cuerpo mayor responde 413 y un
// error de lectura responde 400, sin reflejar el contenido.
func mutationReadBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	if r.Body == nil {
		return nil, true
	}
	body := http.MaxBytesReader(w, r.Body, mutationsMaxBodyBytes)
	raw, err := io.ReadAll(body)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{
				"error": "Solicitud demasiado grande.",
			})
			return nil, false
		}
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Cuerpo inválido."})
		return nil, false
	}
	return raw, true
}

// mutationDecodeBody valida y deserializa el cuerpo. allowEmpty permite que las
// rutas sin cuerpo admitan una petición vacía.
func mutationDecodeBody(w http.ResponseWriter, raw []byte, target any, allowEmpty bool) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		if allowEmpty {
			return true
		}
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Cuerpo vacío."})
		return false
	}
	if err := json.Unmarshal(trimmed, target); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "JSON inválido."})
		return false
	}
	return true
}

// mutationOptionalJSON exige JSON válido cuando hay cuerpo, pero no impone una
// forma concreta a las rutas que no reciben datos.
func mutationOptionalJSON(w http.ResponseWriter, raw []byte) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return true
	}
	if !json.Valid(trimmed) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "JSON inválido."})
		return false
	}
	return true
}

// mutationPayload garantiza que la columna jsonb recibe un documento válido.
func mutationPayload(raw []byte) []byte {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || !json.Valid(trimmed) {
		return []byte("{}")
	}
	return trimmed
}

func mutationValueInvalid(value float64, positive bool) bool {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return true
	}
	if positive {
		return value <= 0
	}
	return value < 0
}

func (api *MutationsAPI) setContribution(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	actor string,
) {
	raw, ok := mutationReadBody(w, r)
	if !ok {
		return
	}
	var body struct {
		Coin    string  `json:"coin"`
		Minimal float64 `json:"minimal"`
	}
	if !mutationDecodeBody(w, raw, &body, false) {
		return
	}
	coin := strings.ToUpper(strings.TrimSpace(body.Coin))
	if !mutationCoinPattern.MatchString(coin) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Mercado inválido."})
		return
	}
	if mutationValueInvalid(body.Minimal, true) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Cantidad mínima inválida."})
		return
	}
	if api.Cooperative == nil || !api.Cooperative.Enabled() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "Sincronizador no conectado."})
		return
	}
	if api.Runtime == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "Configuración no disponible."})
		return
	}
	config, _, err := api.Runtime.Load(ctx)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "Configuración no disponible."})
		return
	}
	var market *runtimeconfig.Market
	for index := range config.Markets {
		if strings.EqualFold(config.Markets[index].Code, coin) {
			market = &config.Markets[index]
			break
		}
	}
	if market == nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Mercado no configurado."})
		return
	}
	price := market.BuyMaxRate
	fiat := math.Floor(market.FiatBalance*100) / 100
	if price <= 0 || fiat < 5*price {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": "El saldo del mercado equivale a menos de 5 QUSD al precio de compra.",
		})
		return
	}
	if err := api.Cooperative.Publish(ctx, coin, fiat, body.Minimal, price); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	if !api.record(ctx, w, "cooperative_contribution_set", coin, raw, actor) {
		return
	}
	writeMutationNoContent(w)
}

func (api *MutationsAPI) deleteContribution(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	coin string,
	actor string,
) {
	if !mutationCoinPattern.MatchString(coin) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Mercado inválido."})
		return
	}
	payload, _ := json.Marshal(map[string]string{"coin": coin})
	if api.Cooperative == nil || !api.Cooperative.Enabled() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "Sincronizador no conectado."})
		return
	}
	if err := api.Cooperative.Withdraw(ctx, coin); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	if !api.record(ctx, w, "cooperative_contribution_withdraw", coin, payload, actor) {
		return
	}
	writeMutationNoContent(w)
}

func (api *MutationsAPI) setHunting(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	actor string,
) {
	raw, ok := mutationReadBody(w, r)
	if !ok {
		return
	}
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if !mutationDecodeBody(w, raw, &body, false) {
		return
	}
	if body.Enabled == nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Estado inválido."})
		return
	}
	if api.Settings != nil {
		encoded, _ := json.Marshal(*body.Enabled)
		if err := api.Settings.PutSetting(ctx, "cooperative_hunting_enabled", encoded, api.now().UnixMilli()); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "No se pudo guardar el estado."})
			return
		}
	}
	if !api.record(ctx, w, "cooperative_hunting_set", "", raw, actor) {
		return
	}
	writeMutationNoContent(w)
}

func (api *MutationsAPI) cooperativeReconcile(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	actor string,
) {
	raw, ok := mutationReadBody(w, r)
	if !ok || !mutationOptionalJSON(w, raw) {
		return
	}
	if api.Cooperative == nil || !api.Cooperative.Enabled() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "Sincronizador no conectado."})
		return
	}
	if err := api.Cooperative.Refresh(ctx); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	if !api.record(ctx, w, "cooperative_network_reconcile", "", raw, actor) {
		return
	}
	writeMutationNoContent(w)
}

func (api *MutationsAPI) executionsCheck(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	actor string,
) {
	raw, ok := mutationReadBody(w, r)
	if !ok || !mutationOptionalJSON(w, raw) {
		return
	}
	if !api.record(ctx, w, "cooperative_executions_check", "", raw, actor) {
		return
	}
	writeMutationNoContent(w)
}

func (api *MutationsAPI) executionDistributed(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	uuid string,
	actor string,
) {
	raw, ok := mutationReadBody(w, r)
	if !ok {
		return
	}
	var body struct {
		Confirmed *bool `json:"confirmed"`
	}
	if !mutationDecodeBody(w, raw, &body, false) {
		return
	}
	if body.Confirmed == nil || !*body.Confirmed {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Confirmación requerida."})
		return
	}
	if !api.record(ctx, w, "cooperative_execution_distributed", uuid, raw, actor) {
		return
	}
	writeMutationNoContent(w)
}

func (api *MutationsAPI) createOffer(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	actor string,
) {
	raw, ok := mutationReadBody(w, r)
	if !ok {
		return
	}
	var body struct {
		Coin   string  `json:"coin"`
		Type   string  `json:"type"`
		Amount float64 `json:"amount"`
		Rate   float64 `json:"rate"`
	}
	if !mutationDecodeBody(w, raw, &body, false) {
		return
	}
	coin := strings.TrimSpace(body.Coin)
	if !mutationCoinPattern.MatchString(coin) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Mercado inválido."})
		return
	}
	if body.Type != "buy" && body.Type != "sell" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Tipo de oferta inválido."})
		return
	}
	if mutationValueInvalid(body.Amount, true) || mutationValueInvalid(body.Rate, true) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Oferta inválida."})
		return
	}
	uuid, err := mobileAdminNewUUID()
	if err != nil {
		writeMutationStorageUnavailable(w)
		return
	}
	execution := "shadow"
	if api.Live != nil {
		var payload map[string]any
		if err := json.Unmarshal(raw, &payload); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Oferta inválida."})
			return
		}
		if _, ok := payload["receive"]; !ok {
			payload["receive"] = body.Amount * body.Rate
		}
		if _, ok := payload["idempotency_key"]; !ok {
			payload["idempotency_key"] = uuid
		}
		result, err := api.Live.CreateOffer(ctx, payload)
		if err != nil {
			_ = api.Store.Record(ctx, "offer_create_failed", uuid, mutationPayload(raw), actor, api.now().UnixMilli())
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": "QvaPay rechazó la creación de la oferta."})
			return
		}
		if remote, ok := result["uuid"].(string); ok && remote != "" {
			uuid = remote
		}
		execution = "qvapay"
	}
	if !api.record(ctx, w, "offer_created", uuid, raw, actor) {
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"data": map[string]any{
			"execution": execution,
			"uuid":      uuid,
			"coin":      coin,
			"type":      body.Type,
			"amount":    body.Amount,
			"receive":   body.Amount * body.Rate,
			"rate":      body.Rate,
			"status":    "open",
		},
	})
}

func (api *MutationsAPI) updateOffer(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	uuid string,
	actor string,
) {
	raw, ok := mutationReadBody(w, r)
	if !ok {
		return
	}
	var body struct {
		Amount *float64 `json:"amount"`
		Rate   *float64 `json:"rate"`
	}
	if !mutationDecodeBody(w, raw, &body, false) {
		return
	}
	if body.Amount == nil && body.Rate == nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Sin cambios."})
		return
	}
	if body.Amount != nil && mutationValueInvalid(*body.Amount, true) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Importe inválido."})
		return
	}
	if body.Rate != nil && mutationValueInvalid(*body.Rate, true) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Tasa inválida."})
		return
	}
	if api.Live != nil {
		var payload map[string]any
		if err := json.Unmarshal(raw, &payload); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Oferta inválida."})
			return
		}
		if err := api.Live.EditOffer(ctx, uuid, payload); err != nil {
			_ = api.Store.Record(ctx, "offer_update_failed", uuid, mutationPayload(raw), actor, api.now().UnixMilli())
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": "QvaPay rechazó la edición de la oferta."})
			return
		}
	}
	if !api.record(ctx, w, "offer_updated", uuid, raw, actor) {
		return
	}
	writeMutationNoContent(w)
}

func (api *MutationsAPI) deleteOffer(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	uuid string,
	actor string,
) {
	payload, _ := json.Marshal(map[string]string{"uuid": uuid})
	if api.Live != nil {
		if err := api.Live.CancelOffer(ctx, uuid, r.URL.Query().Get("order")); err != nil {
			_ = api.Store.Record(ctx, "offer_cancel_failed", uuid, payload, actor, api.now().UnixMilli())
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": "QvaPay rechazó la cancelación de la oferta."})
			return
		}
	}
	if !api.record(ctx, w, "offer_cancelled", uuid, payload, actor) {
		return
	}
	writeMutationNoContent(w)
}

func (api *MutationsAPI) rebalancePreview(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	actor string,
) {
	raw, ok := mutationReadBody(w, r)
	if !ok {
		return
	}
	var body struct {
		Refresh *bool `json:"refresh"`
	}
	if !mutationDecodeBody(w, raw, &body, true) {
		return
	}
	if !api.record(ctx, w, "offer_rebalance_preview", "", raw, actor) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"data": map[string]any{
			"plans":     []any{},
			"execution": "shadow",
		},
	})
}

func (api *MutationsAPI) rebalanceApply(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	actor string,
) {
	raw, ok := mutationReadBody(w, r)
	if !ok {
		return
	}
	var body struct {
		Adjustments []json.RawMessage `json:"adjustments"`
	}
	if !mutationDecodeBody(w, raw, &body, false) {
		return
	}
	if len(body.Adjustments) == 0 || len(body.Adjustments) > 100 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Ajustes inválidos."})
		return
	}
	for _, adjustment := range body.Adjustments {
		var item struct {
			UUID   string   `json:"uuid"`
			Amount *float64 `json:"amount"`
		}
		if err := json.Unmarshal(adjustment, &item); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Ajustes inválidos."})
			return
		}
		if strings.TrimSpace(item.UUID) == "" || utf8.RuneCountInString(item.UUID) > 100 ||
			item.Amount == nil || mutationValueInvalid(*item.Amount, true) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Ajustes inválidos."})
			return
		}
	}
	id, err := mobileAdminNewUUID()
	if err != nil {
		writeMutationStorageUnavailable(w)
		return
	}
	if !api.record(ctx, w, "offer_rebalance_apply", id, raw, actor) {
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"data": map[string]any{
			"id":          id,
			"state":       "pending",
			"adjustments": body.Adjustments,
			"execution":   "shadow",
		},
	})
}

func (api *MutationsAPI) operationAction(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	route mutationRoute,
	actor string,
) {
	switch route.action {
	case "ack":
		if route.mobile {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Acción de operación inválida."})
			return
		}
	case "paid", "received", "cancel":
	default:
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Acción de operación inválida."})
		return
	}

	raw, ok := mutationReadBody(w, r)
	if !ok {
		return
	}
	var body struct {
		Reference *string `json:"reference"`
	}
	if !mutationDecodeBody(w, raw, &body, true) {
		return
	}
	reference := ""
	if body.Reference != nil {
		reference = strings.TrimSpace(*body.Reference)
		if reference == "" || utf8.RuneCountInString(reference) > 200 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "La referencia del pago es inválida."})
			return
		}
	}
	if api.Live != nil && route.action != "ack" {
		order := r.URL.Query().Get("order")
		var operation OperationRecord
		var found bool
		if api.Operations != nil {
			loaded, exists, err := api.Operations.Get(ctx, route.id)
			if err != nil {
				_ = api.Store.Record(ctx, "operation_lookup_failed", route.id, mutationPayload(raw), actor, api.now().UnixMilli())
				writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "No se pudo leer la operación."})
				return
			}
			operation, found = loaded, exists
		}
		if found {
			switch route.action {
			case "paid":
				if operation.OfferType != "sell" || (operation.State != "applied" && operation.State != "acknowledged") {
					writeJSON(w, http.StatusConflict, map[string]any{"error": "La operación no permite marcar pago en su estado actual."})
					return
				}
			case "received":
				if operation.OfferType != "buy" ||
					(operation.State != "applied" && operation.State != "acknowledged" && operation.State != "paid") {
					writeJSON(w, http.StatusConflict, map[string]any{"error": "La operación no permite confirmar recepción en su estado actual."})
					return
				}
			}
			if order == "" && operation.OrderUUID != "" {
				order = operation.OrderUUID
			}
		}
		var err error
		switch route.action {
		case "paid":
			if reference == "" {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": "La referencia del pago es obligatoria."})
				return
			}
			err = api.Live.MarkPaid(ctx, route.id, order, reference)
		case "received":
			err = api.Live.ConfirmReceived(ctx, route.id, order)
		case "cancel":
			err = api.Live.CancelOffer(ctx, route.id, order)
		}
		if err != nil {
			_ = api.Store.Record(ctx, "operation_"+route.action+"_failed", route.id, mutationPayload(raw), actor, api.now().UnixMilli())
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": "QvaPay rechazó la operación."})
			return
		}
		if found {
			if err := api.afterOperationAction(ctx, operation, route.action, actor); err != nil {
				_ = api.Store.Record(ctx, "operation_fiat_failed", route.id, mutationPayload(raw), actor, api.now().UnixMilli())
				writeJSON(w, http.StatusBadGateway, map[string]any{"error": "La operación se aplicó, pero no se pudo registrar el saldo fiat."})
				return
			}
		}
	}
	if !api.record(ctx, w, "operation_"+route.action, route.id, raw, actor) {
		return
	}
	writeMutationNoContent(w)
}

// afterOperationAction persiste el estado local y el movimiento fiat. El
// ledger es idempotente: un reintento no duplica el débito ni el crédito.
func (api *MutationsAPI) afterOperationAction(
	ctx context.Context,
	operation OperationRecord,
	action, actor string,
) error {
	now := api.now().UnixMilli()
	key := operation.OrderUUID
	if key == "" {
		key = operation.UUID
	}
	source := "Acción " + action + " desde el panel (" + actor + ")"
	// El movimiento fiat va primero: si falla, el estado local se queda en el
	// valor anterior y la acción puede reintentarse. El ledger es idempotente,
	// así que un reintento no duplica el débito/crédito.
	if api.Fiat != nil {
		switch {
		case action == "paid" && operation.OfferType == "sell":
			if err := api.Fiat.DebitOperation(ctx, operation, key, source, now); err != nil {
				return err
			}
		case action == "received" && operation.OfferType == "buy":
			if err := api.Fiat.CreditOperation(ctx, operation, key, source, now); err != nil {
				return err
			}
		case action == "cancel" && operation.OfferType == "sell" && operation.State == "paid":
			if err := api.Fiat.ReverseOperation(ctx, operation, "reversal:"+key, source, now); err != nil {
				return err
			}
		}
	}
	if api.Operations == nil {
		return nil
	}
	state := operation.State
	switch action {
	case "paid":
		state = "paid"
	case "received":
		state = "completed"
	case "cancel":
		state = "cancelled"
	}
	if state == operation.State {
		return nil
	}
	return api.Operations.SetState(ctx, operation.UUID, state, now)
}

func (api *MutationsAPI) workflowReconcile(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	workflowID string,
	actor string,
) {
	raw, ok := mutationReadBody(w, r)
	if !ok || !mutationOptionalJSON(w, raw) {
		return
	}
	payload, _ := json.Marshal(map[string]string{"workflowId": workflowID})
	if api.Reconcile != nil {
		report, err := api.Reconcile.Check(ctx, workflowID, r.URL.Query().Get("order"))
		if err != nil {
			_ = api.Store.Record(ctx, "workflow_reconcile_failed", workflowID, payload, actor, api.now().UnixMilli())
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": "No se pudo conciliar con QvaPay."})
			return
		}
		if !api.record(ctx, w, "workflow_reconcile", workflowID, payload, actor) {
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
			"workflowId": workflowID, "report": report, "execution": "qvapay",
		}})
		return
	}
	if !api.record(ctx, w, "workflow_reconcile", workflowID, payload, actor) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"data": map[string]any{
			"workflowId": workflowID,
			"state":      "shadow_reconciled",
			"execution":  "shadow",
		},
	})
}

func (api *MutationsAPI) blockedPreview(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	uuid string,
	actor string,
) {
	raw, ok := mutationReadBody(w, r)
	if !ok || !mutationOptionalJSON(w, raw) {
		return
	}
	payload, _ := json.Marshal(map[string]string{"uuid": uuid})
	if !api.record(ctx, w, "blocked_offer_preview", uuid, payload, actor) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"data": map[string]any{
			"uuid":                 uuid,
			"coin":                 "",
			"offerType":            "",
			"amount":               0,
			"receive":              0,
			"rate":                 0,
			"referenceRate":        nil,
			"deviationPercent":     0,
			"plannedCancellations": []any{},
			"liquidityReason":      "Vista shadow sin QvaPay en vivo.",
			"execution":            "shadow",
		},
	})
}

func (api *MutationsAPI) blockedApply(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	uuid string,
	actor string,
) {
	raw, ok := mutationReadBody(w, r)
	if !ok {
		return
	}
	var body struct {
		OverridePriceGuard *bool `json:"overridePriceGuard"`
	}
	if !mutationDecodeBody(w, raw, &body, false) {
		return
	}
	if body.OverridePriceGuard == nil || !*body.OverridePriceGuard {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Confirmación requerida."})
		return
	}
	if !api.record(ctx, w, "blocked_offer_apply", uuid, raw, actor) {
		return
	}
	writeMutationNoContent(w)
}

func (api *MutationsAPI) recoveryCheck(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	intentID string,
	actor string,
) {
	raw, ok := mutationReadBody(w, r)
	if !ok || !mutationOptionalJSON(w, raw) {
		return
	}
	if !api.record(ctx, w, "recovery_check", intentID, raw, actor) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"data": map[string]any{
			"intentId":  intentID,
			"checkedAt": api.now().UnixMilli(),
			"outcome":   "shadow_review",
			"state":     "uncertain",
			"message":   "Comprobación shadow: no se ejecutaron compensaciones.",
			"retry":     nil,
		},
	})
}

func (api *MutationsAPI) recoveryResolve(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	intentID string,
	actor string,
) {
	raw, ok := mutationReadBody(w, r)
	if !ok {
		return
	}
	var body struct {
		ExpectedUpdatedAt *int64 `json:"expectedUpdatedAt"`
		Outcome           string `json:"outcome"`
		Reason            string `json:"reason"`
		Evidence          string `json:"evidence"`
		Confirmed         *bool  `json:"confirmed"`
	}
	if !mutationDecodeBody(w, raw, &body, false) {
		return
	}
	if body.ExpectedUpdatedAt == nil || *body.ExpectedUpdatedAt < 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Comprobación inválida."})
		return
	}
	switch body.Outcome {
	case "not_applied", "cancelled", "terminal_reviewed":
	default:
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Resultado inválido."})
		return
	}
	reason := strings.TrimSpace(body.Reason)
	evidence := strings.TrimSpace(body.Evidence)
	if utf8.RuneCountInString(reason) < 12 || utf8.RuneCountInString(reason) > 500 ||
		utf8.RuneCountInString(evidence) < 12 || utf8.RuneCountInString(evidence) > 1_000 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Comprobación inválida."})
		return
	}
	if body.Confirmed == nil || !*body.Confirmed {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Confirmación requerida."})
		return
	}
	if !api.record(ctx, w, "recovery_resolve", intentID, raw, actor) {
		return
	}
	writeMutationNoContent(w)
}

func (api *MutationsAPI) chatGet(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	operationUUID string,
) {
	var messages []ChatMessage
	var err error
	if api.Chat != nil {
		messages, err = api.Chat.ListChat(ctx, operationUUID, strings.TrimSpace(r.URL.Query().Get("order")))
	} else {
		messages, err = api.Store.ListMessages(ctx, operationUUID, mutationsChatListLimit)
	}
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "Chat no disponible."})
		return
	}
	if messages == nil {
		messages = []ChatMessage{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"data": map[string]any{
			"operation":   map[string]string{"uuid": operationUUID},
			"messages":    messages,
			"unreadCount": 0,
		},
	})
}

func (api *MutationsAPI) chatSendStatus(w http.ResponseWriter, attemptID string) {
	writeJSON(w, http.StatusOK, map[string]any{
		"data": map[string]any{
			"attemptId": attemptID,
			"state":     "sent",
			"execution": "shadow",
		},
	})
}

func (api *MutationsAPI) chatSend(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	operationUUID string,
	actor string,
) {
	raw, ok := mutationReadBody(w, r)
	if !ok {
		return
	}
	var body struct {
		Message   string  `json:"message"`
		AttemptID *string `json:"attemptId"`
	}
	if !mutationDecodeBody(w, raw, &body, false) {
		return
	}
	message := strings.TrimSpace(body.Message)
	if utf8.RuneCountInString(message) < 1 || utf8.RuneCountInString(message) > mutationsMaxChatRunes {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Mensaje inválido."})
		return
	}
	attemptID := ""
	if body.AttemptID != nil {
		attemptID = strings.TrimSpace(*body.AttemptID)
		if utf8.RuneCountInString(attemptID) > 80 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Intento inválido."})
			return
		}
	}
	orderUUID := strings.TrimSpace(r.URL.Query().Get("order"))
	if utf8.RuneCountInString(orderUUID) > 100 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Orden inválida."})
		return
	}
	id, err := mobileAdminNewUUID()
	if err != nil {
		writeMutationStorageUnavailable(w)
		return
	}
	if api.Chat != nil {
		remote, err := api.Chat.SendChat(ctx, operationUUID, orderUUID, message)
		if err != nil {
			_ = api.Store.Record(ctx, "chat_send_failed", operationUUID, mutationPayload(raw), actor, api.now().UnixMilli())
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": "QvaPay rechazó el mensaje."})
			return
		}
		if remote.ID != "" {
			id = remote.ID
		}
	}
	chatMessage := ChatMessage{
		ID:            id,
		OperationUUID: operationUUID,
		OrderUUID:     orderUUID,
		Message:       message,
		AttemptID:     attemptID,
		Direction:     "out",
		CreatedAt:     api.now().UnixMilli(),
	}
	if err := api.Store.SaveMessage(ctx, chatMessage); err != nil {
		writeMutationStorageUnavailable(w)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"data": map[string]any{"message": chatMessage},
	})
}

func (api *MutationsAPI) chatMarkRead(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	operationUUID string,
	actor string,
) {
	raw, ok := mutationReadBody(w, r)
	if !ok {
		return
	}
	var body struct {
		IDs []string `json:"ids"`
	}
	if !mutationDecodeBody(w, raw, &body, true) {
		return
	}
	if len(body.IDs) > 100 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Marcas inválidas."})
		return
	}
	for _, id := range body.IDs {
		if utf8.RuneCountInString(id) > 256 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Marcas inválidas."})
			return
		}
	}
	payload, _ := json.Marshal(map[string]string{"operationUuid": operationUUID})
	if !api.record(ctx, w, "chat_read", operationUUID, payload, actor) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"data": map[string]any{"unreadCount": 0},
	})
}

func (api *MutationsAPI) chatImageSend(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	operationUUID string,
	actor string,
) {
	// No se parsea multipart ni se guarda la imagen: solo se acusa el envío y
	// se deja constancia del tamaño en shadow.
	raw, ok := mutationReadBody(w, r)
	if !ok {
		return
	}
	id, err := mobileAdminNewUUID()
	if err != nil {
		writeMutationStorageUnavailable(w)
		return
	}
	payload, _ := json.Marshal(map[string]any{
		"messageId":     id,
		"operationUuid": operationUUID,
		"bytes":         len(raw),
	})
	if !api.record(ctx, w, "chat_image_uploaded", operationUUID, payload, actor) {
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"data": map[string]any{
			"message": map[string]string{
				"id":            id,
				"operationUuid": operationUUID,
			},
			"execution": "shadow",
		},
	})
}

func (api *MutationsAPI) paymentReceipt(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	actor string,
) {
	raw, ok := mutationReadBody(w, r)
	if !ok {
		return
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || !json.Valid(trimmed) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Comprobante inválido."})
		return
	}
	id, err := mobileAdminNewUUID()
	if err != nil {
		writeMutationStorageUnavailable(w)
		return
	}
	receivedAt := api.now().UnixMilli()
	if !api.record(ctx, w, "payment_receipt_received", id, raw, actor) {
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"data": map[string]any{
			"receipt": map[string]any{
				"id":         id,
				"status":     "pending",
				"receivedAt": receivedAt,
			},
			"duplicate": false,
		},
	})
}
