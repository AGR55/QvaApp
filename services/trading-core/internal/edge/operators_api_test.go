package edge

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// operatorsResponse es el sobre documentado por el handler y se usa para
// decodificar las respuestas en las pruebas.
type operatorsResponse struct {
	Data json.RawMessage `json:"data"`
}

func newOperatorsTestAPI(t *testing.T, file string) (*OperatorsAPI, *http.Cookie, time.Time) {
	t.Helper()
	manager := newSessionTestManager(t, 15*time.Minute)
	now := time.Unix(1_700_000_000, 0)
	token, _, err := manager.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	api := &OperatorsAPI{
		Sessions: manager,
		File:     file,
		Now:      func() time.Time { return now },
	}
	cookie := &http.Cookie{Name: CookieName, Value: token}
	return api, cookie, now
}

func writeOperatorsFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}
}

func operatorsDo(
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

func assertOperatorsJSONHeaders(t *testing.T, recorder *httptest.ResponseRecorder) {
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
		t.Fatal("la API de operadores no debe emitir cookies")
	}
}

// decodeOperatorsData devuelve el valor crudo de "data" y exige que sea la
// única clave del sobre.
func decodeOperatorsData(t *testing.T, recorder *httptest.ResponseRecorder) json.RawMessage {
	t.Helper()
	var body operatorsResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	if body.Data == nil {
		t.Fatalf("respuesta sin clave data (cuerpo %q)", recorder.Body.String())
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(recorder.Body.Bytes(), &fields); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	if len(fields) != 1 {
		t.Fatalf("el sobre solo debe tener data, claves = %v", fields)
	}
	return body.Data
}

func decodeOperatorsStatus(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	var body map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return body["status"]
}

// operatorsArrayOfSize construye un arreglo JSON válido de exactamente size
// bytes: [1] seguido de ceros hasta completar el tamaño.
func operatorsArrayOfSize(size int) []byte {
	raw := make([]byte, size)
	raw[0] = '['
	raw[1] = '1'
	for i := 2; i < size-1; i++ {
		raw[i] = '0'
	}
	raw[size-1] = ']'
	return raw
}

func TestOperatorsAPIServesSnapshotVerbatim(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "mobile_operators_v1.json")
	// Se incluyen espacios y saltos de línea para comprobar que el arreglo no
	// se re-serializa ni se compacta.
	snapshot := `[
  {"id":"op-1", "label": "Android", "scopes":["read","actions"], "createdAt":1700000000000},
  {"id":"op-2", "label":"iPhone", "scopes":["read"], "createdAt":1700000001000, "revokedAt":null}
]`
	writeOperatorsFile(t, file, snapshot)

	api, cookie, _ := newOperatorsTestAPI(t, file)
	recorder := operatorsDo(api, http.MethodGet, operatorsPath, cookie)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, se esperaba 200 (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	assertOperatorsJSONHeaders(t, recorder)

	want := `{"data":` + snapshot + "}\n"
	if got := recorder.Body.String(); got != want {
		t.Fatalf("cuerpo = %q, se esperaba %q", got, want)
	}
	if strings.Contains(recorder.Body.String(), dir) {
		t.Fatal("la respuesta no debe exponer la ruta del archivo")
	}

	data := decodeOperatorsData(t, recorder)
	var operators []struct {
		ID    string   `json:"id"`
		Label string   `json:"label"`
		Scope []string `json:"scopes"`
	}
	if err := json.Unmarshal(data, &operators); err != nil {
		t.Fatalf("data no es un arreglo decodificable: %v", err)
	}
	if len(operators) != 2 || operators[0].ID != "op-1" ||
		operators[0].Label != "Android" || operators[1].ID != "op-2" {
		t.Fatalf("operadores = %+v", operators)
	}
}

func TestOperatorsAPIServesEmptyArrayForEmptySnapshot(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "mobile_operators_v1.json")
	for name, content := range map[string]string{
		"archivo vacío":     "",
		"espacios y saltos": " \n\t\r\n",
		"arreglo vacío":     "[]",
	} {
		t.Run(name, func(t *testing.T) {
			writeOperatorsFile(t, file, content)
			api, cookie, _ := newOperatorsTestAPI(t, file)
			recorder := operatorsDo(api, http.MethodGet, operatorsPath, cookie)
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
			}
			assertOperatorsJSONHeaders(t, recorder)
			if got := recorder.Body.String(); got != "{\"data\":[]}\n" {
				t.Fatalf("cuerpo = %q, se esperaba data vacía", got)
			}
		})
	}

	// Un arreglo vacío con aire interior es válido y se sirve sin compactar.
	t.Run("arreglo vacío con aire", func(t *testing.T) {
		writeOperatorsFile(t, file, " [ ] \n")
		api, cookie, _ := newOperatorsTestAPI(t, file)
		recorder := operatorsDo(api, http.MethodGet, operatorsPath, cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		assertOperatorsJSONHeaders(t, recorder)
		if got := string(decodeOperatorsData(t, recorder)); got != "[ ]" {
			t.Fatalf("data = %q, se esperaba el arreglo vacío sin transformar", got)
		}
	})
}

func TestOperatorsAPIServesEmptyArrayWhenFileMissing(t *testing.T) {
	dir := t.TempDir()
	for name, file := range map[string]string{
		"ruta inexistente": filepath.Join(dir, "no-existe.json"),
		"ruta vacía":       "",
	} {
		t.Run(name, func(t *testing.T) {
			api, cookie, _ := newOperatorsTestAPI(t, file)
			recorder := operatorsDo(api, http.MethodGet, operatorsPath, cookie)
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
			}
			assertOperatorsJSONHeaders(t, recorder)
			if got := recorder.Body.String(); got != "{\"data\":[]}\n" {
				t.Fatalf("cuerpo = %q, se esperaba data vacía", got)
			}
			if strings.Contains(recorder.Body.String(), dir) {
				t.Fatal("la respuesta no debe exponer la ruta del archivo")
			}
		})
	}
}

func TestOperatorsAPIRejectsInvalidSnapshot(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "mobile_operators_v1.json")
	for name, content := range map[string]string{
		"truncado":      `[{"id":"op-1"}`,
		"objeto":        `{"id":"op-1"}`,
		"cadena":        `"operadores"`,
		"null":          `null`,
		"número":        `42`,
		"solo apertura": `[`,
		"coma final":    `[{"id":"op-1"},]`,
		"basura final":  `[] extra`,
		"texto plano":   `no es json`,
	} {
		t.Run(name, func(t *testing.T) {
			writeOperatorsFile(t, file, content)
			api, cookie, _ := newOperatorsTestAPI(t, file)
			recorder := operatorsDo(api, http.MethodGet, operatorsPath, cookie)
			if recorder.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, se esperaba 503 (cuerpo %q)", recorder.Code, recorder.Body.String())
			}
			assertOperatorsJSONHeaders(t, recorder)
			if status := decodeOperatorsStatus(t, recorder); status != "unavailable" {
				t.Fatalf("status = %q, se esperaba unavailable", status)
			}
			body := recorder.Body.String()
			if strings.Contains(body, dir) {
				t.Fatalf("la respuesta expone la ruta del archivo: %q", body)
			}
			if strings.Contains(body, "json") || strings.Contains(body, "invalid") {
				t.Fatalf("la respuesta expone el detalle del parser: %q", body)
			}
		})
	}

	t.Run("directorio", func(t *testing.T) {
		api, cookie, _ := newOperatorsTestAPI(t, dir)
		recorder := operatorsDo(api, http.MethodGet, operatorsPath, cookie)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, se esperaba 503 (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		assertOperatorsJSONHeaders(t, recorder)
	})
}

func TestOperatorsAPIAcceptsMaxSizeAndRejectsOversizedSnapshot(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "mobile_operators_v1.json")

	exact := operatorsArrayOfSize(maxOperatorsSnapshotBytes)
	if !json.Valid(exact) {
		t.Fatal("el arreglo de tamaño máximo debe ser JSON válido")
	}
	writeOperatorsFile(t, file, string(exact))
	api, cookie, _ := newOperatorsTestAPI(t, file)
	recorder := operatorsDo(api, http.MethodGet, operatorsPath, cookie)
	if recorder.Code != http.StatusOK {
		t.Fatalf("tamaño máximo: status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	assertOperatorsJSONHeaders(t, recorder)
	if got := decodeOperatorsData(t, recorder); len(got) != maxOperatorsSnapshotBytes {
		t.Fatalf("data mide %d bytes, se esperaban %d", len(got), maxOperatorsSnapshotBytes)
	}

	oversized := operatorsArrayOfSize(maxOperatorsSnapshotBytes + 1)
	writeOperatorsFile(t, file, string(oversized))
	api, cookie, _ = newOperatorsTestAPI(t, file)
	recorder = operatorsDo(api, http.MethodGet, operatorsPath, cookie)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("tamaño excedido: status = %d, se esperaba 503 (cuerpo %q)",
			recorder.Code, recorder.Body.String())
	}
	assertOperatorsJSONHeaders(t, recorder)
	if status := decodeOperatorsStatus(t, recorder); status != "unavailable" {
		t.Fatalf("status = %q, se esperaba unavailable", status)
	}
	if strings.Contains(recorder.Body.String(), dir) {
		t.Fatal("la respuesta no debe exponer la ruta del archivo")
	}
}

func TestOperatorsAPIRequiresSession(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "mobile_operators_v1.json")
	writeOperatorsFile(t, file, `[{"id":"op-1","label":"Android"}]`)

	api, _, now := newOperatorsTestAPI(t, file)
	invalid := &http.Cookie{Name: CookieName, Value: "no-es-un-token"}
	expiredToken, _, err := api.Sessions.Issue(now.Add(-2 * time.Hour))
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	expired := &http.Cookie{Name: CookieName, Value: expiredToken}

	for name, cookie := range map[string]*http.Cookie{
		"sin cookie": nil,
		"inválida":   invalid,
		"expirada":   expired,
		"vacía":      {Name: CookieName, Value: ""},
	} {
		t.Run(name, func(t *testing.T) {
			recorder := operatorsDo(api, http.MethodGet, operatorsPath, cookie)
			if recorder.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, se esperaba 401 (cuerpo %q)", recorder.Code, recorder.Body.String())
			}
			assertOperatorsJSONHeaders(t, recorder)
			if status := decodeOperatorsStatus(t, recorder); status != "unauthenticated" {
				t.Fatalf("status = %q, se esperaba unauthenticated", status)
			}
			if strings.Contains(recorder.Body.String(), "op-1") {
				t.Fatal("una petición no autenticada no debe ver el snapshot")
			}
		})
	}

	t.Run("sin manejador de sesión", func(t *testing.T) {
		withoutSessions := &OperatorsAPI{File: file}
		recorder := operatorsDo(
			withoutSessions, http.MethodGet, operatorsPath,
			&http.Cookie{Name: CookieName, Value: "cualquiera"},
		)
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, se esperaba 401 (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		assertOperatorsJSONHeaders(t, recorder)
	})
}

func TestOperatorsAPIRejectsNonGET(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "mobile_operators_v1.json")
	writeOperatorsFile(t, file, `[]`)
	api, cookie, _ := newOperatorsTestAPI(t, file)

	for _, method := range []string{
		http.MethodPost, http.MethodPut, http.MethodPatch,
		http.MethodDelete, http.MethodHead, http.MethodOptions,
	} {
		recorder := operatorsDo(api, method, operatorsPath, cookie)
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s: status = %d, se esperaba 405 (cuerpo %q)",
				method, recorder.Code, recorder.Body.String())
		}
		if got := recorder.Header().Get("Allow"); got != http.MethodGet {
			t.Fatalf("%s: Allow = %q, se esperaba GET", method, got)
		}
		assertOperatorsJSONHeaders(t, recorder)
		if status := decodeOperatorsStatus(t, recorder); status != "method_not_allowed" {
			t.Fatalf("%s: status = %q", method, status)
		}
	}
}

func TestOperatorsAPIRejectsUnknownRoutes(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "mobile_operators_v1.json")
	writeOperatorsFile(t, file, `[]`)
	api, cookie, _ := newOperatorsTestAPI(t, file)

	for _, target := range []string{
		"/api/mobile/operators/", "/api/mobile/operators/op-1",
		"/api/mobile/operator", "/api/mobile", "/api/session",
		"/api/mobile/operators/../operators",
	} {
		recorder := operatorsDo(api, http.MethodGet, target, cookie)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s: status = %d, se esperaba 404 (cuerpo %q)",
				target, recorder.Code, recorder.Body.String())
		}
		assertOperatorsJSONHeaders(t, recorder)
		if status := decodeOperatorsStatus(t, recorder); status != "not_found" {
			t.Fatalf("%s: status = %q", target, status)
		}
	}

	// La ruta se resuelve antes que el método: una ruta desconocida es 404.
	recorder := operatorsDo(api, http.MethodPost, "/api/mobile/operators/op-1", cookie)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("POST desconocido: status = %d, se esperaba 404", recorder.Code)
	}

	// La query no altera la ruta servida.
	recorder = operatorsDo(api, http.MethodGet, operatorsPath+"?limit=5&x=1", cookie)
	if recorder.Code != http.StatusOK {
		t.Fatalf("con query: status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
}

// TestOperatorsAPIServesFreshSnapshotPerRequest documenta la ausencia de caché:
// una revocación publicada en el snapshot se ve en la petición siguiente. Si se
// añadiera una caché de 30 s, este test debería actualizarse a propósito.
func TestOperatorsAPIServesFreshSnapshotPerRequest(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "mobile_operators_v1.json")
	first := `[{"id":"op-1","label":"Android"}]`
	second := `[{"id":"op-1","label":"Android","revokedAt":1700000002000}]`

	writeOperatorsFile(t, file, first)
	api, cookie, _ := newOperatorsTestAPI(t, file)

	recorder := operatorsDo(api, http.MethodGet, operatorsPath, cookie)
	if recorder.Code != http.StatusOK {
		t.Fatalf("primera lectura: status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	if got := string(decodeOperatorsData(t, recorder)); got != first {
		t.Fatalf("primera lectura = %q", got)
	}

	writeOperatorsFile(t, file, second)
	recorder = operatorsDo(api, http.MethodGet, operatorsPath, cookie)
	if recorder.Code != http.StatusOK {
		t.Fatalf("segunda lectura: status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	if got := string(decodeOperatorsData(t, recorder)); got != second {
		t.Fatalf("segunda lectura = %q, se esperaba %q", got, second)
	}
}
