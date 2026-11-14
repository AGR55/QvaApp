// Package dashboardauth implementa la autenticación local de `src/dashboard-auth.ts`:
// contraseña, sesión, CSRF, origen exacto y rate-limit por cliente.
package dashboardauth

//lint:file-ignore ST1005 los mensajes son contractuales y deben coincidir con el oráculo

import (
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
)

const sessionCookie = "qvaapply_session"

// Error es un rechazo HTTP de autenticación.
type Error struct {
	Status  int
	Message string
}

func (err *Error) Error() string { return err.Message }

type sessionRecord struct {
	CSRFToken string
	ExpiresAt int64
}

// Options configura la autenticación.
type Options struct {
	Password          string
	TrustedOrigin     string
	Now               func() int64
	SessionDurationMs int64
	CreateToken       func() string
	CreateCSRF        func() string
}

// Auth es el autenticador en memoria.
type Auth struct {
	mu            sync.Mutex
	passwordHash  [32]byte
	trustedOrigin string
	trustedURL    *url.URL
	now           func() int64
	duration      int64
	sessions      map[string]sessionRecord
	attempts      map[string][]int64
	createToken   func() string
	createCSRF    func() string
}

// New crea el autenticador.
func New(options Options) (*Auth, error) {
	if len(options.Password) < 14 {
		return nil, errors.New("DASHBOARD_ADMIN_PASSWORD debe tener al menos 14 caracteres.")
	}
	trusted, err := url.Parse(options.TrustedOrigin)
	if err != nil {
		return nil, err
	}
	now := options.Now
	if now == nil {
		now = func() int64 { return 0 }
	}
	duration := options.SessionDurationMs
	if duration == 0 {
		duration = 8 * 60 * 60 * 1_000
	}
	token := options.CreateToken
	if token == nil {
		token = func() string { return "token" }
	}
	csrf := options.CreateCSRF
	if csrf == nil {
		csrf = func() string { return "csrf" }
	}
	return &Auth{
		passwordHash:  sha256.Sum256([]byte(options.Password)),
		trustedOrigin: trusted.Scheme + "://" + trusted.Host,
		trustedURL:    trusted,
		now:           now,
		duration:      duration,
		sessions:      map[string]sessionRecord{},
		attempts:      map[string][]int64{},
		createToken:   token,
		createCSRF:    csrf,
	}, nil
}

// Login valida la contraseña, aplica rate-limit y crea una sesión.
func (auth *Auth) Login(password, clientID string) (cookie, csrfToken string, expiresAt int64, err error) {
	auth.mu.Lock()
	defer auth.mu.Unlock()
	auth.pruneLocked()
	now := auth.now()
	attempts := auth.attempts[clientID]
	recent := make([]int64, 0, len(attempts))
	for _, timestamp := range attempts {
		if timestamp > now-15*60*1_000 {
			recent = append(recent, timestamp)
		}
	}
	if len(recent) >= 5 {
		return "", "", 0, &Error{Status: 429, Message: "Demasiados intentos. Espera 15 minutos."}
	}
	hash := sha256.Sum256([]byte(password))
	if subtle.ConstantTimeCompare(hash[:], auth.passwordHash[:]) != 1 {
		recent = append(recent, now)
		auth.attempts[clientID] = recent
		return "", "", 0, &Error{Status: 401, Message: "Credenciales incorrectas."}
	}
	delete(auth.attempts, clientID)
	token := auth.createToken()
	csrfToken = auth.createCSRF()
	expiresAt = now + auth.duration
	auth.sessions[tokenKey(token)] = sessionRecord{CSRFToken: csrfToken, ExpiresAt: expiresAt}
	maxAge := (auth.duration + 999) / 1_000
	return fmt.Sprintf("%s=%s; Path=/; HttpOnly; SameSite=Strict; Max-Age=%d", sessionCookie, token, maxAge), csrfToken, expiresAt, nil
}

func (auth *Auth) session(cookieHeader string) (sessionRecord, bool) {
	auth.mu.Lock()
	defer auth.mu.Unlock()
	auth.pruneLocked()
	token := parseCookies(cookieHeader)[sessionCookie]
	record, ok := auth.sessions[tokenKey(token)]
	return record, ok
}

// AssertOrigin valida el origen exacto o un loopback equivalente.
func (auth *Auth) AssertOrigin(origin string) error {
	if origin == "" {
		return &Error{Status: 403, Message: "Origen de solicitud no autorizado."}
	}
	candidate, err := url.Parse(origin)
	if err != nil {
		return &Error{Status: 403, Message: "Origen de solicitud no autorizado."}
	}
	exact := candidate.Scheme+"://"+candidate.Host == auth.trustedOrigin
	equivalent := isLoopback(auth.trustedURL.Hostname()) &&
		isLoopback(candidate.Hostname()) &&
		candidate.Scheme == auth.trustedURL.Scheme &&
		candidate.Port() == auth.trustedURL.Port()
	if exact || equivalent {
		return nil
	}
	return &Error{Status: 403, Message: "Origen de solicitud no autorizado."}
}

// AssertCSRF valida la sesión y el token CSRF.
func (auth *Auth) AssertCSRF(cookieHeader, csrfHeader string) error {
	session, ok := auth.session(cookieHeader)
	if !ok {
		return &Error{Status: 401, Message: "Sesión no válida."}
	}
	if csrfHeader == "" {
		return &Error{Status: 403, Message: "Token CSRF no válido."}
	}
	left := sha256.Sum256([]byte(session.CSRFToken))
	right := sha256.Sum256([]byte(csrfHeader))
	if subtle.ConstantTimeCompare(left[:], right[:]) != 1 {
		return &Error{Status: 403, Message: "Token CSRF no válido."}
	}
	return nil
}

func (auth *Auth) pruneLocked() {
	now := auth.now()
	for key, session := range auth.sessions {
		if session.ExpiresAt <= now {
			delete(auth.sessions, key)
		}
	}
}

func tokenKey(token string) string {
	hash := sha256.Sum256([]byte(token))
	return fmt.Sprintf("%x", hash)
}

func parseCookies(header string) map[string]string {
	result := map[string]string{}
	for _, part := range strings.Split(header, ";") {
		separator := strings.IndexByte(part, '=')
		if separator < 1 {
			continue
		}
		result[strings.TrimSpace(part[:separator])] = strings.TrimSpace(part[separator+1:])
	}
	return result
}

func isLoopback(hostname string) bool {
	switch strings.ToLower(hostname) {
	case "127.0.0.1", "localhost", "[::1]", "::1":
		return true
	default:
		return false
	}
}

// SessionValid indica si la cookie corresponde a una sesión vigente.
func (auth *Auth) SessionValid(cookieHeader string) bool {
	_, ok := auth.session(cookieHeader)
	return ok
}
