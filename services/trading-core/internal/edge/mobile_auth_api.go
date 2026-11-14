package edge

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"regexp"
	"sync"
	"time"
)

const (
	// mobileDeviceCheckPath y mobileOperatorCheckPath son las únicas rutas
	// servidas por MobileAuthAPI.
	mobileDeviceCheckPath   = "/api/mobile/device-check"
	mobileOperatorCheckPath = "/api/mobile/operator-check"

	// maxMobileAuthSnapshotBytes acota el snapshot leído del disco. Un archivo
	// mayor se rechaza sin cargarlo entero en memoria.
	maxMobileAuthSnapshotBytes = 1 << 20

	// mobileOperatorReadLimit es el número de lecturas permitidas por operador
	// dentro de mobileOperatorReadWindow, igual que el monolito TS.
	mobileOperatorReadLimit  = 60
	mobileOperatorReadWindow = time.Minute

	// Mensajes copiados literalmente del contrato HTTP del monolito TS.
	mobileDeviceCredentialError   = "Credencial de dispositivo requerida."
	mobileOperatorCredentialError = "Credencial de operador requerida o revocada."
	mobileOperatorRateLimitError  = "Límite de solicitudes alcanzado."
)

// mobileBearerPattern es el mismo formato aceptado por el monolito TS.
var mobileBearerPattern = regexp.MustCompile(`^Bearer ([A-Za-z0-9_-]{40,100})$`)

var (
	// errMobileAuthSnapshotTooLarge marca snapshots por encima del límite. El
	// detalle nunca se escribe en la respuesta.
	errMobileAuthSnapshotTooLarge = errors.New("edge: snapshot de autenticación móvil demasiado grande")
	// errMobileAuthSnapshotInvalid marca snapshots que no son un objeto JSON
	// válido. El detalle nunca se escribe en la respuesta.
	errMobileAuthSnapshotInvalid = errors.New("edge: snapshot de autenticación móvil inválido")
)

// mobileAuthSnapshot es el documento privado montado en el contenedor. Solo se
// usan los hashes, scopes e identificadores; ningún otro campo se expone.
type mobileAuthSnapshot struct {
	Devices   []mobileAuthRecord `json:"devices"`
	Operators []mobileAuthRecord `json:"operators"`
}

// mobileAuthRecord representa un dispositivo u operador. RevokedAt se conserva
// en crudo para ignorar cualquier valor no nulo sin fallar si el monolito usa
// un tipo distinto de timestamp.
type mobileAuthRecord struct {
	ID        string          `json:"id"`
	TokenHash string          `json:"tokenHash"`
	Scopes    []string        `json:"scopes"`
	RevokedAt json.RawMessage `json:"revokedAt"`
}

// revoked indica si el registro fue revocado. Un campo ausente o null cuenta
// como vigente.
func (record mobileAuthRecord) revoked() bool {
	raw := bytes.TrimSpace(record.RevokedAt)
	return len(raw) > 0 && !bytes.Equal(raw, []byte("null"))
}

// hasScope comprueba un permiso con la misma comparación exacta que el TS.
func (record mobileAuthRecord) hasScope(scope string) bool {
	for _, candidate := range record.Scopes {
		if candidate == scope {
			return true
		}
	}
	return false
}

// rateKey identifica al operador para el límite en memoria. El id del snapshot
// es estable entre peticiones; el hash solo se usa como respaldo defensivo.
func (record mobileAuthRecord) rateKey() string {
	if record.ID != "" {
		return record.ID
	}
	return record.TokenHash
}

// mobileAuthReadWindow es la ventana fija de lecturas de un operador.
type mobileAuthReadWindow struct {
	start time.Time
	count int
}

// MobileAuthAPI verifica credenciales Bearer de dispositivos y operadores
// móviles contra el snapshot JSON privado indicado en File. Es de solo lectura:
// nunca escribe el snapshot, no emite cookies ni hace proxy al monolito TS.
//
// Rutas:
//
//	GET /api/mobile/device-check
//	GET /api/mobile/operator-check
//
// La credencial se lee del encabezado Authorization con el formato
// "Bearer <token>" y se compara sha256(token) en hex, en tiempo constante,
// contra los hashes no revocados del snapshot. El token y los hashes nunca se
// registran ni se devuelven.
//
// Un snapshot ausente o vacío equivale a no tener credenciales y produce 401;
// un JSON inválido, un archivo mayor de 1 MiB o un fallo de lectura producen
// 503 sin detalles. Cada petición relee el snapshot para que una revocación sea
// visible de inmediato.
//
// El límite de 60 lecturas por minuto del operador vive en memoria y se
// protege con un mutex. Now permite inyectar el reloj en las pruebas; nil usa
// time.Now.
type MobileAuthAPI struct {
	File string
	Now  func() time.Time

	mu    sync.Mutex
	reads map[string]mobileAuthReadWindow
}

// mobileDeviceCheckResponse y mobileOperatorCheckResponse replican la forma
// exacta del contrato TS.
type mobileDeviceCheckResponse struct {
	OK bool `json:"ok"`
}

type mobileOperatorCheckResponse struct {
	OK     bool     `json:"ok"`
	Scopes []string `json:"scopes"`
}

type mobileAuthErrorResponse struct {
	Error string `json:"error"`
}

func (api *MobileAuthAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")

	switch r.URL.Path {
	case mobileDeviceCheckPath, mobileOperatorCheckPath:
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
		return
	}

	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
		return
	}

	token, ok := mobileBearerToken(r)
	if !ok {
		api.writeCredentialError(w, r.URL.Path)
		return
	}

	snapshot, err := api.snapshot()
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
		return
	}

	switch r.URL.Path {
	case mobileDeviceCheckPath:
		api.deviceCheck(w, token, snapshot)
	case mobileOperatorCheckPath:
		api.operatorCheck(w, token, snapshot)
	}
}

// mobileBearerToken extrae el token del encabezado Authorization. Cualquier
// variante fuera del formato aceptado se trata como credencial ausente.
func mobileBearerToken(r *http.Request) (string, bool) {
	match := mobileBearerPattern.FindStringSubmatch(r.Header.Get("Authorization"))
	if len(match) != 2 {
		return "", false
	}
	return match[1], true
}

// deviceCheck acepta cualquier dispositivo vigente, sin scopes ni límite.
func (api *MobileAuthAPI) deviceCheck(
	w http.ResponseWriter,
	token string,
	snapshot mobileAuthSnapshot,
) {
	if !mobileAuthDeviceValid(snapshot.Devices, token) {
		writeJSON(w, http.StatusUnauthorized, mobileAuthErrorResponse{
			Error: mobileDeviceCredentialError,
		})
		return
	}
	writeJSON(w, http.StatusOK, mobileDeviceCheckResponse{OK: true})
}

// operatorCheck exige un operador vigente con scope read y aplica el límite de
// lecturas antes de responder. Un operador sin scope no consume cupo, igual
// que en el TS.
func (api *MobileAuthAPI) operatorCheck(
	w http.ResponseWriter,
	token string,
	snapshot mobileAuthSnapshot,
) {
	record, ok := mobileAuthOperator(snapshot.Operators, token)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, mobileAuthErrorResponse{
			Error: mobileOperatorCredentialError,
		})
		return
	}
	if !api.allowRead(record.rateKey(), api.now()) {
		writeJSON(w, http.StatusTooManyRequests, mobileAuthErrorResponse{
			Error: mobileOperatorRateLimitError,
		})
		return
	}
	scopes := record.Scopes
	if scopes == nil {
		scopes = []string{}
	}
	writeJSON(w, http.StatusOK, mobileOperatorCheckResponse{OK: true, Scopes: scopes})
}

// writeCredentialError elige el mensaje 401 correspondiente a la ruta.
func (api *MobileAuthAPI) writeCredentialError(w http.ResponseWriter, path string) {
	message := mobileDeviceCredentialError
	if path == mobileOperatorCheckPath {
		message = mobileOperatorCredentialError
	}
	writeJSON(w, http.StatusUnauthorized, mobileAuthErrorResponse{Error: message})
}

// now devuelve el reloj inyectado o el del sistema.
func (api *MobileAuthAPI) now() time.Time {
	if api.Now != nil {
		return api.Now()
	}
	return time.Now()
}

// allowRead registra una lectura del operador y devuelve false al superar 60
// en la ventana de un minuto. La ventana se reinicia al cumplirse el minuto o
// si el reloj retrocede, para no dejar al operador bloqueado.
func (api *MobileAuthAPI) allowRead(key string, now time.Time) bool {
	api.mu.Lock()
	defer api.mu.Unlock()

	if api.reads == nil {
		api.reads = make(map[string]mobileAuthReadWindow)
	}
	window, found := api.reads[key]
	if !found || now.Sub(window.start) >= mobileOperatorReadWindow || now.Before(window.start) {
		api.reads[key] = mobileAuthReadWindow{start: now, count: 1}
		return true
	}
	if window.count >= mobileOperatorReadLimit {
		return false
	}
	window.count++
	api.reads[key] = window
	return true
}

// mobileAuthDigestHex calcula sha256(token) en hex, el mismo digest guardado
// por el monolito TS.
func mobileAuthDigestHex(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// mobileAuthDeviceValid compara el digest contra todos los dispositivos
// vigentes sin cortocircuitar, para no revelar por tiempos qué entrada coincidió.
func mobileAuthDeviceValid(records []mobileAuthRecord, token string) bool {
	digest := mobileAuthDigestHex(token)
	matched := 0
	for _, record := range records {
		if record.revoked() {
			continue
		}
		matched |= subtle.ConstantTimeCompare([]byte(digest), []byte(record.TokenHash))
	}
	return matched == 1
}

// mobileAuthOperator devuelve el operador vigente con scope read cuyo hash
// coincide. La comparación es en tiempo constante y recorre todos los registros
// elegibles.
func mobileAuthOperator(records []mobileAuthRecord, token string) (mobileAuthRecord, bool) {
	digest := mobileAuthDigestHex(token)
	var found mobileAuthRecord
	matched := 0
	for _, record := range records {
		if record.revoked() || !record.hasScope("read") {
			continue
		}
		equal := subtle.ConstantTimeCompare([]byte(digest), []byte(record.TokenHash))
		if equal == 1 {
			found = record
		}
		matched |= equal
	}
	return found, matched == 1
}

// snapshot lee y valida el documento privado. Nunca devuelve el error de E/S al
// cliente ni incluye la ruta en un mensaje. Un archivo ausente o vacío es un
// snapshot vacío: sin credenciales, toda petición termina en 401.
func (api *MobileAuthAPI) snapshot() (mobileAuthSnapshot, error) {
	if api.File == "" {
		return mobileAuthSnapshot{}, nil
	}

	file, err := os.Open(api.File)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return mobileAuthSnapshot{}, nil
		}
		return mobileAuthSnapshot{}, err
	}
	defer file.Close()

	// Se lee como máximo un byte de más para detectar archivos fuera de límite
	// sin cargar el resto en memoria.
	raw, err := io.ReadAll(io.LimitReader(file, maxMobileAuthSnapshotBytes+1))
	if err != nil {
		return mobileAuthSnapshot{}, err
	}
	if len(raw) > maxMobileAuthSnapshotBytes {
		return mobileAuthSnapshot{}, errMobileAuthSnapshotTooLarge
	}

	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return mobileAuthSnapshot{}, nil
	}
	// json.Valid garantiza que el valor completo (sin datos extra al final) es
	// JSON; el primer byte descarta escalares y arreglos, que no son el objeto
	// esperado.
	if trimmed[0] != '{' || !json.Valid(trimmed) {
		return mobileAuthSnapshot{}, errMobileAuthSnapshotInvalid
	}

	var snapshot mobileAuthSnapshot
	if err := json.Unmarshal(trimmed, &snapshot); err != nil {
		return mobileAuthSnapshot{}, errMobileAuthSnapshotInvalid
	}
	return snapshot, nil
}
