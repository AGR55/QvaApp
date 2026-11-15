package edge

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// fakeMobileCredentialStore implementa MobileCredentialStore en memoria. Los
// errores inyectables permiten comprobar el fallback del overlay y el 503 de
// las lecturas administrativas.
type fakeMobileCredentialStore struct {
	devices       map[string]MobileDevice
	operators     map[string]MobileOperator
	push          map[string]string
	listErr       error
	credentialErr error
}

func newFakeMobileCredentialStore() *fakeMobileCredentialStore {
	return &fakeMobileCredentialStore{
		devices:   make(map[string]MobileDevice),
		operators: make(map[string]MobileOperator),
		push:      make(map[string]string),
	}
}

func (store *fakeMobileCredentialStore) Devices(context.Context) ([]MobileDevice, error) {
	if store.listErr != nil {
		return nil, store.listErr
	}
	devices := make([]MobileDevice, 0, len(store.devices))
	for _, device := range store.devices {
		devices = append(devices, device)
	}
	return devices, nil
}

func (store *fakeMobileCredentialStore) Operators(context.Context) ([]MobileOperator, error) {
	if store.listErr != nil {
		return nil, store.listErr
	}
	operators := make([]MobileOperator, 0, len(store.operators))
	for _, operator := range store.operators {
		operators = append(operators, operator)
	}
	return operators, nil
}

func (store *fakeMobileCredentialStore) CreateDevice(_ context.Context, device MobileDevice) error {
	store.devices[device.ID] = device
	return nil
}

func (store *fakeMobileCredentialStore) CreateOperator(_ context.Context, operator MobileOperator) error {
	store.operators[operator.ID] = operator
	return nil
}

func (store *fakeMobileCredentialStore) RevokeDevice(_ context.Context, id string, now int64) (bool, error) {
	device, ok := store.devices[id]
	if !ok || device.RevokedAt != nil {
		return false, nil
	}
	value := now
	device.RevokedAt = &value
	store.devices[id] = device
	return true, nil
}

func (store *fakeMobileCredentialStore) RevokeOperator(_ context.Context, id string, now int64) (bool, error) {
	operator, ok := store.operators[id]
	if !ok || operator.RevokedAt != nil {
		return false, nil
	}
	value := now
	operator.RevokedAt = &value
	store.operators[id] = operator
	return true, nil
}

func (store *fakeMobileCredentialStore) CredentialDevices(context.Context) ([]MobileCredential, error) {
	if store.credentialErr != nil {
		return nil, store.credentialErr
	}
	credentials := make([]MobileCredential, 0, len(store.devices))
	for _, device := range store.devices {
		credentials = append(credentials, MobileCredential{
			ID: device.ID, TokenHash: device.TokenHash,
			Revoked: device.RevokedAt != nil,
		})
	}
	return credentials, nil
}

func (store *fakeMobileCredentialStore) CredentialOperators(context.Context) ([]MobileCredential, error) {
	if store.credentialErr != nil {
		return nil, store.credentialErr
	}
	credentials := make([]MobileCredential, 0, len(store.operators))
	for _, operator := range store.operators {
		credentials = append(credentials, MobileCredential{
			ID: operator.ID, TokenHash: operator.TokenHash,
			Scopes: operator.Scopes, Revoked: operator.RevokedAt != nil,
		})
	}
	return credentials, nil
}

func (store *fakeMobileCredentialStore) PutChatPushDevice(_ context.Context, operatorID, token string, _ int64) error {
	for owner, existing := range store.push {
		if existing == token && owner != operatorID {
			delete(store.push, owner)
		}
	}
	store.push[operatorID] = token
	return nil
}

func (store *fakeMobileCredentialStore) DeleteChatPushDevice(_ context.Context, operatorID string) error {
	delete(store.push, operatorID)
	return nil
}

type mobileAdminTestCall struct {
	method        string
	target        string
	body          string
	cookie        *http.Cookie
	csrf          string
	origin        string
	authorization string
}

func mobileAdminTestDo(handler http.Handler, call mobileAdminTestCall) *httptest.ResponseRecorder {
	request := httptest.NewRequest(call.method, call.target, strings.NewReader(call.body))
	if call.cookie != nil {
		request.AddCookie(call.cookie)
	}
	if call.csrf != "" {
		request.Header.Set("X-CSRF-Token", call.csrf)
	}
	if call.origin != "" {
		request.Header.Set("Origin", call.origin)
	}
	if call.authorization != "" {
		request.Header.Set("Authorization", call.authorization)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func mobileAdminTestJSON(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	return string(raw)
}

func writeMobileAdminTestFile(t *testing.T, path string, value any) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("Marshal(%q): %v", path, err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}
}

func assertMobileAdminHeaders(t *testing.T, recorder *httptest.ResponseRecorder) {
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
	if len(recorder.Result().Cookies()) != 0 {
		t.Fatal("la API administrativa no debe emitir cookies")
	}
	if recorder.Code != http.StatusNoContent {
		if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
			t.Fatalf("Content-Type = %q, se esperaba JSON", got)
		}
	}
}

type mobileAdminFixture struct {
	api    *MobileAdminAPI
	store  *fakeMobileCredentialStore
	cookie *http.Cookie
	csrf   string
	now    time.Time
	dir    string
}

func newMobileAdminFixture(t *testing.T) mobileAdminFixture {
	t.Helper()
	now := time.UnixMilli(1_700_000_000_000)
	manager := newSessionTestManager(t, time.Hour)
	token, csrf, err := manager.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	dir := t.TempDir()
	store := newFakeMobileCredentialStore()
	api := &MobileAdminAPI{
		Sessions:      manager,
		Store:         store,
		DashboardFile: filepath.Join(dir, "dashboard-snapshot.json"),
		OperatorsFile: filepath.Join(dir, "operators.json"),
		TrustedOrigin: "https://panel.example",
		Now:           func() time.Time { return now },
	}
	return mobileAdminFixture{
		api: api, store: store,
		cookie: &http.Cookie{Name: CookieName, Value: token},
		csrf:   csrf, now: now, dir: dir,
	}
}

func (fixture mobileAdminFixture) authorized(method, target, body string) mobileAdminTestCall {
	return mobileAdminTestCall{
		method: method, target: target, body: body,
		cookie: fixture.cookie, csrf: fixture.csrf,
		origin: "https://panel.example",
	}
}

func TestMobileAdminAPIListCombinesFilesAndStore(t *testing.T) {
	fixture := newMobileAdminFixture(t)
	writeMobileAdminTestFile(t, fixture.api.DashboardFile, map[string]any{
		"generatedAt": 1_700_000_000_000,
		"devices": []map[string]any{
			{"id": "dev-file", "label": "Archivo", "createdAt": 3000, "revokedAt": nil},
			{"id": "dev-shared", "label": "Antiguo", "createdAt": 1000, "revokedAt": nil},
			{"id": "dev-revoked", "label": "Revocado", "createdAt": 2000, "revokedAt": 123},
		},
	})
	fixture.store.devices["dev-shared"] = MobileDevice{
		ID: "dev-shared", Label: "Nuevo", TokenHash: "hash-shared", CreatedAt: 1000,
	}
	fixture.store.devices["dev-db"] = MobileDevice{
		ID: "dev-db", Label: "Base", TokenHash: "hash-db", CreatedAt: 4000,
	}
	writeMobileAdminTestFile(t, fixture.api.OperatorsFile, []map[string]any{
		{"id": "op-file", "label": "Archivo", "scopes": []string{"read"}, "createdAt": 3000, "revokedAt": nil},
		{"id": "op-shared", "label": "Antiguo", "scopes": []string{"read"}, "createdAt": 1000, "revokedAt": nil},
	})
	revokedAt := int64(5000)
	fixture.store.operators["op-shared"] = MobileOperator{
		ID: "op-shared", Label: "Nuevo", TokenHash: "hash-op-shared",
		Scopes: []string{"read", "actions"}, CreatedAt: 1000, RevokedAt: &revokedAt,
	}
	fixture.store.operators["op-db"] = MobileOperator{
		ID: "op-db", Label: "Base", TokenHash: "hash-op-db",
		Scopes: []string{"read", "actions"}, CreatedAt: 2000,
	}

	deviceRecorder := mobileAdminTestDo(fixture.api, mobileAdminTestCall{
		method: http.MethodGet, target: mobileAdminDevicesPath, cookie: fixture.cookie,
	})
	if deviceRecorder.Code != http.StatusOK {
		t.Fatalf("dispositivos: %d (cuerpo %q)", deviceRecorder.Code, deviceRecorder.Body.String())
	}
	assertMobileAdminHeaders(t, deviceRecorder)
	if strings.Contains(deviceRecorder.Body.String(), "tokenHash") ||
		strings.Contains(deviceRecorder.Body.String(), "hash-shared") {
		t.Fatal("la respuesta no debe exponer hashes")
	}
	var devices struct {
		Data []MobileDevice `json:"data"`
	}
	if err := json.Unmarshal(deviceRecorder.Body.Bytes(), &devices); err != nil {
		t.Fatalf("dispositivos JSON: %v", err)
	}
	if len(devices.Data) != 4 {
		t.Fatalf("dispositivos = %+v", devices.Data)
	}
	wantDeviceOrder := []string{"dev-db", "dev-file", "dev-revoked", "dev-shared"}
	for index, id := range wantDeviceOrder {
		if devices.Data[index].ID != id {
			t.Fatalf("orden dispositivos = %+v", devices.Data)
		}
	}
	if devices.Data[3].Label != "Nuevo" {
		t.Fatalf("la base de datos debe prevalecer: %+v", devices.Data[3])
	}
	if devices.Data[2].RevokedAt == nil || *devices.Data[2].RevokedAt != 123 {
		t.Fatalf("revokedAt = %v", devices.Data[2].RevokedAt)
	}
	if devices.Data[0].RevokedAt != nil {
		t.Fatalf("dev-db debería estar vigente: %+v", devices.Data[0])
	}

	operatorRecorder := mobileAdminTestDo(fixture.api, mobileAdminTestCall{
		method: http.MethodGet, target: mobileAdminOperatorsPath, cookie: fixture.cookie,
	})
	if operatorRecorder.Code != http.StatusOK {
		t.Fatalf("operadores: %d (cuerpo %q)", operatorRecorder.Code, operatorRecorder.Body.String())
	}
	assertMobileAdminHeaders(t, operatorRecorder)
	var operators struct {
		Data []MobileOperator `json:"data"`
	}
	if err := json.Unmarshal(operatorRecorder.Body.Bytes(), &operators); err != nil {
		t.Fatalf("operadores JSON: %v", err)
	}
	if len(operators.Data) != 3 {
		t.Fatalf("operadores = %+v", operators.Data)
	}
	wantOperatorOrder := []string{"op-file", "op-db", "op-shared"}
	for index, id := range wantOperatorOrder {
		if operators.Data[index].ID != id {
			t.Fatalf("orden operadores = %+v", operators.Data)
		}
	}
	if operators.Data[2].RevokedAt == nil || *operators.Data[2].RevokedAt != 5000 {
		t.Fatalf("op-shared debería venir revocado de la base: %+v", operators.Data[2])
	}

	fixture.store.listErr = errors.New("db caída")
	if got := mobileAdminTestDo(fixture.api, mobileAdminTestCall{
		method: http.MethodGet, target: mobileAdminDevicesPath, cookie: fixture.cookie,
	}); got.Code != http.StatusServiceUnavailable {
		t.Fatalf("error de base: %d (cuerpo %q)", got.Code, got.Body.String())
	}
	fixture.store.listErr = nil

	if err := os.WriteFile(fixture.api.OperatorsFile, []byte(`{"no":"es un arreglo"}`), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if got := mobileAdminTestDo(fixture.api, mobileAdminTestCall{
		method: http.MethodGet, target: mobileAdminOperatorsPath, cookie: fixture.cookie,
	}); got.Code != http.StatusServiceUnavailable {
		t.Fatalf("archivo inválido: %d (cuerpo %q)", got.Code, got.Body.String())
	}
}

var mobileAdminTestUUIDPattern = regexp.MustCompile(
	`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

var mobileAdminTestTokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

func TestMobileAdminAPICreateDeviceAndOperator(t *testing.T) {
	fixture := newMobileAdminFixture(t)

	deviceRecorder := mobileAdminTestDo(fixture.api, fixture.authorized(
		http.MethodPost, mobileAdminDevicesPath, `{"label":"  Android QA  "}`))
	if deviceRecorder.Code != http.StatusCreated {
		t.Fatalf("crear dispositivo: %d (cuerpo %q)", deviceRecorder.Code, deviceRecorder.Body.String())
	}
	assertMobileAdminHeaders(t, deviceRecorder)
	if strings.Contains(deviceRecorder.Body.String(), "tokenHash") {
		t.Fatal("no debe exponerse tokenHash")
	}
	var devicePayload struct {
		Data struct {
			Device MobileDevice `json:"device"`
			Token  string       `json:"token"`
		} `json:"data"`
	}
	if err := json.Unmarshal(deviceRecorder.Body.Bytes(), &devicePayload); err != nil {
		t.Fatalf("dispositivo JSON: %v", err)
	}
	device := devicePayload.Data.Device
	if !mobileAdminTestUUIDPattern.MatchString(device.ID) {
		t.Fatalf("id de dispositivo = %q", device.ID)
	}
	if device.Label != "Android QA" {
		t.Fatalf("label = %q", device.Label)
	}
	if device.CreatedAt != fixture.now.UnixMilli() || device.RevokedAt != nil {
		t.Fatalf("device = %+v", device)
	}
	if len(devicePayload.Data.Token) < 40 ||
		!mobileAdminTestTokenPattern.MatchString(devicePayload.Data.Token) {
		t.Fatalf("token de dispositivo inválido = %q", devicePayload.Data.Token)
	}
	hash := mobileAuthTestHash(devicePayload.Data.Token)
	if strings.Contains(deviceRecorder.Body.String(), hash) {
		t.Fatal("la respuesta no debe contener el hash del token")
	}
	stored, ok := fixture.store.devices[device.ID]
	if !ok || stored.TokenHash != hash {
		t.Fatalf("dispositivo guardado = %+v", stored)
	}

	operatorRecorder := mobileAdminTestDo(fixture.api, fixture.authorized(
		http.MethodPost, mobileAdminOperatorsPath, `{"label":"Operador QA"}`))
	if operatorRecorder.Code != http.StatusCreated {
		t.Fatalf("crear operador: %d (cuerpo %q)", operatorRecorder.Code, operatorRecorder.Body.String())
	}
	assertMobileAdminHeaders(t, operatorRecorder)
	if strings.Contains(operatorRecorder.Body.String(), "tokenHash") {
		t.Fatal("no debe exponerse tokenHash")
	}
	var operatorPayload struct {
		Data struct {
			Operator MobileOperator `json:"operator"`
			Token    string         `json:"token"`
		} `json:"data"`
	}
	if err := json.Unmarshal(operatorRecorder.Body.Bytes(), &operatorPayload); err != nil {
		t.Fatalf("operador JSON: %v", err)
	}
	operator := operatorPayload.Data.Operator
	if !mobileAdminTestUUIDPattern.MatchString(operator.ID) {
		t.Fatalf("id de operador = %q", operator.ID)
	}
	if operator.Label != "Operador QA" || operator.CreatedAt != fixture.now.UnixMilli() ||
		operator.RevokedAt != nil {
		t.Fatalf("operator = %+v", operator)
	}
	if len(operator.Scopes) != 2 || operator.Scopes[0] != "read" || operator.Scopes[1] != "actions" {
		t.Fatalf("scopes = %v", operator.Scopes)
	}
	if len(operatorPayload.Data.Token) != 48 ||
		!mobileAdminTestTokenPattern.MatchString(operatorPayload.Data.Token) {
		t.Fatalf("token de operador inválido = %q", operatorPayload.Data.Token)
	}
	operatorHash := mobileAuthTestHash(operatorPayload.Data.Token)
	if strings.Contains(operatorRecorder.Body.String(), operatorHash) {
		t.Fatal("la respuesta no debe contener el hash del token")
	}
	storedOperator, ok := fixture.store.operators[operator.ID]
	if !ok || storedOperator.TokenHash != operatorHash {
		t.Fatalf("operador guardado = %+v", storedOperator)
	}

	// Las credenciales creadas deben aparecer en el listado combinado.
	list := mobileAdminTestDo(fixture.api, mobileAdminTestCall{
		method: http.MethodGet, target: mobileAdminDevicesPath, cookie: fixture.cookie,
	})
	if !strings.Contains(list.Body.String(), device.ID) {
		t.Fatalf("el dispositivo creado no aparece en el listado: %q", list.Body.String())
	}
}

func TestMobileAdminAPIRevokeDeviceAndOperator(t *testing.T) {
	fixture := newMobileAdminFixture(t)
	fixture.store.devices["dev-1"] = MobileDevice{ID: "dev-1", Label: "Uno", CreatedAt: 1}
	fixture.store.operators["op-1"] = MobileOperator{
		ID: "op-1", Label: "Uno", Scopes: []string{"read"}, CreatedAt: 1,
	}

	deviceRecorder := mobileAdminTestDo(fixture.api, fixture.authorized(
		http.MethodDelete, mobileAdminDevicesPath+"/dev-1", ""))
	if deviceRecorder.Code != http.StatusNoContent {
		t.Fatalf("revocar dispositivo: %d (cuerpo %q)", deviceRecorder.Code, deviceRecorder.Body.String())
	}
	assertMobileAdminHeaders(t, deviceRecorder)
	if revoked := fixture.store.devices["dev-1"].RevokedAt; revoked == nil || *revoked != fixture.now.UnixMilli() {
		t.Fatalf("revokedAt = %v", revoked)
	}
	if again := mobileAdminTestDo(fixture.api, fixture.authorized(
		http.MethodDelete, mobileAdminDevicesPath+"/dev-1", "")); again.Code != http.StatusNotFound {
		t.Fatalf("segunda revocación: %d", again.Code)
	}
	if missing := mobileAdminTestDo(fixture.api, fixture.authorized(
		http.MethodDelete, mobileAdminDevicesPath+"/nope", "")); missing.Code != http.StatusNotFound {
		t.Fatalf("dispositivo inexistente: %d", missing.Code)
	}

	operatorRecorder := mobileAdminTestDo(fixture.api, fixture.authorized(
		http.MethodDelete, mobileAdminOperatorsPath+"/op-1", ""))
	if operatorRecorder.Code != http.StatusNoContent {
		t.Fatalf("revocar operador: %d (cuerpo %q)", operatorRecorder.Code, operatorRecorder.Body.String())
	}
	assertMobileAdminHeaders(t, operatorRecorder)
	if revoked := fixture.store.operators["op-1"].RevokedAt; revoked == nil || *revoked != fixture.now.UnixMilli() {
		t.Fatalf("revokedAt = %v", revoked)
	}
	if again := mobileAdminTestDo(fixture.api, fixture.authorized(
		http.MethodDelete, mobileAdminOperatorsPath+"/op-1", "")); again.Code != http.StatusNotFound {
		t.Fatalf("segunda revocación: %d", again.Code)
	}
}

func TestMobileAdminAPIValidationAndRouting(t *testing.T) {
	fixture := newMobileAdminFixture(t)
	longLabel := mobileAdminTestJSON(t, map[string]string{"label": strings.Repeat("a", 81)})
	hugeLabel := mobileAdminTestJSON(t, map[string]string{"label": strings.Repeat("a", 9000)})

	cases := []struct {
		name   string
		call   mobileAdminTestCall
		status int
		allow  string
	}{
		{"etiqueta vacía", fixture.authorized(http.MethodPost, mobileAdminDevicesPath, `{"label":""}`), http.StatusBadRequest, ""},
		{"etiqueta solo espacios", fixture.authorized(http.MethodPost, mobileAdminDevicesPath, `{"label":"   "}`), http.StatusBadRequest, ""},
		{"etiqueta de 81", fixture.authorized(http.MethodPost, mobileAdminDevicesPath, longLabel), http.StatusBadRequest, ""},
		{"etiqueta de operador vacía", fixture.authorized(http.MethodPost, mobileAdminOperatorsPath, `{"label":""}`), http.StatusBadRequest, ""},
		{"JSON inválido", fixture.authorized(http.MethodPost, mobileAdminDevicesPath, `{`), http.StatusBadRequest, ""},
		{"cuerpo vacío", fixture.authorized(http.MethodPost, mobileAdminDevicesPath, ""), http.StatusBadRequest, ""},
		{"cuerpo enorme", fixture.authorized(http.MethodPost, mobileAdminDevicesPath, hugeLabel), http.StatusRequestEntityTooLarge, ""},
		{"método incorrecto en colección", fixture.authorized(http.MethodPut, mobileAdminDevicesPath, ""), http.StatusMethodNotAllowed, "GET, POST"},
		{"método incorrecto en operadores", fixture.authorized(http.MethodPut, mobileAdminOperatorsPath, ""), http.StatusMethodNotAllowed, "GET, POST"},
		{"método incorrecto en dispositivo", fixture.authorized(http.MethodGet, mobileAdminDevicesPath+"/dev-1", ""), http.StatusMethodNotAllowed, "DELETE"},
		{"método incorrecto en operador", fixture.authorized(http.MethodPost, mobileAdminOperatorsPath+"/op-1", ""), http.StatusMethodNotAllowed, "DELETE"},
		{"método incorrecto en push", fixture.authorized(http.MethodGet, mobileAdminPushDevicePath, ""), http.StatusMethodNotAllowed, "POST, DELETE"},
		{"ruta desconocida", fixture.authorized(http.MethodGet, "/api/mobile/device-check", ""), http.StatusNotFound, ""},
		{"id vacío", fixture.authorized(http.MethodDelete, mobileAdminDevicesPath+"/", ""), http.StatusNotFound, ""},
		{"id con separador", fixture.authorized(http.MethodDelete, mobileAdminDevicesPath+"/a/b", ""), http.StatusNotFound, ""},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := mobileAdminTestDo(fixture.api, testCase.call)
			if recorder.Code != testCase.status {
				t.Fatalf("status = %d, se esperaba %d (cuerpo %q)",
					recorder.Code, testCase.status, recorder.Body.String())
			}
			assertMobileAdminHeaders(t, recorder)
			if testCase.allow != "" {
				if got := recorder.Header().Get("Allow"); got != testCase.allow {
					t.Fatalf("Allow = %q, se esperaba %q", got, testCase.allow)
				}
			}
		})
	}
}

func TestMobileAdminAPIAuthCSRFAndOrigin(t *testing.T) {
	fixture := newMobileAdminFixture(t)
	body := `{"label":"Android"}`

	cases := []struct {
		name   string
		call   mobileAdminTestCall
		status int
	}{
		{"GET sin cookie", mobileAdminTestCall{
			method: http.MethodGet, target: mobileAdminDevicesPath,
		}, http.StatusUnauthorized},
		{"POST sin cookie", mobileAdminTestCall{
			method: http.MethodPost, target: mobileAdminDevicesPath, body: body,
			csrf: fixture.csrf, origin: "https://panel.example",
		}, http.StatusUnauthorized},
		{"DELETE sin cookie", mobileAdminTestCall{
			method: http.MethodDelete, target: mobileAdminDevicesPath + "/dev-1",
			csrf: fixture.csrf, origin: "https://panel.example",
		}, http.StatusUnauthorized},
		{"cookie inválida", mobileAdminTestCall{
			method: http.MethodGet, target: mobileAdminDevicesPath,
			cookie: &http.Cookie{Name: CookieName, Value: "invalida"},
		}, http.StatusUnauthorized},
		{"POST sin CSRF", mobileAdminTestCall{
			method: http.MethodPost, target: mobileAdminDevicesPath, body: body,
			cookie: fixture.cookie, origin: "https://panel.example",
		}, http.StatusForbidden},
		{"POST sin Origin", mobileAdminTestCall{
			method: http.MethodPost, target: mobileAdminDevicesPath, body: body,
			cookie: fixture.cookie, csrf: fixture.csrf,
		}, http.StatusForbidden},
		{"POST con Origin ajeno", mobileAdminTestCall{
			method: http.MethodPost, target: mobileAdminDevicesPath, body: body,
			cookie: fixture.cookie, csrf: fixture.csrf, origin: "https://evil.example",
		}, http.StatusForbidden},
		{"DELETE sin CSRF", mobileAdminTestCall{
			method: http.MethodDelete, target: mobileAdminDevicesPath + "/dev-1",
			cookie: fixture.cookie, origin: "https://panel.example",
		}, http.StatusForbidden},
		{"POST de operador sin CSRF", mobileAdminTestCall{
			method: http.MethodPost, target: mobileAdminOperatorsPath, body: body,
			cookie: fixture.cookie, origin: "https://panel.example",
		}, http.StatusForbidden},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := mobileAdminTestDo(fixture.api, testCase.call)
			if recorder.Code != testCase.status {
				t.Fatalf("status = %d, se esperaba %d (cuerpo %q)",
					recorder.Code, testCase.status, recorder.Body.String())
			}
			assertMobileAdminHeaders(t, recorder)
		})
	}

	// Las lecturas no exigen Origin ni CSRF, solo cookie.
	read := mobileAdminTestDo(fixture.api, mobileAdminTestCall{
		method: http.MethodGet, target: mobileAdminDevicesPath,
		cookie: fixture.cookie, origin: "https://evil.example",
	})
	if read.Code != http.StatusOK {
		t.Fatalf("GET con cookie: %d (cuerpo %q)", read.Code, read.Body.String())
	}
	// La mutación correcta sigue funcionando.
	created := mobileAdminTestDo(fixture.api, fixture.authorized(
		http.MethodPost, mobileAdminDevicesPath, body))
	if created.Code != http.StatusCreated {
		t.Fatalf("POST autorizado: %d (cuerpo %q)", created.Code, created.Body.String())
	}
}

func TestMobileAdminAPIPushDevice(t *testing.T) {
	fixture := newMobileAdminFixture(t)
	authFile := filepath.Join(fixture.dir, "mobile_auth.json")
	operatorToken := strings.Repeat("p", 48)
	writeMobileAuthTestSnapshot(t, authFile, nil, []map[string]any{
		mobileAuthTestOperator("op-mobile", operatorToken, []string{"read", "actions"}, nil),
		mobileAuthTestOperator("op-revoked", mobileAuthTestRevokedOperatorToken,
			[]string{"read", "actions"}, int64(1_700_000_000_000)),
	})
	fixture.api.MobileAuth = &MobileAuthAPI{
		File: authFile, Now: func() time.Time { return fixture.now },
	}
	authorization := "Bearer " + operatorToken

	created := mobileAdminTestDo(fixture.api, mobileAdminTestCall{
		method: http.MethodPost, target: mobileAdminPushDevicePath,
		body: `{"token":"test-firebase-token-123456789"}`, authorization: authorization,
		// Cookie y Origin ajenos: push-device no participa del CSRF del panel.
		cookie: fixture.cookie, origin: "https://evil.example",
	})
	if created.Code != http.StatusOK {
		t.Fatalf("registrar push: %d (cuerpo %q)", created.Code, created.Body.String())
	}
	assertMobileAdminHeaders(t, created)
	var pushPayload map[string]any
	if err := json.Unmarshal(created.Body.Bytes(), &pushPayload); err != nil {
		t.Fatalf("push JSON: %v", err)
	}
	if pushPayload["ok"] != true || pushPayload["operatorId"] != "op-mobile" {
		t.Fatalf("push = %v", pushPayload)
	}
	if got := fixture.store.push["op-mobile"]; got != "test-firebase-token-123456789" {
		t.Fatalf("token guardado = %q", got)
	}

	invalid := mobileAdminTestDo(fixture.api, mobileAdminTestCall{
		method: http.MethodPost, target: mobileAdminPushDevicePath,
		body: `{"token":"corto"}`, authorization: authorization,
	})
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("token inválido: %d (cuerpo %q)", invalid.Code, invalid.Body.String())
	}
	assertMobileAdminHeaders(t, invalid)

	anonymous := mobileAdminTestDo(fixture.api, mobileAdminTestCall{
		method: http.MethodPost, target: mobileAdminPushDevicePath,
		body: `{"token":"test-firebase-token-123456789"}`,
	})
	if anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("sin Bearer: %d (cuerpo %q)", anonymous.Code, anonymous.Body.String())
	}
	assertMobileAdminHeaders(t, anonymous)

	revoked := mobileAdminTestDo(fixture.api, mobileAdminTestCall{
		method: http.MethodPost, target: mobileAdminPushDevicePath,
		body:          `{"token":"test-firebase-token-123456789"}`,
		authorization: "Bearer " + mobileAuthTestRevokedOperatorToken,
	})
	if revoked.Code != http.StatusUnauthorized {
		t.Fatalf("operador revocado: %d (cuerpo %q)", revoked.Code, revoked.Body.String())
	}

	deleted := mobileAdminTestDo(fixture.api, mobileAdminTestCall{
		method: http.MethodDelete, target: mobileAdminPushDevicePath,
		authorization: authorization,
	})
	if deleted.Code != http.StatusOK {
		t.Fatalf("borrar push: %d (cuerpo %q)", deleted.Code, deleted.Body.String())
	}
	assertMobileAdminHeaders(t, deleted)
	if _, exists := fixture.store.push["op-mobile"]; exists {
		t.Fatal("el token push debería haberse borrado")
	}
	if strings.Contains(deleted.Body.String(), operatorToken) {
		t.Fatal("la respuesta no debe contener el token Bearer")
	}
}

func TestMobileAdminAPIHidesTokenHash(t *testing.T) {
	fixture := newMobileAdminFixture(t)
	fixture.api.MobileAuth = &MobileAuthAPI{
		File: filepath.Join(fixture.dir, "missing.json"),
		Now:  func() time.Time { return fixture.now },
	}
	deviceToken := strings.Repeat("k", 48)
	operatorToken := strings.Repeat("m", 48)
	// Se crean credenciales con hashes conocidos y se comprueba que ningún
	// listado ni respuesta de creación los filtra.
	fixture.store.devices["dev-secret"] = MobileDevice{
		ID: "dev-secret", Label: "Secreto", TokenHash: mobileAuthTestHash(deviceToken), CreatedAt: 10,
	}
	fixture.store.operators["op-secret"] = MobileOperator{
		ID: "op-secret", Label: "Secreto", TokenHash: mobileAuthTestHash(operatorToken),
		Scopes: []string{"read"}, CreatedAt: 10,
	}
	for _, target := range []string{mobileAdminDevicesPath, mobileAdminOperatorsPath} {
		recorder := mobileAdminTestDo(fixture.api, mobileAdminTestCall{
			method: http.MethodGet, target: target, cookie: fixture.cookie,
		})
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s: %d", target, recorder.Code)
		}
		body := recorder.Body.String()
		if strings.Contains(body, "tokenHash") ||
			strings.Contains(body, mobileAuthTestHash(deviceToken)) ||
			strings.Contains(body, mobileAuthTestHash(operatorToken)) {
			t.Fatalf("%s expone un hash: %q", target, body)
		}
	}
}

func TestMobileAuthAPIOverlayCredentials(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "mobile_auth.json")
	fileOperatorToken := strings.Repeat("f", 48)
	fileDeviceToken := strings.Repeat("g", 48)
	writeMobileAuthTestSnapshot(t, file,
		[]map[string]any{mobileAuthTestDevice(fileDeviceToken, nil)},
		[]map[string]any{mobileAuthTestOperator("op-file", fileOperatorToken,
			[]string{"read"}, nil)},
	)

	dbDeviceToken := strings.Repeat("q", 48)
	dbOperatorToken := strings.Repeat("w", 48)
	revokedDeviceToken := strings.Repeat("e", 48)
	revokedOperatorToken := strings.Repeat("r", 48)
	store := newFakeMobileCredentialStore()
	store.devices["dev-db"] = MobileDevice{
		ID: "dev-db", Label: "Base", TokenHash: mobileAuthTestHash(dbDeviceToken),
	}
	store.devices["dev-revoked"] = MobileDevice{
		ID: "dev-revoked", Label: "Revocado", TokenHash: mobileAuthTestHash(revokedDeviceToken),
		RevokedAt: func() *int64 { value := int64(1); return &value }(),
	}
	store.operators["op-db"] = MobileOperator{
		ID: "op-db", Label: "Base", TokenHash: mobileAuthTestHash(dbOperatorToken),
		Scopes: []string{"read", "actions"},
	}
	store.operators["op-revoked"] = MobileOperator{
		ID: "op-revoked", Label: "Revocado", TokenHash: mobileAuthTestHash(revokedOperatorToken),
		Scopes: []string{"read"}, RevokedAt: func() *int64 { value := int64(1); return &value }(),
	}
	now := time.Unix(mobileAuthTestNowUnix, 0)
	api := &MobileAuthAPI{File: file, Overlay: store, Now: func() time.Time { return now }}

	if got := mobileAuthTestDo(api, http.MethodGet, mobileDeviceCheckPath,
		"Bearer "+dbDeviceToken); got.Code != http.StatusOK {
		t.Fatalf("dispositivo de la base: %d (cuerpo %q)", got.Code, got.Body.String())
	}
	if got := mobileAuthTestDo(api, http.MethodGet, mobileDeviceCheckPath,
		"Bearer "+revokedDeviceToken); got.Code != http.StatusUnauthorized {
		t.Fatalf("dispositivo revocado de la base: %d (cuerpo %q)", got.Code, got.Body.String())
	}
	if got := mobileAuthTestDo(api, http.MethodGet, mobileOperatorCheckPath,
		"Bearer "+dbOperatorToken); got.Code != http.StatusOK {
		t.Fatalf("operador de la base: %d (cuerpo %q)", got.Code, got.Body.String())
	}
	if got := mobileAuthTestDo(api, http.MethodGet, mobileOperatorCheckPath,
		"Bearer "+revokedOperatorToken); got.Code != http.StatusUnauthorized {
		t.Fatalf("operador revocado de la base: %d (cuerpo %q)", got.Code, got.Body.String())
	}
	if got := mobileAuthTestDo(api, http.MethodGet, mobileOperatorCheckPath,
		"Bearer "+fileOperatorToken); got.Code != http.StatusOK {
		t.Fatalf("operador del archivo con overlay: %d (cuerpo %q)", got.Code, got.Body.String())
	}

	request := httptest.NewRequest(http.MethodGet, mobileOperatorCheckPath, nil)
	request.Header.Set("Authorization", "Bearer "+dbOperatorToken)
	recorder := httptest.NewRecorder()
	operatorID, ok := api.AuthorizeOperatorRead(recorder, request)
	if !ok || operatorID != "op-db" {
		t.Fatalf("AuthorizeOperatorRead = %q, %v (cuerpo %q)", operatorID, ok, recorder.Body.String())
	}

	// Si la base falla, la autenticación por archivo debe seguir intacta.
	store.credentialErr = errors.New("db caída")
	failing := &MobileAuthAPI{File: file, Overlay: store, Now: func() time.Time { return now }}
	if got := mobileAuthTestDo(failing, http.MethodGet, mobileOperatorCheckPath,
		"Bearer "+fileOperatorToken); got.Code != http.StatusOK {
		t.Fatalf("fallback al archivo: %d (cuerpo %q)", got.Code, got.Body.String())
	}
	if got := mobileAuthTestDo(failing, http.MethodGet, mobileDeviceCheckPath,
		"Bearer "+fileDeviceToken); got.Code != http.StatusOK {
		t.Fatalf("fallback de dispositivo: %d (cuerpo %q)", got.Code, got.Body.String())
	}
	if got := mobileAuthTestDo(failing, http.MethodGet, mobileDeviceCheckPath,
		"Bearer "+dbDeviceToken); got.Code != http.StatusUnauthorized {
		t.Fatalf("la base caída no debe autenticar: %d (cuerpo %q)", got.Code, got.Body.String())
	}
}

func TestMobileAdminAPIPushRequiresOperatorID(t *testing.T) {
	fixture := newMobileAdminFixture(t)
	authFile := filepath.Join(fixture.dir, "mobile_auth.json")
	// Un operador sin id no puede registrar push: la tabla exige operator_id.
	token := strings.Repeat("z", 48)
	writeMobileAuthTestSnapshot(t, authFile, nil, []map[string]any{{
		"tokenHash": mobileAuthTestHash(token),
		"scopes":    []string{"read"},
		"revokedAt": nil,
	}})
	fixture.api.MobileAuth = &MobileAuthAPI{
		File: authFile, Now: func() time.Time { return fixture.now },
	}
	recorder := mobileAdminTestDo(fixture.api, mobileAdminTestCall{
		method: http.MethodPost, target: mobileAdminPushDevicePath,
		body:          `{"token":"test-firebase-token-123456789"}`,
		authorization: "Bearer " + token,
	})
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("operador sin id: %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	assertMobileAdminHeaders(t, recorder)
	if !strings.Contains(recorder.Body.String(), mobileAdminOperatorUnauthorized) {
		t.Fatalf("cuerpo = %q", recorder.Body.String())
	}
}

func TestMobileAdminAPIPushStoreUnavailable(t *testing.T) {
	fixture := newMobileAdminFixture(t)
	authFile := filepath.Join(fixture.dir, "mobile_auth.json")
	token := strings.Repeat("y", 48)
	writeMobileAuthTestSnapshot(t, authFile, nil, []map[string]any{
		mobileAuthTestOperator("op-1", token, []string{"read"}, nil),
	})
	fixture.api.MobileAuth = &MobileAuthAPI{
		File: authFile, Now: func() time.Time { return fixture.now },
	}
	fixture.api.Store = nil
	recorder := mobileAdminTestDo(fixture.api, mobileAdminTestCall{
		method: http.MethodPost, target: mobileAdminPushDevicePath,
		body:          `{"token":"test-firebase-token-123456789"}`,
		authorization: "Bearer " + token,
	})
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("store nil: %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	assertMobileAdminHeaders(t, recorder)
}

func TestMobileAdminAPIRejectsMalformedCreateLabel(t *testing.T) {
	fixture := newMobileAdminFixture(t)
	for _, target := range []string{mobileAdminDevicesPath, mobileAdminOperatorsPath} {
		for _, body := range []string{`[]`, `{"label":123}`, `"texto"`} {
			recorder := mobileAdminTestDo(fixture.api, fixture.authorized(http.MethodPost, target, body))
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("%s %s: %d (cuerpo %q)", target, body, recorder.Code, recorder.Body.String())
			}
			assertMobileAdminHeaders(t, recorder)
		}
	}
	// 80 runes (no bytes) es el límite aceptado por el contrato.
	body := mobileAdminTestJSON(t, map[string]string{"label": strings.Repeat("ñ", 80)})
	recorder := mobileAdminTestDo(fixture.api, fixture.authorized(
		http.MethodPost, mobileAdminDevicesPath, body))
	if recorder.Code != http.StatusCreated {
		t.Fatalf("80 runes: %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
}
