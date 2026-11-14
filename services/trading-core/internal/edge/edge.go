// Package edge implementa el borde HTTP de sólo lectura para web y Android.
// Sirve estáticos y un resumen agregado; no autentica, no muta ni hace proxy
// al monolito TS.
package edge

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"
)

const statsTimeout = 2 * time.Second

// Summary es el agregado expuesto por /api/edge/summary.
type Summary struct {
	HunterEvents int64 `json:"hunterEvents"`
	CoreAllowed  int64 `json:"coreAllowed"`
	CoreBlocked  int64 `json:"coreBlocked"`
	CorePending  int64 `json:"corePending"`
}

// StatsFunc obtiene el resumen desde la fuente de datos. Puede ser nil: en ese
// caso /readyz sigue respondiendo 200 y /api/edge/summary responde 503.
type StatsFunc func(context.Context) (Summary, error)

type handler struct {
	staticDir    string
	stats        StatsFunc
	files        http.Handler
	requests     atomic.Uint64
	staticServed atomic.Uint64
}

// NewHandler construye el handler del borde. staticDir es la raíz de los
// archivos estáticos; si no existe, las rutas de salud siguen funcionando y
// los estáticos responden 404 JSON.
func NewHandler(staticDir string, stats StatsFunc) http.Handler {
	return &handler{
		staticDir: staticDir,
		stats:     stats,
		files:     http.FileServer(http.Dir(staticDir)),
	}
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.requests.Add(1)
	requestPath := r.URL.Path
	switch requestPath {
	case "/healthz", "/readyz", "/metrics", "/api/edge/summary":
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
			return
		}
	}

	switch requestPath {
	case "/healthz":
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	case "/readyz":
		h.readyz(w, r)
	case "/metrics":
		h.metrics(w)
	case "/api/edge/summary":
		h.summary(w, r)
	default:
		if strings.HasPrefix(requestPath, "/api/") {
			writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
			return
		}
		h.serveStatic(w, r)
	}
}

func (h *handler) readyz(w http.ResponseWriter, r *http.Request) {
	if h.stats == nil {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), statsTimeout)
	defer cancel()
	if _, err := h.stats(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *handler) summary(w http.ResponseWriter, r *http.Request) {
	if h.stats == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), statsTimeout)
	defer cancel()
	summary, err := h.stats(ctx)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func (h *handler) metrics(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	fmt.Fprint(w, "# HELP edge_up Servicio edge en ejecución (1/0).\n")
	fmt.Fprint(w, "# TYPE edge_up gauge\n")
	fmt.Fprint(w, "edge_up 1\n")
	fmt.Fprint(w, "# HELP edge_http_requests_total Peticiones HTTP recibidas.\n")
	fmt.Fprint(w, "# TYPE edge_http_requests_total counter\n")
	fmt.Fprintf(w, "edge_http_requests_total %d\n", h.requests.Load())
	fmt.Fprint(w, "# HELP edge_static_files_served_total Archivos estáticos servidos.\n")
	fmt.Fprint(w, "# TYPE edge_static_files_served_total counter\n")
	fmt.Fprintf(w, "edge_static_files_served_total %d\n", h.staticServed.Load())
}

func (h *handler) serveStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
		return
	}
	rel, ok := cleanStaticPath(r.URL.Path)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
		return
	}
	target := filepath.Join(h.staticDir, filepath.FromSlash(rel))
	info, err := os.Stat(target)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
		return
	}
	if info.IsDir() {
		// Sin listados de directorio: sólo se sirve un index.html existente.
		index, err := os.Stat(filepath.Join(target, "index.html"))
		if err != nil || index.IsDir() {
			writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
			return
		}
	}
	h.staticServed.Add(1)
	h.files.ServeHTTP(w, r)
}

// cleanStaticPath valida la ruta URL y devuelve una ruta relativa segura.
// Rechaza segmentos "..", NUL y separadores de Windows antes de normalizar.
func cleanStaticPath(urlPath string) (string, bool) {
	if urlPath == "" || !strings.HasPrefix(urlPath, "/") {
		return "", false
	}
	if strings.ContainsRune(urlPath, 0) || strings.Contains(urlPath, `\`) {
		return "", false
	}
	for _, segment := range strings.Split(urlPath, "/") {
		if segment == ".." {
			return "", false
		}
	}
	rel := strings.TrimPrefix(path.Clean(urlPath), "/")
	if rel == "" || rel == "." {
		return "", true
	}
	if !fs.ValidPath(rel) {
		return "", false
	}
	return rel, true
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
