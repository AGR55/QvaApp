package edge

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

func testSecret(t *testing.T) []byte {
	t.Helper()
	secret := make([]byte, minSecretLen)
	if _, err := rand.Read(secret); err != nil {
		t.Fatalf("generar secreto: %v", err)
	}
	return secret
}

func testManager(t *testing.T) *SessionManager {
	t.Helper()
	m, err := NewSessionManager(testSecret(t), 15*time.Minute)
	if err != nil {
		t.Fatalf("NewSessionManager: %v", err)
	}
	return m
}

func TestNewSessionManagerRejectsShortSecret(t *testing.T) {
	if _, err := NewSessionManager(nil, time.Minute); !errors.Is(err, ErrShortSecret) {
		t.Fatalf("secreto nil: err = %v, se esperaba ErrShortSecret", err)
	}
	if _, err := NewSessionManager(make([]byte, minSecretLen-1), time.Minute); !errors.Is(err, ErrShortSecret) {
		t.Fatalf("secreto corto: err = %v, se esperaba ErrShortSecret", err)
	}
	if _, err := NewSessionManager(make([]byte, minSecretLen), time.Minute); err != nil {
		t.Fatalf("secreto de %d bytes debería aceptarse: %v", minSecretLen, err)
	}
}

func TestNewSessionManagerRejectsNonPositiveTTL(t *testing.T) {
	for _, ttl := range []time.Duration{0, -time.Second} {
		if _, err := NewSessionManager(testSecret(t), ttl); !errors.Is(err, ErrInvalidTTL) {
			t.Fatalf("ttl %v: err = %v, se esperaba ErrInvalidTTL", ttl, err)
		}
	}
}

func TestNewSessionManagerCopiesSecret(t *testing.T) {
	secret := testSecret(t)
	m, err := NewSessionManager(secret, time.Minute)
	if err != nil {
		t.Fatalf("NewSessionManager: %v", err)
	}
	for i := range secret {
		secret[i] = 0
	}
	now := time.Now()
	token, csrf, err := m.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if _, err := m.Verify(token, now); err != nil {
		t.Fatalf("Verify tras mutar el slice original: %v", err)
	}
	if !m.ValidateCSRF(token, csrf, now) {
		t.Fatal("ValidateCSRF debería aceptar el token emitido")
	}
}

func TestIssueVerifyRoundTrip(t *testing.T) {
	m := testManager(t)
	now := time.Now().UTC().Truncate(time.Nanosecond)

	token, csrf, err := m.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if token == "" || csrf == "" {
		t.Fatal("Issue devolvió token o csrf vacío")
	}
	if strings.Count(token, ".") != 1 {
		t.Fatalf("el token debe tener dos segmentos separados por un punto: %q", token)
	}
	for _, part := range strings.Split(token, ".") {
		if part == "" {
			t.Fatal("el token contiene un segmento vacío")
		}
	}

	rawCSRF, err := base64.RawURLEncoding.DecodeString(csrf)
	if err != nil {
		t.Fatalf("csrf no es base64url sin padding: %v", err)
	}
	if len(rawCSRF) != csrfBytes {
		t.Fatalf("csrf decodificado = %d bytes, se esperaban %d", len(rawCSRF), csrfBytes)
	}

	session, err := m.Verify(token, now)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if !session.CreatedAt.Equal(now) {
		t.Fatalf("CreatedAt = %v, se esperaba %v", session.CreatedAt, now)
	}
	if !session.ExpiresAt.Equal(now.Add(m.TTL())) {
		t.Fatalf("ExpiresAt = %v, se esperaba %v", session.ExpiresAt, now.Add(m.TTL()))
	}
	if session.CSRF != csrf {
		t.Fatalf("Verify devolvió un CSRF distinto del emitido")
	}
	if m.TTL() != 15*time.Minute {
		t.Fatalf("TTL = %v", m.TTL())
	}

	// Verify acepta el token justo antes de expirar.
	if _, err := m.Verify(token, now.Add(m.TTL()).Add(-time.Nanosecond)); err != nil {
		t.Fatalf("Verify un nanosegundo antes de expirar: %v", err)
	}
}

func TestIssueProducesUniqueTokens(t *testing.T) {
	m := testManager(t)
	now := time.Now()

	firstToken, firstCSRF, err := m.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	secondToken, secondCSRF, err := m.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if firstToken == secondToken {
		t.Fatal("dos emisiones con el mismo instante devolvieron el mismo token")
	}
	if firstCSRF == secondCSRF {
		t.Fatal("dos emisiones devolvieron el mismo CSRF")
	}
	if m.ValidateCSRF(firstToken, secondCSRF, now) {
		t.Fatal("el CSRF de otra sesión no debe validar")
	}
}

func TestVerifyExpired(t *testing.T) {
	m := testManager(t)
	now := time.Now()
	token, _, err := m.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	if _, err := m.Verify(token, now.Add(m.TTL())); !errors.Is(err, ErrExpiredSession) {
		t.Fatalf("Verify en el instante de expiración: err = %v, se esperaba ErrExpiredSession", err)
	}
	if _, err := m.Verify(token, now.Add(m.TTL()+time.Hour)); !errors.Is(err, ErrExpiredSession) {
		t.Fatalf("Verify después de expirar: err = %v, se esperaba ErrExpiredSession", err)
	}
}

func TestVerifyRejectsTamperedToken(t *testing.T) {
	m := testManager(t)
	now := time.Now()
	token, _, err := m.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	encoded, signature, _ := strings.Cut(token, ".")

	if _, err := m.Verify(encoded+"."+signature, now); err != nil {
		t.Fatalf("el token original debería validar: %v", err)
	}

	cases := map[string]string{
		"vacío":              "",
		"sin separador":      encoded + signature,
		"segmento extra":     token + ".extra",
		"payload alterado":   flipFirstChar(encoded) + "." + signature,
		"firma alterada":     encoded + "." + flipFirstChar(signature),
		"firma recortada":    encoded + "." + signature[:len(signature)-1],
		"payload vacío":      "." + signature,
		"firma vacía":        encoded + ".",
		"firma no base64url": encoded + ".%%%",
		"demasiado largo":    strings.Repeat("a", maxTokenLen+1),
	}
	for name, candidate := range cases {
		if _, err := m.Verify(candidate, now); err == nil {
			t.Fatalf("%s: Verify aceptó un token inválido", name)
		}
	}
}

func TestVerifyRejectsOtherSecret(t *testing.T) {
	m := testManager(t)
	other, err := NewSessionManager(testSecret(t), 15*time.Minute)
	if err != nil {
		t.Fatalf("NewSessionManager: %v", err)
	}
	now := time.Now()
	token, csrf, err := m.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	if _, err := other.Verify(token, now); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("Verify con otro secreto: err = %v, se esperaba ErrInvalidSignature", err)
	}
	if other.ValidateCSRF(token, csrf, now) {
		t.Fatal("ValidateCSRF no debe aceptar un token firmado con otro secreto")
	}
}

func TestVerifyRejectsUnsupportedVersion(t *testing.T) {
	m := testManager(t)
	now := time.Now()
	encoded, err := encodePayload(payload{
		Version:   sessionVersion + 1,
		IssuedAt:  now.UnixNano(),
		ExpiresAt: now.Add(time.Minute).UnixNano(),
		CSRF:      "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
	})
	if err != nil {
		t.Fatalf("encodePayload: %v", err)
	}
	token := encoded + "." + m.sign(encoded)

	if _, err := m.Verify(token, now); !errors.Is(err, ErrUnsupportedVersion) {
		t.Fatalf("err = %v, se esperaba ErrUnsupportedVersion", err)
	}
}

func TestVerifyRejectsSignedGarbage(t *testing.T) {
	m := testManager(t)
	now := time.Now()
	for _, encoded := range []string{"bm90LWpzb24", "e30"} { // "not-json" y "{}"
		token := encoded + "." + m.sign(encoded)
		if _, err := m.Verify(token, now); !errors.Is(err, ErrMalformedToken) {
			t.Fatalf("payload %q: err = %v, se esperaba ErrMalformedToken", encoded, err)
		}
	}
}

func TestValidateCSRF(t *testing.T) {
	m := testManager(t)
	now := time.Now()
	token, csrf, err := m.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	if !m.ValidateCSRF(token, csrf, now) {
		t.Fatal("ValidateCSRF debería aceptar el CSRF correcto")
	}
	if m.ValidateCSRF(token, "", now) {
		t.Fatal("ValidateCSRF aceptó un CSRF vacío")
	}
	if m.ValidateCSRF(token, "otro", now) {
		t.Fatal("ValidateCSRF aceptó un CSRF incorrecto")
	}
	if m.ValidateCSRF(token, csrf+"x", now) {
		t.Fatal("ValidateCSRF aceptó un CSRF con longitud distinta")
	}
	if m.ValidateCSRF("", csrf, now) {
		t.Fatal("ValidateCSRF aceptó un token vacío")
	}
	if m.ValidateCSRF(token, csrf, now.Add(m.TTL())) {
		t.Fatal("ValidateCSRF aceptó un token expirado")
	}

	encoded, signature, _ := strings.Cut(token, ".")
	if m.ValidateCSRF(flipFirstChar(encoded)+"."+signature, csrf, now) {
		t.Fatal("ValidateCSRF aceptó un token manipulado")
	}
}

func TestSessionCookie(t *testing.T) {
	token := "token-de-prueba"
	cookie := SessionCookie(token, true, 15*time.Minute)

	if cookie.Name != CookieName {
		t.Fatalf("Name = %q", cookie.Name)
	}
	if CookieName != "qva_edge_session" {
		t.Fatalf("CookieName = %q", CookieName)
	}
	if cookie.Value != token {
		t.Fatalf("Value = %q", cookie.Value)
	}
	if !cookie.HttpOnly {
		t.Fatal("la cookie de sesión debe ser HttpOnly")
	}
	if !cookie.Secure {
		t.Fatal("Secure debería propagarse")
	}
	if cookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("SameSite = %v, se esperaba Lax", cookie.SameSite)
	}
	if cookie.Path != "/" {
		t.Fatalf("Path = %q", cookie.Path)
	}
	if cookie.MaxAge != 900 {
		t.Fatalf("MaxAge = %d, se esperaban 900", cookie.MaxAge)
	}

	insecure := SessionCookie(token, false, time.Minute)
	if insecure.Secure {
		t.Fatal("Secure=false debería propagarse")
	}
	if insecure.MaxAge != 60 {
		t.Fatalf("MaxAge = %d, se esperaban 60", insecure.MaxAge)
	}

	if got := SessionCookie(token, true, 1500*time.Millisecond).MaxAge; got != 2 {
		t.Fatalf("MaxAge sub-segundo = %d, se esperaban 2 (redondeo hacia arriba)", got)
	}
	if got := SessionCookie(token, true, 0).MaxAge; got != 0 {
		t.Fatalf("MaxAge con ttl 0 = %d, se esperaba 0", got)
	}
	if got := SessionCookie(token, true, -time.Minute).MaxAge; got != 0 {
		t.Fatalf("MaxAge con ttl negativo = %d, se esperaba 0", got)
	}
}

func TestCSRFCookie(t *testing.T) {
	csrf := "csrf-de-prueba"
	cookie := CSRFCookie(csrf, true, time.Hour)

	if cookie.Name != CSRFCookieName {
		t.Fatalf("Name = %q", cookie.Name)
	}
	if CSRFCookieName != "qva_edge_csrf" {
		t.Fatalf("CSRFCookieName = %q", CSRFCookieName)
	}
	if cookie.Value != csrf {
		t.Fatalf("Value = %q", cookie.Value)
	}
	if cookie.HttpOnly {
		t.Fatal("la cookie CSRF no debe ser HttpOnly: el cliente necesita leerla")
	}
	if !cookie.Secure {
		t.Fatal("Secure debería propagarse")
	}
	if cookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("SameSite = %v, se esperaba Lax", cookie.SameSite)
	}
	if cookie.Path != "/" {
		t.Fatalf("Path = %q", cookie.Path)
	}
	if cookie.MaxAge != 3600 {
		t.Fatalf("MaxAge = %d, se esperaban 3600", cookie.MaxAge)
	}
	if CSRFCookie(csrf, false, time.Hour).Secure {
		t.Fatal("Secure=false debería propagarse")
	}
}

func TestAuthDoesNotLeakSecrets(t *testing.T) {
	secret := testSecret(t)
	m, err := NewSessionManager(secret, time.Minute)
	if err != nil {
		t.Fatalf("NewSessionManager: %v", err)
	}
	now := time.Now()
	token, csrf, err := m.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	var errs []error
	_, err = m.Verify(token, now.Add(time.Hour))
	errs = append(errs, err)
	_, err = m.Verify(flipFirstChar(token), now)
	errs = append(errs, err)
	_, err = NewSessionManager(make([]byte, 3), time.Minute)
	errs = append(errs, err)
	_, err = NewSessionManager(secret, 0)
	errs = append(errs, err)

	for _, e := range errs {
		if e == nil {
			t.Fatal("se esperaba un error")
		}
		msg := e.Error()
		for _, forbidden := range []string{token, csrf, string(secret)} {
			if forbidden == "" {
				continue
			}
			if strings.Contains(msg, forbidden) {
				t.Fatalf("el error filtra un valor sensible: %q", msg)
			}
		}
	}

	// El token no expone el secreto en claro.
	for _, part := range strings.Split(token, ".") {
		raw, err := base64.RawURLEncoding.DecodeString(part)
		if err != nil {
			continue
		}
		if strings.Contains(string(raw), string(secret)) {
			t.Fatal("el token contiene el secreto en claro")
		}
	}
}

func TestSessionManagerConcurrentUse(t *testing.T) {
	m := testManager(t)
	now := time.Now()

	const goroutines = 32
	var wg sync.WaitGroup
	wg.Add(goroutines)
	errs := make(chan error, goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			token, csrf, err := m.Issue(now)
			if err != nil {
				errs <- err
				return
			}
			session, err := m.Verify(token, now)
			if err != nil {
				errs <- err
				return
			}
			if session.CSRF != csrf || !m.ValidateCSRF(token, csrf, now) {
				errs <- errors.New("csrf inconsistente")
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("uso concurrente: %v", err)
	}
}

func TestNilSessionManager(t *testing.T) {
	var m *SessionManager
	if _, _, err := m.Issue(time.Now()); !errors.Is(err, ErrNilSessionManager) {
		t.Fatalf("Issue nil: err = %v", err)
	}
	if _, err := m.Verify("a.b", time.Now()); !errors.Is(err, ErrNilSessionManager) {
		t.Fatalf("Verify nil: err = %v", err)
	}
	if m.ValidateCSRF("a.b", "c", time.Now()) {
		t.Fatal("ValidateCSRF nil debería ser false")
	}
	if m.TTL() != 0 {
		t.Fatal("TTL nil debería ser 0")
	}
}

// flipFirstChar altera el primer carácter base64url. Se cambia el primero y no
// el último porque los bits sobrantes del último carácter pueden no afectar a
// los bytes decodificados y harían el test intermitente.
func flipFirstChar(s string) string {
	if s == "" {
		return "x"
	}
	first := s[0]
	if first == 'a' {
		return "b" + s[1:]
	}
	return "a" + s[1:]
}
