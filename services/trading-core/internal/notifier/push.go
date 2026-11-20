package notifier

import (
	"encoding/base64"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	// maxPushLabel es el máximo de caracteres de la etiqueta de una suscripción.
	maxPushLabel = 128
	// minPushP256DH es el mínimo de bytes de la clave pública p256dh.
	minPushP256DH = 32
	// minPushAuth es el mínimo de bytes del secreto auth.
	minPushAuth = 16
	// minVAPIDPrivateKey es el mínimo de bytes de la clave privada VAPID.
	minVAPIDPrivateKey = 32
	// defaultPushStoreTTL es el TTL usado cuando NewPushStore recibe un valor
	// no positivo.
	defaultPushStoreTTL = 24 * time.Hour
)

// PushSubscription es una suscripción Web Push ya normalizada. No contiene
// estado de envío ni realiza ninguna llamada de red.
type PushSubscription struct {
	Endpoint string
	P256DH   string
	Auth     string
	Label    string
}

// Validate comprueba el endpoint, las claves y la etiqueta de la suscripción
// sin hacer red. El endpoint debe ser HTTPS, o HTTP en localhost/127.0.0.1/::1
// para pruebas, y no puede incluir credenciales ni query. p256dh y auth deben
// ser base64url decodificables con longitudes mínimas de 32 y 16 bytes.
// La etiqueta no puede superar los 128 caracteres.
func (subscription PushSubscription) Validate() error {
	if err := validatePushEndpoint(subscription.Endpoint); err != nil {
		return err
	}

	p256dh, err := decodePushBase64URL(subscription.P256DH)
	if err != nil {
		return fmt.Errorf("clave p256dh de la suscripción inválida")
	}
	if len(p256dh) < minPushP256DH {
		return fmt.Errorf("clave p256dh de la suscripción demasiado corta: mínimo %d bytes",
			minPushP256DH)
	}

	auth, err := decodePushBase64URL(subscription.Auth)
	if err != nil {
		return fmt.Errorf("secreto auth de la suscripción inválido")
	}
	if len(auth) < minPushAuth {
		return fmt.Errorf("secreto auth de la suscripción demasiado corto: mínimo %d bytes",
			minPushAuth)
	}

	if utf8.RuneCountInString(subscription.Label) > maxPushLabel {
		return fmt.Errorf("etiqueta de la suscripción demasiado larga: máximo %d caracteres",
			maxPushLabel)
	}
	return nil
}

// validatePushEndpoint exige una URL absoluta con host. HTTPS siempre es
// válido; HTTP sólo se acepta en localhost, 127.0.0.1 o ::1 para poder usar
// servidores de prueba. Se rechazan credenciales y query para no filtrar
// secretos en la URL.
func validatePushEndpoint(endpoint string) error {
	if strings.TrimSpace(endpoint) == "" {
		return fmt.Errorf("endpoint de la suscripción no configurado")
	}

	parsed, err := url.Parse(endpoint)
	if err != nil || !parsed.IsAbs() || parsed.Host == "" {
		return fmt.Errorf("endpoint de la suscripción inválido")
	}
	if parsed.User != nil {
		return fmt.Errorf("endpoint de la suscripción no puede incluir credenciales")
	}
	if parsed.RawQuery != "" || parsed.ForceQuery {
		return fmt.Errorf("endpoint de la suscripción no puede incluir query")
	}

	switch strings.ToLower(parsed.Scheme) {
	case "https":
		return nil
	case "http":
		host := strings.ToLower(parsed.Hostname())
		if host == "localhost" || host == "127.0.0.1" || host == "::1" {
			return nil
		}
		return fmt.Errorf("endpoint de la suscripción con http sólo se permite en localhost")
	default:
		return fmt.Errorf("endpoint de la suscripción debe usar https")
	}
}

// decodePushBase64URL acepta base64url con o sin padding. El error nunca
// incluye el valor recibido.
func decodePushBase64URL(encoded string) ([]byte, error) {
	if encoded == "" {
		return nil, fmt.Errorf("valor base64url vacío")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(encoded)
	if err == nil {
		return decoded, nil
	}
	decoded, err = base64.URLEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("valor base64url inválido")
	}
	return decoded, nil
}

// pushEntry guarda una suscripción y el instante en el que deja de ser válida.
type pushEntry struct {
	subscription PushSubscription
	expiresAt    time.Time
}

// PushStore almacena suscripciones Web Push en memoria, deduplicadas por
// endpoint y con expiración por TTL. Es seguro para uso concurrente. Los
// métodos reciben el instante actual para poder inyectar un reloj en pruebas.
type PushStore struct {
	mu      sync.Mutex
	entries map[string]pushEntry
	ttl     time.Duration
}

// NewPushStore crea un almacén vacío. Un TTL no positivo usa 24 horas.
func NewPushStore(ttl time.Duration) *PushStore {
	if ttl <= 0 {
		ttl = defaultPushStoreTTL
	}
	return &PushStore{
		entries: make(map[string]pushEntry),
		ttl:     ttl,
	}
}

// Upsert valida y guarda una suscripción. Devuelve false cuando el endpoint ya
// existía vigente; en ese caso actualiza claves, etiqueta y expiración. Una
// suscripción expirada se considera nueva.
func (store *PushStore) Upsert(subscription PushSubscription, now time.Time) (bool, error) {
	if err := subscription.Validate(); err != nil {
		return false, err
	}

	store.mu.Lock()
	defer store.mu.Unlock()

	inserted := true
	if entry, exists := store.entries[subscription.Endpoint]; exists {
		if now.Before(entry.expiresAt) {
			inserted = false
		} else {
			delete(store.entries, subscription.Endpoint)
		}
	}
	store.entries[subscription.Endpoint] = pushEntry{
		subscription: subscription,
		expiresAt:    now.Add(store.ttl),
	}
	return inserted, nil
}

// Remove elimina una suscripción por endpoint. Devuelve true si existía.
func (store *PushStore) Remove(endpoint string) bool {
	store.mu.Lock()
	defer store.mu.Unlock()

	if _, exists := store.entries[endpoint]; !exists {
		return false
	}
	delete(store.entries, endpoint)
	return true
}

// List devuelve una copia de las suscripciones vigentes en now, ordenadas de
// forma estable por endpoint. Los expirados se descartan.
func (store *PushStore) List(now time.Time) []PushSubscription {
	store.mu.Lock()
	defer store.mu.Unlock()

	store.purgeExpiredLocked(now)
	subscriptions := make([]PushSubscription, 0, len(store.entries))
	for _, entry := range store.entries {
		subscriptions = append(subscriptions, entry.subscription)
	}
	sort.Slice(subscriptions, func(left, right int) bool {
		return subscriptions[left].Endpoint < subscriptions[right].Endpoint
	})
	return subscriptions
}

// Count devuelve cuántas suscripciones están vigentes en now.
func (store *PushStore) Count(now time.Time) int {
	store.mu.Lock()
	defer store.mu.Unlock()

	store.purgeExpiredLocked(now)
	return len(store.entries)
}

// purgeExpiredLocked elimina las entradas cuya expiración ya alcanzó now.
// El llamador debe mantener el mutex.
func (store *PushStore) purgeExpiredLocked(now time.Time) {
	for endpoint, entry := range store.entries {
		if !now.Before(entry.expiresAt) {
			delete(store.entries, endpoint)
		}
	}
}

// VAPIDConfig contiene las claves y el subject usados para firmar VAPID. No
// realiza ninguna operación criptográfica ni de red.
type VAPIDConfig struct {
	PublicKey  string
	PrivateKey string
	Subject    string
}

// Validate comprueba que las claves sean base64url decodificables, que la
// privada tenga al menos 32 bytes y que el subject use mailto: o https://.
// Los errores nunca incluyen el valor de las claves.
func (config VAPIDConfig) Validate() error {
	publicKey, err := decodePushBase64URL(config.PublicKey)
	if err != nil || len(publicKey) == 0 {
		return fmt.Errorf("clave pública VAPID inválida")
	}

	privateKey, err := decodePushBase64URL(config.PrivateKey)
	if err != nil {
		return fmt.Errorf("clave privada VAPID inválida")
	}
	if len(privateKey) < minVAPIDPrivateKey {
		return fmt.Errorf("clave privada VAPID demasiado corta: mínimo %d bytes",
			minVAPIDPrivateKey)
	}

	if err := validateVAPIDSubject(config.Subject); err != nil {
		return err
	}
	return nil
}

// validateVAPIDSubject exige un subject mailto: con destinatario o una URL
// https:// con host. No repite el valor en el error.
func validateVAPIDSubject(subject string) error {
	if strings.HasPrefix(subject, "mailto:") {
		if len(subject) == len("mailto:") {
			return fmt.Errorf("subject VAPID mailto: sin destinatario")
		}
		return nil
	}
	if strings.HasPrefix(subject, "https://") {
		parsed, err := url.Parse(subject)
		if err != nil || parsed.Host == "" {
			return fmt.Errorf("subject VAPID https:// inválido")
		}
		return nil
	}
	return fmt.Errorf("subject VAPID debe usar mailto: o https://")
}
