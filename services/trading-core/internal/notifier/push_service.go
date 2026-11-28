package notifier

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"net/http"
	"time"
)

const (
	// pushSendPath es la ruta interna que dispara el envío a suscriptores.
	pushSendPath = "/push/send"
	// maxPushSendPayload es el máximo de bytes aceptado en el payload.
	maxPushSendPayload = 4096
	// defaultPushMaxSubscriptions limita cuántas suscripciones se atienden por
	// envío cuando MaxSubscriptions no se configura.
	defaultPushMaxSubscriptions = 500
	// pushSendAllow lista el único método aceptado por la ruta.
	pushSendAllow = http.MethodPost
)

// errPushStoreNotConfigured indica que PushService no tiene almacén. Se
// distingue de un fallo del almacén para responder 503 sin filtrar detalles.
var errPushStoreNotConfigured = errors.New("almacén de suscripciones push no configurado")

// PushService envía un payload a las suscripciones almacenadas. No registra
// endpoints, claves ni payloads. Nace sin red: mientras Sender sea nil o el
// WebPushSender esté deshabilitado, SendAll devuelve disabled=true sin listar
// ni enviar nada.
type PushService struct {
	Sender           PushSender
	Store            PushSubscriptionStore
	InternalToken    string
	Now              func() time.Time
	MaxSubscriptions int
}

var _ http.Handler = (*PushService)(nil)

// SendAll valida el payload y lo entrega a cada suscripción vigente, hasta
// MaxSubscriptions (500 por defecto). Un fallo individual incrementa failed sin
// abortar el resto. Devuelve disabled=true, sin tocar el almacén ni la red,
// cuando no hay sender o el WebPushSender está deshabilitado. No registra
// endpoints ni payloads.
func (service *PushService) SendAll(
	ctx context.Context,
	payload []byte,
) (sent, failed int, disabled bool, err error) {
	if err := validatePushSendPayload(payload); err != nil {
		return 0, 0, false, err
	}
	if !service.senderEnabled() {
		return 0, 0, true, nil
	}
	if service.Store == nil {
		return 0, 0, false, errPushStoreNotConfigured
	}
	if ctx == nil {
		ctx = context.Background()
	}

	subscriptions, err := service.Store.List(ctx, service.now(), service.maxSubscriptions())
	if err != nil {
		return 0, 0, false, fmt.Errorf("listar suscripciones push falló: %w", err)
	}
	if limit := service.maxSubscriptions(); len(subscriptions) > limit {
		subscriptions = subscriptions[:limit]
	}

	for _, subscription := range subscriptions {
		if sendErr := service.Sender.Send(ctx, subscription, payload); sendErr != nil {
			failed++
			continue
		}
		sent++
	}
	return sent, failed, false, nil
}

// ServeHTTP atiende POST /push/send. Exige X-Notifier-Token cuando hay token
// interno, acepta un cuerpo JSON {"payload":"..."} de hasta 8 KiB y responde
// 202 con los contadores. Rutas desconocidas responden 404, métodos no
// soportados 405 y el resto de errores en JSON.
func (service *PushService) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != pushSendPath {
		writePushJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
		return
	}
	if r.Method != http.MethodPost {
		writePushJSON(w, http.StatusMethodNotAllowed, map[string]string{
			"status": "method_not_allowed",
		}, pushSendAllow)
		return
	}
	if !service.authorized(r) {
		writePushJSON(w, http.StatusUnauthorized, map[string]string{
			"status": "unauthorized",
		})
		return
	}

	var request struct {
		Payload string `json:"payload"`
	}
	if !decodePushJSON(w, r, &request) {
		return
	}
	payload := []byte(request.Payload)
	if err := validatePushSendPayload(payload); err != nil {
		writePushJSON(w, http.StatusBadRequest, map[string]string{
			"status": "invalid_payload",
			"error":  err.Error(),
		})
		return
	}

	sent, failed, disabled, err := service.SendAll(r.Context(), payload)
	if err != nil {
		status := "internal_error"
		if errors.Is(err, errPushStoreNotConfigured) {
			status = "not_configured"
		}
		writePushJSON(w, http.StatusServiceUnavailable, map[string]string{
			"status": status,
		})
		return
	}
	writePushJSON(w, http.StatusAccepted, pushSendResponse{
		Sent:     sent,
		Failed:   failed,
		Disabled: disabled,
	})
}

// pushSendResponse es el cuerpo de éxito de POST /push/send.
type pushSendResponse struct {
	Sent     int  `json:"sent"`
	Failed   int  `json:"failed"`
	Disabled bool `json:"disabled"`
}

// validatePushSendPayload exige un payload no vacío y de hasta 4096 bytes.
// El error nunca incluye el contenido del payload.
func validatePushSendPayload(payload []byte) error {
	if len(payload) == 0 {
		return fmt.Errorf("payload push vacío")
	}
	if len(payload) > maxPushSendPayload {
		return fmt.Errorf("payload push demasiado grande: máximo %d bytes",
			maxPushSendPayload)
	}
	return nil
}

// senderEnabled indica si hay un sender dispuesto a enviar. Un WebPushSender
// se consulta bajo su mutex; cualquier otra implementación se considera
// habilitada.
func (service *PushService) senderEnabled() bool {
	if service == nil || service.Sender == nil {
		return false
	}
	if sender, ok := service.Sender.(*WebPushSender); ok {
		return sender.enabled()
	}
	return true
}

// maxSubscriptions devuelve el límite configurado o el valor por defecto.
func (service *PushService) maxSubscriptions() int {
	if service.MaxSubscriptions <= 0 {
		return defaultPushMaxSubscriptions
	}
	return service.MaxSubscriptions
}

// now devuelve el reloj inyectado o time.Now si no se configuró.
func (service *PushService) now() time.Time {
	if service.Now != nil {
		return service.Now()
	}
	return time.Now()
}

// authorized exige X-Notifier-Token cuando hay token interno configurado. La
// comparación es constante en tiempo. Sin token configurado no hay auth.
func (service *PushService) authorized(r *http.Request) bool {
	if service.InternalToken == "" {
		return true
	}
	provided := r.Header.Get("X-Notifier-Token")
	return subtle.ConstantTimeCompare([]byte(provided), []byte(service.InternalToken)) == 1
}
