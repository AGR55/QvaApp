package edge

// Administración de credenciales móviles desde el panel web. Empareja y revoca
// dispositivos y operadores, y registra el token de notificaciones del chat.
// Las mutaciones exigen cookie de sesión, Origin confiable y CSRF; las lecturas
// solo cookie. /api/mobile/push-device usa exclusivamente el Bearer del
// operador, igual que la APK Android.

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// Rutas servidas por MobileAdminAPI.
	mobileAdminDevicesPath    = "/api/mobile/devices"
	mobileAdminOperatorsPath  = "/api/mobile/operators"
	mobileAdminPushDevicePath = "/api/mobile/push-device"

	mobileAdminDevicePrefix   = "/api/mobile/devices/"
	mobileAdminOperatorPrefix = "/api/mobile/operators/"

	// maxMobileAdminFileBytes acota los snapshots leídos del disco.
	maxMobileAdminFileBytes = 8 << 20
	// mobileAdminMaxBodyBytes acota el cuerpo JSON de las mutaciones.
	mobileAdminMaxBodyBytes = 8 << 10
	// mobileAdminMaxLabelRunes es la longitud máxima de una etiqueta.
	mobileAdminMaxLabelRunes = 80

	// Mensajes copiados del contrato HTTP del monolito TS.
	mobileAdminDeviceInvalidError   = "Nombre de dispositivo inválido."
	mobileAdminDeviceNotFoundError  = "Dispositivo no encontrado o ya revocado."
	mobileAdminOperatorNotFound     = "Operador no encontrado o ya revocado."
	mobileAdminPushTokenInvalid     = "Token de notificación inválido."
	mobileAdminOperatorUnauthorized = "Operador móvil no autorizado."
)

// mobileAdminPushTokenPattern valida el alfabeto del token FCM. La longitud
// 20..4096 se comprueba aparte porque Go limita las repeticiones de regexp a
// 1000.
var mobileAdminPushTokenPattern = regexp.MustCompile(`^[A-Za-z0-9_:.-]+$`)

func mobileAdminPushTokenValid(token string) bool {
	return len(token) >= 20 && len(token) <= 4096 &&
		mobileAdminPushTokenPattern.MatchString(token)
}

var (
	errMobileAdminFileTooLarge = errors.New("edge: snapshot móvil demasiado grande")
	errMobileAdminFileInvalid  = errors.New("edge: snapshot móvil inválido")
)

// MobileAdminAPI administra dispositivos y operadores móviles. Store es la
// persistencia; DashboardFile y OperatorsFile son los snapshots públicos que se
// combinan con la base de datos. MobileAuth valida el Bearer del operador en
// /api/mobile/push-device. Now permite inyectar el reloj en las pruebas; nil usa
// time.Now.
type MobileAdminAPI struct {
	Sessions      *SessionManager
	Store         MobileCredentialStore
	MobileAuth    *MobileAuthAPI
	DashboardFile string
	OperatorsFile string
	TrustedOrigin string
	Now           func() time.Time
}

type mobileAdminEnvelope struct {
	Data any `json:"data"`
}

type mobileAdminPairDevice struct {
	Device MobileDevice `json:"device"`
	Token  string       `json:"token"`
}

type mobileAdminPairOperator struct {
	Operator MobileOperator `json:"operator"`
	Token    string         `json:"token"`
}

// mobileAdminFileDevice es la proyección pública almacenada en
// dashboard-snapshot.json. revokedAt se conserva en crudo para aceptar números
// o cadenas sin fallar.
type mobileAdminFileDevice struct {
	ID        string          `json:"id"`
	Label     string          `json:"label"`
	CreatedAt int64           `json:"createdAt"`
	RevokedAt json.RawMessage `json:"revokedAt"`
}

type mobileAdminDashboardSnapshot struct {
	Devices []mobileAdminFileDevice `json:"devices"`
}

// mobileAdminFileOperator es la proyección pública almacenada en
// operators.json.
type mobileAdminFileOperator struct {
	ID        string          `json:"id"`
	Label     string          `json:"label"`
	Scopes    []string        `json:"scopes"`
	CreatedAt int64           `json:"createdAt"`
	RevokedAt json.RawMessage `json:"revokedAt"`
}

// mobileAdminRouteKind identifica la familia de ruta antes de autenticar.
type mobileAdminRouteKind int

const (
	mobileAdminRouteDevices mobileAdminRouteKind = iota
	mobileAdminRouteDevice
	mobileAdminRouteOperators
	mobileAdminRouteOperator
	mobileAdminRoutePush
)

func (api *MobileAdminAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")

	kind, id, ok := mobileAdminResolveRoute(r.URL.Path)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
		return
	}

	switch kind {
	case mobileAdminRouteDevice:
		if r.Method != http.MethodDelete {
			writeMobileAdminMethodNotAllowed(w, http.MethodDelete)
			return
		}
		api.deleteDevice(w, r, id)
	case mobileAdminRouteOperator:
		if r.Method != http.MethodDelete {
			writeMobileAdminMethodNotAllowed(w, http.MethodDelete)
			return
		}
		api.deleteOperator(w, r, id)
	case mobileAdminRoutePush:
		if r.Method != http.MethodPost && r.Method != http.MethodDelete {
			writeMobileAdminMethodNotAllowed(w, "POST, DELETE")
			return
		}
		api.servePushDevice(w, r)
	case mobileAdminRouteDevices:
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			writeMobileAdminMethodNotAllowed(w, "GET, POST")
			return
		}
		api.serveDevices(w, r)
	case mobileAdminRouteOperators:
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			writeMobileAdminMethodNotAllowed(w, "GET, POST")
			return
		}
		api.serveOperators(w, r)
	}
}

// mobileAdminResolveRoute reconoce las rutas administradas. Un id vacío, con
// separadores o con la ruta incompleta no es una ruta válida y termina en 404.
func mobileAdminResolveRoute(path string) (mobileAdminRouteKind, string, bool) {
	switch path {
	case mobileAdminDevicesPath:
		return mobileAdminRouteDevices, "", true
	case mobileAdminOperatorsPath:
		return mobileAdminRouteOperators, "", true
	case mobileAdminPushDevicePath:
		return mobileAdminRoutePush, "", true
	}
	if id, ok := mobileAdminRouteID(path, mobileAdminDevicePrefix); ok {
		return mobileAdminRouteDevice, id, true
	}
	if id, ok := mobileAdminRouteID(path, mobileAdminOperatorPrefix); ok {
		return mobileAdminRouteOperator, id, true
	}
	return 0, "", false
}

func mobileAdminRouteID(path, prefix string) (string, bool) {
	if !strings.HasPrefix(path, prefix) {
		return "", false
	}
	id := strings.TrimPrefix(path, prefix)
	if id == "" || strings.Contains(id, "/") || len(id) > 200 {
		return "", false
	}
	return id, true
}

func writeMobileAdminMethodNotAllowed(w http.ResponseWriter, allow string) {
	w.Header().Set("Allow", allow)
	writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
}

// authenticated valida la cookie de sesión y devuelve su valor para el
// double-submit de CSRF. Un SessionManager nil también produce false.
func (api *MobileAdminAPI) authenticated(r *http.Request) (string, bool) {
	if api.Sessions == nil {
		return "", false
	}
	cookie, err := r.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		return "", false
	}
	_, err = api.Sessions.Verify(cookie.Value, api.now())
	return cookie.Value, err == nil
}

// mutationAllowed exige Origin confiable y CSRF ligado a la sesión.
func (api *MobileAdminAPI) mutationAllowed(w http.ResponseWriter, r *http.Request, cookie string) bool {
	if !edgeOriginAllowed(r, api.TrustedOrigin) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "Origen de solicitud no autorizado."})
		return false
	}
	csrf := requestCSRFToken(r)
	if csrf == "" || api.Sessions == nil || !api.Sessions.ValidateCSRF(cookie, csrf, api.now()) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "CSRF inválido."})
		return false
	}
	return true
}

func (api *MobileAdminAPI) serveDevices(w http.ResponseWriter, r *http.Request) {
	cookie, authenticated := api.authenticated(r)
	if !authenticated {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"status": "unauthenticated"})
		return
	}
	if r.Method == http.MethodGet {
		api.listDevices(w, r)
		return
	}
	if !api.mutationAllowed(w, r, cookie) {
		return
	}
	api.createDevice(w, r)
}

func (api *MobileAdminAPI) serveOperators(w http.ResponseWriter, r *http.Request) {
	cookie, authenticated := api.authenticated(r)
	if !authenticated {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"status": "unauthenticated"})
		return
	}
	if r.Method == http.MethodGet {
		api.listOperators(w, r)
		return
	}
	if !api.mutationAllowed(w, r, cookie) {
		return
	}
	api.createOperator(w, r)
}

func (api *MobileAdminAPI) listDevices(w http.ResponseWriter, r *http.Request) {
	if api.Store == nil {
		writeMobileAdminUnavailable(w)
		return
	}
	devices := make([]MobileDevice, 0)
	if api.DashboardFile != "" {
		fileDevices, err := mobileAdminReadDashboardDevices(api.DashboardFile)
		if err != nil {
			writeMobileAdminUnavailable(w)
			return
		}
		devices = append(devices, fileDevices...)
	}
	ctx, cancel := mobileAdminContext(r)
	defer cancel()
	stored, err := api.Store.Devices(ctx)
	if err != nil {
		writeMobileAdminUnavailable(w)
		return
	}
	devices = append(devices, stored...)
	writeJSON(w, http.StatusOK, mobileAdminEnvelope{Data: mobileAdminMergeDevices(devices)})
}

func (api *MobileAdminAPI) listOperators(w http.ResponseWriter, r *http.Request) {
	if api.Store == nil {
		writeMobileAdminUnavailable(w)
		return
	}
	operators := make([]MobileOperator, 0)
	if api.OperatorsFile != "" {
		fileOperators, err := mobileAdminReadOperators(api.OperatorsFile)
		if err != nil {
			writeMobileAdminUnavailable(w)
			return
		}
		operators = append(operators, fileOperators...)
	}
	ctx, cancel := mobileAdminContext(r)
	defer cancel()
	stored, err := api.Store.Operators(ctx)
	if err != nil {
		writeMobileAdminUnavailable(w)
		return
	}
	operators = append(operators, stored...)
	writeJSON(w, http.StatusOK, mobileAdminEnvelope{Data: mobileAdminMergeOperators(operators)})
}

func (api *MobileAdminAPI) createDevice(w http.ResponseWriter, r *http.Request) {
	label, ok := mobileAdminDecodeLabel(w, r)
	if !ok {
		return
	}
	token, err := mobileAdminRandomToken(32)
	if err != nil {
		writeMobileAdminUnavailable(w)
		return
	}
	id, err := mobileAdminNewUUID()
	if err != nil {
		writeMobileAdminUnavailable(w)
		return
	}
	now := api.now()
	device := MobileDevice{
		ID:        id,
		Label:     label,
		TokenHash: mobileAuthDigestHex(token),
		CreatedAt: now.UnixMilli(),
	}
	ctx, cancel := mobileAdminContext(r)
	defer cancel()
	if err := api.Store.CreateDevice(ctx, device); err != nil {
		writeMobileAdminUnavailable(w)
		return
	}
	writeJSON(w, http.StatusCreated, mobileAdminEnvelope{
		Data: mobileAdminPairDevice{Device: device, Token: token},
	})
}

func (api *MobileAdminAPI) createOperator(w http.ResponseWriter, r *http.Request) {
	label, ok := mobileAdminDecodeLabel(w, r)
	if !ok {
		return
	}
	token, err := mobileAdminRandomToken(36)
	if err != nil {
		writeMobileAdminUnavailable(w)
		return
	}
	id, err := mobileAdminNewUUID()
	if err != nil {
		writeMobileAdminUnavailable(w)
		return
	}
	now := api.now()
	operator := MobileOperator{
		ID:        id,
		Label:     label,
		TokenHash: mobileAuthDigestHex(token),
		Scopes:    []string{"read", "actions"},
		CreatedAt: now.UnixMilli(),
	}
	ctx, cancel := mobileAdminContext(r)
	defer cancel()
	if err := api.Store.CreateOperator(ctx, operator); err != nil {
		writeMobileAdminUnavailable(w)
		return
	}
	writeJSON(w, http.StatusCreated, mobileAdminEnvelope{
		Data: mobileAdminPairOperator{Operator: operator, Token: token},
	})
}

func (api *MobileAdminAPI) deleteDevice(w http.ResponseWriter, r *http.Request, id string) {
	cookie, authenticated := api.authenticated(r)
	if !authenticated {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"status": "unauthenticated"})
		return
	}
	if !api.mutationAllowed(w, r, cookie) {
		return
	}
	if api.Store == nil {
		writeMobileAdminUnavailable(w)
		return
	}
	ctx, cancel := mobileAdminContext(r)
	defer cancel()
	revoked, err := api.Store.RevokeDevice(ctx, id, api.now().UnixMilli())
	if err != nil {
		writeMobileAdminUnavailable(w)
		return
	}
	if !revoked {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": mobileAdminDeviceNotFoundError})
		return
	}
	writeMobileAdminNoContent(w)
}

func (api *MobileAdminAPI) deleteOperator(w http.ResponseWriter, r *http.Request, id string) {
	cookie, authenticated := api.authenticated(r)
	if !authenticated {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"status": "unauthenticated"})
		return
	}
	if !api.mutationAllowed(w, r, cookie) {
		return
	}
	if api.Store == nil {
		writeMobileAdminUnavailable(w)
		return
	}
	ctx, cancel := mobileAdminContext(r)
	defer cancel()
	revoked, err := api.Store.RevokeOperator(ctx, id, api.now().UnixMilli())
	if err != nil {
		writeMobileAdminUnavailable(w)
		return
	}
	if !revoked {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": mobileAdminOperatorNotFound})
		return
	}
	writeMobileAdminNoContent(w)
}

// servePushDevice valida solo el Bearer del operador. No usa cookie, Origin ni
// CSRF: la APK Android no participa del patrón double-submit del panel.
func (api *MobileAdminAPI) servePushDevice(w http.ResponseWriter, r *http.Request) {
	if api.MobileAuth == nil {
		writeJSON(w, http.StatusUnauthorized, mobileAuthErrorResponse{
			Error: mobileOperatorCredentialError,
		})
		return
	}
	operatorID, ok := api.MobileAuth.AuthorizeOperatorRead(w, r)
	if !ok {
		return
	}
	if operatorID == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": mobileAdminOperatorUnauthorized})
		return
	}
	if api.Store == nil {
		writeMobileAdminUnavailable(w)
		return
	}
	ctx, cancel := mobileAdminContext(r)
	defer cancel()

	if r.Method == http.MethodDelete {
		if err := api.Store.DeleteChatPushDevice(ctx, operatorID); err != nil {
			writeMobileAdminUnavailable(w)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}

	var body struct {
		Token string `json:"token"`
	}
	if !mobileAdminDecodeBody(w, r, &body) {
		return
	}
	if !mobileAdminPushTokenValid(body.Token) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": mobileAdminPushTokenInvalid})
		return
	}
	if err := api.Store.PutChatPushDevice(ctx, operatorID, body.Token, api.now().UnixMilli()); err != nil {
		writeMobileAdminUnavailable(w)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "operatorId": operatorID})
}

// mobileAdminDecodeLabel valida la etiqueta 1..80 exigida por el contrato.
func mobileAdminDecodeLabel(w http.ResponseWriter, r *http.Request) (string, bool) {
	var body struct {
		Label string `json:"label"`
	}
	if !mobileAdminDecodeBody(w, r, &body) {
		return "", false
	}
	label := strings.TrimSpace(body.Label)
	if label == "" || utf8.RuneCountInString(label) > mobileAdminMaxLabelRunes {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": mobileAdminDeviceInvalidError})
		return "", false
	}
	return label, true
}

// mobileAdminDecodeBody lee un JSON acotado. El detalle del error nunca se
// escribe en la respuesta.
func mobileAdminDecodeBody(w http.ResponseWriter, r *http.Request, target any) bool {
	body := http.MaxBytesReader(w, r.Body, mobileAdminMaxBodyBytes)
	raw, err := io.ReadAll(body)
	if err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "Cuerpo demasiado grande."})
		return false
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Cuerpo vacío."})
		return false
	}
	if err := json.Unmarshal(raw, target); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "JSON inválido."})
		return false
	}
	return true
}

func (api *MobileAdminAPI) now() time.Time {
	if api.Now != nil {
		return api.Now()
	}
	return time.Now()
}

func mobileAdminContext(r *http.Request) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), 5*time.Second)
}

func writeMobileAdminUnavailable(w http.ResponseWriter) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
}

func writeMobileAdminNoContent(w http.ResponseWriter) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusNoContent)
}

// mobileAdminRandomToken genera el token en Base64 URL sin relleno. El token
// solo se devuelve al crear la credencial; solo se persiste su hash.
func mobileAdminRandomToken(size int) (string, error) {
	raw := make([]byte, size)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// mobileAdminNewUUID genera un UUID v4 con crypto/rand.
func mobileAdminNewUUID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x",
		raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16]), nil
}

// mobileAdminReadDashboardDevices lee la lista pública de dispositivos. Un
// archivo ausente o vacío equivale a una lista vacía.
func mobileAdminReadDashboardDevices(path string) ([]MobileDevice, error) {
	var snapshot mobileAdminDashboardSnapshot
	if err := mobileAdminReadJSON(path, '{', &snapshot); err != nil {
		return nil, err
	}
	devices := make([]MobileDevice, 0, len(snapshot.Devices))
	for _, device := range snapshot.Devices {
		if device.ID == "" {
			continue
		}
		devices = append(devices, MobileDevice{
			ID:        device.ID,
			Label:     device.Label,
			CreatedAt: device.CreatedAt,
			RevokedAt: mobileAdminRevokedAt(device.RevokedAt),
		})
	}
	return devices, nil
}

// mobileAdminReadOperators lee el arreglo público de operadores.
func mobileAdminReadOperators(path string) ([]MobileOperator, error) {
	var fileOperators []mobileAdminFileOperator
	if err := mobileAdminReadJSON(path, '[', &fileOperators); err != nil {
		return nil, err
	}
	operators := make([]MobileOperator, 0, len(fileOperators))
	for _, operator := range fileOperators {
		if operator.ID == "" {
			continue
		}
		scopes := operator.Scopes
		if scopes == nil {
			scopes = []string{}
		}
		operators = append(operators, MobileOperator{
			ID:        operator.ID,
			Label:     operator.Label,
			Scopes:    scopes,
			CreatedAt: operator.CreatedAt,
			RevokedAt: mobileAdminRevokedAt(operator.RevokedAt),
		})
	}
	return operators, nil
}

// mobileAdminReadJSON aplica el límite de tamaño y valida el primer byte del
// valor antes de deserializarlo.
func mobileAdminReadJSON(path string, first byte, target any) error {
	file, err := os.Open(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}
	defer file.Close()

	raw, err := io.ReadAll(io.LimitReader(file, maxMobileAdminFileBytes+1))
	if err != nil {
		return err
	}
	if len(raw) > maxMobileAdminFileBytes {
		return errMobileAdminFileTooLarge
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil
	}
	if trimmed[0] != first || !json.Valid(trimmed) {
		return errMobileAdminFileInvalid
	}
	if err := json.Unmarshal(trimmed, target); err != nil {
		return errMobileAdminFileInvalid
	}
	return nil
}

// mobileAdminRevokedAt convierte revokedAt a puntero Unix en milisegundos.
// null o ausente significa vigente. Un valor no reconocido se conserva como
// revocado con marca 0 para no reactivar una credencial por error de formato.
func mobileAdminRevokedAt(raw json.RawMessage) *int64 {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}
	var integer int64
	if err := json.Unmarshal(trimmed, &integer); err == nil {
		return &integer
	}
	var decimal float64
	if err := json.Unmarshal(trimmed, &decimal); err == nil {
		value := int64(decimal)
		return &value
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err == nil {
		if integer, err := time.Parse(time.RFC3339, text); err == nil {
			value := integer.UnixMilli()
			return &value
		}
	}
	value := int64(0)
	return &value
}

// mobileAdminMergeDevices deduplica por id y ordena por createdAt descendente.
// La base de datos se añade después del archivo, por lo que su estado (por
// ejemplo, una revocación) prevalece.
func mobileAdminMergeDevices(devices []MobileDevice) []MobileDevice {
	byID := make(map[string]MobileDevice, len(devices))
	for _, device := range devices {
		if device.ID == "" {
			continue
		}
		byID[device.ID] = device
	}
	merged := make([]MobileDevice, 0, len(byID))
	for _, device := range byID {
		merged = append(merged, device)
	}
	sort.Slice(merged, func(i, j int) bool {
		if merged[i].CreatedAt != merged[j].CreatedAt {
			return merged[i].CreatedAt > merged[j].CreatedAt
		}
		return merged[i].ID < merged[j].ID
	})
	return merged
}

// mobileAdminMergeOperators deduplica por id y ordena por createdAt
// descendente, con la base de datos como fuente autoritativa.
func mobileAdminMergeOperators(operators []MobileOperator) []MobileOperator {
	byID := make(map[string]MobileOperator, len(operators))
	for _, operator := range operators {
		if operator.ID == "" {
			continue
		}
		byID[operator.ID] = operator
	}
	merged := make([]MobileOperator, 0, len(byID))
	for _, operator := range byID {
		merged = append(merged, operator)
	}
	sort.Slice(merged, func(i, j int) bool {
		if merged[i].CreatedAt != merged[j].CreatedAt {
			return merged[i].CreatedAt > merged[j].CreatedAt
		}
		return merged[i].ID < merged[j].ID
	})
	return merged
}

// PostgresMobileCredentialStore persiste las credenciales móviles con SQL
// parametrizado. El pool debe apuntar a una base con la migración 0017 aplicada.
type PostgresMobileCredentialStore struct {
	Pool *pgxpool.Pool
}

func (store *PostgresMobileCredentialStore) Devices(ctx context.Context) ([]MobileDevice, error) {
	if store == nil || store.Pool == nil {
		return nil, errors.New("edge: mobile credential store sin pool")
	}
	rows, err := store.Pool.Query(ctx, `
		SELECT id, label, created_at, revoked_at
		FROM shadow.mobile_devices
		ORDER BY created_at DESC, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	devices := make([]MobileDevice, 0)
	for rows.Next() {
		var device MobileDevice
		var revoked pgtype.Int8
		if err := rows.Scan(&device.ID, &device.Label, &device.CreatedAt, &revoked); err != nil {
			return nil, err
		}
		if revoked.Valid {
			value := revoked.Int64
			device.RevokedAt = &value
		}
		devices = append(devices, device)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return devices, nil
}

func (store *PostgresMobileCredentialStore) Operators(ctx context.Context) ([]MobileOperator, error) {
	if store == nil || store.Pool == nil {
		return nil, errors.New("edge: mobile credential store sin pool")
	}
	rows, err := store.Pool.Query(ctx, `
		SELECT id, label, scopes, created_at, revoked_at
		FROM shadow.mobile_operators
		ORDER BY created_at DESC, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	operators := make([]MobileOperator, 0)
	for rows.Next() {
		var operator MobileOperator
		var scopes []byte
		var revoked pgtype.Int8
		if err := rows.Scan(&operator.ID, &operator.Label, &scopes, &operator.CreatedAt, &revoked); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(scopes, &operator.Scopes); err != nil {
			return nil, err
		}
		if operator.Scopes == nil {
			operator.Scopes = []string{}
		}
		if revoked.Valid {
			value := revoked.Int64
			operator.RevokedAt = &value
		}
		operators = append(operators, operator)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return operators, nil
}

func (store *PostgresMobileCredentialStore) CreateDevice(ctx context.Context, device MobileDevice) error {
	if store == nil || store.Pool == nil {
		return errors.New("edge: mobile credential store sin pool")
	}
	_, err := store.Pool.Exec(ctx, `
		INSERT INTO shadow.mobile_devices (id, label, token_hash, created_at)
		VALUES ($1, $2, $3, $4)`,
		device.ID, device.Label, device.TokenHash, device.CreatedAt)
	return err
}

func (store *PostgresMobileCredentialStore) CreateOperator(ctx context.Context, operator MobileOperator) error {
	if store == nil || store.Pool == nil {
		return errors.New("edge: mobile credential store sin pool")
	}
	scopes, err := json.Marshal(operator.Scopes)
	if err != nil {
		return err
	}
	_, err = store.Pool.Exec(ctx, `
		INSERT INTO shadow.mobile_operators (id, label, token_hash, scopes, created_at)
		VALUES ($1, $2, $3, $4::jsonb, $5)`,
		operator.ID, operator.Label, operator.TokenHash, string(scopes), operator.CreatedAt)
	return err
}

func (store *PostgresMobileCredentialStore) RevokeDevice(ctx context.Context, id string, now int64) (bool, error) {
	if store == nil || store.Pool == nil {
		return false, errors.New("edge: mobile credential store sin pool")
	}
	tag, err := store.Pool.Exec(ctx, `
		UPDATE shadow.mobile_devices SET revoked_at = $2
		WHERE id = $1 AND revoked_at IS NULL`, id, now)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func (store *PostgresMobileCredentialStore) RevokeOperator(ctx context.Context, id string, now int64) (bool, error) {
	if store == nil || store.Pool == nil {
		return false, errors.New("edge: mobile credential store sin pool")
	}
	tag, err := store.Pool.Exec(ctx, `
		UPDATE shadow.mobile_operators SET revoked_at = $2
		WHERE id = $1 AND revoked_at IS NULL`, id, now)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func (store *PostgresMobileCredentialStore) CredentialDevices(ctx context.Context) ([]MobileCredential, error) {
	if store == nil || store.Pool == nil {
		return nil, errors.New("edge: mobile credential store sin pool")
	}
	rows, err := store.Pool.Query(ctx, `
		SELECT id, token_hash, revoked_at IS NOT NULL
		FROM shadow.mobile_devices`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	credentials := make([]MobileCredential, 0)
	for rows.Next() {
		var credential MobileCredential
		if err := rows.Scan(&credential.ID, &credential.TokenHash, &credential.Revoked); err != nil {
			return nil, err
		}
		credentials = append(credentials, credential)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return credentials, nil
}

func (store *PostgresMobileCredentialStore) CredentialOperators(ctx context.Context) ([]MobileCredential, error) {
	if store == nil || store.Pool == nil {
		return nil, errors.New("edge: mobile credential store sin pool")
	}
	rows, err := store.Pool.Query(ctx, `
		SELECT id, token_hash, scopes, revoked_at IS NOT NULL
		FROM shadow.mobile_operators`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	credentials := make([]MobileCredential, 0)
	for rows.Next() {
		var credential MobileCredential
		var scopes []byte
		if err := rows.Scan(&credential.ID, &credential.TokenHash, &scopes, &credential.Revoked); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(scopes, &credential.Scopes); err != nil {
			return nil, err
		}
		if credential.Scopes == nil {
			credential.Scopes = []string{}
		}
		credentials = append(credentials, credential)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return credentials, nil
}

// PutChatPushDevice mueve el token de un operador a otro si ya estaba
// registrado y lo inserta o actualiza para operatorID. La transacción evita
// violar el UNIQUE de token.
func (store *PostgresMobileCredentialStore) PutChatPushDevice(ctx context.Context, operatorID, token string, now int64) error {
	if store == nil || store.Pool == nil {
		return errors.New("edge: mobile credential store sin pool")
	}
	tx, err := store.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `
		DELETE FROM shadow.chat_push_devices
		WHERE token = $1 AND operator_id <> $2`, token, operatorID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO shadow.chat_push_devices (operator_id, token, updated_at)
		VALUES ($1, $2, $3)
		ON CONFLICT (operator_id) DO UPDATE
		SET token = EXCLUDED.token, updated_at = EXCLUDED.updated_at`,
		operatorID, token, now); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (store *PostgresMobileCredentialStore) DeleteChatPushDevice(ctx context.Context, operatorID string) error {
	if store == nil || store.Pool == nil {
		return errors.New("edge: mobile credential store sin pool")
	}
	_, err := store.Pool.Exec(ctx, `
		DELETE FROM shadow.chat_push_devices WHERE operator_id = $1`, operatorID)
	return err
}
