package edge

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// staticRoutePrefixes son los directorios públicos que este handler expone.
// Sólo se sirven archivos regulares directamente contenidos en ellos.
var staticRoutePrefixes = []string{"auth", "icons", "logo", "market-icons"}

// StaticRoutes sirve un subconjunto acotado de los estáticos públicos con
// cabeceras de caché explícitas y sin listados de directorio. Es intencional
// que no exista un fallback: una ruta desconocida responde 404 JSON.
type StaticRoutes struct {
	// Dir es la raíz de los estáticos (por ejemplo public/).
	Dir string
	// IconDir es un volumen escribible para iconos subidos desde el panel.
	// Si un icono no existe ahí se usa el asset público de Dir.
	IconDir string
	// Files sirve los archivos ya validados. Si es nil se usa un
	// http.FileServer sobre Dir.
	Files http.Handler
}

// NewStaticRoutes construye el handler para los estáticos públicos de dir.
func NewStaticRoutes(dir string) *StaticRoutes {
	return &StaticRoutes{
		Dir:   dir,
		Files: http.FileServer(http.Dir(dir)),
	}
}

func (s *StaticRoutes) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
		return
	}

	rel, ok := s.resolve(r.URL.Path)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
		return
	}

	if s.IconDir != "" && strings.HasPrefix(rel, "market-icons/") {
		iconRel := strings.TrimPrefix(rel, "market-icons/")
		iconPath := filepath.Join(s.IconDir, filepath.FromSlash(iconRel))
		if info, err := os.Lstat(iconPath); err == nil && info.Mode().IsRegular() {
			w.Header().Set("Cache-Control", staticCacheControl(iconRel))
			http.ServeFile(w, r, iconPath)
			return
		}
	}

	// Lstat (no Stat) rechaza symlinks: sólo se publican archivos regulares
	// dentro de Dir, nunca enlaces que puedan apuntar fuera del árbol.
	info, err := os.Lstat(filepath.Join(s.Dir, filepath.FromSlash(rel)))
	if err != nil || !info.Mode().IsRegular() {
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
		return
	}

	w.Header().Set("Cache-Control", staticCacheControl(rel))
	s.files().ServeHTTP(w, s.assetRequest(r, rel))
}

// resolve traduce una ruta URL a una ruta relativa segura dentro de Dir.
// Cualquier nombre con separadores, ".." o componentes ocultos se rechaza
// antes de tocar el sistema de archivos.
func (s *StaticRoutes) resolve(urlPath string) (string, bool) {
	if urlPath == "/service-worker.js" {
		return "service-worker.js", true
	}

	for _, prefix := range staticRoutePrefixes {
		rest, found := strings.CutPrefix(urlPath, "/"+prefix+"/")
		if !found {
			continue
		}
		if !validStaticName(rest) {
			return "", false
		}
		return prefix + "/" + rest, true
	}

	return "", false
}

// validStaticName acepta únicamente un archivo hijo directo del prefijo.
func validStaticName(name string) bool {
	if name == "" || strings.HasPrefix(name, ".") {
		return false
	}
	if strings.ContainsAny(name, "/\\\x00") {
		return false
	}
	// La ruta ya viene decodificada por net/http, de modo que %2e%2e y %2f
	// también quedan cubiertos aquí.
	return !strings.Contains(name, "..")
}

func (s *StaticRoutes) files() http.Handler {
	if s.Files != nil {
		return s.Files
	}
	return http.FileServer(http.Dir(s.Dir))
}

// assetRequest reapunta la petición al archivo relativo validado para que
// http.FileServer resuelva el MIME, las peticiones condicionales y HEAD.
func (s *StaticRoutes) assetRequest(r *http.Request, rel string) *http.Request {
	asset := r.Clone(r.Context())
	asset.URL.Path = "/" + rel
	asset.URL.RawPath = ""
	return asset
}

// staticCacheControl fija la política de caché por tipo de archivo: el service
// worker siempre se revalida y los bundles con hash de Vite son inmutables.
func staticCacheControl(rel string) string {
	base := path.Base(rel)
	if base == "service-worker.js" {
		return "no-cache"
	}
	if isHashedAsset(base) {
		return "public, max-age=31536000, immutable"
	}
	return "public, max-age=3600"
}
