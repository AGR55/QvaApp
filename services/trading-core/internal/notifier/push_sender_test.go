package notifier

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// pushSenderTestVAPID genera un par VAPID real y un subject mailto válido.
func pushSenderTestVAPID(t *testing.T) VAPIDConfig {
	t.Helper()

	privateKey, publicKey, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		t.Fatalf("generar claves VAPID: %v", err)
	}
	return VAPIDConfig{
		PublicKey:  publicKey,
		PrivateKey: privateKey,
		Subject:    "mailto:ops@example.com",
	}
}

// pushSenderTestSubscription genera una suscripción con una clave p256dh real
// (punto válido de P-256) y un auth de 16 bytes.
func pushSenderTestSubscription(t *testing.T, endpoint string) PushSubscription {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generar clave de suscripción: %v", err)
	}
	publicKey, err := key.PublicKey.Bytes()
	if err != nil {
		t.Fatalf("codificar clave de suscripción: %v", err)
	}

	auth := make([]byte, 16)
	if _, err := rand.Read(auth); err != nil {
		t.Fatalf("generar auth: %v", err)
	}
	return PushSubscription{
		Endpoint: endpoint,
		P256DH:   base64.RawURLEncoding.EncodeToString(publicKey),
		Auth:     base64.RawURLEncoding.EncodeToString(auth),
		Label:    "pruebas",
	}
}

func TestNewWebPushSender(t *testing.T) {
	vapid := pushSenderTestVAPID(t)

	sender, err := NewWebPushSender(vapid)
	if err != nil {
		t.Fatalf("NewWebPushSender rechazó VAPID válido: %v", err)
	}
	if sender.Enabled {
		t.Fatal("NewWebPushSender debe crear el sender deshabilitado")
	}
	if sender.PayloadLimit != defaultPushPayloadLimit {
		t.Fatalf("PayloadLimit = %d, se esperaba %d", sender.PayloadLimit, defaultPushPayloadLimit)
	}
	if sender.HTTP == nil {
		t.Fatal("NewWebPushSender debe configurar un cliente HTTP")
	}
	if sender.VAPID != vapid {
		t.Fatal("NewWebPushSender no conservó la configuración VAPID")
	}
}

func TestNewWebPushSenderRejectsInvalidVAPID(t *testing.T) {
	valid := pushSenderTestVAPID(t)
	tests := []struct {
		name  string
		vapid VAPIDConfig
	}{
		{
			name: "pública vacía",
			vapid: VAPIDConfig{
				PublicKey:  "",
				PrivateKey: valid.PrivateKey,
				Subject:    valid.Subject,
			},
		},
		{
			name: "privada demasiado corta",
			vapid: VAPIDConfig{
				PublicKey:  valid.PublicKey,
				PrivateKey: pushTestKey(minVAPIDPrivateKey - 1),
				Subject:    valid.Subject,
			},
		},
		{
			name: "subject vacío",
			vapid: VAPIDConfig{
				PublicKey:  valid.PublicKey,
				PrivateKey: valid.PrivateKey,
				Subject:    "",
			},
		},
		{
			name: "subject http",
			vapid: VAPIDConfig{
				PublicKey:  valid.PublicKey,
				PrivateKey: valid.PrivateKey,
				Subject:    "http://example.com/contacto",
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			sender, err := NewWebPushSender(test.vapid)
			if err == nil {
				t.Fatal("NewWebPushSender aceptó VAPID inválido")
			}
			if sender != nil {
				t.Fatal("NewWebPushSender devolvió sender con VAPID inválido")
			}
			if strings.Contains(err.Error(), test.vapid.PrivateKey) &&
				test.vapid.PrivateKey != "" {
				t.Fatalf("el error filtra la clave privada: %v", err)
			}
		})
	}
}

func TestWebPushSenderDisabledDoesNotUseNetwork(t *testing.T) {
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	sender, err := NewWebPushSender(pushSenderTestVAPID(t))
	if err != nil {
		t.Fatalf("NewWebPushSender: %v", err)
	}
	sender.HTTP = server.Client()

	subscription := pushSenderTestSubscription(t, server.URL+"/push")
	err = sender.Send(context.Background(), subscription, []byte("hola"))
	if !errors.Is(err, ErrPushDisabled) {
		t.Fatalf("Send deshabilitado = %v, se esperaba ErrPushDisabled", err)
	}
	if got := requests.Load(); got != 0 {
		t.Fatalf("Send deshabilitado hizo %d peticiones", got)
	}

	var nilSender *WebPushSender
	if err := nilSender.Send(context.Background(), subscription, []byte("hola")); !errors.Is(err, ErrPushDisabled) {
		t.Fatalf("Send sobre sender nil = %v, se esperaba ErrPushDisabled", err)
	}
	if got := requests.Load(); got != 0 {
		t.Fatalf("Send sobre sender nil hizo %d peticiones", got)
	}
}

func TestWebPushSenderEnableDisable(t *testing.T) {
	sender, err := NewWebPushSender(pushSenderTestVAPID(t))
	if err != nil {
		t.Fatalf("NewWebPushSender: %v", err)
	}

	sender.Enable()
	if !sender.enabled() {
		t.Fatal("Enable no habilitó el sender")
	}
	sender.Disable()
	if sender.enabled() {
		t.Fatal("Disable no deshabilitó el sender")
	}

	var wait sync.WaitGroup
	for index := 0; index < 32; index++ {
		wait.Add(2)
		go func() {
			defer wait.Done()
			sender.Enable()
		}()
		go func() {
			defer wait.Done()
			sender.Disable()
		}()
	}
	wait.Wait()

	// El estado final es indeterminado; Disable debe dejarlo deshabilitado.
	sender.Disable()
	if err := sender.Send(context.Background(), PushSubscription{}, nil); !errors.Is(err, ErrPushDisabled) {
		t.Fatalf("Send tras Disable = %v, se esperaba ErrPushDisabled", err)
	}
}

func TestWebPushSenderSendSuccess(t *testing.T) {
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Method != http.MethodPost {
			t.Errorf("método = %s, se esperaba POST", r.Method)
		}
		if got := r.Header.Get("Content-Encoding"); got != "aes128gcm" {
			t.Errorf("Content-Encoding = %q", got)
		}
		if got := r.Header.Get("TTL"); got == "" {
			t.Error("falta la cabecera TTL")
		}
		if got := r.Header.Get("Authorization"); !strings.HasPrefix(got, "vapid t=") {
			t.Errorf("Authorization inesperada: %q", got)
		}
		body := make([]byte, 1)
		if _, err := r.Body.Read(body); err != nil {
			t.Errorf("leer cuerpo: %v", err)
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	sender, err := NewWebPushSender(pushSenderTestVAPID(t))
	if err != nil {
		t.Fatalf("NewWebPushSender: %v", err)
	}
	sender.HTTP = server.Client()
	sender.Enable()

	subscription := pushSenderTestSubscription(t, server.URL+"/push")
	if err := sender.Send(context.Background(), subscription, []byte(`{"title":"alerta"}`)); err != nil {
		t.Fatalf("Send habilitado devolvió error: %v", err)
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("peticiones = %d, se esperaba 1", got)
	}
}

func TestWebPushSenderUsesDefaultPayloadLimit(t *testing.T) {
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()

	sender, err := NewWebPushSender(pushSenderTestVAPID(t))
	if err != nil {
		t.Fatalf("NewWebPushSender: %v", err)
	}
	sender.HTTP = server.Client()
	sender.PayloadLimit = 0
	sender.Enable()

	subscription := pushSenderTestSubscription(t, server.URL+"/push")
	if err := sender.Send(context.Background(), subscription, []byte("ok")); err != nil {
		t.Fatalf("Send con PayloadLimit por defecto: %v", err)
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("peticiones = %d, se esperaba 1", got)
	}
}

func TestWebPushSenderRejectsInvalidSubscriptionWithoutNetwork(t *testing.T) {
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	valid := pushSenderTestSubscription(t, server.URL+"/push")
	tests := []struct {
		name         string
		subscription PushSubscription
	}{
		{
			name: "endpoint no https",
			subscription: PushSubscription{
				Endpoint: "ftp://push.example/abc",
				P256DH:   valid.P256DH,
				Auth:     valid.Auth,
			},
		},
		{
			name: "endpoint con credenciales",
			subscription: PushSubscription{
				Endpoint: "https://user:clave@push.example/abc",
				P256DH:   valid.P256DH,
				Auth:     valid.Auth,
			},
		},
		{
			name: "p256dh inválida",
			subscription: PushSubscription{
				Endpoint: valid.Endpoint,
				P256DH:   "no-es-base64!",
				Auth:     valid.Auth,
			},
		},
		{
			name: "auth corto",
			subscription: PushSubscription{
				Endpoint: valid.Endpoint,
				P256DH:   valid.P256DH,
				Auth:     pushTestKey(minPushAuth - 1),
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			sender, err := NewWebPushSender(pushSenderTestVAPID(t))
			if err != nil {
				t.Fatalf("NewWebPushSender: %v", err)
			}
			sender.HTTP = server.Client()
			sender.Enable()

			err = sender.Send(context.Background(), test.subscription, []byte("hola"))
			if err == nil {
				t.Fatal("Send aceptó una suscripción inválida")
			}
			if strings.Contains(err.Error(), test.subscription.P256DH) ||
				strings.Contains(err.Error(), test.subscription.Auth) {
				t.Fatalf("el error filtra claves de la suscripción: %v", err)
			}
			if got := requests.Load(); got != 0 {
				t.Fatalf("Send inválido hizo %d peticiones", got)
			}
		})
	}
}

func TestWebPushSenderRejectsInvalidPayloadWithoutNetwork(t *testing.T) {
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	subscription := pushSenderTestSubscription(t, server.URL+"/push")

	tests := []struct {
		name         string
		payload      []byte
		payloadLimit int
	}{
		{name: "vacío", payload: nil},
		{name: "vacío explícito", payload: []byte{}},
		{
			name:         "supera límite configurado",
			payload:      []byte(strings.Repeat("x", 33)),
			payloadLimit: 32,
		},
		{
			name:         "supera límite por defecto",
			payload:      make([]byte, defaultPushPayloadLimit+1),
			payloadLimit: defaultPushPayloadLimit,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			sender, err := NewWebPushSender(pushSenderTestVAPID(t))
			if err != nil {
				t.Fatalf("NewWebPushSender: %v", err)
			}
			sender.HTTP = server.Client()
			if test.payloadLimit > 0 {
				sender.PayloadLimit = test.payloadLimit
			}
			sender.Enable()

			if err := sender.Send(context.Background(), subscription, test.payload); err == nil {
				t.Fatal("Send aceptó un payload inválido")
			}
			if got := requests.Load(); got != 0 {
				t.Fatalf("Send inválido hizo %d peticiones", got)
			}
		})
	}
}

func TestWebPushSenderRejectsInvalidVAPIDWithoutNetwork(t *testing.T) {
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	sender, err := NewWebPushSender(pushSenderTestVAPID(t))
	if err != nil {
		t.Fatalf("NewWebPushSender: %v", err)
	}
	sender.HTTP = server.Client()
	sender.VAPID.PrivateKey = "***"
	sender.Enable()

	subscription := pushSenderTestSubscription(t, server.URL+"/push")
	if err := sender.Send(context.Background(), subscription, []byte("hola")); err == nil {
		t.Fatal("Send aceptó una configuración VAPID inválida")
	}
	if got := requests.Load(); got != 0 {
		t.Fatalf("Send inválido hizo %d peticiones", got)
	}
}

func TestWebPushSenderRejectsCancelledContextWithoutNetwork(t *testing.T) {
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	sender, err := NewWebPushSender(pushSenderTestVAPID(t))
	if err != nil {
		t.Fatalf("NewWebPushSender: %v", err)
	}
	sender.HTTP = server.Client()
	sender.Enable()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	subscription := pushSenderTestSubscription(t, server.URL+"/push")
	err = sender.Send(ctx, subscription, []byte("hola"))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Send con contexto cancelado = %v, se esperaba context.Canceled", err)
	}
	if got := requests.Load(); got != 0 {
		t.Fatalf("Send cancelado hizo %d peticiones", got)
	}
}

func TestWebPushSenderRejectsNonSuccessStatus(t *testing.T) {
	const endpointPath = "/push/suscripcion-privada"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusGone)
	}))
	defer server.Close()

	sender, err := NewWebPushSender(pushSenderTestVAPID(t))
	if err != nil {
		t.Fatalf("NewWebPushSender: %v", err)
	}
	sender.HTTP = server.Client()
	sender.Enable()

	subscription := pushSenderTestSubscription(t, server.URL+endpointPath)
	err = sender.Send(context.Background(), subscription, []byte("hola"))
	if err == nil {
		t.Fatal("Send aceptó una respuesta 410")
	}
	if !strings.Contains(err.Error(), "410") {
		t.Fatalf("el error no menciona el estado: %v", err)
	}
	if strings.Contains(err.Error(), subscription.Endpoint) ||
		strings.Contains(err.Error(), endpointPath) {
		t.Fatalf("el error filtra el endpoint: %v", err)
	}
}

func TestWebPushSenderConcurrentEnableDisableAndSend(t *testing.T) {
	sender, err := NewWebPushSender(pushSenderTestVAPID(t))
	if err != nil {
		t.Fatalf("NewWebPushSender: %v", err)
	}

	// Una suscripción inválida evita la red con independencia del estado.
	invalid := PushSubscription{Endpoint: "ftp://push.example/abc"}
	var wait sync.WaitGroup
	errs := make(chan error, 64)
	for index := 0; index < 32; index++ {
		wait.Add(3)
		go func() {
			defer wait.Done()
			sender.Enable()
		}()
		go func() {
			defer wait.Done()
			sender.Disable()
		}()
		go func() {
			defer wait.Done()
			errs <- sender.Send(context.Background(), invalid, []byte("hola"))
		}()
	}
	wait.Wait()
	close(errs)

	for err := range errs {
		if err == nil {
			t.Fatal("Send aceptó una suscripción inválida")
		}
		if !errors.Is(err, ErrPushDisabled) && !strings.Contains(err.Error(), "suscripción push inválida") {
			t.Fatalf("error inesperado: %v", err)
		}
	}
}
