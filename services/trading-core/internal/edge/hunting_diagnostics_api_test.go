package edge

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// newHuntingDiagnosticsTestAPI construye la API con un snapshot temporal y una
// sesión válida emitida con el mismo reloj inyectado.
func newHuntingDiagnosticsTestAPI(
	t *testing.T,
	now time.Time,
) (*HuntingDiagnosticsAPI, *http.Cookie) {
	t.Helper()
	manager := newSessionTestManager(t, 15*time.Minute)
	token, _, err := manager.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	api := &HuntingDiagnosticsAPI{
		Sessions: manager,
		File:     filepath.Join(t.TempDir(), "dashboard-snapshot.json"),
		Now:      func() time.Time { return now },
	}
	return api, &http.Cookie{Name: CookieName, Value: token}
}

func huntingDiagnosticsDo(
	handler http.Handler,
	method string,
	target string,
	cookie *http.Cookie,
) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, nil)
	if cookie != nil {
		request.AddCookie(cookie)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func huntingDiagnosticsWriteRaw(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}
}

func huntingDiagnosticsWriteSnapshot(t *testing.T, path string, snapshot any) {
	t.Helper()
	raw, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}
}

func huntingDiagnosticsRow(
	id int64,
	createdAt int64,
	action string,
	uuid string,
	detail string,
) map[string]any {
	return map[string]any{
		"id":        id,
		"createdAt": createdAt,
		"action":    action,
		"uuid":      uuid,
		"detail":    detail,
	}
}

func huntingDiagnosticsFeedDetail(uuid, coin, outcome string) string {
	return fmt.Sprintf(
		"Evento p2p.created de oferta %s (%s) procesado desde el feed: %s.",
		uuid, coin, outcome,
	)
}

func huntingDiagnosticsTimingDetail(dispatchedAt, finishedAt any, outcome string) string {
	payload := map[string]any{"outcome": outcome}
	if dispatchedAt != nil {
		payload["dispatchedAt"] = dispatchedAt
	}
	if finishedAt != nil {
		payload["finishedAt"] = finishedAt
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		panic(err)
	}
	return string(raw)
}

func huntingDiagnosticsMarketEntry(code string) map[string]any {
	return map[string]any{"code": code, "label": code, "currency": "CUP"}
}

func huntingDiagnosticsSnapshotDoc(markets []any, rows []any) map[string]any {
	return map[string]any{
		"auditLog":  rows,
		"analytics": map[string]any{"markets": markets},
	}
}

// huntingDiagnosticsDecodeData exige que el sobre tenga exactamente data y
// devuelve el objeto decodificado junto con su JSON crudo.
func huntingDiagnosticsDecodeData(
	t *testing.T,
	recorder *httptest.ResponseRecorder,
) (huntingDiagnosticsData, string) {
	t.Helper()
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(recorder.Body.Bytes(), &fields); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	if len(fields) != 1 {
		t.Fatalf("el sobre solo debe tener data, claves = %v", fields)
	}
	data, ok := fields["data"]
	if !ok {
		t.Fatalf("respuesta sin clave data (cuerpo %q)", recorder.Body.String())
	}
	var report huntingDiagnosticsData
	if err := json.Unmarshal(data, &report); err != nil {
		t.Fatalf("data inválida: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return report, string(data)
}

func huntingDiagnosticsAssertHeaders(
	t *testing.T,
	recorder *httptest.ResponseRecorder,
) {
	t.Helper()
	if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Fatalf("Content-Type = %q, se esperaba JSON", got)
	}
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
		t.Fatal("la API de diagnóstico no debe emitir cookies")
	}
}

func huntingDiagnosticsExpectStatus(
	t *testing.T,
	recorder *httptest.ResponseRecorder,
	want int,
	status string,
) {
	t.Helper()
	if recorder.Code != want {
		t.Fatalf("status = %d, se esperaba %d (cuerpo %q)",
			recorder.Code, want, recorder.Body.String())
	}
	huntingDiagnosticsAssertHeaders(t, recorder)
	if status != "" {
		var body map[string]string
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
			t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
		}
		if got := body["status"]; got != status {
			t.Fatalf("status = %q, se esperaba %q", got, status)
		}
	}
}

func TestHuntingDiagnosticsHandlerReport(t *testing.T) {
	now := time.UnixMilli(1_790_000_000_000)
	nowMS := now.UnixMilli()
	api, cookie := newHuntingDiagnosticsTestAPI(t, now)

	rows := []any{
		huntingDiagnosticsRow(11, nowMS-12_000, "market_feed_processing_error", "offer-x", "fallo transitorio"),
		huntingDiagnosticsRow(10, nowMS-60_000, "market_feed_processed", "offer-a",
			huntingDiagnosticsFeedDetail("offer-a", "CLASICA", "venta aplicada correctamente")),
		huntingDiagnosticsRow(9, nowMS-120_000, "market_feed_processed", "offer-b",
			huntingDiagnosticsFeedDetail("offer-b", "CLASICA", "Tasa por encima del objetivo")),
		huntingDiagnosticsRow(8, nowMS-180_000, "market_feed_processed", "offer-c",
			huntingDiagnosticsFeedDetail("offer-c", "CLASICA", "La observación es antigua")),
		huntingDiagnosticsRow(7, nowMS-240_000, "market_feed_processed", "offer-d",
			huntingDiagnosticsFeedDetail("offer-d", "CUP", "Saldo insuficiente")),
		huntingDiagnosticsRow(6, nowMS-300_000, "offer_apply_timing", "offer-a",
			huntingDiagnosticsTimingDetail(nowMS-600_000, nowMS-599_880, "confirmed")),
		huntingDiagnosticsRow(5, nowMS-360_000, "offer_apply_timing", "offer-b",
			huntingDiagnosticsTimingDetail(nowMS-540_000, nowMS-539_760, "uncertain")),
		huntingDiagnosticsRow(4, nowMS-420_000, "offer_apply_timing", "offer-c",
			huntingDiagnosticsTimingDetail(nil, nowMS-480_000, "confirmed")),
		huntingDiagnosticsRow(3, nowMS-480_000, "offer_apply_timing", "offer-d",
			huntingDiagnosticsTimingDetail(nowMS-660_000, nowMS-659_640, "timeout")),
		huntingDiagnosticsRow(2, nowMS-540_000, "offer_apply_timing", "offer-e", "not-json"),
		huntingDiagnosticsRow(1, nowMS-48*3_600_000, "market_feed_processed", "offer-z",
			huntingDiagnosticsFeedDetail("offer-z", "CLASICA", "venta aplicada")),
	}
	huntingDiagnosticsWriteSnapshot(t, api.File, huntingDiagnosticsSnapshotDoc(
		[]any{huntingDiagnosticsMarketEntry("CLASICA"), huntingDiagnosticsMarketEntry("CUP")},
		rows,
	))

	t.Run("sin filtro de moneda", func(t *testing.T) {
		recorder := huntingDiagnosticsDo(api, http.MethodGet, huntingDiagnosticsPath, cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		huntingDiagnosticsAssertHeaders(t, recorder)
		report, raw := huntingDiagnosticsDecodeData(t, recorder)

		if report.Hours != 24 || report.Coin != nil {
			t.Fatalf("hours/coin = %d/%v", report.Hours, report.Coin)
		}
		if report.GeneratedAt != nowMS {
			t.Fatalf("generatedAt = %d, se esperaba %d", report.GeneratedAt, nowMS)
		}
		if want := nowMS - 24*3_600_000; report.Since != want || report.CoverageSince != want {
			t.Fatalf("since/coverageSince = %d/%d, se esperaba %d", report.Since, report.CoverageSince, want)
		}
		if report.Truncated {
			t.Fatal("truncated debe ser false")
		}
		if report.Observations != 4 || report.UniqueOffers != 4 || report.AcceptedObservations != 1 {
			t.Fatalf("observaciones = %+v", report)
		}
		wantReasons := []huntingDiagnosticsReason{
			{Code: "price", Label: "Precio o comisión fuera del objetivo", Count: 1},
			{Code: "stale", Label: "Observación antigua", Count: 1},
			{Code: "capital", Label: "Saldo o límites insuficientes", Count: 1},
		}
		if fmt.Sprintf("%+v", report.Reasons) != fmt.Sprintf("%+v", wantReasons) {
			t.Fatalf("reasons = %+v, se esperaba %+v", report.Reasons, wantReasons)
		}
		wantApplications := huntingDiagnosticsApplications{
			Sent: 3, Confirmed: 1, Rejected: 1, Uncertain: 1,
			NotSent: 1, UnknownMarket: 0,
		}
		if report.Applications.Sent != wantApplications.Sent ||
			report.Applications.Confirmed != wantApplications.Confirmed ||
			report.Applications.Rejected != wantApplications.Rejected ||
			report.Applications.Uncertain != wantApplications.Uncertain ||
			report.Applications.NotSent != wantApplications.NotSent ||
			report.Applications.UnknownMarket != wantApplications.UnknownMarket {
			t.Fatalf("applications = %+v, se esperaba %+v", report.Applications, wantApplications)
		}
		if report.Applications.ResponseP50Ms == nil || *report.Applications.ResponseP50Ms != 240 {
			t.Fatalf("responseP50Ms = %v, se esperaba 240", report.Applications.ResponseP50Ms)
		}
		if report.Note != huntingDiagnosticsNote {
			t.Fatalf("note = %q", report.Note)
		}
		if !strings.Contains(raw, `"reasons":[`) {
			t.Fatalf("reasons debe ser un arreglo: %s", raw)
		}
	})

	t.Run("filtro CLASICA", func(t *testing.T) {
		recorder := huntingDiagnosticsDo(api, http.MethodGet, huntingDiagnosticsPath+"?coin=CLASICA", cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		huntingDiagnosticsAssertHeaders(t, recorder)
		report, _ := huntingDiagnosticsDecodeData(t, recorder)

		if report.Coin == nil || *report.Coin != "CLASICA" {
			t.Fatalf("coin = %v", report.Coin)
		}
		if report.Observations != 3 || report.UniqueOffers != 3 || report.AcceptedObservations != 1 {
			t.Fatalf("observaciones = %+v", report)
		}
		if len(report.Reasons) != 2 ||
			report.Reasons[0].Code != "price" || report.Reasons[1].Code != "stale" {
			t.Fatalf("reasons = %+v", report.Reasons)
		}
		if report.Applications.Sent != 2 ||
			report.Applications.Confirmed != 1 ||
			report.Applications.Uncertain != 1 ||
			report.Applications.Rejected != 0 ||
			report.Applications.NotSent != 1 ||
			// La fila malformada de offer-e no tiene mercado conocido y, con
			// filtro, el TS la cuenta como unknownMarket antes de parsear.
			report.Applications.UnknownMarket != 1 {
			t.Fatalf("applications = %+v", report.Applications)
		}
		if report.Applications.ResponseP50Ms == nil || *report.Applications.ResponseP50Ms != 240 {
			t.Fatalf("responseP50Ms = %v, se esperaba 240", report.Applications.ResponseP50Ms)
		}
	})
}

func TestHuntingDiagnosticsHoursWindow(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	nowMS := now.UnixMilli()
	api, cookie := newHuntingDiagnosticsTestAPI(t, now)

	rows := []any{
		huntingDiagnosticsRow(5, nowMS+60_000, "market_feed_processed", "future",
			huntingDiagnosticsFeedDetail("future", "CLASICA", "venta aplicada")),
		huntingDiagnosticsRow(4, nowMS-30*60_000, "market_feed_processed", "m30",
			huntingDiagnosticsFeedDetail("m30", "CLASICA", "venta aplicada")),
		huntingDiagnosticsRow(3, nowMS-2*3_600_000, "market_feed_processed", "h2",
			huntingDiagnosticsFeedDetail("h2", "CLASICA", "venta aplicada")),
		huntingDiagnosticsRow(2, nowMS-100*3_600_000, "market_feed_processed", "h100",
			huntingDiagnosticsFeedDetail("h100", "CLASICA", "venta aplicada")),
	}
	huntingDiagnosticsWriteSnapshot(t, api.File, huntingDiagnosticsSnapshotDoc(
		[]any{huntingDiagnosticsMarketEntry("CLASICA")}, rows,
	))

	cases := []struct {
		query     string
		wantHours int
		wantCount int
	}{
		{query: "?hours=1", wantHours: 1, wantCount: 1},
		{query: "?hours=24", wantHours: 24, wantCount: 2},
		{query: "?hours=168", wantHours: 168, wantCount: 3},
		{query: "?hours=5", wantHours: 24, wantCount: 2},
		{query: "?hours=abc", wantHours: 24, wantCount: 2},
		{query: "", wantHours: 24, wantCount: 2},
	}
	for _, testCase := range cases {
		t.Run(testCase.query, func(t *testing.T) {
			recorder := huntingDiagnosticsDo(api, http.MethodGet, huntingDiagnosticsPath+testCase.query, cookie)
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
			}
			report, _ := huntingDiagnosticsDecodeData(t, recorder)
			if report.Hours != testCase.wantHours {
				t.Fatalf("hours = %d, se esperaba %d", report.Hours, testCase.wantHours)
			}
			if report.Observations != testCase.wantCount {
				t.Fatalf("observations = %d, se esperaba %d", report.Observations, testCase.wantCount)
			}
			wantSince := nowMS - int64(testCase.wantHours)*3_600_000
			if report.Since != wantSince || report.CoverageSince != wantSince {
				t.Fatalf("since/coverageSince = %d/%d, se esperaba %d",
					report.Since, report.CoverageSince, wantSince)
			}
		})
	}
}

func TestHuntingDiagnosticsUnknownMarket(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	api, cookie := newHuntingDiagnosticsTestAPI(t, now)
	huntingDiagnosticsWriteSnapshot(t, api.File, huntingDiagnosticsSnapshotDoc(
		[]any{huntingDiagnosticsMarketEntry("CLASICA")}, []any{},
	))

	t.Run("moneda no configurada", func(t *testing.T) {
		recorder := huntingDiagnosticsDo(api, http.MethodGet, huntingDiagnosticsPath+"?coin=UNKNOWN", cookie)
		huntingDiagnosticsExpectStatus(t, recorder, http.StatusBadRequest, "unknown_market")
	})

	t.Run("moneda demasiado larga", func(t *testing.T) {
		coin := strings.Repeat("A", huntingDiagnosticsCoinLimit+1)
		recorder := huntingDiagnosticsDo(api, http.MethodGet, huntingDiagnosticsPath+"?coin="+coin, cookie)
		huntingDiagnosticsExpectStatus(t, recorder, http.StatusBadRequest, "unknown_market")
	})

	t.Run("moneda limite permitida", func(t *testing.T) {
		coin := strings.Repeat("A", huntingDiagnosticsCoinLimit)
		// No existe en el snapshot, pero el límite de longitud se acepta.
		recorder := huntingDiagnosticsDo(api, http.MethodGet, huntingDiagnosticsPath+"?coin="+coin, cookie)
		huntingDiagnosticsExpectStatus(t, recorder, http.StatusBadRequest, "unknown_market")
	})
}

func TestHuntingDiagnosticsAcceptedAndReasons(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	nowMS := now.UnixMilli()
	api, cookie := newHuntingDiagnosticsTestAPI(t, now)

	outcomes := []string{
		"venta aplicada correctamente",
		"APLICADA sin venta",
		"aplicada ",
		"La oferta es antigua",
		"precio antiguo",
		"Es una oferta propia",
		"saldo de oferta propia",
		"Cacería pausada",
		"Saldo y límites insuficientes",
		"Comisión fuera del objetivo",
		"oferta no disponible por comisión",
		"Operación previa ya evaluada",
		"La oferta fue invalidada",
		"Requiere KYC y conciliación",
		"Motivo desconocido",
	}
	rows := make([]any, 0, len(outcomes))
	for index, outcome := range outcomes {
		rows = append(rows, huntingDiagnosticsRow(
			int64(len(outcomes)-index),
			nowMS-int64(index)*1_000,
			"market_feed_processed",
			fmt.Sprintf("offer-%02d", index),
			huntingDiagnosticsFeedDetail(fmt.Sprintf("offer-%02d", index), "CLASICA", outcome),
		))
	}
	huntingDiagnosticsWriteSnapshot(t, api.File, huntingDiagnosticsSnapshotDoc(
		[]any{huntingDiagnosticsMarketEntry("CLASICA")}, rows,
	))

	recorder := huntingDiagnosticsDo(api, http.MethodGet, huntingDiagnosticsPath, cookie)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	huntingDiagnosticsAssertHeaders(t, recorder)
	report, _ := huntingDiagnosticsDecodeData(t, recorder)

	if report.Observations != len(outcomes) {
		t.Fatalf("observations = %d, se esperaba %d", report.Observations, len(outcomes))
	}
	if report.AcceptedObservations != 3 {
		t.Fatalf("acceptedObservations = %d, se esperaba 3", report.AcceptedObservations)
	}
	// "precio antiguo" no coincide con /antigua/i (femenino) y cae en price,
	// igual que en el TS. "comisión" precede a unavailable.
	wantReasons := []huntingDiagnosticsReason{
		{Code: "price", Label: "Precio o comisión fuera del objetivo", Count: 3},
		{Code: "own", Label: "Oferta propia", Count: 2},
		{Code: "stale", Label: "Observación antigua", Count: 1},
		{Code: "inactive", Label: "Cacería desactivada o pausada", Count: 1},
		{Code: "capital", Label: "Saldo o límites insuficientes", Count: 1},
		{Code: "previous", Label: "Operación previa o ya evaluada", Count: 1},
		{Code: "unavailable", Label: "Oferta no disponible", Count: 1},
		{Code: "safety", Label: "Requisitos o protección de la operación", Count: 1},
		{Code: "other", Label: "Otros motivos", Count: 1},
	}
	if fmt.Sprintf("%+v", report.Reasons) != fmt.Sprintf("%+v", wantReasons) {
		t.Fatalf("reasons = %+v, se esperaba %+v", report.Reasons, wantReasons)
	}
}

func TestHuntingDiagnosticsApplicationsP50(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	nowMS := now.UnixMilli()
	api, cookie := newHuntingDiagnosticsTestAPI(t, now)

	rows := []any{
		huntingDiagnosticsRow(1, nowMS-1_000, "market_feed_processed", "offer-1",
			huntingDiagnosticsFeedDetail("offer-1", "CLASICA", "venta aplicada")),
		huntingDiagnosticsRow(2, nowMS-2_000, "offer_apply_timing", "offer-1",
			huntingDiagnosticsTimingDetail(1_000, 1_100, "confirmed")),
		huntingDiagnosticsRow(3, nowMS-3_000, "offer_apply_timing", "offer-2",
			huntingDiagnosticsTimingDetail(2_000, 2_400, "uncertain")),
		huntingDiagnosticsRow(4, nowMS-4_000, "offer_apply_timing", "offer-3",
			huntingDiagnosticsTimingDetail(3_000, 3_500, "rejected")),
		huntingDiagnosticsRow(5, nowMS-5_000, "offer_apply_timing", "offer-4",
			huntingDiagnosticsTimingDetail(4_000, 4_700, "timeout")),
		huntingDiagnosticsRow(6, nowMS-6_000, "offer_apply_timing", "offer-5",
			huntingDiagnosticsTimingDetail(nil, 5_000, "confirmed")),
		huntingDiagnosticsRow(7, nowMS-7_000, "offer_apply_timing", "offer-6",
			huntingDiagnosticsTimingDetail(5_000, 4_999, "confirmed")),
		huntingDiagnosticsRow(8, nowMS-8_000, "offer_apply_timing", "offer-7", "not-json"),
		huntingDiagnosticsRow(9, nowMS-9_000, "offer_apply_timing", "offer-8",
			huntingDiagnosticsTimingDetail(6_000, 6_800, "confirmed")),
	}
	huntingDiagnosticsWriteSnapshot(t, api.File, huntingDiagnosticsSnapshotDoc(
		[]any{huntingDiagnosticsMarketEntry("CLASICA")}, rows,
	))

	recorder := huntingDiagnosticsDo(api, http.MethodGet, huntingDiagnosticsPath, cookie)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	huntingDiagnosticsAssertHeaders(t, recorder)
	report, _ := huntingDiagnosticsDecodeData(t, recorder)

	if report.Applications.Sent != 6 ||
		report.Applications.Confirmed != 3 ||
		report.Applications.Uncertain != 1 ||
		report.Applications.Rejected != 2 ||
		report.Applications.NotSent != 1 ||
		report.Applications.UnknownMarket != 0 {
		t.Fatalf("applications = %+v", report.Applications)
	}
	if report.Applications.ResponseP50Ms == nil || *report.Applications.ResponseP50Ms != 500 {
		t.Fatalf("responseP50Ms = %v, se esperaba 500 (elemento len/2)", report.Applications.ResponseP50Ms)
	}
}

func TestHuntingDiagnosticsApplicationsUnknownMarket(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	nowMS := now.UnixMilli()
	api, cookie := newHuntingDiagnosticsTestAPI(t, now)

	rows := []any{
		huntingDiagnosticsRow(1, nowMS-1_000, "market_feed_processed", "known",
			huntingDiagnosticsFeedDetail("known", "CLASICA", "venta aplicada")),
		huntingDiagnosticsRow(2, nowMS-2_000, "market_feed_processed", "cup-offer",
			huntingDiagnosticsFeedDetail("cup-offer", "CUP", "venta aplicada")),
		huntingDiagnosticsRow(3, nowMS-3_000, "offer_apply_timing", "known",
			huntingDiagnosticsTimingDetail(1_000, 1_050, "confirmed")),
		huntingDiagnosticsRow(4, nowMS-4_000, "offer_apply_timing", "orphan",
			huntingDiagnosticsTimingDetail(1_000, 1_050, "confirmed")),
		huntingDiagnosticsRow(5, nowMS-5_000, "offer_apply_timing", "cup-offer",
			huntingDiagnosticsTimingDetail(1_000, 1_050, "confirmed")),
	}
	huntingDiagnosticsWriteSnapshot(t, api.File, huntingDiagnosticsSnapshotDoc(
		[]any{huntingDiagnosticsMarketEntry("CLASICA"), huntingDiagnosticsMarketEntry("CUP")}, rows,
	))

	t.Run("con filtro CLASICA", func(t *testing.T) {
		recorder := huntingDiagnosticsDo(api, http.MethodGet, huntingDiagnosticsPath+"?coin=CLASICA", cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		report, _ := huntingDiagnosticsDecodeData(t, recorder)
		if report.Applications.Sent != 1 ||
			report.Applications.Confirmed != 1 ||
			report.Applications.UnknownMarket != 1 {
			t.Fatalf("applications = %+v", report.Applications)
		}
	})

	t.Run("sin filtro", func(t *testing.T) {
		recorder := huntingDiagnosticsDo(api, http.MethodGet, huntingDiagnosticsPath, cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		report, _ := huntingDiagnosticsDecodeData(t, recorder)
		if report.Applications.Sent != 3 ||
			report.Applications.Confirmed != 3 ||
			report.Applications.UnknownMarket != 0 {
			t.Fatalf("applications = %+v", report.Applications)
		}
	})
}

func TestHuntingDiagnosticsAuth(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	api, cookie := newHuntingDiagnosticsTestAPI(t, now)
	huntingDiagnosticsWriteSnapshot(t, api.File, huntingDiagnosticsSnapshotDoc(
		[]any{huntingDiagnosticsMarketEntry("CLASICA")}, []any{},
	))

	t.Run("sin cookie", func(t *testing.T) {
		recorder := huntingDiagnosticsDo(api, http.MethodGet, huntingDiagnosticsPath, nil)
		huntingDiagnosticsExpectStatus(t, recorder, http.StatusUnauthorized, "unauthenticated")
	})

	t.Run("cookie manipulada", func(t *testing.T) {
		bad := &http.Cookie{Name: CookieName, Value: cookie.Value + "x"}
		recorder := huntingDiagnosticsDo(api, http.MethodGet, huntingDiagnosticsPath, bad)
		huntingDiagnosticsExpectStatus(t, recorder, http.StatusUnauthorized, "unauthenticated")
	})

	t.Run("sesiones nil", func(t *testing.T) {
		withoutSessions := &HuntingDiagnosticsAPI{
			File: api.File,
			Now:  func() time.Time { return now },
		}
		recorder := huntingDiagnosticsDo(withoutSessions, http.MethodGet, huntingDiagnosticsPath, cookie)
		huntingDiagnosticsExpectStatus(t, recorder, http.StatusUnauthorized, "unauthenticated")
	})
}

func TestHuntingDiagnosticsMethodAndRoute(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	api, cookie := newHuntingDiagnosticsTestAPI(t, now)

	t.Run("metodo no permitido", func(t *testing.T) {
		recorder := huntingDiagnosticsDo(api, http.MethodPost, huntingDiagnosticsPath, cookie)
		huntingDiagnosticsExpectStatus(t, recorder, http.StatusMethodNotAllowed, "method_not_allowed")
		if got := recorder.Header().Get("Allow"); got != http.MethodGet {
			t.Fatalf("Allow = %q, se esperaba GET", got)
		}
	})

	t.Run("ruta desconocida", func(t *testing.T) {
		recorder := huntingDiagnosticsDo(api, http.MethodGet, huntingDiagnosticsPath+"/extra", cookie)
		huntingDiagnosticsExpectStatus(t, recorder, http.StatusNotFound, "not_found")
	})

	t.Run("ruta desconocida con metodo no permitido", func(t *testing.T) {
		recorder := huntingDiagnosticsDo(api, http.MethodPost, "/api/otra", cookie)
		huntingDiagnosticsExpectStatus(t, recorder, http.StatusNotFound, "not_found")
		if got := recorder.Header().Get("Allow"); got != "" {
			t.Fatalf("Allow = %q, una ruta desconocida no debe anunciar métodos", got)
		}
	})
}

func TestHuntingDiagnosticsEmptySnapshot(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	nowMS := now.UnixMilli()

	cases := []struct {
		name  string
		setup func(t *testing.T, api *HuntingDiagnosticsAPI)
	}{
		{
			name: "archivo vacio en configuracion",
			setup: func(t *testing.T, api *HuntingDiagnosticsAPI) {
				api.File = ""
			},
		},
		{
			name: "archivo ausente",
			setup: func(t *testing.T, api *HuntingDiagnosticsAPI) {
				api.File = filepath.Join(t.TempDir(), "missing.json")
			},
		},
		{
			name: "archivo vacio",
			setup: func(t *testing.T, api *HuntingDiagnosticsAPI) {
				huntingDiagnosticsWriteRaw(t, api.File, "")
			},
		},
		{
			name: "solo espacios",
			setup: func(t *testing.T, api *HuntingDiagnosticsAPI) {
				huntingDiagnosticsWriteRaw(t, api.File, " \n\t ")
			},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			api, cookie := newHuntingDiagnosticsTestAPI(t, now)
			testCase.setup(t, api)

			recorder := huntingDiagnosticsDo(api, http.MethodGet, huntingDiagnosticsPath, cookie)
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
			}
			huntingDiagnosticsAssertHeaders(t, recorder)
			report, raw := huntingDiagnosticsDecodeData(t, recorder)

			if report.Hours != 24 || report.Coin != nil || report.Truncated {
				t.Fatalf("cabecera = %+v", report)
			}
			if report.GeneratedAt != nowMS {
				t.Fatalf("generatedAt = %d, se esperaba %d", report.GeneratedAt, nowMS)
			}
			wantSince := nowMS - 24*3_600_000
			if report.Since != wantSince || report.CoverageSince != wantSince {
				t.Fatalf("since/coverageSince = %d/%d", report.Since, report.CoverageSince)
			}
			if report.Observations != 0 || report.UniqueOffers != 0 || report.AcceptedObservations != 0 {
				t.Fatalf("contadores = %+v", report)
			}
			if len(report.Reasons) != 0 {
				t.Fatalf("reasons = %+v, se esperaba vacío", report.Reasons)
			}
			if report.Applications.Sent != 0 || report.Applications.Confirmed != 0 ||
				report.Applications.Rejected != 0 || report.Applications.Uncertain != 0 ||
				report.Applications.NotSent != 0 || report.Applications.UnknownMarket != 0 ||
				report.Applications.ResponseP50Ms != nil {
				t.Fatalf("applications = %+v", report.Applications)
			}
			if report.Note != huntingDiagnosticsNote {
				t.Fatalf("note = %q", report.Note)
			}
			if !strings.Contains(raw, `"coin":null`) ||
				!strings.Contains(raw, `"reasons":[]`) ||
				!strings.Contains(raw, `"responseP50Ms":null`) {
				t.Fatalf("data no normalizada: %s", raw)
			}
		})
	}
}

func TestHuntingDiagnosticsUnavailableSnapshot(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)

	cases := []struct {
		name  string
		setup func(t *testing.T, api *HuntingDiagnosticsAPI)
	}{
		{
			name: "json invalido",
			setup: func(t *testing.T, api *HuntingDiagnosticsAPI) {
				huntingDiagnosticsWriteRaw(t, api.File, "{")
			},
		},
		{
			name: "arreglo en lugar de objeto",
			setup: func(t *testing.T, api *HuntingDiagnosticsAPI) {
				huntingDiagnosticsWriteRaw(t, api.File, "[]")
			},
		},
		{
			name: "escalar en lugar de objeto",
			setup: func(t *testing.T, api *HuntingDiagnosticsAPI) {
				huntingDiagnosticsWriteRaw(t, api.File, `"texto"`)
			},
		},
		{
			name: "tipo de campo invalido",
			setup: func(t *testing.T, api *HuntingDiagnosticsAPI) {
				huntingDiagnosticsWriteRaw(t, api.File, `{"auditLog":"no-es-lista"}`)
			},
		},
		{
			name: "archivo mayor de 8 MiB",
			setup: func(t *testing.T, api *HuntingDiagnosticsAPI) {
				raw := make([]byte, maxHuntingDiagnosticsSnapshotBytes+1)
				if err := os.WriteFile(api.File, raw, 0o600); err != nil {
					t.Fatalf("WriteFile(%q): %v", api.File, err)
				}
			},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			api, cookie := newHuntingDiagnosticsTestAPI(t, now)
			testCase.setup(t, api)

			recorder := huntingDiagnosticsDo(api, http.MethodGet, huntingDiagnosticsPath, cookie)
			huntingDiagnosticsExpectStatus(t, recorder, http.StatusServiceUnavailable, "unavailable")
			body := recorder.Body.String()
			if strings.Contains(body, api.File) || strings.Contains(body, "invalid") ||
				strings.Contains(body, "error") {
				t.Fatalf("la respuesta no debe exponer detalles internos: %q", body)
			}
		})
	}
}

func TestHuntingDiagnosticsTruncated(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	nowMS := now.UnixMilli()
	api, cookie := newHuntingDiagnosticsTestAPI(t, now)

	rows := make([]any, 0, huntingDiagnosticsExportLimit)
	for index := 0; index < huntingDiagnosticsExportLimit; index++ {
		rows = append(rows, huntingDiagnosticsRow(
			int64(huntingDiagnosticsExportLimit-index),
			nowMS-int64(index),
			"market_feed_processing_error",
			fmt.Sprintf("offer-%d", index),
			"telemetría de error",
		))
	}
	huntingDiagnosticsWriteSnapshot(t, api.File, huntingDiagnosticsSnapshotDoc(
		[]any{huntingDiagnosticsMarketEntry("CLASICA")}, rows,
	))

	recorder := huntingDiagnosticsDo(api, http.MethodGet, huntingDiagnosticsPath, cookie)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	report, _ := huntingDiagnosticsDecodeData(t, recorder)
	if !report.Truncated {
		t.Fatal("truncated debe ser true con 15000 filas dentro de la ventana")
	}
	wantCoverage := nowMS - int64(huntingDiagnosticsExportLimit-1)
	if report.CoverageSince != wantCoverage {
		t.Fatalf("coverageSince = %d, se esperaba %d", report.CoverageSince, wantCoverage)
	}

	// Una sola fila fuera de la ventana desactiva la marca de truncado.
	rows[0] = huntingDiagnosticsRow(
		int64(huntingDiagnosticsExportLimit+1),
		nowMS-25*3_600_000,
		"market_feed_processing_error",
		"old-offer",
		"telemetría antigua",
	)
	huntingDiagnosticsWriteSnapshot(t, api.File, huntingDiagnosticsSnapshotDoc(
		[]any{huntingDiagnosticsMarketEntry("CLASICA")}, rows,
	))
	recorder = huntingDiagnosticsDo(api, http.MethodGet, huntingDiagnosticsPath, cookie)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	report, _ = huntingDiagnosticsDecodeData(t, recorder)
	if report.Truncated {
		t.Fatal("truncated debe ser false si alguna fila queda fuera de la ventana")
	}
	if want := nowMS - 24*3_600_000; report.CoverageSince != want {
		t.Fatalf("coverageSince = %d, se esperaba %d", report.CoverageSince, want)
	}
}
