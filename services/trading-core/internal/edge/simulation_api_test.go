package edge

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/AGR55/QvaApp/services/trading-core/internal/runtimeconfig"
)

const simulationTestNowMS int64 = 1_700_000_000_000

const simulationTestEmptySnapshot = `{"simulation":{"accountUuid":"","ownOffers":[],"observations":[]}}`

func simulationTestNow() time.Time {
	return time.UnixMilli(simulationTestNowMS)
}

func simulationTestConfig() runtimeconfig.Config {
	return runtimeconfig.Config{
		Markets: []runtimeconfig.Market{{
			Code:                "BANK_CUP",
			Label:               "Banco",
			Currency:            "CUP",
			Active:              true,
			BuyMaxRate:          100,
			SellMinRate:         90,
			OutgoingTransferFee: 5,
		}},
	}
}

type simulationFakeRuntime struct {
	config runtimeconfig.Config
	err    error
}

var _ RuntimeLoader = (*simulationFakeRuntime)(nil)

func (loader *simulationFakeRuntime) Load(
	context.Context,
) (runtimeconfig.Config, int64, error) {
	if loader.err != nil {
		return runtimeconfig.Config{}, 0, loader.err
	}
	return loader.config, 1, nil
}

// newSimulationTestAPI escribe el snapshot (aunque sea vacío) y emite una
// sesión válida con el mismo reloj inyectado.
func newSimulationTestAPI(
	t *testing.T,
	snapshot []byte,
) (*SimulationAPI, *http.Cookie, string, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "web-extras.json")
	if err := os.WriteFile(path, snapshot, 0o600); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}

	now := simulationTestNow()
	manager := newSessionTestManager(t, 15*time.Minute)
	token, csrf, err := manager.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	api := &SimulationAPI{
		Sessions:      manager,
		File:          path,
		Runtime:       &simulationFakeRuntime{config: simulationTestConfig()},
		TrustedOrigin: "https://panel.example",
		Now:           func() time.Time { return now },
	}
	return api, &http.Cookie{Name: CookieName, Value: token}, csrf, path
}

func simulationDo(
	api *SimulationAPI,
	method, target, body string,
	cookie *http.Cookie,
	csrf, origin string,
) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	if cookie != nil {
		request.AddCookie(cookie)
	}
	if csrf != "" {
		request.Header.Set("X-CSRF-Token", csrf)
	}
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	recorder := httptest.NewRecorder()
	api.ServeHTTP(recorder, request)
	return recorder
}

// simulationPostWeb envía un POST web con Origin y CSRF válidos.
func simulationPostWeb(
	t *testing.T,
	api *SimulationAPI,
	cookie *http.Cookie,
	csrf, body string,
) *httptest.ResponseRecorder {
	t.Helper()
	return simulationDo(api, http.MethodPost, simulationWebPath, body, cookie, csrf, "https://panel.example")
}

func simulationBody(
	t *testing.T,
	coin string,
	hours int,
	buyMaxRate, sellMinRate, maxQusd float64,
) string {
	t.Helper()
	raw, err := json.Marshal(simulationInput{
		Coin:        coin,
		Hours:       hours,
		BuyMaxRate:  buyMaxRate,
		SellMinRate: sellMinRate,
		MaxQusd:     maxQusd,
	})
	if err != nil {
		t.Fatalf("Marshal body: %v", err)
	}
	return string(raw)
}

func simulationDecodeReport(
	t *testing.T,
	recorder *httptest.ResponseRecorder,
) (simulationReport, map[string]json.RawMessage) {
	t.Helper()
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(recorder.Body.Bytes(), &fields); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	if len(fields) != 1 {
		t.Fatalf("el sobre solo debe tener data, claves = %v", fields)
	}
	raw, ok := fields["data"]
	if !ok {
		t.Fatalf("respuesta sin clave data (cuerpo %q)", recorder.Body.String())
	}
	var report simulationReport
	if err := json.Unmarshal(raw, &report); err != nil {
		t.Fatalf("data inválida: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return report, fields
}

func simulationAssertHeaders(t *testing.T, recorder *httptest.ResponseRecorder) {
	t.Helper()
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q", got)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("no debe haber CORS, Access-Control-Allow-Origin = %q", got)
	}
}

func simulationErrorBody(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	var body map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return body["error"]
}

func TestSimulationWebAuthAndCSRF(t *testing.T) {
	api, cookie, csrf, _ := newSimulationTestAPI(t, []byte(simulationTestEmptySnapshot))
	body := simulationBody(t, "BANK_CUP", 24, 120, 80, 100)

	cases := []struct {
		name   string
		cookie *http.Cookie
		csrf   string
		origin string
		status int
		want   string
	}{
		{"sin cookie", nil, csrf, "https://panel.example", http.StatusUnauthorized, ""},
		{"cookie inválida", &http.Cookie{Name: CookieName, Value: "token-roto"}, csrf, "https://panel.example", http.StatusUnauthorized, ""},
		{"sin origin", cookie, csrf, "", http.StatusForbidden, "Origen de solicitud no autorizado."},
		{"origin ajeno", cookie, csrf, "https://evil.example", http.StatusForbidden, "Origen de solicitud no autorizado."},
		{"sin csrf", cookie, "", "https://panel.example", http.StatusForbidden, "CSRF inválido."},
		{"csrf inválido", cookie, "otro", "https://panel.example", http.StatusForbidden, "CSRF inválido."},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := simulationDo(
				api, http.MethodPost, simulationWebPath, body,
				testCase.cookie, testCase.csrf, testCase.origin,
			)
			if recorder.Code != testCase.status {
				t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
			}
			if testCase.want != "" {
				if got := simulationErrorBody(t, recorder); got != testCase.want {
					t.Fatalf("error = %q, quiero %q", got, testCase.want)
				}
			}
			simulationAssertHeaders(t, recorder)
		})
	}

	recorder := simulationPostWeb(t, api, cookie, csrf, body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("credenciales válidas: status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
}

func simulationTestMobileAuth(t *testing.T) (*MobileAuthAPI, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "mobile-auth.json")
	token := strings.Repeat("m", 48)
	sum := sha256.Sum256([]byte(token))
	raw, err := json.Marshal(map[string]any{
		"devices": []any{},
		"operators": []any{map[string]any{
			"id":        "simulation-operator",
			"tokenHash": hex.EncodeToString(sum[:]),
			"scopes":    []string{"read"},
			"revokedAt": nil,
		}},
	})
	if err != nil {
		t.Fatalf("Marshal auth: %v", err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}
	return &MobileAuthAPI{
		File: path,
		Now:  simulationTestNow,
	}, token
}

func TestSimulationMobileAuth(t *testing.T) {
	api, _, _, _ := newSimulationTestAPI(t, []byte(simulationTestEmptySnapshot))
	body := simulationBody(t, "BANK_CUP", 24, 120, 80, 100)

	// Sin MobileAuth configurado toda petición termina en 401.
	recorder := simulationDo(api, http.MethodPost, simulationMobilePath, body, nil, "", "")
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("sin auth: status = %d", recorder.Code)
	}

	auth, token := simulationTestMobileAuth(t)
	api.MobileAuth = auth

	recorder = simulationDo(api, http.MethodPost, simulationMobilePath, body, nil, "", "")
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("sin bearer: status = %d", recorder.Code)
	}

	request := httptest.NewRequest(
		http.MethodPost, simulationMobilePath, strings.NewReader(body),
	)
	request.Header.Set("Authorization", "Bearer "+strings.Repeat("x", 48))
	recorder = httptest.NewRecorder()
	api.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("bearer inválido: status = %d", recorder.Code)
	}

	request = httptest.NewRequest(
		http.MethodPost, simulationMobilePath, strings.NewReader(body),
	)
	request.Header.Set("Authorization", "Bearer "+token)
	recorder = httptest.NewRecorder()
	api.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("bearer válido: status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	report, _ := simulationDecodeReport(t, recorder)
	if report.Coin != "BANK_CUP" || report.Hours != 24 {
		t.Fatalf("informe inesperado: %+v", report)
	}
	simulationAssertHeaders(t, recorder)
}

func TestSimulationRouting(t *testing.T) {
	api, cookie, csrf, _ := newSimulationTestAPI(t, []byte(simulationTestEmptySnapshot))

	for _, path := range []string{simulationWebPath, simulationMobilePath} {
		recorder := simulationDo(api, http.MethodGet, path, "", cookie, csrf, "https://panel.example")
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s GET: status = %d", path, recorder.Code)
		}
		if got := recorder.Header().Get("Allow"); got != http.MethodPost {
			t.Fatalf("%s GET: Allow = %q", path, got)
		}
	}

	recorder := simulationDo(api, http.MethodPut, "/api/otra/ruta", "", cookie, csrf, "https://panel.example")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("ruta desconocida: status = %d", recorder.Code)
	}
}

func TestSimulationRejectsInvalidInput(t *testing.T) {
	api, cookie, csrf, _ := newSimulationTestAPI(t, []byte(simulationTestEmptySnapshot))
	longCoin := simulationBody(t, strings.Repeat("A", simulationMaxCoinRunes+1), 24, 120, 80, 100)

	cases := []struct {
		name string
		body string
		want string
	}{
		{"horas fuera de rango", `{"coin":"BANK_CUP","hours":2,"buyMaxRate":120,"sellMinRate":80,"maxQusd":100}`, simulationInputError},
		{"horas cero", `{"coin":"BANK_CUP","hours":0,"buyMaxRate":120,"sellMinRate":80,"maxQusd":100}`, simulationInputError},
		{"buyMaxRate cero", `{"coin":"BANK_CUP","hours":24,"buyMaxRate":0,"sellMinRate":80,"maxQusd":100}`, simulationInputError},
		{"sellMinRate negativa", `{"coin":"BANK_CUP","hours":24,"buyMaxRate":120,"sellMinRate":-1,"maxQusd":100}`, simulationInputError},
		{"maxQusd fuera de rango", `{"coin":"BANK_CUP","hours":24,"buyMaxRate":120,"sellMinRate":80,"maxQusd":1000000001}`, simulationInputError},
		{"coin vacía", `{"coin":"","hours":24,"buyMaxRate":120,"sellMinRate":80,"maxQusd":100}`, simulationInputError},
		{"coin demasiado larga", longCoin, simulationInputError},
		{"coin con tipo incorrecto", `{"coin":1,"hours":24,"buyMaxRate":120,"sellMinRate":80,"maxQusd":100}`, simulationInputError},
		{"mercado no configurado", `{"coin":"UNKNOWN","hours":24,"buyMaxRate":120,"sellMinRate":80,"maxQusd":100}`, simulationMarketError},
		{"json inválido", `{`, simulationInputError},
		{"cuerpo vacío", ``, simulationInputError},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := simulationPostWeb(t, api, cookie, csrf, testCase.body)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
			}
			if got := simulationErrorBody(t, recorder); got != testCase.want {
				t.Fatalf("error = %q, quiero %q", got, testCase.want)
			}
			simulationAssertHeaders(t, recorder)
		})
	}
}

func simulationAssertZeroReport(t *testing.T, report simulationReport, hours int) {
	t.Helper()
	if report.GeneratedAt != simulationTestNowMS {
		t.Fatalf("generatedAt = %d", report.GeneratedAt)
	}
	if want := simulationTestNowMS - int64(hours)*3_600_000; report.Since != want {
		t.Fatalf("since = %d, quiero %d", report.Since, want)
	}
	if report.CoverageSince != report.Since {
		t.Fatalf("coverageSince = %d, quiero %d", report.CoverageSince, report.Since)
	}
	if report.Truncated || report.Scanned != 0 || report.UniqueOffers != 0 {
		t.Fatalf("informe truncado o con datos: %+v", report)
	}
	if report.Counts != (simulationCounts{}) {
		t.Fatalf("counts = %+v", report.Counts)
	}
	if report.Baseline != (simulationTotals{}) || report.Proposed != (simulationTotals{}) {
		t.Fatalf("totales = %+v / %+v", report.Baseline, report.Proposed)
	}
	if report.Assumptions != (simulationAssumptions{
		OutgoingTransferFee: 5,
		CurrentBuyMaxRate:   100,
		CurrentSellMinRate:  90,
	}) {
		t.Fatalf("assumptions = %+v", report.Assumptions)
	}
	if report.Note != simulationNote {
		t.Fatalf("note = %q", report.Note)
	}
}

func TestSimulationSnapshotHandling(t *testing.T) {
	body := simulationBody(t, "BANK_CUP", 1, 120, 80, 100)

	t.Run("archivo vacío", func(t *testing.T) {
		api, cookie, csrf, _ := newSimulationTestAPI(t, nil)
		recorder := simulationPostWeb(t, api, cookie, csrf, body)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		report, _ := simulationDecodeReport(t, recorder)
		simulationAssertZeroReport(t, report, 1)
	})

	t.Run("archivo ausente", func(t *testing.T) {
		api, cookie, csrf, path := newSimulationTestAPI(t, []byte(simulationTestEmptySnapshot))
		if err := os.Remove(path); err != nil {
			t.Fatalf("Remove: %v", err)
		}
		recorder := simulationPostWeb(t, api, cookie, csrf, body)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		report, _ := simulationDecodeReport(t, recorder)
		simulationAssertZeroReport(t, report, 1)
	})

	t.Run("sin archivo configurado", func(t *testing.T) {
		api, cookie, csrf, _ := newSimulationTestAPI(t, []byte(simulationTestEmptySnapshot))
		api.File = ""
		recorder := simulationPostWeb(t, api, cookie, csrf, body)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d", recorder.Code)
		}
		report, _ := simulationDecodeReport(t, recorder)
		simulationAssertZeroReport(t, report, 1)
	})

	unavailable := func(t *testing.T, api *SimulationAPI, cookie *http.Cookie, csrf string) {
		t.Helper()
		recorder := simulationPostWeb(t, api, cookie, csrf, body)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		var response map[string]string
		if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
			t.Fatalf("JSON inválido: %v", err)
		}
		if response["status"] != "unavailable" {
			t.Fatalf("status = %q", response["status"])
		}
		simulationAssertHeaders(t, recorder)
	}

	t.Run("json inválido", func(t *testing.T) {
		api, cookie, csrf, path := newSimulationTestAPI(t, []byte(simulationTestEmptySnapshot))
		if err := os.WriteFile(path, []byte(`{"simulation":`), 0o600); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
		unavailable(t, api, cookie, csrf)
	})

	t.Run("raíz no objeto", func(t *testing.T) {
		api, cookie, csrf, path := newSimulationTestAPI(t, []byte(simulationTestEmptySnapshot))
		if err := os.WriteFile(path, []byte(`[]`), 0o600); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
		unavailable(t, api, cookie, csrf)
	})

	t.Run("demasiado grande", func(t *testing.T) {
		api, cookie, csrf, path := newSimulationTestAPI(t, []byte(simulationTestEmptySnapshot))
		raw := make([]byte, maxSimulationSnapshotBytes+1)
		for index := range raw {
			raw[index] = ' '
		}
		if err := os.WriteFile(path, raw, 0o600); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
		unavailable(t, api, cookie, csrf)
	})

	t.Run("ruta es directorio", func(t *testing.T) {
		api, cookie, csrf, _ := newSimulationTestAPI(t, []byte(simulationTestEmptySnapshot))
		api.File = t.TempDir()
		unavailable(t, api, cookie, csrf)
	})

	t.Run("runtime con error", func(t *testing.T) {
		api, cookie, csrf, _ := newSimulationTestAPI(t, []byte(simulationTestEmptySnapshot))
		api.Runtime = &simulationFakeRuntime{err: errors.New("sin conexión")}
		unavailable(t, api, cookie, csrf)
	})

	t.Run("runtime ausente", func(t *testing.T) {
		api, cookie, csrf, _ := newSimulationTestAPI(t, []byte(simulationTestEmptySnapshot))
		api.Runtime = nil
		unavailable(t, api, cookie, csrf)
	})
}

func simulationTestRow(
	t *testing.T,
	key string,
	at int64,
	sentAt string,
	data map[string]any,
) map[string]any {
	t.Helper()
	payload, err := json.Marshal(map[string]any{"sent_at": sentAt, "data": data})
	if err != nil {
		t.Fatalf("Marshal payload: %v", err)
	}
	return map[string]any{"key": key, "at": at, "payload": string(payload)}
}

func simulationTestOffer(
	coin, uuid, status, offerType string,
	amount, receive float64,
) map[string]any {
	return map[string]any{
		"coin":    coin,
		"uuid":    uuid,
		"status":  status,
		"type":    offerType,
		"amount":  amount,
		"receive": receive,
	}
}

func TestSimulationAlgorithm(t *testing.T) {
	api, cookie, csrf, _ := newSimulationTestAPI(t, []byte(simulationTestEmptySnapshot))

	const account = "acc-1"
	type rowSpec struct {
		key     string
		data    map[string]any
		sentOff int64 // desfase en ms respecto de at; 0 usa el mismo instante
		sentRaw string
	}

	at := func(index int) int64 { return simulationTestNowMS - int64(index)*1000 }
	offer := simulationTestOffer

	ownOwner := offer("BANK_CUP", "own-owner", "open", "sell", 50, 5000)
	ownOwner["owner_uuid"] = account
	ownUser := offer("BANK_CUP", "own-user", "open", "sell", 50, 5000)
	ownUser["User"] = map[string]any{"uuid": account}
	ownKnown := offer("BANK_CUP", "own-offer", "open", "sell", 50, 5000)

	flexibleOK := offer("BANK_CUP", "flex-ok", "open", "sell", 1, 100)
	flexibleOK["offer_kind"] = "flexible"
	flexibleOK["available_amount"] = 50.0
	flexibleOK["order_min"] = 5.0
	flexibleOK["order_max"] = 200.0

	flexibleRange := offer("BANK_CUP", "flex-range", "open", "sell", 1, 100)
	flexibleRange["offer_kind"] = "flexible"
	flexibleRange["available_amount"] = 1.0
	flexibleRange["order_min"] = 5.0
	flexibleRange["order_max"] = 10.0

	otherCoin := offer("OTHER", "other-coin", "open", "sell", 10, 1000)
	badUUID := offer("BANK_CUP", "", "open", "sell", 10, 1000)
	badUUID["uuid"] = 123

	specs := []rowSpec{
		// Compras (type sell): una por encima del límite actual y otra por
		// debajo. La flexibles se dimensiona al máximo permitido.
		{"obs-1", offer("BANK_CUP", "buy-a", "open", "sell", 10, 1050), 0, ""},
		{"obs-2", offer("BANK_CUP", "buy-b", "open", "sell", 20, 1900), 0, ""},
		// Ventas (type buy): una en el mínimo actual y otra por debajo.
		{"obs-3", offer("BANK_CUP", "sell-c", "open", "buy", 30, 2700), 0, ""},
		{"obs-4", offer("BANK_CUP", "sell-d", "open", "buy", 25, 2000), 0, ""},
		// Ofertas propias por las tres vías.
		{"obs-5", ownOwner, 0, ""},
		{"obs-6", ownUser, 0, ""},
		{"obs-7", ownKnown, 0, ""},
		// Observación cuyo sent_at no coincide con el instante de recepción.
		{"obs-8", offer("BANK_CUP", "stale-one", "open", "sell", 10, 1100), 6000, ""},
		// Repetición de la primera oferta: cuenta como observación, no como
		// oferta única.
		{"obs-9", offer("BANK_CUP", "buy-a", "open", "sell", 10, 1050), 0, ""},
		{"obs-10", offer("BANK_CUP", "invalid-status", "closed", "sell", 10, 1000), 0, ""},
		{"obs-11", offer("BANK_CUP", "invalid-amount", "open", "buy", 0, 100), 0, ""},
		{"obs-12", offer("BANK_CUP", "range-amount", "open", "sell", 200, 20000), 0, ""},
		{"obs-13", flexibleOK, 0, ""},
		{"obs-14", flexibleRange, 0, ""},
		// Moneda distinta y uuid no textual: se ignoran antes de contar.
		{"obs-15", otherCoin, 0, ""},
		{"obs-16", badUUID, 0, ""},
		// Fecha inválida: stale.
		{"obs-17", offer("BANK_CUP", "stale-date", "open", "sell", 10, 1100), 0, "no-es-fecha"},
	}

	observations := make([]map[string]any, 0, len(specs))
	for index, spec := range specs {
		atMS := at(index + 1)
		sentAt := spec.sentRaw
		if sentAt == "" {
			sentAt = time.UnixMilli(atMS + spec.sentOff).UTC().Format(time.RFC3339Nano)
		}
		observations = append(observations, simulationTestRow(t, spec.key, atMS, sentAt, spec.data))
	}

	raw, err := json.Marshal(map[string]any{
		"simulation": map[string]any{
			"accountUuid":  account,
			"ownOffers":    []string{"own-offer"},
			"observations": observations,
		},
	})
	if err != nil {
		t.Fatalf("Marshal snapshot: %v", err)
	}
	if err := os.WriteFile(api.File, raw, 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	recorder := simulationPostWeb(
		t, api, cookie, csrf,
		simulationBody(t, "BANK_CUP", 24, 120, 80, 100),
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	simulationAssertHeaders(t, recorder)
	report, _ := simulationDecodeReport(t, recorder)

	if report.Coin != "BANK_CUP" || report.Hours != 24 ||
		report.BuyMaxRate != 120 || report.SellMinRate != 80 || report.MaxQusd != 100 {
		t.Fatalf("eco del cuerpo inesperado: %+v", report)
	}
	if report.GeneratedAt != simulationTestNowMS {
		t.Fatalf("generatedAt = %d", report.GeneratedAt)
	}
	if want := simulationTestNowMS - 24*3_600_000; report.Since != want {
		t.Fatalf("since = %d, quiero %d", report.Since, want)
	}
	if report.CoverageSince != report.Since {
		t.Fatalf("coverageSince = %d, quiero %d", report.CoverageSince, report.Since)
	}
	if report.Truncated {
		t.Fatalf("truncated = true con un snapshot de %d filas", len(observations))
	}
	if report.Scanned != len(observations) {
		t.Fatalf("scanned = %d, quiero %d", report.Scanned, len(observations))
	}
	if report.UniqueOffers != 14 {
		t.Fatalf("uniqueOffers = %d, quiero 14", report.UniqueOffers)
	}

	wantCounts := simulationCounts{
		Observations:  15,
		Own:           3,
		Stale:         2,
		Invalid:       2,
		RangeOrAmount: 2,
	}
	if report.Counts != wantCounts {
		t.Fatalf("counts = %+v, quiero %+v", report.Counts, wantCounts)
	}

	wantBaseline := simulationTotals{Buy: 1, Sell: 1, BuyQusd: 20, SellQusd: 30}
	if report.Baseline != wantBaseline {
		t.Fatalf("baseline = %+v, quiero %+v", report.Baseline, wantBaseline)
	}
	wantProposed := simulationTotals{Buy: 3, Sell: 2, BuyQusd: 80, SellQusd: 55}
	if report.Proposed != wantProposed {
		t.Fatalf("proposed = %+v, quiero %+v", report.Proposed, wantProposed)
	}

	if report.Assumptions != (simulationAssumptions{
		OutgoingTransferFee: 5,
		CurrentBuyMaxRate:   100,
		CurrentSellMinRate:  90,
	}) {
		t.Fatalf("assumptions = %+v", report.Assumptions)
	}
	if report.Note != simulationNote {
		t.Fatalf("note = %q", report.Note)
	}
}
