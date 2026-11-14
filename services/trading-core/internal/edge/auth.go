package edge

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Primitivas de autenticación del borde: tokens de sesión stateless firmados con
// HMAC-SHA256 y tokens CSRF ligados a la sesión. Este archivo es puro: no hace
// I/O, no guarda sesiones y no registra tokens ni secretos.
const (
	// CookieName es la cookie que transporta el token de sesión.
	CookieName = "qva_edge_session"
	// CSRFCookieName es la cookie que transporta el token CSRF. No es HttpOnly
	// porque el cliente debe poder leerla para el patrón double-submit.
	CSRFCookieName = "qva_edge_csrf"

	// sessionVersion versiona el payload firmado. Cambiarlo invalida los tokens
	// emitidos con versiones anteriores.
	sessionVersion = 1
	// minSecretLen es la longitud mínima exigida al secreto HMAC.
	minSecretLen = 32
	// csrfBytes es la entropía del token CSRF antes de codificar.
	csrfBytes = 32
	// maxTokenLen acota la entrada para evitar trabajo innecesario con valores
	// arbitrariamente grandes.
	maxTokenLen = 2048
)

// Errores centinela. Nunca incluyen el token, el CSRF ni el secreto.
var (
	ErrShortSecret        = errors.New("edge: session secret must be at least 32 bytes")
	ErrInvalidTTL         = errors.New("edge: session ttl must be positive")
	ErrNilSessionManager  = errors.New("edge: nil session manager")
	ErrMalformedToken     = errors.New("edge: malformed session token")
	ErrInvalidSignature   = errors.New("edge: invalid session token signature")
	ErrUnsupportedVersion = errors.New("edge: unsupported session token version")
	ErrExpiredSession     = errors.New("edge: session token expired")
)

// sessionSigningContext separa el uso de la clave HMAC de otros protocolos que
// pudieran compartir el mismo secreto.
var sessionSigningContext = []byte("qva.edge.session.v1\x00")

// Session es el contenido autenticado de un token de sesión.
type Session struct {
	CreatedAt time.Time
	ExpiresAt time.Time
	CSRF      string
}

// SessionManager emite y valida tokens de sesión stateless. Es inmutable una
// vez construido, por lo que es seguro usarlo desde varias goroutines.
type SessionManager struct {
	secret []byte
	ttl    time.Duration
}

// payload es la representación serializada y firmada del token.
type payload struct {
	Version   int    `json:"v"`
	IssuedAt  int64  `json:"iat"` // UnixNano
	ExpiresAt int64  `json:"exp"` // UnixNano
	CSRF      string `json:"csrf"`
}

// NewSessionManager construye un gestor con secreto HMAC y TTL positivos. El
// secreto se copia: el llamador puede reutilizar o limpiar su slice.
func NewSessionManager(secret []byte, ttl time.Duration) (*SessionManager, error) {
	if len(secret) < minSecretLen {
		return nil, ErrShortSecret
	}
	if ttl <= 0 {
		return nil, ErrInvalidTTL
	}
	cloned := make([]byte, len(secret))
	copy(cloned, secret)
	return &SessionManager{secret: cloned, ttl: ttl}, nil
}

// Issue genera un token de sesión y su CSRF asociado. El CSRF es aleatorio
// (32 bytes) y viaja dentro del payload firmado, de modo que Verify lo
// recupera y ValidateCSRF puede comprobarlo contra el token.
func (m *SessionManager) Issue(now time.Time) (token string, csrf string, err error) {
	if m == nil {
		return "", "", ErrNilSessionManager
	}

	rawCSRF := make([]byte, csrfBytes)
	if _, err := rand.Read(rawCSRF); err != nil {
		return "", "", fmt.Errorf("edge: generate csrf: %w", err)
	}
	csrf = base64.RawURLEncoding.EncodeToString(rawCSRF)

	expiresAt := now.Add(m.ttl)
	p := payload{
		Version:   sessionVersion,
		IssuedAt:  now.UnixNano(),
		ExpiresAt: expiresAt.UnixNano(),
		CSRF:      csrf,
	}
	encoded, err := encodePayload(p)
	if err != nil {
		return "", "", err
	}
	return encoded + "." + m.sign(encoded), csrf, nil
}

// Verify comprueba firma, versión y expiración (en ese orden) y devuelve el
// contenido autenticado. Un token expirado devuelve ErrExpiredSession.
func (m *SessionManager) Verify(token string, now time.Time) (Session, error) {
	if m == nil {
		return Session{}, ErrNilSessionManager
	}
	if len(token) == 0 || len(token) > maxTokenLen {
		return Session{}, ErrMalformedToken
	}

	encoded, signature, ok := strings.Cut(token, ".")
	if !ok || encoded == "" || signature == "" || strings.ContainsRune(signature, '.') {
		return Session{}, ErrMalformedToken
	}
	provided, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil || len(provided) != sha256.Size {
		return Session{}, ErrMalformedToken
	}
	if !hmac.Equal(provided, m.mac(encoded)) {
		return Session{}, ErrInvalidSignature
	}

	p, err := decodePayload(encoded)
	if err != nil {
		return Session{}, err
	}
	if p.Version != sessionVersion {
		return Session{}, ErrUnsupportedVersion
	}
	expiresAt := time.Unix(0, p.ExpiresAt)
	if !now.Before(expiresAt) {
		return Session{}, ErrExpiredSession
	}

	return Session{
		CreatedAt: time.Unix(0, p.IssuedAt),
		ExpiresAt: expiresAt,
		CSRF:      p.CSRF,
	}, nil
}

// ValidateCSRF comprueba en tiempo constante que csrf corresponde al token y
// que el token sigue vigente. Cualquier error de Verify produce false.
func (m *SessionManager) ValidateCSRF(token, csrf string, now time.Time) bool {
	session, err := m.Verify(token, now)
	if err != nil || session.CSRF == "" || csrf == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(session.CSRF), []byte(csrf)) == 1
}

// TTL devuelve la vida útil configurada para las sesiones.
func (m *SessionManager) TTL() time.Duration {
	if m == nil {
		return 0
	}
	return m.ttl
}

// SessionCookie construye la cookie de sesión: HttpOnly, SameSite=Lax y Path=/.
func SessionCookie(token string, secure bool, ttl time.Duration) *http.Cookie {
	return &http.Cookie{
		Name:     CookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   cookieMaxAge(ttl),
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	}
}

// CSRFCookie construye la cookie CSRF. Deliberadamente no es HttpOnly: el
// cliente la lee para reenviarla en una cabecera y compararla en el servidor.
func CSRFCookie(csrf string, secure bool, ttl time.Duration) *http.Cookie {
	return &http.Cookie{
		Name:     CSRFCookieName,
		Value:    csrf,
		Path:     "/",
		MaxAge:   cookieMaxAge(ttl),
		HttpOnly: false,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	}
}

// cookieMaxAge convierte un TTL a segundos redondeando hacia arriba. Un TTL no
// positivo produce una cookie de sesión (MaxAge 0).
func cookieMaxAge(ttl time.Duration) int {
	if ttl <= 0 {
		return 0
	}
	seconds := int64((ttl + time.Second - 1) / time.Second)
	if seconds < 1 {
		return 1
	}
	if seconds > int64(^uint(0)>>1) {
		return int(^uint(0) >> 1)
	}
	return int(seconds)
}

func (m *SessionManager) mac(encoded string) []byte {
	h := hmac.New(sha256.New, m.secret)
	h.Write(sessionSigningContext)
	h.Write([]byte(encoded))
	return h.Sum(nil)
}

func (m *SessionManager) sign(encoded string) string {
	return base64.RawURLEncoding.EncodeToString(m.mac(encoded))
}

func encodePayload(p payload) (string, error) {
	raw, err := json.Marshal(p)
	if err != nil {
		return "", fmt.Errorf("edge: encode session payload: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func decodePayload(encoded string) (payload, error) {
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return payload{}, ErrMalformedToken
	}
	var p payload
	if err := json.Unmarshal(raw, &p); err != nil {
		return payload{}, ErrMalformedToken
	}
	if p.CSRF == "" {
		return payload{}, ErrMalformedToken
	}
	return p, nil
}
