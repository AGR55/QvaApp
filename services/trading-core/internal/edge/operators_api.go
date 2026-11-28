package edge

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"time"
)

const (
	// operatorsPath es la única ruta servida por OperatorsAPI.
	operatorsPath = "/api/mobile/operators"

	// maxOperatorsSnapshotBytes acota el snapshot leído del disco. Un archivo
	// mayor se rechaza sin cargarlo entero en memoria.
	maxOperatorsSnapshotBytes = 256 << 10
)

// operatorsEmptyArray es el cuerpo usado cuando aún no hay operadores. Se
// comparte entre peticiones porque nunca se modifica.
var operatorsEmptyArray = []byte("[]")

var (
	// errOperatorsSnapshotTooLarge marca snapshots por encima del límite. El
	// detalle nunca se escribe en la respuesta.
	errOperatorsSnapshotTooLarge = errors.New("edge: snapshot de operadores demasiado grande")
	// errOperatorsSnapshotInvalid marca snapshots que no son un arreglo JSON
	// válido. El detalle nunca se escribe en la respuesta.
	errOperatorsSnapshotInvalid = errors.New("edge: snapshot de operadores inválido")
)

// OperatorsAPI sirve en solo lectura el snapshot JSON de operadores móviles
// publicado por producción en settings.mobile_operators_v1.
//
// Rutas:
//
//	GET /api/mobile/operators
//
// La respuesta es siempre {"data": <arreglo>} y el arreglo se copia byte a
// byte desde el archivo, sin re-serializar, filtrar ni enriquecer campos. Un
// archivo ausente o vacío produce {"data":[]}; un JSON inválido, un archivo
// mayor de 256 KiB o un fallo de lectura producen 503 JSON.
//
// Toda petición exige la cookie de sesión emitida por SessionHandler. El
// handler no registra la ruta del archivo ni su contenido, y no emite cookies.
// Cualquier otro método responde 405 y cualquier otra ruta 404, siempre JSON.
//
// No hay caché: cada petición relee el snapshot para que una revocación sea
// visible de inmediato. El escritor del snapshot debe publicarlo de forma
// atómica (escribir un temporal y renombrarlo) para que un lector concurrente
// nunca observe un archivo a medio escribir; si lo observara, respondería 503.
type OperatorsAPI struct {
	Sessions *SessionManager
	File     string
	Now      func() time.Time
}

func (api *OperatorsAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")

	if r.URL.Path != operatorsPath {
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
		return
	}

	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
		return
	}

	if !api.authenticated(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"status": "unauthenticated"})
		return
	}

	snapshot, err := api.snapshot()
	if err != nil {
		writeOperatorsUnavailable(w)
		return
	}
	writeOperatorsSnapshot(w, snapshot)
}

// authenticated valida la cookie de sesión con el reloj configurado. Un
// SessionManager nil también produce false.
func (api *OperatorsAPI) authenticated(r *http.Request) bool {
	if api.Sessions == nil {
		return false
	}
	cookie, err := r.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		return false
	}
	now := time.Now
	if api.Now != nil {
		now = api.Now
	}
	_, err = api.Sessions.Verify(cookie.Value, now())
	return err == nil
}

// snapshot lee y valida el arreglo JSON publicado. Nunca devuelve el error de
// E/S al cliente ni incluye la ruta en un mensaje.
func (api *OperatorsAPI) snapshot() ([]byte, error) {
	if api.File == "" {
		return operatorsEmptyArray, nil
	}

	file, err := os.Open(api.File)
	if err != nil {
		// Un snapshot ausente es un estado normal mientras no existan
		// operadores; cualquier otro fallo se trata como indisponibilidad.
		if errors.Is(err, fs.ErrNotExist) {
			return operatorsEmptyArray, nil
		}
		return nil, err
	}
	defer file.Close()

	// Se lee como máximo un byte de más para detectar archivos fuera de límite
	// sin cargar el resto en memoria.
	raw, err := io.ReadAll(io.LimitReader(file, maxOperatorsSnapshotBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > maxOperatorsSnapshotBytes {
		return nil, errOperatorsSnapshotTooLarge
	}

	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return operatorsEmptyArray, nil
	}
	// json.Valid garantiza que el valor completo (sin datos extra al final) es
	// JSON; el primer byte descarta escalares y objetos, que no son un arreglo.
	if trimmed[0] != '[' || !json.Valid(trimmed) {
		return nil, errOperatorsSnapshotInvalid
	}
	return trimmed, nil
}

// writeOperatorsSnapshot escribe el sobre {"data":...} pegando el arreglo en
// crudo. Se evita re-marshal para preservar exactamente el contenido publicado.
func writeOperatorsSnapshot(w http.ResponseWriter, snapshot []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"data":`))
	_, _ = w.Write(snapshot)
	_, _ = w.Write([]byte("}\n"))
}

func writeOperatorsUnavailable(w http.ResponseWriter) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
}
