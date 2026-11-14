package edge

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Tokens fijos con formato válido (40..100 caracteres de [A-Za-z0-9_-]) y
// hashes deterministas: las pruebas no dependen de aleatoriedad ni del reloj
// real.
var (
	mobileAuthTestDeviceToken          = strings.Repeat("d", 48)
	mobileAuthTestOperatorToken        = strings.Repeat("o", 48)
	mobileAuthTestReadOnlyToken        = strings.Repeat("r", 48)
	mobileAuthTestActionsOnlyToken     = strings.Repeat("a", 48)
	mobileAuthTestRevokedOperatorToken = strings.Repeat("v", 48)
	mobileAuthTestRevokedStringToken   = strings.Repeat("s", 48)
	mobileAuthTestUnknownToken         = strings.Repeat("x", 48)
)

const mobileAuthTestNowUnix = 1_700_000_000

func mobileAuthTestHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func mobileAuthTestDevice(token string, revokedAt any) map[string]any {
	return map[string]any{
		"tokenHash": mobileAuthTestHash(token),
		"revokedAt": revokedAt,
	}
}

func mobileAuthTestOperator(id, token string, scopes []string, revokedAt any) map[string]any {
	return map[string]any{
		"id":        id,
		"tokenHash": mobileAuthTestHash(token),
		"scopes":    scopes,
		"revokedAt": revokedAt,
	}
}

func writeMobileAuthTestFile(t *testing.T, path string, content []byte) {
	t.Helper()
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}
}

func writeMobileAuthTestSnapshot(
	t *testing.T,
	path string,
	devices []map[string]any,
	operators []map[string]any,
) {
	t.Helper()
	if devices == nil {
		devices = []map[string]any{}
	}
	if operators == nil {
		operators = []map[string]any{}
	}
	raw, err := json.Marshal(map[string]any{
		"devices":   devices,
		"operators": operators,
	})
	if err != nil {
		t.Fatalf("Marshal snapshot: %v", err)
	}
	writeMobileAuthTestFile(t, path, raw)
}

func newMobileAuthTestAPI(t *testing.T, file string) *MobileAuthAPI {
	t.Helper()
	now := time.Unix(mobileAuthTestNowUnix, 0)
	return &MobileAuthAPI{File: file, Now: func() time.Time { return now }}
}

func mobileAuthTestDo(
	handler http.Handler,
	method string,
	target string,
	authorization string,
) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, nil)
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func assertMobileAuthTestHeaders(t *testing.T, recorder *httptest.ResponseRecorder) {
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
		t.Fatal("la autenticación móvil es Bearer y no debe emitir cookies")
	}
}

func decodeMobileAuthTestBody(
	t *testing.T,
	recorder *httptest.ResponseRecorder,
) map[string]json.RawMessage {
	t.Helper()
	var body map[string]json.RawMessage
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return body
}

func assertMobileAuthTestError(
	t *testing.T,
	recorder *httptest.ResponseRecorder,
	status int,
	message string,
) {
	t.Helper()
	if recorder.Code != status {
		t.Fatalf("status = %d, se esperaba %d (cuerpo %q)", recorder.Code, status, recorder.Body.String())
	}
	assertMobileAuthTestHeaders(t, recorder)
	body := decodeMobileAuthTestBody(t, recorder)
	if len(body) != 1 {
		t.Fatalf("el cuerpo de error solo debe tener error, claves = %v", body)
	}
	var got string
	if err := json.Unmarshal(body["error"], &got); err != nil {
		t.Fatalf("error no es una cadena: %v", err)
	}
	if got != message {
		t.Fatalf("error = %q, se esperaba %q", got, message)
	}
	if strings.Contains(recorder.Body.String(), mobileAuthTestDeviceToken) ||
		strings.Contains(recorder.Body.String(), mobileAuthTestOperatorToken) {
		t.Fatal("la respuesta no debe contener el token")
	}
}

func assertMobileAuthTestUnavailable(t *testing.T, recorder *httptest.ResponseRecorder) {
	t.Helper()
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, se esperaba 503 (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	assertMobileAuthTestHeaders(t, recorder)
	if got := recorder.Body.String(); got != "{\"status\":\"unavailable\"}\n" {
		t.Fatalf("cuerpo = %q, se esperaba el estado sin detalles", got)
	}
}

func TestMobileAuthAPIDeviceCheck(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "mobile_auth.json")
	writeMobileAuthTestSnapshot(t, file, []map[string]any{
		mobileAuthTestDevice(mobileAuthTestDeviceToken, nil),
		mobileAuthTestDevice(mobileAuthTestUnknownToken, int64(1_700_000_000_000)),
	}, nil)
	api := newMobileAuthTestAPI(t, file)

	t.Run("dispositivo vigente", func(t *testing.T) {
		recorder := mobileAuthTestDo(api, http.MethodGet, mobileDeviceCheckPath,
			"Bearer "+mobileAuthTestDeviceToken)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		assertMobileAuthTestHeaders(t, recorder)
		if got := recorder.Body.String(); got != "{\"ok\":true}\n" {
			t.Fatalf("cuerpo = %q", got)
		}
		body := decodeMobileAuthTestBody(t, recorder)
		if len(body) != 1 {
			t.Fatalf("la respuesta solo debe tener ok, claves = %v", body)
		}
		if string(body["ok"]) != "true" {
			t.Fatalf("ok = %s", body["ok"])
		}
		if strings.Contains(recorder.Body.String(), mobileAuthTestHash(mobileAuthTestDeviceToken)) {
			t.Fatal("la respuesta no debe contener el hash")
		}
		if strings.Contains(recorder.Body.String(), dir) {
			t.Fatal("la respuesta no debe contener la ruta del snapshot")
		}
	})

	t.Run("dispositivo revocado", func(t *testing.T) {
		recorder := mobileAuthTestDo(api, http.MethodGet, mobileDeviceCheckPath,
			"Bearer "+mobileAuthTestUnknownToken)
		assertMobileAuthTestError(t, recorder, http.StatusUnauthorized,
			mobileDeviceCredentialError)
	})

	t.Run("hash desconocido", func(t *testing.T) {
		recorder := mobileAuthTestDo(api, http.MethodGet, mobileDeviceCheckPath,
			"Bearer "+mobileAuthTestOperatorToken)
		assertMobileAuthTestError(t, recorder, http.StatusUnauthorized,
			mobileDeviceCredentialError)
	})
}

func TestMobileAuthAPIDeviceCheckRejectsInvalidAuthorization(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "mobile_auth.json")
	writeMobileAuthTestSnapshot(t, file, []map[string]any{
		mobileAuthTestDevice(mobileAuthTestDeviceToken, nil),
	}, nil)
	api := newMobileAuthTestAPI(t, file)

	cases := map[string]string{
		"sin encabezado":           "",
		"solo esquema":             "Bearer",
		"esquema sin token":        "Bearer ",
		"esquema en minúsculas":    "bearer " + mobileAuthTestDeviceToken,
		"otro esquema":             "Token " + mobileAuthTestDeviceToken,
		"token de 39":              "Bearer " + strings.Repeat("a", 39),
		"token de 101":             "Bearer " + strings.Repeat("a", 101),
		"token con punto":          "Bearer " + strings.Repeat("a", 20) + "." + strings.Repeat("a", 20),
		"espacios extra":           "Bearer  " + mobileAuthTestDeviceToken,
		"texto extra":              "Bearer " + mobileAuthTestDeviceToken + " extra",
		"token sin esquema":        mobileAuthTestDeviceToken,
		"token con salto de línea": "Bearer " + mobileAuthTestDeviceToken + "\n",
	}
	for name, authorization := range cases {
		t.Run(name, func(t *testing.T) {
			recorder := mobileAuthTestDo(api, http.MethodGet, mobileDeviceCheckPath, authorization)
			assertMobileAuthTestError(t, recorder, http.StatusUnauthorized,
				mobileDeviceCredentialError)
		})
	}
}

func TestMobileAuthAPIOperatorCheck(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "mobile_auth.json")
	writeMobileAuthTestSnapshot(t, file, nil, []map[string]any{
		mobileAuthTestOperator("op-1", mobileAuthTestOperatorToken,
			[]string{"read", "actions"}, nil),
		mobileAuthTestOperator("op-read", mobileAuthTestReadOnlyToken,
			[]string{"read"}, nil),
		mobileAuthTestOperator("op-actions", mobileAuthTestActionsOnlyToken,
			[]string{"actions"}, nil),
		mobileAuthTestOperator("op-revoked", mobileAuthTestRevokedOperatorToken,
			[]string{"read", "actions"}, int64(1_700_000_000_000)),
		mobileAuthTestOperator("op-revoked-string", mobileAuthTestRevokedStringToken,
			[]string{"read", "actions"}, "2026-01-01T00:00:00Z"),
	})
	api := newMobileAuthTestAPI(t, file)

	t.Run("operador vigente con scopes", func(t *testing.T) {
		recorder := mobileAuthTestDo(api, http.MethodGet, mobileOperatorCheckPath,
			"Bearer "+mobileAuthTestOperatorToken)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		assertMobileAuthTestHeaders(t, recorder)
		if got := recorder.Body.String(); got != "{\"ok\":true,\"scopes\":[\"read\",\"actions\"]}\n" {
			t.Fatalf("cuerpo = %q", got)
		}
		body := decodeMobileAuthTestBody(t, recorder)
		if len(body) != 2 {
			t.Fatalf("la respuesta solo debe tener ok y scopes, claves = %v", body)
		}
		var scopes []string
		if err := json.Unmarshal(body["scopes"], &scopes); err != nil {
			t.Fatalf("scopes inválidos: %v", err)
		}
		if len(scopes) != 2 || scopes[0] != "read" || scopes[1] != "actions" {
			t.Fatalf("scopes = %v", scopes)
		}
	})

	t.Run("operador solo lectura", func(t *testing.T) {
		recorder := mobileAuthTestDo(api, http.MethodGet, mobileOperatorCheckPath,
			"Bearer "+mobileAuthTestReadOnlyToken)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		assertMobileAuthTestHeaders(t, recorder)
		if got := recorder.Body.String(); got != "{\"ok\":true,\"scopes\":[\"read\"]}\n" {
			t.Fatalf("cuerpo = %q", got)
		}
	})

	for name, token := range map[string]string{
		"sin scope read":         mobileAuthTestActionsOnlyToken,
		"revocado con timestamp": mobileAuthTestRevokedOperatorToken,
		"revocado con cadena":    mobileAuthTestRevokedStringToken,
		"hash desconocido":       mobileAuthTestUnknownToken,
	} {
		t.Run(name, func(t *testing.T) {
			recorder := mobileAuthTestDo(api, http.MethodGet, mobileOperatorCheckPath,
				"Bearer "+token)
			assertMobileAuthTestError(t, recorder, http.StatusUnauthorized,
				mobileOperatorCredentialError)
		})
	}

	t.Run("formato inválido", func(t *testing.T) {
		recorder := mobileAuthTestDo(api, http.MethodGet, mobileOperatorCheckPath,
			"Bearer "+strings.Repeat("a", 39))
		assertMobileAuthTestError(t, recorder, http.StatusUnauthorized,
			mobileOperatorCredentialError)
	})
}

func TestMobileAuthAPIOperatorReadRateLimit(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "mobile_auth.json")
	writeMobileAuthTestSnapshot(t, file, []map[string]any{
		mobileAuthTestDevice(mobileAuthTestDeviceToken, nil),
	}, []map[string]any{
		mobileAuthTestOperator("op-1", mobileAuthTestOperatorToken,
			[]string{"read", "actions"}, nil),
		mobileAuthTestOperator("op-2", mobileAuthTestReadOnlyToken,
			[]string{"read"}, nil),
	})

	now := time.Unix(mobileAuthTestNowUnix, 0)
	api := &MobileAuthAPI{File: file, Now: func() time.Time { return now }}

	for i := 0; i < mobileOperatorReadLimit; i++ {
		recorder := mobileAuthTestDo(api, http.MethodGet, mobileOperatorCheckPath,
			"Bearer "+mobileAuthTestOperatorToken)
		if recorder.Code != http.StatusOK {
			t.Fatalf("lectura %d: status = %d (cuerpo %q)", i+1, recorder.Code, recorder.Body.String())
		}
	}

	recorder := mobileAuthTestDo(api, http.MethodGet, mobileOperatorCheckPath,
		"Bearer "+mobileAuthTestOperatorToken)
	assertMobileAuthTestError(t, recorder, http.StatusTooManyRequests,
		mobileOperatorRateLimitError)

	t.Run("otro operador conserva su cupo", func(t *testing.T) {
		recorder := mobileAuthTestDo(api, http.MethodGet, mobileOperatorCheckPath,
			"Bearer "+mobileAuthTestReadOnlyToken)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
	})

	t.Run("el dispositivo no comparte el límite", func(t *testing.T) {
		for i := 0; i < mobileOperatorReadLimit+1; i++ {
			recorder := mobileAuthTestDo(api, http.MethodGet, mobileDeviceCheckPath,
				"Bearer "+mobileAuthTestDeviceToken)
			if recorder.Code != http.StatusOK {
				t.Fatalf("device-check %d: status = %d (cuerpo %q)", i+1, recorder.Code, recorder.Body.String())
			}
		}
	})

	t.Run("sigue limitado antes del minuto", func(t *testing.T) {
		now = now.Add(mobileOperatorReadWindow - time.Second)
		recorder := mobileAuthTestDo(api, http.MethodGet, mobileOperatorCheckPath,
			"Bearer "+mobileAuthTestOperatorToken)
		assertMobileAuthTestError(t, recorder, http.StatusTooManyRequests,
			mobileOperatorRateLimitError)
	})

	t.Run("se reinicia al cumplir el minuto", func(t *testing.T) {
		now = now.Add(time.Second)
		recorder := mobileAuthTestDo(api, http.MethodGet, mobileOperatorCheckPath,
			"Bearer "+mobileAuthTestOperatorToken)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		for i := 0; i < mobileOperatorReadLimit-1; i++ {
			recorder := mobileAuthTestDo(api, http.MethodGet, mobileOperatorCheckPath,
				"Bearer "+mobileAuthTestOperatorToken)
			if recorder.Code != http.StatusOK {
				t.Fatalf("lectura tras reinicio %d: status = %d", i+2, recorder.Code)
			}
		}
		recorder = mobileAuthTestDo(api, http.MethodGet, mobileOperatorCheckPath,
			"Bearer "+mobileAuthTestOperatorToken)
		assertMobileAuthTestError(t, recorder, http.StatusTooManyRequests,
			mobileOperatorRateLimitError)
	})
}

func TestMobileAuthAPIMethodAndRoute(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "mobile_auth.json")
	writeMobileAuthTestSnapshot(t, file, []map[string]any{
		mobileAuthTestDevice(mobileAuthTestDeviceToken, nil),
	}, []map[string]any{
		mobileAuthTestOperator("op-1", mobileAuthTestOperatorToken,
			[]string{"read", "actions"}, nil),
	})
	api := newMobileAuthTestAPI(t, file)

	for _, target := range []string{mobileDeviceCheckPath, mobileOperatorCheckPath} {
		for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodHead} {
			t.Run(method+" "+target, func(t *testing.T) {
				recorder := mobileAuthTestDo(api, method, target,
					"Bearer "+mobileAuthTestOperatorToken)
				if recorder.Code != http.StatusMethodNotAllowed {
					t.Fatalf("status = %d, se esperaba 405 (cuerpo %q)",
						recorder.Code, recorder.Body.String())
				}
				assertMobileAuthTestHeaders(t, recorder)
				if got := recorder.Header().Get("Allow"); got != http.MethodGet {
					t.Fatalf("Allow = %q, se esperaba GET", got)
				}
				body := decodeMobileAuthTestBody(t, recorder)
				var status string
				if err := json.Unmarshal(body["status"], &status); err != nil {
					t.Fatalf("status no es cadena: %v", err)
				}
				if status != "method_not_allowed" {
					t.Fatalf("status = %q", status)
				}
			})
		}
	}

	otherRoutes := []string{
		"/api/mobile/device-check/",
		"/api/mobile/operator-check/extra",
		"/api/mobile/device-checks",
		"/api/mobile/auth",
		"/api/mobile",
		"/",
	}
	for _, target := range otherRoutes {
		t.Run("404 "+target, func(t *testing.T) {
			recorder := mobileAuthTestDo(api, http.MethodGet, target,
				"Bearer "+mobileAuthTestOperatorToken)
			if recorder.Code != http.StatusNotFound {
				t.Fatalf("status = %d, se esperaba 404 (cuerpo %q)",
					recorder.Code, recorder.Body.String())
			}
			assertMobileAuthTestHeaders(t, recorder)
			body := decodeMobileAuthTestBody(t, recorder)
			var status string
			if err := json.Unmarshal(body["status"], &status); err != nil {
				t.Fatalf("status no es cadena: %v", err)
			}
			if status != "not_found" {
				t.Fatalf("status = %q", status)
			}
		})
	}

	t.Run("ruta desconocida con método distinto sigue siendo 404", func(t *testing.T) {
		recorder := mobileAuthTestDo(api, http.MethodPost, "/api/mobile/desconocida",
			"Bearer "+mobileAuthTestOperatorToken)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("status = %d, se esperaba 404", recorder.Code)
		}
	})
}

func TestMobileAuthAPISnapshotMissingOrEmpty(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, "no-existe.json")
	empty := filepath.Join(dir, "vacío.json")
	writeMobileAuthTestFile(t, empty, nil)
	spaces := filepath.Join(dir, "espacios.json")
	writeMobileAuthTestFile(t, spaces, []byte(" \n\t\r\n"))
	emptyArrays := filepath.Join(dir, "arreglos-vacíos.json")
	writeMobileAuthTestFile(t, emptyArrays, []byte(`{"devices":[],"operators":[]}`))
	emptyObject := filepath.Join(dir, "objeto-vacío.json")
	writeMobileAuthTestFile(t, emptyObject, []byte(`{}`))

	cases := map[string]string{
		"ruta vacía":      "",
		"archivo ausente": missing,
		"archivo vacío":   empty,
		"solo espacios":   spaces,
		"arreglos vacíos": emptyArrays,
		"objeto vacío":    emptyObject,
	}
	for name, file := range cases {
		t.Run(name, func(t *testing.T) {
			api := newMobileAuthTestAPI(t, file)

			device := mobileAuthTestDo(api, http.MethodGet, mobileDeviceCheckPath,
				"Bearer "+mobileAuthTestDeviceToken)
			assertMobileAuthTestError(t, device, http.StatusUnauthorized,
				mobileDeviceCredentialError)

			operator := mobileAuthTestDo(api, http.MethodGet, mobileOperatorCheckPath,
				"Bearer "+mobileAuthTestOperatorToken)
			assertMobileAuthTestError(t, operator, http.StatusUnauthorized,
				mobileOperatorCredentialError)

			if strings.Contains(device.Body.String(), dir) ||
				strings.Contains(operator.Body.String(), dir) {
				t.Fatal("la respuesta no debe exponer la ruta del snapshot")
			}
		})
	}
}

func TestMobileAuthAPISnapshotUnavailable(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "mobile_auth.json")

	invalid := map[string][]byte{
		"truncado":             []byte(`{"devices":[`),
		"arreglo":              []byte(`[]`),
		"null":                 []byte(`null`),
		"cadena":               []byte(`"snapshot"`),
		"número":               []byte(`42`),
		"devices no arreglo":   []byte(`{"devices":"nope"}`),
		"operators no arreglo": []byte(`{"operators":{"id":"op"}}`),
		"basura final":         []byte(`{"devices":[]} extra`),
		"texto plano":          []byte(`no es json`),
	}
	for name, content := range invalid {
		t.Run(name, func(t *testing.T) {
			writeMobileAuthTestFile(t, file, content)
			api := newMobileAuthTestAPI(t, file)
			recorder := mobileAuthTestDo(api, http.MethodGet, mobileDeviceCheckPath,
				"Bearer "+mobileAuthTestDeviceToken)
			assertMobileAuthTestUnavailable(t, recorder)
			if strings.Contains(recorder.Body.String(), dir) {
				t.Fatal("la respuesta no debe exponer la ruta del snapshot")
			}
		})
	}

	t.Run("mayor de 1 MiB", func(t *testing.T) {
		writeMobileAuthTestFile(t, file, bytes.Repeat([]byte(" "), maxMobileAuthSnapshotBytes+1))
		api := newMobileAuthTestAPI(t, file)
		recorder := mobileAuthTestDo(api, http.MethodGet, mobileOperatorCheckPath,
			"Bearer "+mobileAuthTestOperatorToken)
		assertMobileAuthTestUnavailable(t, recorder)
	})

	t.Run("error de lectura", func(t *testing.T) {
		api := newMobileAuthTestAPI(t, dir)
		recorder := mobileAuthTestDo(api, http.MethodGet, mobileDeviceCheckPath,
			"Bearer "+mobileAuthTestDeviceToken)
		assertMobileAuthTestUnavailable(t, recorder)
		if strings.Contains(recorder.Body.String(), dir) {
			t.Fatal("la respuesta no debe exponer la ruta del snapshot")
		}
	})
}

func TestMobileAuthAPIChecksTokenFormatBeforeSnapshot(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "mobile_auth.json")
	writeMobileAuthTestFile(t, file, []byte(`{"devices":[`))
	api := newMobileAuthTestAPI(t, file)

	for _, target := range []string{mobileDeviceCheckPath, mobileOperatorCheckPath} {
		recorder := mobileAuthTestDo(api, http.MethodGet, target, "")
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("%s sin token: status = %d, se esperaba 401", target, recorder.Code)
		}
		recorder = mobileAuthTestDo(api, http.MethodGet, target,
			"Bearer "+mobileAuthTestDeviceToken)
		assertMobileAuthTestUnavailable(t, recorder)
	}
}

func TestMobileAuthAPIHeadersOnEveryResponse(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "mobile_auth.json")
	writeMobileAuthTestSnapshot(t, file, []map[string]any{
		mobileAuthTestDevice(mobileAuthTestDeviceToken, nil),
	}, []map[string]any{
		mobileAuthTestOperator("op-1", mobileAuthTestOperatorToken,
			[]string{"read", "actions"}, nil),
	})
	api := newMobileAuthTestAPI(t, file)

	responses := map[string]*httptest.ResponseRecorder{
		"device ok": mobileAuthTestDo(api, http.MethodGet, mobileDeviceCheckPath,
			"Bearer "+mobileAuthTestDeviceToken),
		"operator ok": mobileAuthTestDo(api, http.MethodGet, mobileOperatorCheckPath,
			"Bearer "+mobileAuthTestOperatorToken),
		"401": mobileAuthTestDo(api, http.MethodGet, mobileDeviceCheckPath,
			"Bearer "+mobileAuthTestUnknownToken),
		"404": mobileAuthTestDo(api, http.MethodGet, "/api/mobile/otra", ""),
		"405": mobileAuthTestDo(api, http.MethodPost, mobileDeviceCheckPath, ""),
	}
	for name, recorder := range responses {
		t.Run(name, func(t *testing.T) {
			assertMobileAuthTestHeaders(t, recorder)
		})
	}
}
