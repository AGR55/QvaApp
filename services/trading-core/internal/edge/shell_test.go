package edge

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeShellFixture(t *testing.T, staticDir, rel string) {
	t.Helper()
	target := filepath.Join(staticDir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatalf("crear directorio de %s: %v", rel, err)
	}
	if err := os.WriteFile(target, []byte("/* "+rel+" */"), 0o644); err != nil {
		t.Fatalf("escribir %s: %v", rel, err)
	}
}

func assertShellDocument(t *testing.T, body string) {
	t.Helper()
	for _, want := range []string{
		"<!doctype html>",
		`<html lang="es">`,
		"<title>QvaApply</title>",
		`href="/dashboard/app.css"`,
		`src="/dashboard/app.js"`,
		`<div id="root"></div>`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("HTML sin %q:\n%s", want, body)
		}
	}
}

func TestShellIndex(t *testing.T) {
	handler := NewShellHandler(t.TempDir())
	recorder := doRequest(t, handler, http.MethodGet, "/")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusOK)
	}
	if contentType := recorder.Header().Get("Content-Type"); contentType != "text/html; charset=utf-8" {
		t.Fatalf("Content-Type = %q", contentType)
	}
	if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q", got)
	}
	csp := recorder.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "script-src 'self'") {
		t.Fatalf("CSP sin script-src 'self': %q", csp)
	}
	if strings.Contains(csp, "script-src 'self' 'unsafe-inline'") {
		t.Fatalf("CSP no debe permitir script inline: %q", csp)
	}
	assertShellDocument(t, recorder.Body.String())
}

func TestShellNavigationRoutes(t *testing.T) {
	handler := NewShellHandler(t.TempDir())
	for _, target := range []string{
		"/dashboard",
		"/dashboard/",
		"/operations",
		"/markets",
		"/markets/BTC-USD",
		"/settings",
		"/logs",
		"/offers",
	} {
		recorder := doRequest(t, handler, http.MethodGet, target)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, quiero %d", target, recorder.Code, http.StatusOK)
		}
		if contentType := recorder.Header().Get("Content-Type"); contentType != "text/html; charset=utf-8" {
			t.Fatalf("%s: Content-Type = %q", target, contentType)
		}
		assertShellDocument(t, recorder.Body.String())
	}
}

func TestShellAPINotSPA(t *testing.T) {
	handler := NewShellHandler(t.TempDir())
	for _, target := range []string{"/api", "/api/whatever", "/api/edge/summary", "/api/unknown/nested"} {
		recorder := doRequest(t, handler, http.MethodGet, target)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s: status = %d, quiero %d", target, recorder.Code, http.StatusNotFound)
		}
		if contentType := recorder.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/json") {
			t.Fatalf("%s: Content-Type = %q", target, contentType)
		}
		if body := recorder.Body.String(); strings.Contains(body, "<!doctype html>") || strings.Contains(body, `id="root"`) {
			t.Fatalf("%s: la API no debe devolver el shell:\n%s", target, body)
		}
		var payload map[string]string
		if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
			t.Fatalf("%s: JSON inválido: %v", target, err)
		}
		if payload["status"] != "not_found" {
			t.Fatalf("%s: status = %q", target, payload["status"])
		}
	}
}

func TestShellAssets(t *testing.T) {
	staticDir := t.TempDir()
	writeShellFixture(t, staticDir, "dashboard/app.js")
	writeShellFixture(t, staticDir, "dashboard/app.css")
	writeShellFixture(t, staticDir, "dashboard/chunk-AbCdEf12.js")
	writeShellFixture(t, staticDir, "icons/icon.svg")
	handler := NewShellHandler(staticDir)

	t.Run("app.js con cache revalidable", func(t *testing.T) {
		recorder := doRequest(t, handler, http.MethodGet, "/dashboard/app.js")
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusOK)
		}
		if got := recorder.Header().Get("Cache-Control"); got != "no-cache" {
			t.Fatalf("Cache-Control = %q, quiero no-cache", got)
		}
		if body := recorder.Body.String(); body != "/* dashboard/app.js */" {
			t.Fatalf("body = %q", body)
		}
	})

	t.Run("bundle con hash inmutable", func(t *testing.T) {
		recorder := doRequest(t, handler, http.MethodGet, "/dashboard/chunk-AbCdEf12.js")
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusOK)
		}
		if got := recorder.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
			t.Fatalf("Cache-Control = %q", got)
		}
	})

	t.Run("icono con cache corta", func(t *testing.T) {
		recorder := doRequest(t, handler, http.MethodGet, "/icons/icon.svg")
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusOK)
		}
		if got := recorder.Header().Get("Cache-Control"); got != "public, max-age=3600" {
			t.Fatalf("Cache-Control = %q", got)
		}
	})

	t.Run("asset inexistente no cae al shell", func(t *testing.T) {
		recorder := doRequest(t, handler, http.MethodGet, "/dashboard/no-existe.js")
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusNotFound)
		}
		if contentType := recorder.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/json") {
			t.Fatalf("Content-Type = %q", contentType)
		}
	})
}

func TestShellNoDirectoryListing(t *testing.T) {
	staticDir := t.TempDir()
	writeShellFixture(t, staticDir, "dashboard/private/secret.txt")
	handler := NewShellHandler(staticDir)

	recorder := doRequest(t, handler, http.MethodGet, "/dashboard/private/")
	body := recorder.Body.String()
	if strings.Contains(body, "secret.txt") || strings.Contains(body, "<pre>") {
		t.Fatalf("se listó el directorio:\n%s", body)
	}
}

func TestShellTraversal(t *testing.T) {
	staticDir := t.TempDir()
	secret := filepath.Join(filepath.Dir(staticDir), "shell-secret.txt")
	if err := os.WriteFile(secret, []byte("secreto-shell"), 0o644); err != nil {
		t.Fatalf("escribir secreto: %v", err)
	}
	t.Cleanup(func() { _ = os.Remove(secret) })
	handler := NewShellHandler(staticDir)

	for _, target := range []string{
		"/../shell-secret.txt",
		"/%2e%2e/shell-secret.txt",
		"/..%2fshell-secret.txt",
		"/%2e%2e%2fshell-secret.txt",
		"/dashboard/../../shell-secret.txt",
		"/..%5cshell-secret.txt",
	} {
		recorder := doRequest(t, handler, http.MethodGet, target)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s: status = %d, quiero %d", target, recorder.Code, http.StatusNotFound)
		}
		if body := recorder.Body.String(); strings.Contains(body, "secreto-shell") || strings.Contains(body, "shell-secret") {
			t.Fatalf("%s filtró el archivo:\n%s", target, body)
		}
	}
}

func TestShellMethodNotAllowed(t *testing.T) {
	handler := NewShellHandler(t.TempDir())
	recorder := doRequest(t, handler, http.MethodPost, "/")
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusMethodNotAllowed)
	}
	if got := recorder.Header().Get("Allow"); got != "GET, HEAD" {
		t.Fatalf("Allow = %q", got)
	}
	if contentType := recorder.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/json") {
		t.Fatalf("Content-Type = %q", contentType)
	}
}

func TestShellHead(t *testing.T) {
	handler := NewShellHandler(t.TempDir())
	recorder := doRequest(t, handler, http.MethodHead, "/")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusOK)
	}
	if recorder.Body.Len() != 0 {
		t.Fatalf("HEAD no debe devolver cuerpo: %q", recorder.Body.String())
	}
}
