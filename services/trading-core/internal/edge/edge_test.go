package edge

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func doRequest(t *testing.T, handler http.Handler, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(method, target, nil))
	return recorder
}

func TestHealthz(t *testing.T) {
	handler := NewHandler(t.TempDir(), nil)
	recorder := doRequest(t, handler, http.MethodGet, "/healthz")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusOK)
	}
	if contentType := recorder.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/json") {
		t.Fatalf("Content-Type = %q", contentType)
	}
	var body map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("JSON inválido: %v", err)
	}
	if body["status"] != "ok" {
		t.Fatalf("status = %q, quiero ok", body["status"])
	}
}

func TestReadyz(t *testing.T) {
	t.Run("sin stats", func(t *testing.T) {
		recorder := doRequest(t, NewHandler(t.TempDir(), nil), http.MethodGet, "/readyz")
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusOK)
		}
	})

	t.Run("stats ok", func(t *testing.T) {
		stats := func(context.Context) (Summary, error) { return Summary{}, nil }
		recorder := doRequest(t, NewHandler(t.TempDir(), stats), http.MethodGet, "/readyz")
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusOK)
		}
	})

	t.Run("stats con error", func(t *testing.T) {
		stats := func(context.Context) (Summary, error) { return Summary{}, errors.New("postgres caído") }
		recorder := doRequest(t, NewHandler(t.TempDir(), stats), http.MethodGet, "/readyz")
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusServiceUnavailable)
		}
		if strings.Contains(recorder.Body.String(), "postgres caído") {
			t.Fatalf("la respuesta no debe filtrar el error interno: %s", recorder.Body.String())
		}
	})
}

func TestMetrics(t *testing.T) {
	handler := NewHandler(t.TempDir(), nil)
	recorder := doRequest(t, handler, http.MethodGet, "/metrics")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusOK)
	}
	if contentType := recorder.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "text/plain") {
		t.Fatalf("Content-Type = %q", contentType)
	}
	body := recorder.Body.String()
	for _, want := range []string{
		"edge_up 1",
		"edge_http_requests_total 1",
		"edge_static_files_served_total 0",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("métricas sin %q:\n%s", want, body)
		}
	}
}

func TestSummary(t *testing.T) {
	want := Summary{HunterEvents: 4, CoreAllowed: 2, CoreBlocked: 1, CorePending: 1}
	t.Run("ok", func(t *testing.T) {
		stats := func(context.Context) (Summary, error) { return want, nil }
		recorder := doRequest(t, NewHandler(t.TempDir(), stats), http.MethodGet, "/api/edge/summary")
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusOK)
		}
		var got Summary
		if err := json.Unmarshal(recorder.Body.Bytes(), &got); err != nil {
			t.Fatalf("JSON inválido: %v", err)
		}
		if got != want {
			t.Fatalf("summary = %+v, quiero %+v", got, want)
		}
	})

	t.Run("sin stats", func(t *testing.T) {
		recorder := doRequest(t, NewHandler(t.TempDir(), nil), http.MethodGet, "/api/edge/summary")
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusServiceUnavailable)
		}
	})

	t.Run("stats con error", func(t *testing.T) {
		stats := func(context.Context) (Summary, error) { return Summary{}, errors.New("db error") }
		recorder := doRequest(t, NewHandler(t.TempDir(), stats), http.MethodGet, "/api/edge/summary")
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusServiceUnavailable)
		}
	})

	t.Run("método no permitido", func(t *testing.T) {
		stats := func(context.Context) (Summary, error) { return want, nil }
		recorder := doRequest(t, NewHandler(t.TempDir(), stats), http.MethodPost, "/api/edge/summary")
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusMethodNotAllowed)
		}
	})
}

func TestStaticFiles(t *testing.T) {
	staticDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(staticDir, "index.html"), []byte("<h1>edge</h1>"), 0o644); err != nil {
		t.Fatalf("escribir index: %v", err)
	}
	if err := os.WriteFile(filepath.Join(staticDir, "app.js"), []byte("console.log('edge')"), 0o644); err != nil {
		t.Fatalf("escribir app.js: %v", err)
	}
	if err := os.Mkdir(filepath.Join(staticDir, "sin-index"), 0o755); err != nil {
		t.Fatalf("crear directorio: %v", err)
	}
	if err := os.Mkdir(filepath.Join(staticDir, "con-index"), 0o755); err != nil {
		t.Fatalf("crear directorio: %v", err)
	}
	if err := os.WriteFile(filepath.Join(staticDir, "con-index", "index.html"), []byte("<h1>sub</h1>"), 0o644); err != nil {
		t.Fatalf("escribir index de subdirectorio: %v", err)
	}
	handler := NewHandler(staticDir, nil)

	t.Run("archivo", func(t *testing.T) {
		recorder := doRequest(t, handler, http.MethodGet, "/app.js")
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusOK)
		}
		if body := recorder.Body.String(); body != "console.log('edge')" {
			t.Fatalf("body = %q", body)
		}
	})

	t.Run("index raíz", func(t *testing.T) {
		recorder := doRequest(t, handler, http.MethodGet, "/")
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusOK)
		}
		if body := recorder.Body.String(); !strings.Contains(body, "edge") {
			t.Fatalf("body = %q", body)
		}
	})

	t.Run("index de subdirectorio", func(t *testing.T) {
		recorder := doRequest(t, handler, http.MethodGet, "/con-index/")
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusOK)
		}
	})

	t.Run("sin listado de directorios", func(t *testing.T) {
		recorder := doRequest(t, handler, http.MethodGet, "/sin-index/")
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusNotFound)
		}
		if contentType := recorder.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/json") {
			t.Fatalf("Content-Type = %q", contentType)
		}
		var body map[string]string
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
			t.Fatalf("JSON inválido: %v", err)
		}
		if body["status"] != "not_found" {
			t.Fatalf("body = %v", body)
		}
	})

	t.Run("archivo inexistente", func(t *testing.T) {
		recorder := doRequest(t, handler, http.MethodGet, "/no-existe.js")
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusNotFound)
		}
		if contentType := recorder.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/json") {
			t.Fatalf("Content-Type = %q", contentType)
		}
	})

	t.Run("api sin fallback SPA", func(t *testing.T) {
		recorder := doRequest(t, handler, http.MethodGet, "/api/desconocida")
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusNotFound)
		}
		if strings.Contains(recorder.Body.String(), "<h1>edge</h1>") {
			t.Fatalf("la API no debe caer al index: %s", recorder.Body.String())
		}
	})

	t.Run("path traversal literal", func(t *testing.T) {
		secret := filepath.Join(filepath.Dir(staticDir), "edge-secret.txt")
		if err := os.WriteFile(secret, []byte("secreto"), 0o644); err != nil {
			t.Fatalf("escribir secreto: %v", err)
		}
		t.Cleanup(func() { _ = os.Remove(secret) })
		for _, target := range []string{"/../edge-secret.txt", "/%2e%2e/edge-secret.txt", "/..%2fedge-secret.txt"} {
			recorder := doRequest(t, handler, http.MethodGet, target)
			if recorder.Code != http.StatusNotFound {
				t.Fatalf("%s: status = %d, quiero %d", target, recorder.Code, http.StatusNotFound)
			}
			if strings.Contains(recorder.Body.String(), "secreto") {
				t.Fatalf("%s filtró el archivo: %s", target, recorder.Body.String())
			}
		}
	})

	t.Run("contador de estáticos", func(t *testing.T) {
		recorder := doRequest(t, handler, http.MethodGet, "/metrics")
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d", recorder.Code)
		}
		if body := recorder.Body.String(); !strings.Contains(body, "edge_static_files_served_total 3") {
			t.Fatalf("métricas sin contador esperado:\n%s", body)
		}
	})
}

func TestCleanStaticPath(t *testing.T) {
	valid := map[string]string{
		"/":            "",
		"/app.js":      "app.js",
		"/assets/x.js": "assets/x.js",
		"/./app.js":    "app.js",
	}
	for input, want := range valid {
		got, ok := cleanStaticPath(input)
		if !ok || got != want {
			t.Fatalf("cleanStaticPath(%q) = %q, %v; quiero %q, true", input, got, ok, want)
		}
	}
	for _, input := range []string{"", "app.js", "/../x", "/a/../../x", "/a\\..\\x", "/a\x00b"} {
		if got, ok := cleanStaticPath(input); ok {
			t.Fatalf("cleanStaticPath(%q) = %q, true; quiero rechazo", input, got)
		}
	}
}
