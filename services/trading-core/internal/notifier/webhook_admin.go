package notifier

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

const (
	webhookAdminRegisterPath = "/admin/telegram/register"
	webhookAdminStatusPath   = "/admin/telegram/status"
	webhookAdminDeletePath   = "/admin/telegram"
)

// WebhookRegistration describe el webhook que el router administrativo puede
// registrar. Enabled=false mantiene el router inerte: permite una URL vacía y
// no realiza ninguna llamada a Telegram. El secret y las actualizaciones se
// validan siempre que estén presentes.
type WebhookRegistration struct {
	PublicURL      string
	Secret         string
	AllowedUpdates []string
	Enabled        bool
}

// Validate comprueba la configuración sin llamar a Telegram. La URL debe ser
// HTTPS, o HTTP en localhost/127.0.0.1; el secret debe tener entre 1 y 256
// caracteres cuando el webhook está habilitado; y las actualizaciones sólo
// pueden ser message y callback_query, como máximo cinco.
func (registration WebhookRegistration) Validate() error {
	if strings.TrimSpace(registration.PublicURL) != "" {
		if err := validateWebhookURL(registration.PublicURL); err != nil {
			return err
		}
	} else if registration.Enabled {
		return fmt.Errorf("URL del webhook no configurada")
	}

	if registration.Secret != "" || registration.Enabled {
		if err := validateWebhookSecret(registration.Secret); err != nil {
			return err
		}
	}
	if err := validateWebhookAllowedUpdates(registration.AllowedUpdates); err != nil {
		return err
	}
	return nil
}

// WebhookAdmin es un router administrativo explícito para el webhook de
// Telegram. No registra nada al construirse: sólo actúa cuando llega una
// petición a register, status o delete. Las respuestas nunca incluyen el token
// del bot, el secret del webhook ni el token interno.
type WebhookAdmin struct {
	Client        *Client
	Registration  WebhookRegistration
	InternalToken string
}

var _ http.Handler = (*WebhookAdmin)(nil)

// ServeHTTP enruta las operaciones administrativas. Las rutas desconocidas
// responden 404 y los métodos incorrectos 405, siempre en JSON.
func (admin *WebhookAdmin) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == webhookAdminRegisterPath:
		if r.Method != http.MethodPost {
			writeWebhookJSON(w, http.StatusMethodNotAllowed, map[string]string{
				"status": "method_not_allowed",
			}, http.MethodPost)
			return
		}
		admin.register(w, r)
	case r.URL.Path == webhookAdminStatusPath:
		if r.Method != http.MethodGet {
			writeWebhookJSON(w, http.StatusMethodNotAllowed, map[string]string{
				"status": "method_not_allowed",
			}, http.MethodGet)
			return
		}
		admin.status(w, r)
	case r.URL.Path == webhookAdminDeletePath:
		if r.Method != http.MethodDelete {
			writeWebhookJSON(w, http.StatusMethodNotAllowed, map[string]string{
				"status": "method_not_allowed",
			}, http.MethodDelete)
			return
		}
		admin.delete(w, r)
	default:
		writeWebhookJSON(w, http.StatusNotFound, map[string]string{
			"status": "not_found",
		})
	}
}

// register valida la configuración y, sólo si está habilitada, registra el
// webhook en Telegram. Con Enabled=false no hay red ni se exige una URL.
func (admin *WebhookAdmin) register(w http.ResponseWriter, r *http.Request) {
	if !admin.authorized(r) {
		writeWebhookJSON(w, http.StatusUnauthorized, map[string]string{
			"status": "unauthorized",
		})
		return
	}
	if err := admin.Registration.Validate(); err != nil {
		writeWebhookJSON(w, http.StatusBadRequest, map[string]string{
			"status": "invalid_registration",
			"error":  err.Error(),
		})
		return
	}
	if !admin.Registration.Enabled {
		writeWebhookJSON(w, http.StatusOK, map[string]string{"status": "disabled"})
		return
	}
	if admin.Client == nil {
		writeWebhookJSON(w, http.StatusServiceUnavailable, map[string]string{
			"status": "not_configured",
		})
		return
	}

	err := admin.Client.SetWebhook(r.Context(), admin.Registration.PublicURL,
		admin.Registration.Secret, admin.Registration.AllowedUpdates)
	if err != nil {
		writeWebhookJSON(w, http.StatusBadGateway, map[string]string{
			"status": "telegram_error",
		})
		return
	}
	writeWebhookJSON(w, http.StatusOK, map[string]string{"status": "registered"})
}

// status consulta el estado del webhook sólo cuando está habilitado. La
// respuesta se limita a datos públicos del webhook, sin token ni secret.
func (admin *WebhookAdmin) status(w http.ResponseWriter, r *http.Request) {
	if !admin.Registration.Enabled {
		writeWebhookJSON(w, http.StatusOK, map[string]string{"status": "disabled"})
		return
	}
	if admin.Client == nil {
		writeWebhookJSON(w, http.StatusServiceUnavailable, map[string]string{
			"status": "not_configured",
		})
		return
	}

	info, err := admin.Client.WebhookInfo(r.Context())
	if err != nil {
		writeWebhookJSON(w, http.StatusBadGateway, map[string]string{
			"status": "telegram_error",
		})
		return
	}
	// El estado es seguro incluso si Telegram devuelve texto inesperado: se
	// redactan el token del bot, el secret y el token interno antes de exponerlo.
	secrets := []string{admin.Registration.Secret, admin.InternalToken}
	safeURL := admin.Client.redactErrorText(info.URL, secrets...)
	safeLastError := admin.Client.redactErrorText(info.LastError, secrets...)
	response := struct {
		Status         string `json:"status"`
		Enabled        bool   `json:"enabled"`
		Registered     bool   `json:"registered"`
		URL            string `json:"url,omitempty"`
		PendingUpdates int64  `json:"pendingUpdates"`
		LastError      string `json:"lastError,omitempty"`
	}{
		Status:         "ok",
		Enabled:        true,
		Registered:     safeURL != "",
		URL:            safeURL,
		PendingUpdates: info.PendingUpdates,
		LastError:      safeLastError,
	}
	writeWebhookJSON(w, http.StatusOK, response)
}

// delete elimina el webhook sólo cuando está habilitado. Con Enabled=false no
// hay red y se informa del estado deshabilitado.
func (admin *WebhookAdmin) delete(w http.ResponseWriter, r *http.Request) {
	if !admin.authorized(r) {
		writeWebhookJSON(w, http.StatusUnauthorized, map[string]string{
			"status": "unauthorized",
		})
		return
	}
	if !admin.Registration.Enabled {
		writeWebhookJSON(w, http.StatusOK, map[string]string{"status": "disabled"})
		return
	}
	if admin.Client == nil {
		writeWebhookJSON(w, http.StatusServiceUnavailable, map[string]string{
			"status": "not_configured",
		})
		return
	}
	if err := admin.Client.DeleteWebhook(r.Context()); err != nil {
		writeWebhookJSON(w, http.StatusBadGateway, map[string]string{
			"status": "telegram_error",
		})
		return
	}
	writeWebhookJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// authorized exige X-Notifier-Token cuando hay un token interno configurado.
// La comparación es constante en tiempo para no filtrar el token.
func (admin *WebhookAdmin) authorized(r *http.Request) bool {
	if admin.InternalToken == "" {
		return true
	}
	provided := r.Header.Get("X-Notifier-Token")
	return subtle.ConstantTimeCompare([]byte(provided), []byte(admin.InternalToken)) == 1
}

// writeWebhookJSON escribe una respuesta JSON sin almacenamiento intermedio y,
// opcionalmente, fija la cabecera Allow de los 405.
func writeWebhookJSON(w http.ResponseWriter, status int, payload any, allow ...string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if len(allow) > 0 {
		w.Header().Set("Allow", strings.Join(allow, ", "))
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
