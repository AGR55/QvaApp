package edge

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	marketIconsPath = "/api/market-icons"

	// maxMarketIconsBodyBytes acota el sobre JSON completo. Deja margen sobre
	// maxMarketIconsBase64Chars para los nombres de campo y comillas.
	maxMarketIconsBodyBytes = 750_000
	// maxMarketIconsBase64Chars acota el campo base64 antes de decodificar.
	maxMarketIconsBase64Chars = 700_000
	// maxMarketIconsBytes es el tamaño máximo del icono ya decodificado.
	maxMarketIconsBytes = 512 << 10
	// maxMarketIconsNameBytes acota el nombre del archivo.
	maxMarketIconsNameBytes = 120
)

var (
	marketIconsNamePattern = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
	marketIconsMIMEByExt   = map[string]string{
		".png":  "image/png",
		".jpg":  "image/jpeg",
		".jpeg": "image/jpeg",
		".webp": "image/webp",
		".svg":  "image/svg+xml",
	}
	marketIconsForbiddenSVG = [][]byte{
		[]byte("<script"),
		[]byte("onload="),
		[]byte("onerror="),
		[]byte("javascript:"),
		[]byte("<foreignobject"),
	}
)

// MarketIconsAPI recibe iconos subidos desde el panel web y los guarda en Dir.
// La mutación exige cookie de sesión, Origin permitido y CSRF de doble envío.
//
// Ruta:
//
//	POST /api/market-icons  {name,mimeType,base64} -> 201 {"data":{"url":...}}
//
// Cualquier otra ruta responde 404 y un método distinto de POST responde 405 con
// Allow: POST. Las respuestas nunca exponen rutas del sistema ni errores
// internos.
type MarketIconsAPI struct {
	Sessions      *SessionManager
	Dir           string
	TrustedOrigin string
	Now           func() time.Time
}

type marketIconsRequest struct {
	Name     string `json:"name"`
	MIMEType string `json:"mimeType"`
	Base64   string `json:"base64"`
}

type marketIconsData struct {
	URL string `json:"url"`
}

type marketIconsResponse struct {
	Data marketIconsData `json:"data"`
}

func (api *MarketIconsAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")

	if r.URL.Path != marketIconsPath {
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
		return
	}

	cookie, authenticated := api.authenticated(r)
	if !authenticated {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Autenticación requerida."})
		return
	}
	if !api.mutationAllowed(w, r, cookie) {
		return
	}

	api.upload(w, r)
}

// authenticated valida la cookie de sesión y devuelve su valor para el
// subsecuente ValidateCSRF. Un SessionManager nil produce 401.
func (api *MarketIconsAPI) authenticated(r *http.Request) (string, bool) {
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

// mutationAllowed exige el Origin configurado (o same-origin) y el CSRF ligado a
// la sesión. Ambos fallos comparten respuesta para no distinguir la causa.
func (api *MarketIconsAPI) mutationAllowed(w http.ResponseWriter, r *http.Request, cookie string) bool {
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

func (api *MarketIconsAPI) upload(w http.ResponseWriter, r *http.Request) {
	body := http.MaxBytesReader(w, r.Body, maxMarketIconsBodyBytes)
	defer body.Close()

	decoder := json.NewDecoder(body)
	var request marketIconsRequest
	if err := decoder.Decode(&request); err != nil {
		writeMarketIconsBodyError(w, err)
		return
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			err = errors.New("edge: cuerpo JSON con datos extra")
		}
		writeMarketIconsBodyError(w, err)
		return
	}

	name, mimeType, ok := validateMarketIconsMetadata(request)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Icono inválido."})
		return
	}
	if len(request.Base64) < 1 || len(request.Base64) > maxMarketIconsBase64Chars {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Icono inválido."})
		return
	}
	content, err := base64.StdEncoding.DecodeString(request.Base64)
	if err != nil || len(content) == 0 || len(content) > maxMarketIconsBytes {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Icono inválido."})
		return
	}
	if mimeType == "image/svg+xml" && !marketIconsSVGAllowed(content) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "SVG no permitido."})
		return
	}

	if err := writeMarketIconFile(api.Dir, name, content); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "No se pudo guardar el icono."})
		return
	}

	writeJSON(w, http.StatusCreated, marketIconsResponse{
		Data: marketIconsData{URL: "/market-icons/" + name},
	})
}

// validateMarketIconsMetadata comprueba nombre, extensión y MIME exacto. El
// nombre debe ser un único componente normalizado: sin separadores, sin ".." y
// sin cambios al aplicar filepath.Base/filepath.Clean.
func validateMarketIconsMetadata(request marketIconsRequest) (string, string, bool) {
	name := request.Name
	if len(name) < 1 || len(name) > maxMarketIconsNameBytes {
		return "", "", false
	}
	if !marketIconsNamePattern.MatchString(name) || strings.Contains(name, "..") {
		return "", "", false
	}
	if filepath.Base(name) != name || filepath.Clean(name) != name || name == "." {
		return "", "", false
	}

	extension := filepath.Ext(name)
	expectedMIME, known := marketIconsMIMEByExt[extension]
	if !known || request.MIMEType != expectedMIME {
		return "", "", false
	}
	if strings.TrimSuffix(name, extension) == "" {
		return "", "", false
	}
	return name, expectedMIME, true
}

// marketIconsSVGAllowed rechaza SVG con scripts, manejadores inline, URLs
// javascript: o contenido externo embebido. La comparación es ASCII
// case-insensitive.
func marketIconsSVGAllowed(content []byte) bool {
	lowered := bytes.ToLower(content)
	for _, forbidden := range marketIconsForbiddenSVG {
		if bytes.Contains(lowered, forbidden) {
			return false
		}
	}
	return true
}

// writeMarketIconFile escribe el icono de forma atómica: un temporal dentro de
// dir, permisos 0644 y rename al destino final. Cualquier fallo elimina el
// temporal para no dejar restos.
func writeMarketIconFile(dir, name string, content []byte) error {
	if dir == "" {
		return errors.New("edge: directorio de iconos vacío")
	}
	target := filepath.Join(dir, name)
	if filepath.Base(target) != name {
		return errors.New("edge: nombre de icono fuera del directorio")
	}

	temp, err := os.CreateTemp(dir, ".icon-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	discard := func() {
		_ = temp.Close()
		_ = os.Remove(tempName)
	}

	if _, err := temp.Write(content); err != nil {
		discard()
		return err
	}
	if err := temp.Chmod(0o644); err != nil {
		discard()
		return err
	}
	if err := temp.Close(); err != nil {
		_ = os.Remove(tempName)
		return err
	}
	if err := os.Rename(tempName, target); err != nil {
		_ = os.Remove(tempName)
		return err
	}
	return nil
}

// writeMarketIconsBodyError traduce fallos de lectura/decodificación. Un cuerpo
// que excede el límite responde 413; el resto, 400, sin exponer el contenido.
func writeMarketIconsBodyError(w http.ResponseWriter, err error) {
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "El icono supera el tamaño máximo."})
		return
	}
	writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Solicitud inválida."})
}

func (api *MarketIconsAPI) now() time.Time {
	if api.Now != nil {
		return api.Now()
	}
	return time.Now()
}
