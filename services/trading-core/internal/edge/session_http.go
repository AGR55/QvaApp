package edge

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	// maxSessionBodyBytes acota el cuerpo de POST /api/session.
	maxSessionBodyBytes = 4 << 10
	// maxCSRFBodyBytes acota el formulario de DELETE /api/session.
	maxCSRFBodyBytes = 4 << 10
)

// SessionHandler expone las rutas HTTP de sesión del borde. No hace I/O externa:
// toda la criptografía y el estado viven en SessionManager y en las cookies.
//
// Rutas:
//
//	GET    /api/session  estado de la sesión y CSRF para el cliente
//	POST   /api/session  login con contraseña
//	DELETE /api/session  logout con doble envío de CSRF
//
// Cualquier otra ruta o método responde 404 JSON. Ninguna respuesta incluye el
// token de sesión ni la contraseña, y el handler no registra nada.
type SessionHandler struct {
	Manager       *SessionManager
	Password      string
	SecureCookies bool
	TTL           time.Duration
}

// sessionLoginRequest es el cuerpo admitido por POST /api/session.
type sessionLoginRequest struct {
	Password string `json:"password"`
}

// sessionResponse es la representación pública de una sesión autenticada. El
// CSRF sólo se incluye en GET para que el cliente pueda reenviarlo.
type sessionData struct {
	Authenticated bool   `json:"authenticated"`
	CSRFToken     string `json:"csrfToken,omitempty"`
	ExpiresAt     int64  `json:"expiresAt,omitempty"`
}

type sessionResponse struct {
	Authenticated bool        `json:"authenticated"`
	CSRF          string      `json:"csrf,omitempty"`
	Data          sessionData `json:"data"`
}

func (h *SessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")

	if r.URL.Path != "/api/session" {
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
		return
	}
	if h.Manager == nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"status": "session_unavailable"})
		return
	}

	switch r.Method {
	case http.MethodGet:
		h.getSession(w, r)
	case http.MethodPost:
		h.postSession(w, r)
	case http.MethodDelete:
		h.deleteSession(w, r)
	default:
		// Los métodos no soportados no revelan qué verbos existen.
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
	}
}

// getSession verifica la cookie de sesión y devuelve el CSRF asociado. Un
// token ausente, manipulado o expirado produce siempre 401.
func (h *SessionHandler) getSession(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		h.writeUnauthenticated(w)
		return
	}
	session, err := h.Manager.Verify(cookie.Value, time.Now())
	if err != nil {
		h.writeUnauthenticated(w)
		return
	}
	writeJSON(w, http.StatusOK, sessionResponse{
		Authenticated: true, CSRF: session.CSRF,
		Data: sessionData{Authenticated: true, CSRFToken: session.CSRF, ExpiresAt: session.ExpiresAt.UnixMilli()},
	})
}

// postSession valida la contraseña en tiempo constante y emite una sesión
// nueva junto con su CSRF. Errores de cuerpo o credenciales nunca incluyen los
// valores recibidos.
func (h *SessionHandler) postSession(w http.ResponseWriter, r *http.Request) {
	body := http.MaxBytesReader(w, r.Body, maxSessionBodyBytes)
	defer body.Close()

	decoder := json.NewDecoder(body)
	var request sessionLoginRequest
	if err := decoder.Decode(&request); err != nil {
		writeSessionBodyError(w, err)
		return
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		writeSessionBodyError(w, err)
		return
	}

	// Una contraseña configurada vacía deshabilita el login en lugar de
	// permitir autenticarse con un cuerpo vacío.
	if h.Password == "" ||
		subtle.ConstantTimeCompare([]byte(h.Password), []byte(request.Password)) != 1 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"status": "invalid_credentials"})
		return
	}

	token, csrf, err := h.Manager.Issue(time.Now())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"status": "session_unavailable"})
		return
	}

	ttl := h.cookieTTL()
	http.SetCookie(w, SessionCookie(token, h.SecureCookies, ttl))
	http.SetCookie(w, CSRFCookie(csrf, h.SecureCookies, ttl))
	writeJSON(w, http.StatusOK, sessionResponse{
		Authenticated: true, CSRF: csrf,
		Data: sessionData{Authenticated: true, CSRFToken: csrf, ExpiresAt: time.Now().Add(ttl).UnixMilli()},
	})
}

// deleteSession exige sesión y CSRF válidos (cabecera, formulario o query) y
// borra ambas cookies. Cualquier fallo responde 403 sin distinguir la causa.
func (h *SessionHandler) deleteSession(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"status": "forbidden"})
		return
	}

	csrf := requestCSRFToken(r)
	if csrf == "" || !h.Manager.ValidateCSRF(cookie.Value, csrf, time.Now()) {
		writeJSON(w, http.StatusForbidden, map[string]string{"status": "forbidden"})
		return
	}

	http.SetCookie(w, expiredCookie(CookieName, true, h.SecureCookies))
	http.SetCookie(w, expiredCookie(CSRFCookieName, false, h.SecureCookies))
	w.WriteHeader(http.StatusNoContent)
}

func (h *SessionHandler) writeUnauthenticated(w http.ResponseWriter) {
	writeJSON(w, http.StatusUnauthorized, map[string]string{"status": "unauthenticated"})
}

// cookieTTL prefiere el TTL del handler y cae al del manager.
func (h *SessionHandler) cookieTTL() time.Duration {
	if h.TTL > 0 {
		return h.TTL
	}
	if h.Manager != nil {
		return h.Manager.TTL()
	}
	return 0
}

// requestCSRFToken busca el token CSRF en la cabecera X-CSRF-Token, en un
// formulario urlencoded o en la query. El cuerpo del formulario se acota para
// que un DELETE no pueda consumir memoria sin límite.
func requestCSRFToken(r *http.Request) string {
	if token := r.Header.Get("X-CSRF-Token"); token != "" {
		return token
	}

	contentType := strings.ToLower(r.Header.Get("Content-Type"))
	if r.Body != nil && strings.HasPrefix(contentType, "application/x-www-form-urlencoded") {
		body, err := io.ReadAll(io.LimitReader(r.Body, maxCSRFBodyBytes+1))
		if err == nil && len(body) <= maxCSRFBodyBytes {
			values, err := url.ParseQuery(string(body))
			if err == nil {
				if token := values.Get("csrf"); token != "" {
					return token
				}
			}
		}
	}

	return r.URL.Query().Get("csrf")
}

// expiredCookie construye una cookie de borrado con MaxAge -1.
func expiredCookie(name string, httpOnly, secure bool) *http.Cookie {
	return &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: httpOnly,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	}
}

// writeSessionBodyError traduce fallos de lectura/decodificación sin exponer
// el contenido recibido.
func writeSessionBodyError(w http.ResponseWriter, err error) {
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"status": "payload_too_large"})
		return
	}
	writeJSON(w, http.StatusBadRequest, map[string]string{"status": "invalid_body"})
}
