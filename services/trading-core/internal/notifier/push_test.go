package notifier

import (
	"encoding/base64"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// pushTestKey genera una clave base64url sin padding de tamaño fijo.
func pushTestKey(size int) string {
	return pushTestKeyWithFill(size, 7)
}

func pushTestKeyWithFill(size int, fill byte) string {
	raw := make([]byte, size)
	for index := range raw {
		raw[index] = fill
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func validPushSubscription() PushSubscription {
	return PushSubscription{
		Endpoint: "https://push.example/subscriptions/abc",
		P256DH:   pushTestKey(65),
		Auth:     pushTestKey(16),
		Label:    "móvil",
	}
}

func TestPushSubscriptionValidate(t *testing.T) {
	tests := []struct {
		name         string
		subscription PushSubscription
		wantErr      bool
	}{
		{
			name:         "https válido",
			subscription: validPushSubscription(),
		},
		{
			name: "http en localhost",
			subscription: func() PushSubscription {
				subscription := validPushSubscription()
				subscription.Endpoint = "http://localhost:8080/push"
				return subscription
			}(),
		},
		{
			name: "http en 127.0.0.1",
			subscription: func() PushSubscription {
				subscription := validPushSubscription()
				subscription.Endpoint = "http://127.0.0.1:8080/push"
				return subscription
			}(),
		},
		{
			name: "http en ipv6 local",
			subscription: func() PushSubscription {
				subscription := validPushSubscription()
				subscription.Endpoint = "http://[::1]:8080/push"
				return subscription
			}(),
		},
		{
			name: "claves con padding",
			subscription: func() PushSubscription {
				subscription := validPushSubscription()
				subscription.P256DH = base64.URLEncoding.EncodeToString(make([]byte, 65))
				subscription.Auth = base64.URLEncoding.EncodeToString(make([]byte, 16))
				return subscription
			}(),
		},
		{
			name: "p256dh en el mínimo",
			subscription: func() PushSubscription {
				subscription := validPushSubscription()
				subscription.P256DH = pushTestKey(minPushP256DH)
				return subscription
			}(),
		},
		{
			name: "auth en el mínimo",
			subscription: func() PushSubscription {
				subscription := validPushSubscription()
				subscription.Auth = pushTestKey(minPushAuth)
				return subscription
			}(),
		},
		{
			name: "etiqueta en el máximo",
			subscription: func() PushSubscription {
				subscription := validPushSubscription()
				subscription.Label = strings.Repeat("a", maxPushLabel)
				return subscription
			}(),
		},
		{
			name: "etiqueta vacía",
			subscription: func() PushSubscription {
				subscription := validPushSubscription()
				subscription.Label = ""
				return subscription
			}(),
		},
		{
			name: "endpoint vacío",
			subscription: func() PushSubscription {
				subscription := validPushSubscription()
				subscription.Endpoint = ""
				return subscription
			}(),
			wantErr: true,
		},
		{
			name: "endpoint relativo",
			subscription: func() PushSubscription {
				subscription := validPushSubscription()
				subscription.Endpoint = "/push"
				return subscription
			}(),
			wantErr: true,
		},
		{
			name: "endpoint sin host",
			subscription: func() PushSubscription {
				subscription := validPushSubscription()
				subscription.Endpoint = "https:///push"
				return subscription
			}(),
			wantErr: true,
		},
		{
			name: "endpoint http remoto",
			subscription: func() PushSubscription {
				subscription := validPushSubscription()
				subscription.Endpoint = "http://push.example/subscriptions/abc"
				return subscription
			}(),
			wantErr: true,
		},
		{
			name: "endpoint con otro esquema",
			subscription: func() PushSubscription {
				subscription := validPushSubscription()
				subscription.Endpoint = "ftp://push.example/subscriptions/abc"
				return subscription
			}(),
			wantErr: true,
		},
		{
			name: "endpoint con credenciales",
			subscription: func() PushSubscription {
				subscription := validPushSubscription()
				subscription.Endpoint = "https://user:secret@push.example/subscriptions/abc"
				return subscription
			}(),
			wantErr: true,
		},
		{
			name: "endpoint con query",
			subscription: func() PushSubscription {
				subscription := validPushSubscription()
				subscription.Endpoint = "https://push.example/subscriptions/abc?token=secreto"
				return subscription
			}(),
			wantErr: true,
		},
		{
			name: "endpoint con query vacía",
			subscription: func() PushSubscription {
				subscription := validPushSubscription()
				subscription.Endpoint = "https://push.example/subscriptions/abc?"
				return subscription
			}(),
			wantErr: true,
		},
		{
			name: "p256dh vacía",
			subscription: func() PushSubscription {
				subscription := validPushSubscription()
				subscription.P256DH = ""
				return subscription
			}(),
			wantErr: true,
		},
		{
			name: "p256dh no base64url",
			subscription: func() PushSubscription {
				subscription := validPushSubscription()
				subscription.P256DH = "no+es/base64url!"
				return subscription
			}(),
			wantErr: true,
		},
		{
			name: "p256dh demasiado corta",
			subscription: func() PushSubscription {
				subscription := validPushSubscription()
				subscription.P256DH = pushTestKey(minPushP256DH - 1)
				return subscription
			}(),
			wantErr: true,
		},
		{
			name: "auth vacío",
			subscription: func() PushSubscription {
				subscription := validPushSubscription()
				subscription.Auth = ""
				return subscription
			}(),
			wantErr: true,
		},
		{
			name: "auth no base64url",
			subscription: func() PushSubscription {
				subscription := validPushSubscription()
				subscription.Auth = "***"
				return subscription
			}(),
			wantErr: true,
		},
		{
			name: "auth demasiado corto",
			subscription: func() PushSubscription {
				subscription := validPushSubscription()
				subscription.Auth = pushTestKey(minPushAuth - 1)
				return subscription
			}(),
			wantErr: true,
		},
		{
			name: "etiqueta demasiado larga",
			subscription: func() PushSubscription {
				subscription := validPushSubscription()
				subscription.Label = strings.Repeat("a", maxPushLabel+1)
				return subscription
			}(),
			wantErr: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := test.subscription.Validate()
			if test.wantErr && err == nil {
				t.Fatal("Validate aceptó una suscripción inválida")
			}
			if !test.wantErr && err != nil {
				t.Fatalf("Validate rechazó una suscripción válida: %v", err)
			}
		})
	}
}

func TestPushSubscriptionValidateDoesNotLeakKeys(t *testing.T) {
	subscription := validPushSubscription()
	subscription.P256DH = "clave-p256dh-super-secreta!"
	subscription.Auth = "auth-super-secreto!"

	err := subscription.Validate()
	if err == nil {
		t.Fatal("se esperaba error")
	}
	if strings.Contains(err.Error(), subscription.P256DH) ||
		strings.Contains(err.Error(), subscription.Auth) {
		t.Fatalf("el error filtra las claves: %v", err)
	}
}

func TestPushStoreUpsertDedupAndUpdate(t *testing.T) {
	store := NewPushStore(time.Hour)
	now := time.Unix(1_700_000_000, 0)
	original := validPushSubscription()

	inserted, err := store.Upsert(original, now)
	if err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	if !inserted {
		t.Fatal("la primera inserción debería ser nueva")
	}
	if count := store.Count(now); count != 1 {
		t.Fatalf("Count = %d, se esperaba 1", count)
	}

	updated := original
	updated.P256DH = pushTestKeyWithFill(65, 9)
	updated.Auth = pushTestKeyWithFill(16, 9)
	updated.Label = "actualizada"
	inserted, err = store.Upsert(updated, now.Add(time.Minute))
	if err != nil {
		t.Fatalf("Upsert de actualización: %v", err)
	}
	if inserted {
		t.Fatal("el mismo endpoint no debería insertarse dos veces")
	}

	list := store.List(now.Add(time.Minute))
	if len(list) != 1 {
		t.Fatalf("List devolvió %d suscripciones, se esperaba 1", len(list))
	}
	if list[0] != updated {
		t.Fatalf("List = %+v, se esperaba %+v", list[0], updated)
	}
}

func TestPushStoreExpiration(t *testing.T) {
	ttl := time.Hour
	store := NewPushStore(ttl)
	now := time.Unix(1_700_000_000, 0)
	subscription := validPushSubscription()

	if _, err := store.Upsert(subscription, now); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	if count := store.Count(now.Add(ttl - time.Nanosecond)); count != 1 {
		t.Fatalf("Count antes de expirar = %d, se esperaba 1", count)
	}
	if list := store.List(now.Add(ttl)); len(list) != 0 {
		t.Fatalf("List en la expiración devolvió %d suscripciones, se esperaba 0", len(list))
	}
	if count := store.Count(now.Add(ttl)); count != 0 {
		t.Fatalf("Count en la expiración = %d, se esperaba 0", count)
	}

	inserted, err := store.Upsert(subscription, now.Add(ttl))
	if err != nil {
		t.Fatalf("Upsert tras expirar: %v", err)
	}
	if !inserted {
		t.Fatal("un endpoint expirado debe poder insertarse de nuevo")
	}
}

func TestPushStoreListOrderAndCopy(t *testing.T) {
	store := NewPushStore(time.Hour)
	now := time.Unix(1_700_000_000, 0)

	endpoints := []string{
		"https://push.example/subscriptions/c",
		"https://push.example/subscriptions/a",
		"https://push.example/subscriptions/b",
	}
	for index, endpoint := range endpoints {
		subscription := validPushSubscription()
		subscription.Endpoint = endpoint
		subscription.Label = fmt.Sprintf("etiqueta-%d", index)
		if _, err := store.Upsert(subscription, now); err != nil {
			t.Fatalf("Upsert(%q): %v", endpoint, err)
		}
	}

	list := store.List(now)
	if len(list) != len(endpoints) {
		t.Fatalf("List devolvió %d suscripciones, se esperaban %d", len(list), len(endpoints))
	}
	want := []string{
		"https://push.example/subscriptions/a",
		"https://push.example/subscriptions/b",
		"https://push.example/subscriptions/c",
	}
	for index, endpoint := range want {
		if list[index].Endpoint != endpoint {
			t.Fatalf("List[%d].Endpoint = %q, se esperaba %q", index, list[index].Endpoint, endpoint)
		}
	}

	list[0].Label = "mutada"
	again := store.List(now)
	if again[0].Label == "mutada" {
		t.Fatal("List expone el estado interno del almacén")
	}
}

func TestPushStoreRemove(t *testing.T) {
	store := NewPushStore(time.Hour)
	now := time.Unix(1_700_000_000, 0)
	subscription := validPushSubscription()

	if _, err := store.Upsert(subscription, now); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	if !store.Remove(subscription.Endpoint) {
		t.Fatal("Remove debería encontrar la suscripción")
	}
	if store.Remove(subscription.Endpoint) {
		t.Fatal("Remove no debería encontrar una suscripción ya eliminada")
	}
	if count := store.Count(now); count != 0 {
		t.Fatalf("Count = %d, se esperaba 0", count)
	}

	inserted, err := store.Upsert(subscription, now)
	if err != nil {
		t.Fatalf("Upsert tras Remove: %v", err)
	}
	if !inserted {
		t.Fatal("tras Remove el endpoint debe volver a insertarse")
	}
}

func TestPushStoreUpsertRejectsInvalidWithoutMutating(t *testing.T) {
	store := NewPushStore(time.Hour)
	now := time.Unix(1_700_000_000, 0)
	valid := validPushSubscription()

	if _, err := store.Upsert(valid, now); err != nil {
		t.Fatalf("Upsert válido: %v", err)
	}

	invalid := valid
	invalid.Label = strings.Repeat("a", maxPushLabel+1)
	if _, err := store.Upsert(invalid, now); err == nil {
		t.Fatal("Upsert aceptó una suscripción inválida")
	}

	list := store.List(now)
	if len(list) != 1 || list[0] != valid {
		t.Fatalf("la suscripción inválida mutó el almacén: %+v", list)
	}
}

func TestPushStoreConcurrentAccess(t *testing.T) {
	const (
		endpoints = 48
		workers   = 12
	)
	store := NewPushStore(24 * time.Hour)
	now := time.Unix(1_700_000_000, 0)
	endpointFor := func(index int) string {
		return fmt.Sprintf("https://push.example/subscriptions/%03d", index)
	}

	var writers sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		writers.Add(1)
		go func(worker int) {
			defer writers.Done()
			for index := 0; index < endpoints; index++ {
				subscription := validPushSubscription()
				subscription.Endpoint = endpointFor(index)
				subscription.Label = fmt.Sprintf("worker-%d", worker)
				if _, err := store.Upsert(subscription, now.Add(time.Duration(worker)*time.Second)); err != nil {
					t.Errorf("Upsert concurrente: %v", err)
				}
				_ = store.List(now)
				_ = store.Count(now)
			}
		}(worker)
	}
	writers.Wait()

	if count := store.Count(now); count != endpoints {
		t.Fatalf("Count tras Upsert concurrente = %d, se esperaba %d", count, endpoints)
	}

	var removers sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		removers.Add(1)
		go func(worker int) {
			defer removers.Done()
			for index := worker; index < endpoints; index += workers {
				_ = store.List(now)
				if !store.Remove(endpointFor(index)) {
					t.Errorf("Remove(%q) no encontró la suscripción", endpointFor(index))
				}
				_ = store.Count(now)
			}
		}(worker)
	}
	removers.Wait()

	if count := store.Count(now); count != 0 {
		t.Fatalf("Count tras Remove concurrente = %d, se esperaba 0", count)
	}
}

func TestVAPIDConfigValidate(t *testing.T) {
	validPrivate := pushTestKey(minVAPIDPrivateKey)
	validPublic := pushTestKey(65)

	tests := []struct {
		name    string
		config  VAPIDConfig
		wantErr bool
	}{
		{
			name: "mailto válido",
			config: VAPIDConfig{
				PublicKey:  validPublic,
				PrivateKey: validPrivate,
				Subject:    "mailto:ops@example.com",
			},
		},
		{
			name: "https válido",
			config: VAPIDConfig{
				PublicKey:  validPublic,
				PrivateKey: validPrivate,
				Subject:    "https://example.com/contact",
			},
		},
		{
			name: "claves con padding",
			config: VAPIDConfig{
				PublicKey:  base64.URLEncoding.EncodeToString(make([]byte, 65)),
				PrivateKey: base64.URLEncoding.EncodeToString(make([]byte, minVAPIDPrivateKey)),
				Subject:    "mailto:ops@example.com",
			},
		},
		{
			name: "privada más larga que el mínimo",
			config: VAPIDConfig{
				PublicKey:  validPublic,
				PrivateKey: pushTestKey(minVAPIDPrivateKey + 8),
				Subject:    "mailto:ops@example.com",
			},
		},
		{
			name: "pública vacía",
			config: VAPIDConfig{
				PublicKey:  "",
				PrivateKey: validPrivate,
				Subject:    "mailto:ops@example.com",
			},
			wantErr: true,
		},
		{
			name: "pública no base64url",
			config: VAPIDConfig{
				PublicKey:  "no+es/base64url!",
				PrivateKey: validPrivate,
				Subject:    "mailto:ops@example.com",
			},
			wantErr: true,
		},
		{
			name: "privada vacía",
			config: VAPIDConfig{
				PublicKey:  validPublic,
				PrivateKey: "",
				Subject:    "mailto:ops@example.com",
			},
			wantErr: true,
		},
		{
			name: "privada no base64url",
			config: VAPIDConfig{
				PublicKey:  validPublic,
				PrivateKey: "***",
				Subject:    "mailto:ops@example.com",
			},
			wantErr: true,
		},
		{
			name: "privada demasiado corta",
			config: VAPIDConfig{
				PublicKey:  validPublic,
				PrivateKey: pushTestKey(minVAPIDPrivateKey - 1),
				Subject:    "mailto:ops@example.com",
			},
			wantErr: true,
		},
		{
			name: "subject vacío",
			config: VAPIDConfig{
				PublicKey:  validPublic,
				PrivateKey: validPrivate,
				Subject:    "",
			},
			wantErr: true,
		},
		{
			name: "subject sin esquema",
			config: VAPIDConfig{
				PublicKey:  validPublic,
				PrivateKey: validPrivate,
				Subject:    "ops@example.com",
			},
			wantErr: true,
		},
		{
			name: "subject http",
			config: VAPIDConfig{
				PublicKey:  validPublic,
				PrivateKey: validPrivate,
				Subject:    "http://example.com/contact",
			},
			wantErr: true,
		},
		{
			name: "subject mailto sin destinatario",
			config: VAPIDConfig{
				PublicKey:  validPublic,
				PrivateKey: validPrivate,
				Subject:    "mailto:",
			},
			wantErr: true,
		},
		{
			name: "subject https sin host",
			config: VAPIDConfig{
				PublicKey:  validPublic,
				PrivateKey: validPrivate,
				Subject:    "https:///contact",
			},
			wantErr: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := test.config.Validate()
			if test.wantErr && err == nil {
				t.Fatal("Validate aceptó una configuración VAPID inválida")
			}
			if !test.wantErr && err != nil {
				t.Fatalf("Validate rechazó una configuración VAPID válida: %v", err)
			}
		})
	}
}

func TestVAPIDConfigValidateDoesNotLeakKeys(t *testing.T) {
	tests := []VAPIDConfig{
		{
			PublicKey:  "publica-super-secreta!",
			PrivateKey: pushTestKey(minVAPIDPrivateKey),
			Subject:    "mailto:ops@example.com",
		},
		{
			PublicKey:  pushTestKey(65),
			PrivateKey: "privada-super-secreta!",
			Subject:    "mailto:ops@example.com",
		},
	}

	for _, config := range tests {
		err := config.Validate()
		if err == nil {
			t.Fatal("se esperaba error")
		}
		if strings.Contains(err.Error(), config.PublicKey) ||
			strings.Contains(err.Error(), config.PrivateKey) {
			t.Fatalf("el error filtra las claves: %v", err)
		}
	}
}
