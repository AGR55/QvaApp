package edge

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/vault"
)

const (
	marketSourceTestNowUnix = int64(1_700_000_000)
	marketSourceTestOrigin  = "https://panel.example"
	marketSourceTestSecret  = "secreto-webhook-qvapay-123"
	marketSourceTestAppID   = "app-id-qvapay"
	marketSourceTestAppKey  = "app-secret-qvapay-123456"
)

var marketSourceTestUUIDPattern = regexp.MustCompile(
	`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
)

// marketSourceMemoryStore implementa ReaderStore en memoria con la misma
// unicidad de fingerprint que la tabla real.
type marketSourceMemoryStore struct {
	mu        sync.Mutex
	readers   map[string]Reader
	order     []string
	settings  map[string][]byte
	updatedAt map[string]int64
}

func newMarketSourceMemoryStore() *marketSourceMemoryStore {
	return &marketSourceMemoryStore{
		readers:   make(map[string]Reader),
		settings:  make(map[string][]byte),
		updatedAt: make(map[string]int64),
	}
}

func (store *marketSourceMemoryStore) List(context.Context) ([]Reader, error) {
	store.mu.Lock()
	defer store.mu.Unlock()

	readers := make([]Reader, 0, len(store.order))
	for _, id := range store.order {
		if reader, found := store.readers[id]; found {
			readers = append(readers, reader)
		}
	}
	return readers, nil
}

func (store *marketSourceMemoryStore) Get(_ context.Context, id string) (Reader, bool, error) {
	reader, found := store.reader(id)
	return reader, found, nil
}

func (store *marketSourceMemoryStore) Create(_ context.Context, reader Reader) error {
	store.mu.Lock()
	defer store.mu.Unlock()

	for _, existing := range store.readers {
		if existing.TokenFingerprint == reader.TokenFingerprint {
			return ErrReaderDuplicate
		}
	}
	store.readers[reader.ID] = reader
	store.order = append(store.order, reader.ID)
	return nil
}

func (store *marketSourceMemoryStore) Update(_ context.Context, reader Reader) (bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()

	if _, found := store.readers[reader.ID]; !found {
		return false, nil
	}
	for id, existing := range store.readers {
		if id != reader.ID && existing.TokenFingerprint == reader.TokenFingerprint {
			return false, ErrReaderDuplicate
		}
	}
	store.readers[reader.ID] = reader
	return true, nil
}

func (store *marketSourceMemoryStore) Delete(_ context.Context, id string) (bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()

	if _, found := store.readers[id]; !found {
		return false, nil
	}
	delete(store.readers, id)
	for index, existing := range store.order {
		if existing == id {
			store.order = append(store.order[:index], store.order[index+1:]...)
			break
		}
	}
	return true, nil
}

func (store *marketSourceMemoryStore) GetSetting(_ context.Context, key string) ([]byte, bool, error) {
	value, found := store.setting(key)
	return value, found, nil
}

func (store *marketSourceMemoryStore) PutSetting(
	_ context.Context,
	key string,
	value []byte,
	now int64,
) error {
	store.mu.Lock()
	defer store.mu.Unlock()

	store.settings[key] = append([]byte(nil), value...)
	store.updatedAt[key] = now
	return nil
}

func (store *marketSourceMemoryStore) reader(id string) (Reader, bool) {
	store.mu.Lock()
	defer store.mu.Unlock()

	reader, found := store.readers[id]
	return reader, found
}

func (store *marketSourceMemoryStore) count() int {
	store.mu.Lock()
	defer store.mu.Unlock()

	return len(store.readers)
}

func (store *marketSourceMemoryStore) setting(key string) ([]byte, bool) {
	store.mu.Lock()
	defer store.mu.Unlock()

	value, found := store.settings[key]
	if !found {
		return nil, false
	}
	return append([]byte(nil), value...), true
}

func (store *marketSourceMemoryStore) settingUpdatedAt(key string) (int64, bool) {
	store.mu.Lock()
	defer store.mu.Unlock()

	value, found := store.updatedAt[key]
	return value, found
}

// marketSourceTestEnv agrupa la API, el store y una sesión válida fija.
type marketSourceTestEnv struct {
	api     *MarketSourceAPI
	store   *marketSourceMemoryStore
	manager *SessionManager
	now     time.Time
	token   string
	csrf    string
}

func newMarketSourceTestEnv(t *testing.T) *marketSourceTestEnv {
	t.Helper()

	encryptionKey := strings.Repeat("ab", 32)
	vaultValue, err := vault.New(encryptionKey)
	if err != nil {
		t.Fatalf("vault.New: %v", err)
	}
	manager, err := NewSessionManager(bytes.Repeat([]byte{0x42}, 32), time.Hour)
	if err != nil {
		t.Fatalf("NewSessionManager: %v", err)
	}
	now := time.Unix(marketSourceTestNowUnix, 0)
	token, csrf, err := manager.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	store := newMarketSourceMemoryStore()
	return &marketSourceTestEnv{
		api: &MarketSourceAPI{
			Sessions:      manager,
			Store:         store,
			Vault:         vaultValue,
			TrustedOrigin: marketSourceTestOrigin,
			Now:           func() time.Time { return now },
		},
		store:   store,
		manager: manager,
		now:     now,
		token:   token,
		csrf:    csrf,
	}
}

// request envía una petición con sesión, CSRF y Origin válidos por defecto.
// mutate permite quitarlos o sustituirlos en cada caso.
func (env *marketSourceTestEnv) request(
	t *testing.T,
	method string,
	target string,
	body any,
	mutate func(*http.Request),
) *httptest.ResponseRecorder {
	t.Helper()

	var reader *strings.Reader
	if body != nil {
		switch value := body.(type) {
		case string:
			reader = strings.NewReader(value)
		default:
			raw, err := json.Marshal(value)
			if err != nil {
				t.Fatalf("Marshal body: %v", err)
			}
			reader = strings.NewReader(string(raw))
		}
	}

	var request *http.Request
	if reader == nil {
		request = httptest.NewRequest(method, target, nil)
	} else {
		request = httptest.NewRequest(method, target, reader)
		request.Header.Set("Content-Type", "application/json")
	}
	request.AddCookie(&http.Cookie{Name: CookieName, Value: env.token})
	request.Header.Set("X-CSRF-Token", env.csrf)
	request.Header.Set("Origin", marketSourceTestOrigin)
	if mutate != nil {
		mutate(request)
	}

	recorder := httptest.NewRecorder()
	env.api.ServeHTTP(recorder, request)
	return recorder
}

func marketSourceTestStatus(t *testing.T, recorder *httptest.ResponseRecorder) MarketSourceSnapshot {
	t.Helper()

	var payload struct {
		Data MarketSourceSnapshot `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return payload.Data
}

func marketSourceTestReader(t *testing.T, recorder *httptest.ResponseRecorder) MarketReader {
	t.Helper()

	var payload struct {
		Data MarketReader `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return payload.Data
}

func marketSourceTestErrorStatus(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()

	var payload struct {
		Status string `json:"status"`
		Field  string `json:"field"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return payload.Status
}

func assertMarketSourceTestHeaders(
	t *testing.T,
	recorder *httptest.ResponseRecorder,
	expectJSON bool,
) {
	t.Helper()

	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, se esperaba no-store", got)
	}
	if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q, se esperaba nosniff", got)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("no debe emitirse CORS, Access-Control-Allow-Origin = %q", got)
	}
	if expectJSON {
		if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
			t.Fatalf("Content-Type = %q, se esperaba JSON", got)
		}
	}
	if len(recorder.Result().Cookies()) != 0 {
		t.Fatal("la API no debe emitir cookies")
	}
}

func assertMarketSourceTestOmits(
	t *testing.T,
	recorder *httptest.ResponseRecorder,
	values ...string,
) {
	t.Helper()

	body := recorder.Body.String()
	for _, value := range values {
		if value == "" {
			continue
		}
		if strings.Contains(body, value) {
			t.Fatalf("la respuesta no debe contener material sensible %q", value)
		}
	}
}

func TestMarketSourceStatusStartsEmpty(t *testing.T) {
	env := newMarketSourceTestEnv(t)

	recorder := env.request(t, http.MethodGet, marketSourceBasePath, nil, nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, se esperaba 200 (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	assertMarketSourceTestHeaders(t, recorder, true)

	status := marketSourceTestStatus(t, recorder)
	if status.Mode != marketModeHybrid {
		t.Fatalf("mode = %q, se esperaba %q", status.Mode, marketModeHybrid)
	}
	if status.Accounts == nil || len(status.Accounts) != 0 {
		t.Fatalf("accounts = %#v, se esperaba lista vacía", status.Accounts)
	}
	if status.Readers == nil || len(status.Readers) != 0 {
		t.Fatalf("readers = %#v, se esperaba lista vacía", status.Readers)
	}
	if status.HealthyAccounts != 0 {
		t.Fatalf("healthyAccounts = %d, se esperaba 0", status.HealthyAccounts)
	}
	if status.EffectiveCadenceSeconds != nil {
		t.Fatalf("effectiveCadenceSeconds = %v, se esperaba null", *status.EffectiveCadenceSeconds)
	}
	if status.EstimatedRequestsPerMinute != 0 {
		t.Fatalf("estimatedRequestsPerMinute = %v, se esperaba 0", status.EstimatedRequestsPerMinute)
	}
	if status.WebhookConfigured || status.StreamConfigured {
		t.Fatalf("webhookConfigured=%v streamConfigured=%v, se esperaban false",
			status.WebhookConfigured, status.StreamConfigured)
	}
}

func TestMarketSourceReaderLifecycle(t *testing.T) {
	env := newMarketSourceTestEnv(t)
	token := "token-lector-uno-123456"

	created := env.request(t, http.MethodPost, marketReadersBasePath, map[string]any{
		"label":           "  Cuenta lectora  ",
		"token":           token,
		"intervalSeconds": 3,
	}, nil)
	if created.Code != http.StatusCreated {
		t.Fatalf("status = %d, se esperaba 201 (cuerpo %q)", created.Code, created.Body.String())
	}
	assertMarketSourceTestHeaders(t, created, true)
	assertMarketSourceTestOmits(t, created, token)

	reader := marketSourceTestReader(t, created)
	if !marketSourceTestUUIDPattern.MatchString(reader.ID) {
		t.Fatalf("id = %q, se esperaba UUID v4", reader.ID)
	}
	if reader.Label != "Cuenta lectora" {
		t.Fatalf("label = %q", reader.Label)
	}
	if reader.IntervalSeconds != 3 || !reader.Enabled {
		t.Fatalf("intervalSeconds=%d enabled=%v", reader.IntervalSeconds, reader.Enabled)
	}
	if reader.Health != "idle" {
		t.Fatalf("health = %q, se esperaba idle", reader.Health)
	}
	if !reader.TokenConfigured {
		t.Fatal("tokenConfigured debe ser true")
	}
	if reader.LastSuccessAt != nil || reader.LastAttemptAt != nil {
		t.Fatalf("lastSuccessAt=%v lastAttemptAt=%v, se esperaban null",
			reader.LastSuccessAt, reader.LastAttemptAt)
	}
	if reader.NextEligibleAt != 0 || reader.ConsecutiveErrors != 0 || reader.LastError != nil {
		t.Fatalf("campos de salud inesperados: %#v", reader)
	}
	if reader.CreatedAt != marketSourceTestNowUnix || reader.UpdatedAt != marketSourceTestNowUnix {
		t.Fatalf("createdAt=%d updatedAt=%d", reader.CreatedAt, reader.UpdatedAt)
	}

	stored, found := env.store.reader(reader.ID)
	if !found {
		t.Fatal("el lector no se guardó")
	}
	sum := sha256.Sum256([]byte(token))
	if stored.TokenFingerprint != hex.EncodeToString(sum[:]) {
		t.Fatalf("fingerprint = %q", stored.TokenFingerprint)
	}
	if stored.EncryptedToken == "" || stored.EncryptedToken == token {
		t.Fatal("el token debe guardarse cifrado")
	}
	decrypted, err := env.api.Vault.Decrypt(stored.EncryptedToken)
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}
	if decrypted != token {
		t.Fatalf("token descifrado = %q", decrypted)
	}

	listed := env.request(t, http.MethodGet, marketSourceBasePath, nil, nil)
	if listed.Code != http.StatusOK {
		t.Fatalf("GET status = %d", listed.Code)
	}
	status := marketSourceTestStatus(t, listed)
	if len(status.Readers) != 1 || len(status.Accounts) != 1 {
		t.Fatalf("readers=%d accounts=%d, se esperaba 1", len(status.Readers), len(status.Accounts))
	}
	if status.Readers[0].ID != reader.ID {
		t.Fatalf("readers[0].id = %q", status.Readers[0].ID)
	}
	if status.HealthyAccounts != 1 {
		t.Fatalf("healthyAccounts = %d, se esperaba 1", status.HealthyAccounts)
	}
	if status.EffectiveCadenceSeconds == nil || *status.EffectiveCadenceSeconds != 3 {
		t.Fatalf("effectiveCadenceSeconds = %v", status.EffectiveCadenceSeconds)
	}
	if status.EstimatedRequestsPerMinute != 20 {
		t.Fatalf("estimatedRequestsPerMinute = %v, se esperaba 20", status.EstimatedRequestsPerMinute)
	}

	updated := env.request(t, http.MethodPut,
		marketReadersBasePath+"/"+reader.ID,
		map[string]any{"label": "Rotada", "intervalSeconds": 6, "enabled": false},
		nil,
	)
	if updated.Code != http.StatusOK {
		t.Fatalf("update status = %d (cuerpo %q)", updated.Code, updated.Body.String())
	}
	assertMarketSourceTestHeaders(t, updated, true)
	updatedReader := marketSourceTestReader(t, updated)
	if updatedReader.Label != "Rotada" || updatedReader.IntervalSeconds != 6 || updatedReader.Enabled {
		t.Fatalf("lector actualizado = %#v", updatedReader)
	}
	if updatedReader.UpdatedAt != marketSourceTestNowUnix {
		t.Fatalf("updatedAt = %d", updatedReader.UpdatedAt)
	}

	status = marketSourceTestStatus(t, env.request(t, http.MethodGet, marketSourceBasePath, nil, nil))
	if status.HealthyAccounts != 0 {
		t.Fatalf("healthyAccounts = %d, se esperaba 0", status.HealthyAccounts)
	}
	if status.EffectiveCadenceSeconds != nil {
		t.Fatalf("effectiveCadenceSeconds = %v, se esperaba null", *status.EffectiveCadenceSeconds)
	}
	if status.EstimatedRequestsPerMinute != 0 {
		t.Fatalf("estimatedRequestsPerMinute = %v, se esperaba 0", status.EstimatedRequestsPerMinute)
	}

	enabled := env.request(t, http.MethodPut,
		marketReadersBasePath+"/"+reader.ID,
		map[string]any{"enabled": true},
		nil,
	)
	if enabled.Code != http.StatusOK {
		t.Fatalf("enable status = %d", enabled.Code)
	}
	if !marketSourceTestReader(t, enabled).Enabled {
		t.Fatal("el lector debe quedar habilitado")
	}

	newToken := "token-lector-dos-654321"
	rotated := env.request(t, http.MethodPut,
		marketReadersBasePath+"/"+reader.ID+"/token",
		map[string]any{"token": newToken},
		nil,
	)
	if rotated.Code != http.StatusOK {
		t.Fatalf("rotate status = %d (cuerpo %q)", rotated.Code, rotated.Body.String())
	}
	assertMarketSourceTestHeaders(t, rotated, true)
	assertMarketSourceTestOmits(t, rotated, token, newToken)
	rotatedReader := marketSourceTestReader(t, rotated)
	if !rotatedReader.TokenConfigured {
		t.Fatal("tokenConfigured debe seguir true")
	}

	stored, found = env.store.reader(reader.ID)
	if !found {
		t.Fatal("el lector desapareció al rotar")
	}
	sum = sha256.Sum256([]byte(newToken))
	if stored.TokenFingerprint != hex.EncodeToString(sum[:]) {
		t.Fatalf("fingerprint rotado = %q", stored.TokenFingerprint)
	}
	decrypted, err = env.api.Vault.Decrypt(stored.EncryptedToken)
	if err != nil {
		t.Fatalf("Decrypt rotado: %v", err)
	}
	if decrypted != newToken {
		t.Fatalf("token rotado descifrado = %q", decrypted)
	}

	deleted := env.request(t, http.MethodDelete,
		marketReadersBasePath+"/"+reader.ID, nil, nil)
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d (cuerpo %q)", deleted.Code, deleted.Body.String())
	}
	assertMarketSourceTestHeaders(t, deleted, false)
	if deleted.Body.Len() != 0 {
		t.Fatalf("204 con cuerpo %q", deleted.Body.String())
	}
	if env.store.count() != 0 {
		t.Fatal("el lector debe eliminarse")
	}

	status = marketSourceTestStatus(t, env.request(t, http.MethodGet, marketSourceBasePath, nil, nil))
	if len(status.Readers) != 0 {
		t.Fatalf("readers = %d, se esperaba 0", len(status.Readers))
	}

	for name, recorder := range map[string]*httptest.ResponseRecorder{
		"delete": env.request(t, http.MethodDelete, marketReadersBasePath+"/"+reader.ID, nil, nil),
		"update": env.request(t, http.MethodPut, marketReadersBasePath+"/"+reader.ID,
			map[string]any{"enabled": true}, nil),
		"rotate": env.request(t, http.MethodPut, marketReadersBasePath+"/"+reader.ID+"/token",
			map[string]any{"token": "token-lector-tres-abcdef"}, nil),
	} {
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d, se esperaba 404 (cuerpo %q)",
				name, recorder.Code, recorder.Body.String())
		}
		assertMarketSourceTestHeaders(t, recorder, true)
		if got := marketSourceTestErrorStatus(t, recorder); got != "not_found" {
			t.Fatalf("%s status = %q", name, got)
		}
	}
}

func TestMarketSourceDuplicateFingerprint(t *testing.T) {
	env := newMarketSourceTestEnv(t)
	firstToken := "token-lector-uno-123456"
	secondToken := "token-lector-dos-654321"
	thirdToken := "token-lector-tres-abcdef"

	first := env.request(t, http.MethodPost, marketReadersBasePath, map[string]any{
		"label": "Primera", "token": firstToken, "intervalSeconds": 3,
	}, nil)
	if first.Code != http.StatusCreated {
		t.Fatalf("primer alta = %d", first.Code)
	}
	firstReader := marketSourceTestReader(t, first)

	duplicate := env.request(t, http.MethodPost, marketReadersBasePath, map[string]any{
		"label": "Duplicada", "token": firstToken, "intervalSeconds": 5,
	}, nil)
	if duplicate.Code != http.StatusConflict {
		t.Fatalf("duplicado status = %d (cuerpo %q)", duplicate.Code, duplicate.Body.String())
	}
	assertMarketSourceTestHeaders(t, duplicate, true)
	if got := marketSourceTestErrorStatus(t, duplicate); got != "duplicate" {
		t.Fatalf("status = %q, se esperaba duplicate", got)
	}
	assertMarketSourceTestOmits(t, duplicate, firstToken)
	if env.store.count() != 1 {
		t.Fatalf("lectores = %d, se esperaba 1", env.store.count())
	}

	second := env.request(t, http.MethodPost, marketReadersBasePath, map[string]any{
		"label": "Segunda", "token": secondToken, "intervalSeconds": 5,
	}, nil)
	if second.Code != http.StatusCreated {
		t.Fatalf("segunda alta = %d (cuerpo %q)", second.Code, second.Body.String())
	}
	secondReader := marketSourceTestReader(t, second)
	if secondReader.ID == firstReader.ID {
		t.Fatal("los ids deben ser distintos")
	}

	rotatedDuplicate := env.request(t, http.MethodPut,
		marketReadersBasePath+"/"+secondReader.ID+"/token",
		map[string]any{"token": firstToken}, nil)
	if rotatedDuplicate.Code != http.StatusConflict {
		t.Fatalf("rotación duplicada = %d (cuerpo %q)",
			rotatedDuplicate.Code, rotatedDuplicate.Body.String())
	}
	if got := marketSourceTestErrorStatus(t, rotatedDuplicate); got != "duplicate" {
		t.Fatalf("status = %q", got)
	}
	stored, found := env.store.reader(secondReader.ID)
	if !found {
		t.Fatal("el segundo lector desapareció")
	}
	decrypted, err := env.api.Vault.Decrypt(stored.EncryptedToken)
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}
	if decrypted != secondToken {
		t.Fatalf("el token no debe cambiar tras un 409: %q", decrypted)
	}

	rotated := env.request(t, http.MethodPut,
		marketReadersBasePath+"/"+secondReader.ID+"/token",
		map[string]any{"token": thirdToken}, nil)
	if rotated.Code != http.StatusOK {
		t.Fatalf("rotación válida = %d (cuerpo %q)", rotated.Code, rotated.Body.String())
	}
	stored, _ = env.store.reader(secondReader.ID)
	decrypted, err = env.api.Vault.Decrypt(stored.EncryptedToken)
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}
	if decrypted != thirdToken {
		t.Fatalf("token rotado = %q", decrypted)
	}
}

func TestMarketSourceValidation(t *testing.T) {
	env := newMarketSourceTestEnv(t)

	validToken := "token-lector-123456"
	createCases := []struct {
		name  string
		body  any
		field string
	}{
		{"etiqueta vacía", map[string]any{
			"label": " ", "token": validToken, "intervalSeconds": 3}, "label"},
		{"etiqueta larga", map[string]any{
			"label": strings.Repeat("a", 61), "token": validToken, "intervalSeconds": 3}, "label"},
		{"token corto", map[string]any{
			"label": "Cuenta", "token": strings.Repeat("x", 11), "intervalSeconds": 3}, "token"},
		{"token largo", map[string]any{
			"label": "Cuenta", "token": strings.Repeat("x", 2049), "intervalSeconds": 3}, "token"},
		{"intervalo bajo", map[string]any{
			"label": "Cuenta", "token": validToken, "intervalSeconds": 2}, "intervalSeconds"},
		{"intervalo alto", map[string]any{
			"label": "Cuenta", "token": validToken, "intervalSeconds": 3601}, "intervalSeconds"},
		{"intervalo ausente", map[string]any{
			"label": "Cuenta", "token": validToken}, "intervalSeconds"},
	}
	for _, testCase := range createCases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := env.request(t, http.MethodPost, marketReadersBasePath, testCase.body, nil)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, se esperaba 400 (cuerpo %q)",
					recorder.Code, recorder.Body.String())
			}
			assertMarketSourceTestHeaders(t, recorder, true)
			var payload struct {
				Status string `json:"status"`
				Field  string `json:"field"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
				t.Fatalf("JSON inválido: %v", err)
			}
			if payload.Status != "validation_failed" || payload.Field != testCase.field {
				t.Fatalf("status=%q field=%q, se esperaba validation_failed/%q",
					payload.Status, payload.Field, testCase.field)
			}
			assertMarketSourceTestOmits(t, recorder, validToken, strings.Repeat("x", 11))
		})
	}
	if env.store.count() != 0 {
		t.Fatal("ninguna validación debe crear lectores")
	}

	for name, body := range map[string]string{
		"json roto":      `{"label":`,
		"json con extra": `{"label":"Cuenta","token":"token-lector-123456","intervalSeconds":3}{"x":1}`,
		"json no objeto": `[]`,
		"cuerpo vacío":   ``,
	} {
		t.Run(name, func(t *testing.T) {
			recorder := env.request(t, http.MethodPost, marketReadersBasePath, body, nil)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, se esperaba 400 (cuerpo %q)",
					recorder.Code, recorder.Body.String())
			}
			if got := marketSourceTestErrorStatus(t, recorder); got != "invalid_body" {
				t.Fatalf("status = %q, se esperaba invalid_body", got)
			}
		})
	}

	created := env.request(t, http.MethodPost, marketReadersBasePath, map[string]any{
		"label": "Cuenta", "token": validToken, "intervalSeconds": 3,
	}, nil)
	if created.Code != http.StatusCreated {
		t.Fatalf("alta válida = %d (cuerpo %q)", created.Code, created.Body.String())
	}
	reader := marketSourceTestReader(t, created)

	updateCases := []struct {
		name  string
		body  map[string]any
		field string
	}{
		{"etiqueta vacía", map[string]any{"label": ""}, "label"},
		{"etiqueta larga", map[string]any{"label": strings.Repeat("b", 61)}, "label"},
		{"intervalo bajo", map[string]any{"intervalSeconds": 2}, "intervalSeconds"},
		{"intervalo alto", map[string]any{"intervalSeconds": 3601}, "intervalSeconds"},
	}
	for _, testCase := range updateCases {
		t.Run("actualizar "+testCase.name, func(t *testing.T) {
			recorder := env.request(t, http.MethodPut,
				marketReadersBasePath+"/"+reader.ID, testCase.body, nil)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, se esperaba 400 (cuerpo %q)",
					recorder.Code, recorder.Body.String())
			}
			if got := marketSourceTestErrorStatus(t, recorder); got != "validation_failed" {
				t.Fatalf("status = %q", got)
			}
		})
	}

	rotate := env.request(t, http.MethodPut,
		marketReadersBasePath+"/"+reader.ID+"/token",
		map[string]any{"token": strings.Repeat("x", 11)}, nil)
	if rotate.Code != http.StatusBadRequest {
		t.Fatalf("rotación corta = %d", rotate.Code)
	}
	if got := marketSourceTestErrorStatus(t, rotate); got != "validation_failed" {
		t.Fatalf("status = %q", got)
	}

	modeCases := []map[string]any{
		{"mode": "otro"},
		{},
		{"mode": ""},
	}
	for _, body := range modeCases {
		recorder := env.request(t, http.MethodPut, marketSourceBasePath, body, nil)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("modo %v status = %d (cuerpo %q)", body, recorder.Code, recorder.Body.String())
		}
		if got := marketSourceTestErrorStatus(t, recorder); got != "validation_failed" {
			t.Fatalf("status = %q", got)
		}
	}

	if recorder := env.request(t, http.MethodPut, marketSourceWebhookSecretPath,
		map[string]any{"secret": strings.Repeat("s", 15)}, nil); recorder.Code != http.StatusBadRequest {
		t.Fatalf("secreto corto = %d", recorder.Code)
	}
	if recorder := env.request(t, http.MethodPut, marketSourceWebhookSecretPath,
		map[string]any{"secret": strings.Repeat("s", 513)}, nil); recorder.Code != http.StatusBadRequest {
		t.Fatalf("secreto largo = %d", recorder.Code)
	}
	if recorder := env.request(t, http.MethodPut, marketSourceStreamCredentialsPath,
		map[string]any{"appId": "abc", "appSecret": marketSourceTestAppKey}, nil); recorder.Code != http.StatusBadRequest {
		t.Fatalf("appId corto = %d", recorder.Code)
	}
	if recorder := env.request(t, http.MethodPut, marketSourceStreamCredentialsPath,
		map[string]any{"appId": marketSourceTestAppID, "appSecret": "corto"}, nil); recorder.Code != http.StatusBadRequest {
		t.Fatalf("appSecret corto = %d", recorder.Code)
	}

	if _, found := env.store.setting(marketSettingMode); found {
		t.Fatal("las validaciones no deben guardar el modo")
	}
	if _, found := env.store.setting(marketSettingWebhookSecret); found {
		t.Fatal("las validaciones no deben guardar el secreto")
	}
}

func TestMarketSourceAuthentication(t *testing.T) {
	env := newMarketSourceTestEnv(t)

	getWithoutCookie := env.request(t, http.MethodGet, marketSourceBasePath, nil,
		func(request *http.Request) { request.Header.Del("Cookie") })
	if getWithoutCookie.Code != http.StatusUnauthorized {
		t.Fatalf("GET sin cookie = %d", getWithoutCookie.Code)
	}
	assertMarketSourceTestHeaders(t, getWithoutCookie, true)
	if got := marketSourceTestErrorStatus(t, getWithoutCookie); got != "unauthenticated" {
		t.Fatalf("status = %q", got)
	}

	getInvalidCookie := env.request(t, http.MethodGet, marketSourceBasePath, nil,
		func(request *http.Request) {
			request.Header.Set("Cookie", CookieName+"=token-invalido")
		})
	if getInvalidCookie.Code != http.StatusUnauthorized {
		t.Fatalf("GET con cookie inválida = %d", getInvalidCookie.Code)
	}

	for name, recorder := range map[string]*httptest.ResponseRecorder{
		"crear": env.request(t, http.MethodPost, marketReadersBasePath, map[string]any{
			"label": "Cuenta", "token": "token-lector-123456", "intervalSeconds": 3,
		}, func(request *http.Request) { request.Header.Del("Cookie") }),
		"modo": env.request(t, http.MethodPut, marketSourceBasePath,
			map[string]any{"mode": marketModePolling},
			func(request *http.Request) { request.Header.Del("Cookie") }),
		"eliminar": env.request(t, http.MethodDelete,
			marketReadersBasePath+"/cualquiera", nil,
			func(request *http.Request) { request.Header.Del("Cookie") }),
	} {
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("%s sin cookie = %d", name, recorder.Code)
		}
		assertMarketSourceTestHeaders(t, recorder, true)
	}
	if env.store.count() != 0 {
		t.Fatal("una petición sin sesión no debe crear lectores")
	}

	// GET no exige Origin ni CSRF.
	withoutOrigin := env.request(t, http.MethodGet, marketSourceBasePath, nil,
		func(request *http.Request) {
			request.Header.Del("Origin")
			request.Header.Del("X-CSRF-Token")
		})
	if withoutOrigin.Code != http.StatusOK {
		t.Fatalf("GET sin Origin = %d", withoutOrigin.Code)
	}
	wrongOrigin := env.request(t, http.MethodGet, marketSourceBasePath, nil,
		func(request *http.Request) { request.Header.Set("Origin", "https://evil.example") })
	if wrongOrigin.Code != http.StatusOK {
		t.Fatalf("GET con Origin ajeno = %d", wrongOrigin.Code)
	}
}

func TestMarketSourceCSRFAndOrigin(t *testing.T) {
	env := newMarketSourceTestEnv(t)

	mutations := func(request *http.Request) {
		request.Header.Del("X-CSRF-Token")
	}
	noCSRF := env.request(t, http.MethodPut, marketSourceBasePath,
		map[string]any{"mode": marketModePolling}, mutations)
	if noCSRF.Code != http.StatusForbidden {
		t.Fatalf("sin CSRF = %d", noCSRF.Code)
	}
	assertMarketSourceTestHeaders(t, noCSRF, true)
	if got := marketSourceTestErrorStatus(t, noCSRF); got != "forbidden" {
		t.Fatalf("status = %q", got)
	}

	randomCSRF := env.request(t, http.MethodPut, marketSourceBasePath,
		map[string]any{"mode": marketModePolling},
		func(request *http.Request) { request.Header.Set("X-CSRF-Token", "csrf-ajeno") })
	if randomCSRF.Code != http.StatusForbidden {
		t.Fatalf("CSRF inválido = %d", randomCSRF.Code)
	}

	wrongOrigin := env.request(t, http.MethodPut, marketSourceBasePath,
		map[string]any{"mode": marketModePolling},
		func(request *http.Request) { request.Header.Set("Origin", "https://evil.example") })
	if wrongOrigin.Code != http.StatusForbidden {
		t.Fatalf("Origin ajeno = %d", wrongOrigin.Code)
	}

	missingOrigin := env.request(t, http.MethodPut, marketSourceBasePath,
		map[string]any{"mode": marketModePolling},
		func(request *http.Request) { request.Header.Del("Origin") })
	if missingOrigin.Code != http.StatusForbidden {
		t.Fatalf("sin Origin = %d", missingOrigin.Code)
	}

	if _, found := env.store.setting(marketSettingMode); found {
		t.Fatal("las peticiones rechazadas no deben guardar el modo")
	}

	createWithoutCSRF := env.request(t, http.MethodPost, marketReadersBasePath,
		map[string]any{"label": "Cuenta", "token": "token-lector-123456", "intervalSeconds": 3},
		func(request *http.Request) { request.Header.Del("X-CSRF-Token") })
	if createWithoutCSRF.Code != http.StatusForbidden {
		t.Fatalf("alta sin CSRF = %d", createWithoutCSRF.Code)
	}
	if env.store.count() != 0 {
		t.Fatal("el alta sin CSRF no debe persistir")
	}

	deleteWithoutCSRF := env.request(t, http.MethodDelete,
		marketReadersBasePath+"/cualquiera", nil,
		func(request *http.Request) { request.Header.Del("X-CSRF-Token") })
	if deleteWithoutCSRF.Code != http.StatusForbidden {
		t.Fatalf("borrado sin CSRF = %d", deleteWithoutCSRF.Code)
	}

	// Una sesión válida pero con el CSRF de otra sesión tampoco pasa.
	_, otherCSRF, err := env.manager.Issue(env.now.Add(time.Minute))
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	mismatched := env.request(t, http.MethodPut, marketSourceBasePath,
		map[string]any{"mode": marketModePolling},
		func(request *http.Request) { request.Header.Set("X-CSRF-Token", otherCSRF) })
	if mismatched.Code != http.StatusForbidden {
		t.Fatalf("CSRF de otra sesión = %d", mismatched.Code)
	}

	valid := env.request(t, http.MethodPut, marketSourceBasePath,
		map[string]any{"mode": marketModePolling}, nil)
	if valid.Code != http.StatusOK {
		t.Fatalf("mutación válida = %d (cuerpo %q)", valid.Code, valid.Body.String())
	}
	if status := marketSourceTestStatus(t, valid); status.Mode != marketModePolling {
		t.Fatalf("mode = %q", status.Mode)
	}
}

func TestMarketSourceModeAndSecrets(t *testing.T) {
	env := newMarketSourceTestEnv(t)

	mode := env.request(t, http.MethodPut, marketSourceBasePath,
		map[string]any{"mode": marketModePolling}, nil)
	if mode.Code != http.StatusOK {
		t.Fatalf("modo status = %d (cuerpo %q)", mode.Code, mode.Body.String())
	}
	assertMarketSourceTestHeaders(t, mode, true)
	status := marketSourceTestStatus(t, mode)
	if status.Mode != marketModePolling {
		t.Fatalf("mode = %q", status.Mode)
	}

	rawMode, found := env.store.setting(marketSettingMode)
	if !found {
		t.Fatal("el modo no se guardó")
	}
	var storedMode string
	if err := json.Unmarshal(rawMode, &storedMode); err != nil {
		t.Fatalf("el modo debe guardarse como JSON: %v (%q)", err, rawMode)
	}
	if storedMode != marketModePolling {
		t.Fatalf("modo guardado = %q", storedMode)
	}
	if updatedAt, found := env.store.settingUpdatedAt(marketSettingMode); !found ||
		updatedAt != marketSourceTestNowUnix {
		t.Fatalf("updated_at = %d", updatedAt)
	}

	if status := marketSourceTestStatus(t,
		env.request(t, http.MethodGet, marketSourceBasePath, nil, nil),
	); status.Mode != marketModePolling {
		t.Fatalf("GET mode = %q", status.Mode)
	}

	webhook := env.request(t, http.MethodPut, marketSourceWebhookSecretPath,
		map[string]any{"secret": marketSourceTestSecret}, nil)
	if webhook.Code != http.StatusOK {
		t.Fatalf("webhook status = %d (cuerpo %q)", webhook.Code, webhook.Body.String())
	}
	assertMarketSourceTestHeaders(t, webhook, true)
	assertMarketSourceTestOmits(t, webhook, marketSourceTestSecret)
	if status := marketSourceTestStatus(t, webhook); !status.WebhookConfigured {
		t.Fatal("webhookConfigured debe ser true")
	}

	rawSecret, found := env.store.setting(marketSettingWebhookSecret)
	if !found {
		t.Fatal("el secreto no se guardó")
	}
	if strings.Contains(string(rawSecret), marketSourceTestSecret) {
		t.Fatal("el ajuste guardado contiene el secreto en texto plano")
	}
	var encryptedSecret string
	if err := json.Unmarshal(rawSecret, &encryptedSecret); err != nil {
		t.Fatalf("el secreto debe guardarse como cadena JSON: %v (%q)", err, rawSecret)
	}
	if encryptedSecret == marketSourceTestSecret {
		t.Fatal("el secreto debe guardarse cifrado")
	}
	decrypted, err := env.api.Vault.Decrypt(encryptedSecret)
	if err != nil {
		t.Fatalf("Decrypt webhook: %v", err)
	}
	if decrypted != marketSourceTestSecret {
		t.Fatalf("secreto descifrado = %q", decrypted)
	}

	rotatedSecret := "secreto-webhook-qvapay-456"
	rotated := env.request(t, http.MethodPut, marketSourceWebhookSecretPath,
		map[string]any{"secret": rotatedSecret}, nil)
	if rotated.Code != http.StatusOK {
		t.Fatalf("rotación webhook = %d", rotated.Code)
	}
	rawSecret, _ = env.store.setting(marketSettingWebhookSecret)
	if strings.Contains(string(rawSecret), rotatedSecret) {
		t.Fatal("el secreto rotado aparece en texto plano")
	}
	encryptedSecret = ""
	if err := json.Unmarshal(rawSecret, &encryptedSecret); err != nil {
		t.Fatalf("Unmarshal secreto: %v", err)
	}
	decrypted, err = env.api.Vault.Decrypt(encryptedSecret)
	if err != nil {
		t.Fatalf("Decrypt secreto rotado: %v", err)
	}
	if decrypted != rotatedSecret {
		t.Fatalf("secreto rotado = %q", decrypted)
	}

	stream := env.request(t, http.MethodPut, marketSourceStreamCredentialsPath,
		map[string]any{
			"appId":     marketSourceTestAppID,
			"appSecret": marketSourceTestAppKey,
		}, nil)
	if stream.Code != http.StatusOK {
		t.Fatalf("stream status = %d (cuerpo %q)", stream.Code, stream.Body.String())
	}
	assertMarketSourceTestHeaders(t, stream, true)
	assertMarketSourceTestOmits(t, stream,
		marketSourceTestAppID, marketSourceTestAppKey)
	status = marketSourceTestStatus(t, stream)
	if !status.StreamConfigured || !status.WebhookConfigured {
		t.Fatalf("streamConfigured=%v webhookConfigured=%v",
			status.StreamConfigured, status.WebhookConfigured)
	}

	for key, plaintext := range map[string]string{
		marketSettingStreamAppID:     marketSourceTestAppID,
		marketSettingStreamAppSecret: marketSourceTestAppKey,
	} {
		raw, found := env.store.setting(key)
		if !found {
			t.Fatalf("falta el ajuste %q", key)
		}
		if strings.Contains(string(raw), plaintext) {
			t.Fatalf("el ajuste %q contiene texto plano", key)
		}
		var encrypted string
		if err := json.Unmarshal(raw, &encrypted); err != nil {
			t.Fatalf("Unmarshal %q: %v", key, err)
		}
		decrypted, err := env.api.Vault.Decrypt(encrypted)
		if err != nil {
			t.Fatalf("Decrypt %q: %v", key, err)
		}
		if decrypted != plaintext {
			t.Fatalf("%q descifrado = %q", key, decrypted)
		}
	}

	// Volver a hybrid actualiza el estado sin tocar los secretos.
	hybrid := env.request(t, http.MethodPut, marketSourceBasePath,
		map[string]any{"mode": marketModeHybrid}, nil)
	if hybrid.Code != http.StatusOK {
		t.Fatalf("hybrid status = %d", hybrid.Code)
	}
	status = marketSourceTestStatus(t, hybrid)
	if status.Mode != marketModeHybrid || !status.WebhookConfigured || !status.StreamConfigured {
		t.Fatalf("estado híbrido = %#v", status)
	}
}

func TestMarketSourceHealthAndAggregates(t *testing.T) {
	env := newMarketSourceTestEnv(t)

	attemptAt := marketSourceTestNowUnix - 30
	successAt := marketSourceTestNowUnix - 60
	warning := "token rechazado"
	readers := []Reader{
		{
			ID: "a", Label: "Primera", EncryptedToken: "enc-a", TokenFingerprint: "fp-a",
			IntervalSeconds: 7, Enabled: true, CreatedAt: 1, UpdatedAt: 2,
			LastSuccessAt: &successAt, LastAttemptAt: &attemptAt,
		},
		{
			ID: "b", Label: "Segunda", EncryptedToken: "enc-b", TokenFingerprint: "fp-b",
			IntervalSeconds: 9, Enabled: true, CreatedAt: 2, UpdatedAt: 3,
		},
		{
			ID: "c", Label: "Tercera", EncryptedToken: "enc-c", TokenFingerprint: "fp-c",
			IntervalSeconds: 8, Enabled: true, CreatedAt: 3, UpdatedAt: 4,
			LastAttemptAt: &attemptAt, ConsecutiveErrors: 2, LastError: &warning,
		},
		{
			ID: "d", Label: "Cuarta", TokenFingerprint: "fp-d",
			IntervalSeconds: 3, Enabled: false, CreatedAt: 4, UpdatedAt: 5,
			LastAttemptAt: &attemptAt,
		},
	}
	for _, reader := range readers {
		if err := env.store.Create(context.Background(), reader); err != nil {
			t.Fatalf("Create(%q): %v", reader.ID, err)
		}
	}

	recorder := env.request(t, http.MethodGet, marketSourceBasePath, nil, nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	status := marketSourceTestStatus(t, recorder)
	if len(status.Readers) != 4 || len(status.Accounts) != 4 {
		t.Fatalf("readers=%d accounts=%d", len(status.Readers), len(status.Accounts))
	}
	if status.HealthyAccounts != 2 {
		t.Fatalf("healthyAccounts = %d, se esperaba 2", status.HealthyAccounts)
	}
	if status.EffectiveCadenceSeconds == nil || *status.EffectiveCadenceSeconds != 7 {
		t.Fatalf("effectiveCadenceSeconds = %v, se esperaba 7", status.EffectiveCadenceSeconds)
	}
	if status.EstimatedRequestsPerMinute != 22.74 {
		t.Fatalf("estimatedRequestsPerMinute = %v, se esperaba 22.74",
			status.EstimatedRequestsPerMinute)
	}

	expectedHealth := map[string]string{
		"a": "healthy",
		"b": "idle",
		"c": "warning",
		"d": "healthy",
	}
	expectedTokens := map[string]bool{
		"a": true, "b": true, "c": true, "d": false,
	}
	for _, reader := range status.Readers {
		if got := expectedHealth[reader.ID]; reader.Health != got {
			t.Fatalf("%s health = %q, se esperaba %q", reader.ID, reader.Health, got)
		}
		if reader.TokenConfigured != expectedTokens[reader.ID] {
			t.Fatalf("%s tokenConfigured = %v", reader.ID, reader.TokenConfigured)
		}
	}
	if status.Readers[0].LastError != nil {
		t.Fatalf("lastError inesperado: %#v", status.Readers[0].LastError)
	}
	if status.Readers[2].LastError == nil || *status.Readers[2].LastError != warning {
		t.Fatalf("lastError = %v", status.Readers[2].LastError)
	}
	if status.Readers[0].LastSuccessAt == nil ||
		*status.Readers[0].LastSuccessAt != successAt {
		t.Fatalf("lastSuccessAt = %v", status.Readers[0].LastSuccessAt)
	}
	if status.Readers[1].LastAttemptAt != nil {
		t.Fatalf("lastAttemptAt = %v, se esperaba null", status.Readers[1].LastAttemptAt)
	}

	firstJSON, err := json.Marshal(status.Accounts)
	if err != nil {
		t.Fatalf("Marshal accounts: %v", err)
	}
	secondJSON, err := json.Marshal(status.Readers)
	if err != nil {
		t.Fatalf("Marshal readers: %v", err)
	}
	if !bytes.Equal(firstJSON, secondJSON) {
		t.Fatal("accounts y readers deben contener la misma lista")
	}
}

func TestMarketSourceRoutesAndMethods(t *testing.T) {
	env := newMarketSourceTestEnv(t)

	methodCases := []struct {
		method string
		target string
		allow  string
	}{
		{http.MethodGet, marketReadersBasePath, "POST"},
		{http.MethodPost, marketSourceBasePath, "GET, PUT"},
		{http.MethodDelete, marketSourceBasePath, "GET, PUT"},
		{http.MethodGet, marketSourceWebhookSecretPath, "PUT"},
		{http.MethodPatch, marketSourceWebhookSecretPath, "PUT"},
		{http.MethodGet, marketSourceStreamCredentialsPath, "PUT"},
		{http.MethodGet, marketReadersBasePath + "/cualquiera", "PUT, DELETE"},
		{http.MethodPost, marketReadersBasePath + "/cualquiera/token", "PUT"},
	}
	for _, testCase := range methodCases {
		recorder := env.request(t, testCase.method, testCase.target, nil, nil)
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s %s = %d, se esperaba 405 (cuerpo %q)",
				testCase.method, testCase.target, recorder.Code, recorder.Body.String())
		}
		assertMarketSourceTestHeaders(t, recorder, true)
		if got := recorder.Header().Get("Allow"); got != testCase.allow {
			t.Fatalf("%s %s Allow = %q, se esperaba %q",
				testCase.method, testCase.target, got, testCase.allow)
		}
		if got := marketSourceTestErrorStatus(t, recorder); got != "method_not_allowed" {
			t.Fatalf("status = %q", got)
		}
	}

	notFound := []string{
		"/api/market-source/",
		"/api/market-source/desconocido",
		"/api/market-source/webhook-secret/extra",
		"/api/market-source/stream-credentials/extra",
		"/api/market-readers/",
		"/api/market-readers/uno/dos",
		"/api/market-readers/" + strings.Repeat("a", 129),
	}
	for _, target := range notFound {
		recorder := env.request(t, http.MethodGet, target, nil, nil)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s = %d, se esperaba 404 (cuerpo %q)",
				target, recorder.Code, recorder.Body.String())
		}
		assertMarketSourceTestHeaders(t, recorder, true)
		if got := marketSourceTestErrorStatus(t, recorder); got != "not_found" {
			t.Fatalf("%s status = %q", target, got)
		}
	}
}

func TestMarketSourceResponsesNeverLeakTokens(t *testing.T) {
	env := newMarketSourceTestEnv(t)
	token := "token-lector-secreto-123456"
	newToken := "token-lector-rotado-654321"

	recorders := []*httptest.ResponseRecorder{
		env.request(t, http.MethodPut, marketSourceBasePath,
			map[string]any{"mode": marketModePolling}, nil),
		env.request(t, http.MethodPut, marketSourceWebhookSecretPath,
			map[string]any{"secret": marketSourceTestSecret}, nil),
		env.request(t, http.MethodPut, marketSourceStreamCredentialsPath,
			map[string]any{
				"appId":     marketSourceTestAppID,
				"appSecret": marketSourceTestAppKey,
			}, nil),
	}

	created := env.request(t, http.MethodPost, marketReadersBasePath, map[string]any{
		"label": "Cuenta", "token": token, "intervalSeconds": 3,
	}, nil)
	recorders = append(recorders, created)
	if created.Code != http.StatusCreated {
		t.Fatalf("alta = %d (cuerpo %q)", created.Code, created.Body.String())
	}
	reader := marketSourceTestReader(t, created)

	recorders = append(recorders,
		env.request(t, http.MethodGet, marketSourceBasePath, nil, nil),
		env.request(t, http.MethodPut, marketReadersBasePath+"/"+reader.ID,
			map[string]any{"label": "Renombrada"}, nil),
		env.request(t, http.MethodPut, marketReadersBasePath+"/"+reader.ID+"/token",
			map[string]any{"token": newToken}, nil),
	)

	stored, found := env.store.reader(reader.ID)
	if !found {
		t.Fatal("el lector no existe")
	}
	webhookRaw, _ := env.store.setting(marketSettingWebhookSecret)
	appIDRaw, _ := env.store.setting(marketSettingStreamAppID)
	appSecretRaw, _ := env.store.setting(marketSettingStreamAppSecret)

	sensitive := []string{
		token,
		newToken,
		marketSourceTestSecret,
		marketSourceTestAppID,
		marketSourceTestAppKey,
		stored.EncryptedToken,
		stored.TokenFingerprint,
		string(webhookRaw),
		string(appIDRaw),
		string(appSecretRaw),
	}
	for index, recorder := range recorders {
		assertMarketSourceTestHeaders(t, recorder, true)
		assertMarketSourceTestOmits(t, recorder, sensitive...)
		if strings.Contains(recorder.Body.String(), "encrypted_token") ||
			strings.Contains(recorder.Body.String(), "tokenFingerprint") ||
			strings.Contains(recorder.Body.String(), "encryptedToken") {
			t.Fatalf("respuesta %d expone campos internos: %q", index, recorder.Body.String())
		}
	}

	deleted := env.request(t, http.MethodDelete,
		marketReadersBasePath+"/"+reader.ID, nil, nil)
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("delete = %d", deleted.Code)
	}
	assertMarketSourceTestHeaders(t, deleted, false)
	assertMarketSourceTestOmits(t, deleted, sensitive...)
	if deleted.Body.Len() != 0 {
		t.Fatalf("204 con cuerpo %q", deleted.Body.String())
	}
}

func TestMarketSourceStoreAndVaultUnavailable(t *testing.T) {
	env := newMarketSourceTestEnv(t)

	env.api.Store = nil
	if recorder := env.request(t, http.MethodGet, marketSourceBasePath, nil, nil); recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("GET sin store = %d", recorder.Code)
	}
	if recorder := env.request(t, http.MethodPut, marketSourceBasePath,
		map[string]any{"mode": marketModePolling}, nil); recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("PUT modo sin store = %d", recorder.Code)
	}

	env = newMarketSourceTestEnv(t)
	env.api.Vault = nil
	recorder := env.request(t, http.MethodPost, marketReadersBasePath, map[string]any{
		"label": "Cuenta", "token": "token-lector-123456", "intervalSeconds": 3,
	}, nil)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("alta sin vault = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	if env.store.count() != 0 {
		t.Fatal("sin vault no debe persistirse el lector")
	}

	env = newMarketSourceTestEnv(t)
	env.api.Vault = nil
	recorder = env.request(t, http.MethodPut, marketSourceWebhookSecretPath,
		map[string]any{"secret": marketSourceTestSecret}, nil)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("webhook sin vault = %d", recorder.Code)
	}
	if _, found := env.store.setting(marketSettingWebhookSecret); found {
		t.Fatal("sin vault no debe persistirse el secreto")
	}
}

func TestMarketSourceBodyLimit(t *testing.T) {
	env := newMarketSourceTestEnv(t)

	// Un cuerpo por encima del límite se rechaza con 413 antes de validar.
	oversized := strings.Repeat("a", maxMarketSourceBodyBytes+1)
	recorder := env.request(t, http.MethodPost, marketReadersBasePath,
		`{"label":"`+oversized+`"}`, nil)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, se esperaba 413 (cuerpo %q)",
			recorder.Code, recorder.Body.String())
	}
	if got := marketSourceTestErrorStatus(t, recorder); got != "payload_too_large" {
		t.Fatalf("status = %q", got)
	}
	assertMarketSourceTestHeaders(t, recorder, true)
}

func TestMarketSourceUUIDsAreUnique(t *testing.T) {
	env := newMarketSourceTestEnv(t)
	seen := make(map[string]struct{})

	for index := 0; index < 8; index++ {
		token := "token-lector-unico-" + string(rune('a'+index)) + "123456"
		recorder := env.request(t, http.MethodPost, marketReadersBasePath, map[string]any{
			"label": "Cuenta", "token": token, "intervalSeconds": 3,
		}, nil)
		if recorder.Code != http.StatusCreated {
			t.Fatalf("alta %d = %d (cuerpo %q)", index, recorder.Code, recorder.Body.String())
		}
		id := marketSourceTestReader(t, recorder).ID
		if !marketSourceTestUUIDPattern.MatchString(id) {
			t.Fatalf("id = %q, no es UUID v4", id)
		}
		if _, duplicate := seen[id]; duplicate {
			t.Fatalf("id repetido %q", id)
		}
		seen[id] = struct{}{}
	}
}
