package notifier

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"sync"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

const (
	// defaultPushPayloadLimit es el máximo de bytes de payload aceptado cuando
	// WebPushSender.PayloadLimit no se configura.
	defaultPushPayloadLimit = 4096
	// defaultPushHTTPTimeout acota el envío cuando el constructor crea el
	// cliente HTTP.
	defaultPushHTTPTimeout = 10 * time.Second
	// defaultPushTTL es el TTL enviado al servicio push.
	defaultPushTTL = 60
	// pushRecordOverhead es el espacio que añade la librería al payload antes
	// de cifrarlo: salt, tamaño de registro, longitud y clave pública local,
	// etiqueta GCM y delimitador de padding.
	pushRecordOverhead = 16 + 4 + 1 + 65 + 16 + 1
)

// ErrPushDisabled indica que el envío de Web Push está deshabilitado. Se
// devuelve antes de cualquier validación o llamada de red.
var ErrPushDisabled = errors.New("envío push deshabilitado")

// PushSender entrega un payload Web Push a una suscripción. Las
// implementaciones no deben registrar endpoints, claves ni payloads.
type PushSender interface {
	Send(ctx context.Context, subscription PushSubscription, payload []byte) error
}

// WebPushSender envía notificaciones Web Push reales. Nace deshabilitado para
// que habilitarlo sea una decisión explícita; mientras Enabled sea false, Send
// devuelve ErrPushDisabled sin tocar la red. Un WebPushSender no debe
// copiarse después de usarse: Enable y Disable protegen el cambio de estado
// con un mutex. Si se modifica Enabled directamente, debe hacerse antes de
// usar el sender de forma concurrente.
type WebPushSender struct {
	VAPID VAPIDConfig
	HTTP  *http.Client
	// Enabled activa el envío. Preferir Enable/Disable para cambiarlo de forma
	// concurrente.
	Enabled bool
	// PayloadLimit es el máximo de bytes del payload sin cifrar. Si es menor o
	// igual que cero se usa defaultPushPayloadLimit.
	PayloadLimit int

	mu sync.RWMutex
}

var _ PushSender = (*WebPushSender)(nil)

// NewWebPushSender valida la configuración VAPID y crea un sender deshabilitado
// con un cliente HTTP con timeout y el límite de payload por defecto.
func NewWebPushSender(vapid VAPIDConfig) (*WebPushSender, error) {
	if err := vapid.Validate(); err != nil {
		return nil, fmt.Errorf("configuración VAPID inválida: %w", err)
	}
	return &WebPushSender{
		VAPID:        vapid,
		HTTP:         &http.Client{Timeout: defaultPushHTTPTimeout},
		Enabled:      false,
		PayloadLimit: defaultPushPayloadLimit,
	}, nil
}

// Enable habilita el envío. Es seguro llamarlo de forma concurrente y sobre un
// receptor nil.
func (sender *WebPushSender) Enable() {
	if sender == nil {
		return
	}
	sender.mu.Lock()
	sender.Enabled = true
	sender.mu.Unlock()
}

// Disable deshabilita el envío. Es seguro llamarlo de forma concurrente y sobre
// un receptor nil.
func (sender *WebPushSender) Disable() {
	if sender == nil {
		return
	}
	sender.mu.Lock()
	sender.Enabled = false
	sender.mu.Unlock()
}

// enabled consulta el estado bajo el mutex.
func (sender *WebPushSender) enabled() bool {
	if sender == nil {
		return false
	}
	sender.mu.RLock()
	defer sender.mu.RUnlock()
	return sender.Enabled
}

// payloadLimit devuelve el límite configurado o el valor por defecto.
func (sender *WebPushSender) payloadLimit() int {
	if sender.PayloadLimit <= 0 {
		return defaultPushPayloadLimit
	}
	return sender.PayloadLimit
}

// Send entrega payload a subscription mediante Web Push. Con el sender
// deshabilitado devuelve ErrPushDisabled sin red. Después valida la
// suscripción, el payload y VAPID; cualquier error evita el envío. No registra
// endpoints, claves ni payloads.
func (sender *WebPushSender) Send(ctx context.Context, subscription PushSubscription, payload []byte) error {
	if !sender.enabled() {
		return ErrPushDisabled
	}
	if err := subscription.Validate(); err != nil {
		return fmt.Errorf("suscripción push inválida: %w", err)
	}

	limit := sender.payloadLimit()
	if len(payload) == 0 {
		return fmt.Errorf("payload push vacío")
	}
	if len(payload) > limit {
		return fmt.Errorf("payload push demasiado grande: máximo %d bytes", limit)
	}
	if err := sender.VAPID.Validate(); err != nil {
		return fmt.Errorf("configuración VAPID inválida: %w", err)
	}
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return err
		}
	}

	options := &webpush.Options{
		HTTPClient:      sender.httpClient(),
		RecordSize:      pushRecordSize(limit),
		Subscriber:      sender.VAPID.Subject,
		TTL:             defaultPushTTL,
		VAPIDPublicKey:  sender.VAPID.PublicKey,
		VAPIDPrivateKey: sender.VAPID.PrivateKey,
	}
	response, err := webpush.SendNotificationWithContext(ctx, payload, &webpush.Subscription{
		Endpoint: subscription.Endpoint,
		Keys: webpush.Keys{
			P256dh: subscription.P256DH,
			Auth:   subscription.Auth,
		},
	}, options)
	if err != nil {
		if errors.Is(err, webpush.ErrMaxPadExceeded) {
			return fmt.Errorf("payload push demasiado grande para el registro cifrado")
		}
		return fmt.Errorf("envío web push falló: %w", err)
	}
	if response == nil {
		return fmt.Errorf("envío web push falló: respuesta vacía")
	}
	defer response.Body.Close() //nolint:errcheck

	// Se descarta el cuerpo sin exponerlo: puede contener datos del servicio.
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
	if response.StatusCode < http.StatusOK ||
		response.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("servicio web push rechazó el envío con estado %d",
			response.StatusCode)
	}
	return nil
}

// httpClient devuelve el cliente configurado o uno con timeout si el sender se
// construyó como literal sin HTTP.
func (sender *WebPushSender) httpClient() *http.Client {
	if sender.HTTP != nil {
		return sender.HTTP
	}
	return &http.Client{Timeout: defaultPushHTTPTimeout}
}

// pushRecordSize mantiene el tamaño de registro por defecto de la librería
// mientras el límite de payload quepa en él. Con límites mayores lo amplía
// para que un payload aceptado no falle después al cifrarse.
func pushRecordSize(limit int) uint32 {
	const defaultCapacity = int(webpush.MaxRecordSize) - pushRecordOverhead
	if limit <= defaultCapacity {
		return 0
	}
	if limit > math.MaxUint32-pushRecordOverhead {
		return math.MaxUint32
	}
	return uint32(limit + pushRecordOverhead)
}
