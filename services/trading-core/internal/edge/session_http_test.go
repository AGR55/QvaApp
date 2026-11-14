package edge

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

const sessionTestPassword = "correct horse battery staple"

func newSessionTestManager(t *testing.T, ttl time.Duration) *SessionManager {
	t.Helper()
	secret := make([]byte, minSecretLen)
	for i := range secret {
		secret[i] = byte(i + 1)
	}
	manager, err := NewSessionManager(secret, ttl)
	if err != nil {
		t.Fatalf("NewSessionManager: %v", err)
	}
	return manager
}

func newSessionTestHandler(t *testing.T, secure bool) *SessionHandler {
	t.Helper()
	return &SessionHandler{
		Manager:       newSessionTestManager(t, 15*time.Minute),
		Password:      sessionTestPassword,
		SecureCookies: secure,
		TTL:           15 * time.Minute,
	}
}

func sessionDo(h http.Handler, method, target, body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func sessionLogin(t *testing.T, h http.Handler, password string) *httptest.ResponseRecorder {
	t.Helper()
	return sessionDo(h, http.MethodPost, "/api/session",
		`{"password":"`+password+`"}`,
		map[string]string{"Content-Type": "application/json"})
}

func sessionCookieFrom(t *testing.T, rec *httptest.ResponseRecorder, name string) *http.Cookie {
	t.Helper()
	for _, cookie := range rec.Result().Cookies() {
		if cookie.Name == name {
			return cookie
		}
	}
	t.Fatalf("la respuesta no incluye la cookie %q", name)
	return nil
}

func decodeSessionResponse(t *testing.T, rec *httptest.ResponseRecorder) sessionResponse {
	t.Helper()
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Fatalf("Content-Type = %q, se esperaba JSON", got)
	}
	var body sessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, rec.Body.String())
	}
	return body
}

func TestSessionLoginSuccess(t *testing.T) {
	h := newSessionTestHandler(t, true)
	rec := sessionLogin(t, h, sessionTestPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("login: status = %d, se esperaba 200 (cuerpo %q)", rec.Code, rec.Body.String())
	}

	body := decodeSessionResponse(t, rec)
	if !body.Authenticated {
		t.Fatal("la respuesta de login debería indicar authenticated=true")
	}

	session := sessionCookieFrom(t, rec, CookieName)
	csrf := sessionCookieFrom(t, rec, CSRFCookieName)
	if session.Value == "" || csrf.Value == "" {
		t.Fatal("las cookies emitidas no deben estar vacías")
	}
	if !session.HttpOnly {
		t.Fatal("la cookie de sesión debe ser HttpOnly")
	}
	if csrf.HttpOnly {
		t.Fatal("la cookie CSRF no debe ser HttpOnly")
	}
	if !session.Secure || !csrf.Secure {
		t.Fatal("SecureCookies=true debe propagarse a ambas cookies")
	}
	if session.SameSite != http.SameSiteLaxMode || csrf.SameSite != http.SameSiteLaxMode {
		t.Fatal("ambas cookies deben usar SameSite=Lax")
	}
	if session.Path != "/" || csrf.Path != "/" {
		t.Fatal("ambas cookies deben tener Path=/")
	}
	if session.MaxAge != 900 || csrf.MaxAge != 900 {
		t.Fatalf("MaxAge = %d/%d, se esperaban 900", session.MaxAge, csrf.MaxAge)
	}

	for _, forbidden := range []string{session.Value, sessionTestPassword} {
		if strings.Contains(rec.Body.String(), forbidden) {
			t.Fatal("la respuesta de login filtra un valor sensible")
		}
	}

	// GET con la cookie emitida devuelve el CSRF y nunca el token.
	req := httptest.NewRequest(http.MethodGet, "/api/session", nil)
	req.AddCookie(session)
	getRec := httptest.NewRecorder()
	h.ServeHTTP(getRec, req)
	if getRec.Code != http.StatusOK {
		t.Fatalf("GET autenticado: status = %d, se esperaba 200", getRec.Code)
	}
	getBody := decodeSessionResponse(t, getRec)
	if !getBody.Authenticated {
		t.Fatal("GET autenticado debería indicar authenticated=true")
	}
	if getBody.CSRF != csrf.Value {
		t.Fatal("GET debe devolver el CSRF ligado a la sesión")
	}
	for _, forbidden := range []string{session.Value, sessionTestPassword} {
		if strings.Contains(getRec.Body.String(), forbidden) {
			t.Fatal("la respuesta GET filtra un valor sensible")
		}
	}
}

func TestSessionLoginWrongPassword(t *testing.T) {
	h := newSessionTestHandler(t, true)
	for _, password := range []string{"", "incorrecta", sessionTestPassword + "x"} {
		rec := sessionLogin(t, h, password)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("contraseña %q: status = %d, se esperaba 401", password, rec.Code)
		}
		if cookies := rec.Result().Cookies(); len(cookies) != 0 {
			t.Fatalf("contraseña %q: no debería emitir cookies", password)
		}
		if password != "" && strings.Contains(rec.Body.String(), password) {
			t.Fatal("la respuesta de error filtra la contraseña recibida")
		}
	}
}

func TestSessionLoginDisabledWhenPasswordUnset(t *testing.T) {
	h := newSessionTestHandler(t, true)
	h.Password = ""

	for _, password := range []string{"", sessionTestPassword} {
		rec := sessionLogin(t, h, password)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("password configurada vacía, intento %q: status = %d, se esperaba 401", password, rec.Code)
		}
		if cookies := rec.Result().Cookies(); len(cookies) != 0 {
			t.Fatal("password vacía no debe emitir cookies")
		}
	}
}

func TestSessionLoginRejectsOversizedBody(t *testing.T) {
	h := newSessionTestHandler(t, true)
	oversized := strings.Repeat("a", maxSessionBodyBytes)
	rec := sessionLogin(t, h, oversized)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("cuerpo de %d bytes: status = %d, se esperaba 413 (cuerpo %q)",
			len(oversized), rec.Code, rec.Body.String())
	}
	if cookies := rec.Result().Cookies(); len(cookies) != 0 {
		t.Fatal("un cuerpo demasiado grande no debe emitir cookies")
	}
}

func TestSessionLoginRejectsMalformedBody(t *testing.T) {
	h := newSessionTestHandler(t, true)
	for _, body := range []string{
		"{",
		`{"password":123}`,
		`{"password":"x"} {"password":"y"}`,
		`"sólo-un-string"`,
	} {
		rec := sessionDo(h, http.MethodPost, "/api/session", body,
			map[string]string{"Content-Type": "application/json"})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("cuerpo %q: status = %d, se esperaba 400", body, rec.Code)
		}
		if cookies := rec.Result().Cookies(); len(cookies) != 0 {
			t.Fatalf("cuerpo %q: no debería emitir cookies", body)
		}
	}
}

func TestSessionGetUnauthenticated(t *testing.T) {
	h := newSessionTestHandler(t, true)
	expiredToken, _, err := h.Manager.Issue(time.Now().Add(-h.Manager.TTL() - time.Minute))
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	cases := []struct {
		name   string
		cookie *http.Cookie
	}{
		{name: "sin cookie"},
		{name: "cookie vacía", cookie: &http.Cookie{Name: CookieName, Value: ""}},
		{name: "token inválido", cookie: &http.Cookie{Name: CookieName, Value: "no-es-un-token"}},
		{name: "token expirado", cookie: &http.Cookie{Name: CookieName, Value: expiredToken}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/session", nil)
			if tc.cookie != nil {
				req.AddCookie(tc.cookie)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, se esperaba 401", rec.Code)
			}
			decodeSessionResponse(t, rec) // valida que el cuerpo es JSON
			if tc.cookie != nil && tc.cookie.Value != "" &&
				strings.Contains(rec.Body.String(), tc.cookie.Value) {
				t.Fatal("la respuesta 401 filtra el token recibido")
			}
		})
	}
}

func TestSessionDeleteWithCSRFHeader(t *testing.T) {
	h := newSessionTestHandler(t, true)
	session, csrf, _ := sessionLoginCookies(t, h)

	req := httptest.NewRequest(http.MethodDelete, "/api/session", nil)
	req.AddCookie(session)
	req.Header.Set("X-CSRF-Token", csrf.Value)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("logout: status = %d, se esperaba 204 (cuerpo %q)", rec.Code, rec.Body.String())
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("204 no debe llevar cuerpo: %q", rec.Body.String())
	}

	clearedSession := sessionCookieFrom(t, rec, CookieName)
	clearedCSRF := sessionCookieFrom(t, rec, CSRFCookieName)
	if clearedSession.Value != "" || clearedCSRF.Value != "" {
		t.Fatal("las cookies borradas deben quedar vacías")
	}
	if clearedSession.MaxAge >= 0 || clearedCSRF.MaxAge >= 0 {
		t.Fatalf("las cookies deben borrarse con MaxAge negativo: %d/%d",
			clearedSession.MaxAge, clearedCSRF.MaxAge)
	}
	if !clearedSession.HttpOnly {
		t.Fatal("la cookie de sesión borrada debe conservar HttpOnly")
	}
	if clearedCSRF.HttpOnly {
		t.Fatal("la cookie CSRF borrada no debe ser HttpOnly")
	}
	if !clearedSession.Secure || !clearedCSRF.Secure {
		t.Fatal("SecureCookies=true debe propagarse al borrar")
	}
}

func TestSessionDeleteRejectsInvalidCSRF(t *testing.T) {
	h := newSessionTestHandler(t, true)
	session, csrf, _ := sessionLoginCookies(t, h)
	_, otherCSRF, _ := sessionLoginCookies(t, h)
	expiredToken, expiredCSRF, err := h.Manager.Issue(time.Now().Add(-h.Manager.TTL() - time.Minute))
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	cases := []struct {
		name      string
		cookie    *http.Cookie
		csrf      string
		headerSet bool
	}{
		{name: "sin CSRF", cookie: session, headerSet: false},
		{name: "CSRF incorrecto", cookie: session, csrf: "incorrecto", headerSet: true},
		{name: "CSRF de otra sesión", cookie: session, csrf: otherCSRF.Value, headerSet: true},
		{name: "sin cookie de sesión", csrf: csrf.Value, headerSet: true},
		{name: "cookie de sesión vacía", cookie: &http.Cookie{Name: CookieName, Value: ""}, csrf: csrf.Value, headerSet: true},
		{name: "sesión expirada", cookie: &http.Cookie{Name: CookieName, Value: expiredToken}, csrf: expiredCSRF, headerSet: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodDelete, "/api/session", nil)
			if tc.cookie != nil {
				req.AddCookie(tc.cookie)
			}
			if tc.headerSet {
				req.Header.Set("X-CSRF-Token", tc.csrf)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != http.StatusForbidden {
				t.Fatalf("status = %d, se esperaba 403", rec.Code)
			}
			if cookies := rec.Result().Cookies(); len(cookies) != 0 {
				t.Fatal("un logout rechazado no debe tocar las cookies")
			}
			decodeSessionResponse(t, rec)
			if tc.csrf != "" && strings.Contains(rec.Body.String(), tc.csrf) {
				t.Fatal("la respuesta 403 filtra el CSRF recibido")
			}
		})
	}
}

func TestSessionDeleteWithFormCSRF(t *testing.T) {
	h := newSessionTestHandler(t, false)
	session, csrf, _ := sessionLoginCookies(t, h)

	form := url.Values{"csrf": {csrf.Value}}.Encode()
	req := httptest.NewRequest(http.MethodDelete, "/api/session", strings.NewReader(form))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(session)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("logout por formulario: status = %d, se esperaba 204 (cuerpo %q)",
			rec.Code, rec.Body.String())
	}
}

func TestSessionDeleteWithQueryCSRF(t *testing.T) {
	h := newSessionTestHandler(t, false)
	session, csrf, _ := sessionLoginCookies(t, h)

	target := "/api/session?csrf=" + url.QueryEscape(csrf.Value)
	req := httptest.NewRequest(http.MethodDelete, target, nil)
	req.AddCookie(session)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("logout por query: status = %d, se esperaba 204 (cuerpo %q)",
			rec.Code, rec.Body.String())
	}
}

func TestSessionUnsupportedMethodsAndRoutes(t *testing.T) {
	h := newSessionTestHandler(t, false)

	for _, method := range []string{
		http.MethodPut,
		http.MethodPatch,
		http.MethodHead,
		http.MethodOptions,
	} {
		rec := sessionDo(h, method, "/api/session", "", nil)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s /api/session: status = %d, se esperaba 404", method, rec.Code)
		}
		decodeSessionResponse(t, rec)
	}

	for _, target := range []string{
		"/api/session/",
		"/api/sessions",
		"/api/otra",
		"/",
	} {
		rec := sessionDo(h, http.MethodGet, target, "", nil)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("GET %s: status = %d, se esperaba 404", target, rec.Code)
		}
		decodeSessionResponse(t, rec)
	}
}

func TestSessionSecureCookieConfigurable(t *testing.T) {
	for _, secure := range []bool{true, false} {
		h := newSessionTestHandler(t, secure)
		session, csrf, _ := sessionLoginCookies(t, h)
		if session.Secure != secure || csrf.Secure != secure {
			t.Fatalf("SecureCookies=%v: Secure = %v/%v", secure, session.Secure, csrf.Secure)
		}

		req := httptest.NewRequest(http.MethodDelete, "/api/session", nil)
		req.AddCookie(session)
		req.Header.Set("X-CSRF-Token", csrf.Value)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("SecureCookies=%v: logout status = %d", secure, rec.Code)
		}
		clearedSession := sessionCookieFrom(t, rec, CookieName)
		clearedCSRF := sessionCookieFrom(t, rec, CSRFCookieName)
		if clearedSession.Secure != secure || clearedCSRF.Secure != secure {
			t.Fatalf("SecureCookies=%v: cookies borradas Secure = %v/%v",
				secure, clearedSession.Secure, clearedCSRF.Secure)
		}
	}
}

func TestSessionHandlerTTL(t *testing.T) {
	h := newSessionTestHandler(t, false)
	h.TTL = time.Minute
	session, _, _ := sessionLoginCookies(t, h)
	if session.MaxAge != 60 {
		t.Fatalf("TTL del handler: MaxAge = %d, se esperaban 60", session.MaxAge)
	}

	h.TTL = 0 // cae al TTL del manager
	session, _, _ = sessionLoginCookies(t, h)
	if session.MaxAge != 900 {
		t.Fatalf("TTL del manager: MaxAge = %d, se esperaban 900", session.MaxAge)
	}
}

func TestSessionNilManager(t *testing.T) {
	h := &SessionHandler{Password: sessionTestPassword}
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodDelete} {
		rec := sessionDo(h, method, "/api/session", `{"password":"`+sessionTestPassword+`"}`, nil)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("%s con manager nil: status = %d, se esperaba 500", method, rec.Code)
		}
	}
}

// sessionLoginCookies hace login y devuelve las dos cookies emitidas.
func sessionLoginCookies(t *testing.T, h *SessionHandler) (*http.Cookie, *http.Cookie, *httptest.ResponseRecorder) {
	t.Helper()
	rec := sessionLogin(t, h, sessionTestPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("login: status = %d (cuerpo %q)", rec.Code, rec.Body.String())
	}
	return sessionCookieFrom(t, rec, CookieName), sessionCookieFrom(t, rec, CSRFCookieName), rec
}
