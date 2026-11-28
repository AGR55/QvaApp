package edge

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
)

// shellHTML es el documento mínimo del dashboard. Se genera en Go para no
// depender de plantillas ni de archivos que puedan faltar en el despliegue.
const shellHTML = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>QvaApply</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><div id="root"></div><script type="module" src="/dashboard/app.js"></script></body></html>`

// shellCSP permite únicamente recursos propios. No hay scripts inline: el
// dashboard se carga como módulo desde /dashboard/app.js.
const shellCSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

type shellHandler struct {
	staticDir string
	files     http.Handler
}

// NewShellHandler sirve el dashboard existente y un fallback SPA para rutas de
// navegación. staticDir es la raíz de los estáticos (por ejemplo public/).
// No autentica ni hace proxy: /api/* siempre responde 404 JSON para que el
// fallback SPA nunca se aplique a la API.
func NewShellHandler(staticDir string) http.Handler {
	return &shellHandler{
		staticDir: staticDir,
		files:     http.FileServer(http.Dir(staticDir)),
	}
}

func (h *shellHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
		return
	}

	requestPath := r.URL.Path
	if requestPath == "" || !strings.HasPrefix(requestPath, "/") ||
		strings.ContainsRune(requestPath, 0) || strings.Contains(requestPath, `\`) ||
		hasDotDotSegment(requestPath) {
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
		return
	}

	// La API nunca cae al shell SPA, ni siquiera cuando la ruta no existe.
	if requestPath == "/api" || strings.HasPrefix(requestPath, "/api/") {
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
		return
	}

	if requestPath == "/" {
		writeShellHTML(w, r)
		return
	}

	// Sólo se sirven archivos regulares existentes. Los directorios no se
	// listan: caen al fallback de navegación o a un 404 JSON.
	if rel, ok := cleanStaticPath(requestPath); ok && rel != "" {
		target := filepath.Join(h.staticDir, filepath.FromSlash(rel))
		if info, err := os.Stat(target); err == nil && info.Mode().IsRegular() {
			h.serveAsset(w, r, rel)
			return
		}
	}

	if isNavigationPath(requestPath) {
		writeShellHTML(w, r)
		return
	}

	writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
}

func (h *shellHandler) serveAsset(w http.ResponseWriter, r *http.Request, rel string) {
	w.Header().Set("Cache-Control", cacheControlFor(rel))
	asset := r.Clone(r.Context())
	asset.URL.Path = "/" + rel
	asset.URL.RawPath = ""
	h.files.ServeHTTP(w, asset)
}

func writeShellHTML(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", shellCSP)
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Length", strconv.Itoa(len(shellHTML)))
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write([]byte(shellHTML))
}

// hasDotDotSegment detecta traversal después del decodificado de la URL, de
// modo que /%2e%2e/ y /..%2f/ se rechazan igual que /../.
func hasDotDotSegment(urlPath string) bool {
	for _, segment := range strings.Split(urlPath, "/") {
		if segment == ".." {
			return true
		}
	}
	return false
}

// isNavigationPath decide si una ruta inexistente puede recibir el shell SPA.
// Las rutas con extensión se consideran assets y no caen al HTML.
func isNavigationPath(urlPath string) bool {
	if urlPath == "" || !strings.HasPrefix(urlPath, "/") {
		return false
	}
	trimmed := strings.TrimRight(urlPath, "/")
	if trimmed == "" {
		return true
	}
	last := trimmed[strings.LastIndexByte(trimmed, '/')+1:]
	if last == "" || strings.ContainsRune(last, '.') {
		return false
	}
	return true
}

// cacheControlFor evita cachear los entrypoints sin hash y permite cachear
// agresivamente los bundles con hash de Vite.
func cacheControlFor(rel string) string {
	base := path.Base(rel)
	if base == "app.js" || base == "app.css" {
		return "no-cache"
	}
	if isHashedAsset(base) {
		return "public, max-age=31536000, immutable"
	}
	return "public, max-age=3600"
}

func isHashedAsset(name string) bool {
	ext := path.Ext(name)
	if ext != ".js" && ext != ".css" {
		return false
	}
	stem := strings.TrimSuffix(name, ext)
	dash := strings.LastIndexByte(stem, '-')
	return dash >= 0 && len(stem)-dash-1 >= 8
}
