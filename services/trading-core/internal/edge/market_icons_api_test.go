package edge

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	marketIconsTestTarget = "https://panel.example/api/market-icons"
	marketIconsTestOrigin = "https://panel.example"
)

func newMarketIconsTestAPI(t *testing.T) (*MarketIconsAPI, string, *http.Cookie, string) {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, "market-icons")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatalf("Mkdir: %v", err)
	}
	manager := newSessionTestManager(t, time.Hour)
	now := time.UnixMilli(1_700_000_000_000)
	token, csrf, err := manager.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	api := &MarketIconsAPI{
		Sessions:      manager,
		Dir:           dir,
		TrustedOrigin: marketIconsTestOrigin,
		Now:           func() time.Time { return now },
	}
	return api, root, &http.Cookie{Name: CookieName, Value: token}, csrf
}

func marketIconsTestPayload(t *testing.T, name, mimeType string, content []byte) string {
	t.Helper()
	raw, err := json.Marshal(marketIconsRequest{
		Name:     name,
		MIMEType: mimeType,
		Base64:   base64.StdEncoding.EncodeToString(content),
	})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	return string(raw)
}

func marketIconsDo(
	api *MarketIconsAPI,
	method, target, body string,
	cookie *http.Cookie,
	csrf, origin string,
) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	if cookie != nil {
		request.AddCookie(cookie)
	}
	if csrf != "" {
		request.Header.Set("X-CSRF-Token", csrf)
	}
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	recorder := httptest.NewRecorder()
	api.ServeHTTP(recorder, request)
	return recorder
}

func marketIconsTestError(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	var payload struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return payload.Error
}

func TestMarketIconsAPIUploads(t *testing.T) {
	api, _, cookie, csrf := newMarketIconsTestAPI(t)

	cases := []struct {
		name    string
		mime    string
		content []byte
	}{
		{"logo.png", "image/png", []byte("\x89PNG\r\n\x1a\nicono")},
		{"photo.jpg", "image/jpeg", []byte("\xff\xd8\xff\xe0icono")},
		{"photo.jpeg", "image/jpeg", []byte("\xff\xd8\xff\xe1icono")},
		{"mark.webp", "image/webp", []byte("RIFF\x00\x00\x00\x00WEBPicono")},
		{"mark.svg", "image/svg+xml", []byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>`)},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := marketIconsDo(
				api, http.MethodPost, marketIconsTestTarget,
				marketIconsTestPayload(t, testCase.name, testCase.mime, testCase.content),
				cookie, csrf, marketIconsTestOrigin,
			)
			if recorder.Code != http.StatusCreated {
				t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
			}
			if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
				t.Fatalf("Cache-Control = %q", got)
			}
			if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
				t.Fatalf("X-Content-Type-Options = %q", got)
			}
			if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
				t.Fatalf("Content-Type = %q", got)
			}

			var payload marketIconsResponse
			if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
				t.Fatalf("respuesta: %v (cuerpo %q)", err, recorder.Body.String())
			}
			wantURL := "/market-icons/" + testCase.name
			if payload.Data.URL != wantURL {
				t.Fatalf("url = %q, quiero %q", payload.Data.URL, wantURL)
			}

			target := filepath.Join(api.Dir, testCase.name)
			saved, err := os.ReadFile(target)
			if err != nil {
				t.Fatalf("ReadFile(%s): %v", testCase.name, err)
			}
			if !bytes.Equal(saved, testCase.content) {
				t.Fatalf("contenido guardado = %q, quiero %q", saved, testCase.content)
			}
			info, err := os.Stat(target)
			if err != nil {
				t.Fatalf("Stat(%s): %v", testCase.name, err)
			}
			if info.Mode().Perm() != 0o644 {
				t.Fatalf("permisos = %o, quiero 644", info.Mode().Perm())
			}
		})
	}

	entries, err := os.ReadDir(api.Dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(entries) != len(cases) {
		t.Fatalf("archivos = %d, quiero %d", len(entries), len(cases))
	}
}

func TestMarketIconsAPISVGRejected(t *testing.T) {
	api, _, cookie, csrf := newMarketIconsTestAPI(t)
	svg := []string{
		`<svg><script>alert(1)</script></svg>`,
		`<svg><SCRIPT>alert(1)</SCRIPT></svg>`,
		`<svg onload="alert(1)"></svg>`,
		`<svg><image onerror="alert(1)"/></svg>`,
		`<svg><a href="javascript:alert(1)"></a></svg>`,
		`<svg><foreignObject></foreignObject></svg>`,
		`<svg><FOREIGNOBJECT></FOREIGNOBJECT></svg>`,
	}
	for index, content := range svg {
		t.Run(string(rune('a'+index)), func(t *testing.T) {
			recorder := marketIconsDo(
				api, http.MethodPost, marketIconsTestTarget,
				marketIconsTestPayload(t, "bad.svg", "image/svg+xml", []byte(content)),
				cookie, csrf, marketIconsTestOrigin,
			)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
			}
			if got := marketIconsTestError(t, recorder); got != "SVG no permitido." {
				t.Fatalf("error = %q", got)
			}
			if _, err := os.Stat(filepath.Join(api.Dir, "bad.svg")); !os.IsNotExist(err) {
				t.Fatalf("SVG rechazado dejó archivo (err=%v)", err)
			}
		})
	}
}

func TestMarketIconsAPIValidation(t *testing.T) {
	api, root, cookie, csrf := newMarketIconsTestAPI(t)
	png := []byte("\x89PNG\r\n\x1a\nicono")

	tooLarge := make([]byte, maxMarketIconsBytes+1)
	cases := []struct {
		name string
		body string
	}{
		{"mime no coincide", marketIconsTestPayload(t, "icon.png", "image/jpeg", png)},
		{"extensión no permitida", marketIconsTestPayload(t, "icon.gif", "image/png", png)},
		{"sin extensión", marketIconsTestPayload(t, "icon", "image/png", png)},
		{"extensión mayúscula", marketIconsTestPayload(t, "ICON.PNG", "image/png", png)},
		{"solo extensión", marketIconsTestPayload(t, ".png", "image/png", png)},
		{"traversal relativo", marketIconsTestPayload(t, "../evil.png", "image/png", png)},
		{"traversal anidado", marketIconsTestPayload(t, "nested/evil.png", "image/png", png)},
		{"doble punto", marketIconsTestPayload(t, "a..b.png", "image/png", png)},
		{"nombre vacío", marketIconsTestPayload(t, "", "image/png", png)},
		{"nombre largo", marketIconsTestPayload(t, strings.Repeat("a", 117)+".png", "image/png", png)},
		{"mime desconocido", marketIconsTestPayload(t, "icon.png", "image/gif", png)},
		{"base64 inválido", `{"name":"icon.png","mimeType":"image/png","base64":"%%%"}`},
		{"base64 vacío", `{"name":"icon.png","mimeType":"image/png","base64":""}`},
		{"base64 demasiado grande", marketIconsTestPayload(t, "icon.png", "image/png", tooLarge)},
		{"json inválido", `no-es-json`},
		{"json con datos extra", marketIconsTestPayload(t, "icon.png", "image/png", png) + `{}`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := marketIconsDo(
				api, http.MethodPost, marketIconsTestTarget, testCase.body,
				cookie, csrf, marketIconsTestOrigin,
			)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
			}
		})
	}

	entries, err := os.ReadDir(api.Dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("archivos inesperados: %v", entries)
	}
	if _, err := os.Stat(filepath.Join(root, "evil.png")); !os.IsNotExist(err) {
		t.Fatalf("traversal escribió fuera de Dir (err=%v)", err)
	}
	if _, err := os.Stat(filepath.Join(root, "nested", "evil.png")); !os.IsNotExist(err) {
		t.Fatalf("traversal anidado escribió fuera de Dir (err=%v)", err)
	}
}

func TestMarketIconsAPIBodyTooLarge(t *testing.T) {
	api, _, cookie, csrf := newMarketIconsTestAPI(t)
	body := `{"name":"big.png","mimeType":"image/png","base64":"` +
		strings.Repeat("A", maxMarketIconsBodyBytes+1) + `"}`

	recorder := marketIconsDo(
		api, http.MethodPost, marketIconsTestTarget, body,
		cookie, csrf, marketIconsTestOrigin,
	)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	if _, err := os.Stat(filepath.Join(api.Dir, "big.png")); !os.IsNotExist(err) {
		t.Fatalf("cuerpo grande dejó archivo (err=%v)", err)
	}
}

func TestMarketIconsAPIAuth(t *testing.T) {
	api, _, cookie, csrf := newMarketIconsTestAPI(t)
	body := marketIconsTestPayload(t, "icon.png", "image/png", []byte("\x89PNG\r\n\x1a\nicono"))

	anonymous := marketIconsDo(
		api, http.MethodPost, marketIconsTestTarget, body,
		nil, csrf, marketIconsTestOrigin,
	)
	if anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("sin cookie: %d", anonymous.Code)
	}
	if got := marketIconsTestError(t, anonymous); got != "Autenticación requerida." {
		t.Fatalf("error = %q", got)
	}

	tampered := marketIconsDo(
		api, http.MethodPost, marketIconsTestTarget, body,
		&http.Cookie{Name: CookieName, Value: cookie.Value + "x"}, csrf, marketIconsTestOrigin,
	)
	if tampered.Code != http.StatusUnauthorized {
		t.Fatalf("cookie manipulada: %d", tampered.Code)
	}

	api.Sessions = nil
	nilManager := marketIconsDo(
		api, http.MethodPost, marketIconsTestTarget, body,
		cookie, csrf, marketIconsTestOrigin,
	)
	if nilManager.Code != http.StatusUnauthorized {
		t.Fatalf("manager nil: %d", nilManager.Code)
	}
}

func TestMarketIconsAPICSRFAndOrigin(t *testing.T) {
	api, _, cookie, csrf := newMarketIconsTestAPI(t)
	body := marketIconsTestPayload(t, "icon.png", "image/png", []byte("\x89PNG\r\n\x1a\nicono"))

	cases := []struct {
		name   string
		csrf   string
		origin string
	}{
		{"sin csrf", "", marketIconsTestOrigin},
		{"csrf incorrecto", "otro-token", marketIconsTestOrigin},
		{"origen no autorizado", csrf, "https://evil.example"},
		{"sin origen", csrf, ""},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := marketIconsDo(
				api, http.MethodPost, marketIconsTestTarget, body,
				cookie, testCase.csrf, testCase.origin,
			)
			if recorder.Code != http.StatusForbidden {
				t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
			}
			if got := marketIconsTestError(t, recorder); got != "CSRF inválido." {
				t.Fatalf("error = %q", got)
			}
			if _, err := os.Stat(filepath.Join(api.Dir, "icon.png")); !os.IsNotExist(err) {
				t.Fatalf("petición rechazada dejó archivo (err=%v)", err)
			}
		})
	}

	// Sin TrustedOrigin configurado, same-origin sigue siendo aceptable.
	api.TrustedOrigin = ""
	recorder := marketIconsDo(
		api, http.MethodPost, marketIconsTestTarget, body,
		cookie, csrf, marketIconsTestOrigin,
	)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("same-origin: %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
}

func TestMarketIconsAPIMethodsAndRoutes(t *testing.T) {
	api, _, cookie, csrf := newMarketIconsTestAPI(t)
	body := marketIconsTestPayload(t, "icon.png", "image/png", []byte("\x89PNG\r\n\x1a\nicono"))

	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		recorder := marketIconsDo(
			api, method, marketIconsTestTarget, body,
			cookie, csrf, marketIconsTestOrigin,
		)
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s: status = %d", method, recorder.Code)
		}
		if got := recorder.Header().Get("Allow"); got != http.MethodPost {
			t.Fatalf("%s: Allow = %q", method, got)
		}
		if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
			t.Fatalf("%s: Cache-Control = %q", method, got)
		}
		if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Fatalf("%s: CORS inesperado %q", method, got)
		}
	}

	for _, target := range []string{
		"https://panel.example/api/market-icons/otra",
		"https://panel.example/api/market-icons/",
	} {
		recorder := marketIconsDo(
			api, http.MethodPost, target, body,
			cookie, csrf, marketIconsTestOrigin,
		)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s: status = %d", target, recorder.Code)
		}
		if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
			t.Fatalf("%s: Content-Type = %q", target, got)
		}
		if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Fatalf("%s: X-Content-Type-Options = %q", target, got)
		}
	}
}

func TestMarketIconsAPIStorageFailure(t *testing.T) {
	api, root, cookie, csrf := newMarketIconsTestAPI(t)
	api.Dir = filepath.Join(root, "missing")
	body := marketIconsTestPayload(t, "icon.png", "image/png", []byte("\x89PNG\r\n\x1a\nicono"))

	recorder := marketIconsDo(
		api, http.MethodPost, marketIconsTestTarget, body,
		cookie, csrf, marketIconsTestOrigin,
	)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	if got := marketIconsTestError(t, recorder); got != "No se pudo guardar el icono." {
		t.Fatalf("error = %q", got)
	}
	if strings.Contains(recorder.Body.String(), "missing") {
		t.Fatalf("la respuesta filtró la ruta: %q", recorder.Body.String())
	}
}
