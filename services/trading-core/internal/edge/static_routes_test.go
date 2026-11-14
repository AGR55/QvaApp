package edge

import (
	"encoding/json"
	"mime"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeStaticRouteFixture(t *testing.T, staticDir, rel, body string) {
	t.Helper()
	target := filepath.Join(staticDir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatalf("crear directorio de %s: %v", rel, err)
	}
	if err := os.WriteFile(target, []byte(body), 0o644); err != nil {
		t.Fatalf("escribir %s: %v", rel, err)
	}
}

func newStaticRouteFixture(t *testing.T) string {
	t.Helper()
	staticDir := t.TempDir()
	writeStaticRouteFixture(t, staticDir, "service-worker.js", "self.addEventListener('install', () => {});")
	writeStaticRouteFixture(t, staticDir, "auth/login.css", "body{color:#000}")
	writeStaticRouteFixture(t, staticDir, "auth/login.js", "/* auth/login.js */")
	writeStaticRouteFixture(t, staticDir, "icons/cup.svg", "<svg></svg>")
	writeStaticRouteFixture(t, staticDir, "logo/encuentro-preciso-symbol.png", "PNG")
	writeStaticRouteFixture(t, staticDir, "market-icons/btc.svg", "<svg>BTC</svg>")
	writeStaticRouteFixture(t, staticDir, "dashboard/app.js", "/* fuera de alcance */")
	return staticDir
}

func assertStaticRouteNotFound(t *testing.T, recorder *httptest.ResponseRecorder, target string) {
	t.Helper()
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("%s: status = %d, quiero %d", target, recorder.Code, http.StatusNotFound)
	}
	if contentType := recorder.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/json") {
		t.Fatalf("%s: Content-Type = %q", target, contentType)
	}
	var payload map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("%s: JSON inválido: %v", target, err)
	}
	if payload["status"] != "not_found" {
		t.Fatalf("%s: status = %q, quiero not_found", target, payload["status"])
	}
}

func TestStaticRoutesServesPrefixes(t *testing.T) {
	handler := NewStaticRoutes(newStaticRouteFixture(t))

	cases := []struct {
		target      string
		body        string
		contentType string
	}{
		{"/auth/login.js", "/* auth/login.js */", "text/javascript"},
		{"/auth/login.css", "body{color:#000}", "text/css"},
		{"/icons/cup.svg", "<svg></svg>", "image/svg+xml"},
		{"/logo/encuentro-preciso-symbol.png", "PNG", "image/png"},
		{"/market-icons/btc.svg", "<svg>BTC</svg>", "image/svg+xml"},
	}

	for _, tc := range cases {
		recorder := doRequest(t, handler, http.MethodGet, tc.target)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, quiero %d", tc.target, recorder.Code, http.StatusOK)
		}
		if body := recorder.Body.String(); body != tc.body {
			t.Fatalf("%s: body = %q", tc.target, body)
		}
		if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Fatalf("%s: X-Content-Type-Options = %q", tc.target, got)
		}
		wantType := mime.TypeByExtension(filepath.Ext(tc.target))
		if got := recorder.Header().Get("Content-Type"); got != wantType {
			t.Fatalf("%s: Content-Type = %q, quiero %q", tc.target, got, wantType)
		}
		if strings.HasPrefix(recorder.Header().Get("Content-Type"), "text/plain") {
			t.Fatalf("%s: tipo genérico text/plain", tc.target)
		}
	}
}

func TestStaticRoutesHead(t *testing.T) {
	handler := NewStaticRoutes(newStaticRouteFixture(t))

	recorder := doRequest(t, handler, http.MethodHead, "/icons/cup.svg")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusOK)
	}
	if recorder.Body.Len() != 0 {
		t.Fatalf("HEAD no debe devolver cuerpo: %q", recorder.Body.String())
	}
	if got := recorder.Header().Get("Content-Type"); got != "image/svg+xml" {
		t.Fatalf("Content-Type = %q", got)
	}
}

func TestStaticRoutesNotFound(t *testing.T) {
	handler := NewStaticRoutes(newStaticRouteFixture(t))

	for _, target := range []string{
		"/service-worker-missing.js",
		"/auth/missing.js",
		"/icons/missing.svg",
		"/logo/missing.png",
		"/market-icons/missing.svg",
		"/dashboard/app.js",
		"/",
		"/auth",
		"/auth/",
		"/icons/",
	} {
		recorder := doRequest(t, handler, http.MethodGet, target)
		assertStaticRouteNotFound(t, recorder, target)
	}
}

func TestStaticRoutesServiceWorker(t *testing.T) {
	handler := NewStaticRoutes(newStaticRouteFixture(t))

	recorder := doRequest(t, handler, http.MethodGet, "/service-worker.js")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusOK)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("Cache-Control = %q, quiero no-cache", got)
	}
	if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/javascript") && !strings.HasPrefix(got, "application/javascript") {
		t.Fatalf("Content-Type = %q", got)
	}
	if body := recorder.Body.String(); !strings.Contains(body, "addEventListener") {
		t.Fatalf("body = %q", body)
	}

	empty := NewStaticRoutes(t.TempDir())
	assertStaticRouteNotFound(t, doRequest(t, empty, http.MethodGet, "/service-worker.js"), "/service-worker.js")
}

func TestStaticRoutesTraversal(t *testing.T) {
	staticDir := newStaticRouteFixture(t)
	secret := filepath.Join(filepath.Dir(staticDir), "static-secret.txt")
	if err := os.WriteFile(secret, []byte("secreto-estatico"), 0o644); err != nil {
		t.Fatalf("escribir secreto: %v", err)
	}
	t.Cleanup(func() { _ = os.Remove(secret) })
	writeStaticRouteFixture(t, staticDir, "auth/private/nested.js", "/* nested */")
	handler := NewStaticRoutes(staticDir)

	for _, target := range []string{
		"/auth/../static-secret.txt",
		"/auth/..%2fstatic-secret.txt",
		"/auth/%2e%2e/static-secret.txt",
		"/auth/%2e%2e%2fstatic-secret.txt",
		"/auth/%2e%2e%2Fstatic-secret.txt",
		"/auth/..%5cstatic-secret.txt",
		"/icons/..%2f..%2fstatic-secret.txt",
		"/logo/%2e%2e%2fstatic-secret.txt",
		"/market-icons/..%2Fstatic-secret.txt",
		"/auth/%252e%252e%252fstatic-secret.txt",
		"/auth/private/nested.js",
		"/auth/private%2fnested.js",
		"/auth//login.js",
	} {
		recorder := doRequest(t, handler, http.MethodGet, target)
		assertStaticRouteNotFound(t, recorder, target)
		if body := recorder.Body.String(); strings.Contains(body, "secreto-estatico") || strings.Contains(body, "nested") {
			t.Fatalf("%s filtró contenido fuera de alcance:\n%s", target, body)
		}
	}
}

func TestStaticRoutesNoDirectoryListing(t *testing.T) {
	staticDir := newStaticRouteFixture(t)
	writeStaticRouteFixture(t, staticDir, "auth/private/secret.txt", "no-listar")
	handler := NewStaticRoutes(staticDir)

	for _, target := range []string{"/auth/", "/auth/private/", "/auth/private"} {
		recorder := doRequest(t, handler, http.MethodGet, target)
		assertStaticRouteNotFound(t, recorder, target)
		body := recorder.Body.String()
		if strings.Contains(body, "secret.txt") || strings.Contains(body, "<pre>") || strings.Contains(body, "no-listar") {
			t.Fatalf("%s listó el directorio:\n%s", target, body)
		}
	}
}

func TestStaticRoutesMethodNotAllowed(t *testing.T) {
	handler := NewStaticRoutes(newStaticRouteFixture(t))

	for _, tc := range []struct {
		method string
		target string
	}{
		{http.MethodPost, "/auth/login.js"},
		{http.MethodPut, "/icons/cup.svg"},
		{http.MethodDelete, "/service-worker.js"},
		{http.MethodPatch, "/logo/encuentro-preciso-symbol.png"},
	} {
		recorder := doRequest(t, handler, tc.method, tc.target)
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s %s: status = %d, quiero %d", tc.method, tc.target, recorder.Code, http.StatusMethodNotAllowed)
		}
		if got := recorder.Header().Get("Allow"); got != "GET, HEAD" {
			t.Fatalf("%s %s: Allow = %q", tc.method, tc.target, got)
		}
		if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Fatalf("%s %s: X-Content-Type-Options = %q", tc.method, tc.target, got)
		}
		if contentType := recorder.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/json") {
			t.Fatalf("%s %s: Content-Type = %q", tc.method, tc.target, contentType)
		}
		if body := recorder.Body.String(); strings.Contains(body, "login.js") {
			t.Fatalf("%s %s: el 405 no debe servir el archivo:\n%s", tc.method, tc.target, body)
		}
	}
}

func TestStaticRoutesCacheHeaders(t *testing.T) {
	staticDir := newStaticRouteFixture(t)
	writeStaticRouteFixture(t, staticDir, "auth/app-AbCdEf12.js", "/* hashed js */")
	writeStaticRouteFixture(t, staticDir, "auth/app-AbCdEf12.css", "/* hashed css */")
	writeStaticRouteFixture(t, staticDir, "logo/mark-AbCdEf12.svg", "<svg></svg>")
	handler := NewStaticRoutes(staticDir)

	cases := []struct {
		target string
		want   string
	}{
		{"/service-worker.js", "no-cache"},
		{"/auth/app-AbCdEf12.js", "public, max-age=31536000, immutable"},
		{"/auth/app-AbCdEf12.css", "public, max-age=31536000, immutable"},
		{"/auth/login.js", "public, max-age=3600"},
		{"/icons/cup.svg", "public, max-age=3600"},
		{"/logo/mark-AbCdEf12.svg", "public, max-age=3600"},
		{"/market-icons/btc.svg", "public, max-age=3600"},
	}

	for _, tc := range cases {
		recorder := doRequest(t, handler, http.MethodGet, tc.target)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, quiero %d", tc.target, recorder.Code, http.StatusOK)
		}
		if got := recorder.Header().Get("Cache-Control"); got != tc.want {
			t.Fatalf("%s: Cache-Control = %q, quiero %q", tc.target, got, tc.want)
		}
	}
}

func TestStaticRoutesRejectsSymlinks(t *testing.T) {
	staticDir := newStaticRouteFixture(t)
	outside := filepath.Join(filepath.Dir(staticDir), "static-outside.txt")
	if err := os.WriteFile(outside, []byte("fuera"), 0o644); err != nil {
		t.Fatalf("escribir archivo externo: %v", err)
	}
	t.Cleanup(func() { _ = os.Remove(outside) })

	link := filepath.Join(staticDir, "auth", "link.js")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks no disponibles: %v", err)
	}
	handler := NewStaticRoutes(staticDir)

	recorder := doRequest(t, handler, http.MethodGet, "/auth/link.js")
	assertStaticRouteNotFound(t, recorder, "/auth/link.js")
	if body := recorder.Body.String(); strings.Contains(body, "fuera") {
		t.Fatalf("el symlink filtró el archivo externo:\n%s", body)
	}
}

func TestStaticRoutesNilFilesFallsBackToDir(t *testing.T) {
	staticDir := newStaticRouteFixture(t)
	handler := &StaticRoutes{Dir: staticDir}

	recorder := doRequest(t, handler, http.MethodGet, "/auth/login.js")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusOK)
	}
	if body := recorder.Body.String(); body != "/* auth/login.js */" {
		t.Fatalf("body = %q", body)
	}
}
