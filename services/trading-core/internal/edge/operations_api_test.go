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

// operationsChatsResponse es el sobre documentado por el handler y se usa para
// decodificar las respuestas en las pruebas.
type operationsChatsResponse struct {
	Data json.RawMessage `json:"data"`
}

func newOperationsChatsTestAPI(t *testing.T, file string) (*OperationsAPI, *http.Cookie, time.Time) {
	t.Helper()
	manager := newSessionTestManager(t, 15*time.Minute)
	now := time.Unix(1_700_000_000, 0)
	token, _, err := manager.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	api := &OperationsAPI{
		Sessions: manager,
		File:     file,
		Now:      func() time.Time { return now },
	}
	cookie := &http.Cookie{Name: CookieName, Value: token}
	return api, cookie, now
}

func writeChatsFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}
}

func chatsDo(
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

func assertChatsJSONHeaders(t *testing.T, recorder *httptest.ResponseRecorder) {
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
		t.Fatal("la API de operaciones no debe emitir cookies")
	}
}

// decodeChatsData devuelve el valor crudo de "data" y exige que sea la única
// clave del sobre.
func decodeChatsData(t *testing.T, recorder *httptest.ResponseRecorder) json.RawMessage {
	t.Helper()
	var body operationsChatsResponse
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

func decodeChatsStatus(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	var body map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return body["status"]
}

// chatsArrayOfSize construye un arreglo JSON válido de exactamente size bytes:
// [1] seguido de ceros hasta completar el tamaño.
func chatsArrayOfSize(size int) []byte {
	raw := make([]byte, size)
	raw[0] = '['
	raw[1] = '1'
	for i := 2; i < size-1; i++ {
		raw[i] = '0'
	}
	raw[size-1] = ']'
	return raw
}

func TestOperationsChatsAPIServesSnapshotFromBothRoutes(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "chat_threads_v1.json")
	// Se incluyen espacios y saltos de línea para comprobar que el arreglo no
	// se re-serializa ni se compacta.
	snapshot := `[
  {"id":"th-1", "title": "Soporte", "updatedAt":1700000000000},
  {"id":"th-2", "title":"Pagos", "updatedAt":1700000001000, "archivedAt":null}
]`
	writeChatsFile(t, file, snapshot)

	for _, path := range []string{operationsChatsPath, mobileOperationsChatsPath} {
		t.Run(path, func(t *testing.T) {
			api, cookie, _ := newOperationsChatsTestAPI(t, file)
			recorder := chatsDo(api, http.MethodGet, path, cookie)
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d, se esperaba 200 (cuerpo %q)", recorder.Code, recorder.Body.String())
			}
			assertChatsJSONHeaders(t, recorder)

			want := `{"data":` + snapshot + "}\n"
			if got := recorder.Body.String(); got != want {
				t.Fatalf("cuerpo = %q, se esperaba %q", got, want)
			}
			if strings.Contains(recorder.Body.String(), dir) {
				t.Fatal("la respuesta no debe exponer la ruta del archivo")
			}

			data := decodeChatsData(t, recorder)
			var threads []struct {
				ID    string `json:"id"`
				Title string `json:"title"`
			}
			if err := json.Unmarshal(data, &threads); err != nil {
				t.Fatalf("data no es un arreglo decodificable: %v", err)
			}
			if len(threads) != 2 || threads[0].Title != "Soporte" || threads[1].ID != "th-2" {
				t.Fatalf("hilos = %+v", threads)
			}
		})
	}
}

func TestOperationsChatsAPIServesEmptyArray(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "chat_threads_v1.json")

	for name, content := range map[string]string{
		"archivo vacío":     "",
		"espacios y saltos": " \n\t\r\n",
		"arreglo vacío":     "[]",
	} {
		t.Run(name, func(t *testing.T) {
			writeChatsFile(t, file, content)
			api, cookie, _ := newOperationsChatsTestAPI(t, file)
			recorder := chatsDo(api, http.MethodGet, operationsChatsPath, cookie)
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
			}
			assertChatsJSONHeaders(t, recorder)
			if got := recorder.Body.String(); got != "{\"data\":[]}\n" {
				t.Fatalf("cuerpo = %q, se esperaba data vacía", got)
			}
		})
	}

	t.Run("ruta vacía", func(t *testing.T) {
		api, cookie, _ := newOperationsChatsTestAPI(t, "")
		recorder := chatsDo(api, http.MethodGet, operationsChatsPath, cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		assertChatsJSONHeaders(t, recorder)
		if got := recorder.Body.String(); got != "{\"data\":[]}\n" {
			t.Fatalf("cuerpo = %q, se esperaba data vacía", got)
		}
	})

	t.Run("arreglo vacío con aire", func(t *testing.T) {
		writeChatsFile(t, file, " [ ] \n")
		api, cookie, _ := newOperationsChatsTestAPI(t, file)
		recorder := chatsDo(api, http.MethodGet, operationsChatsPath, cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		assertChatsJSONHeaders(t, recorder)
		if got := string(decodeChatsData(t, recorder)); got != "[ ]" {
			t.Fatalf("data = %q, se esperaba el arreglo vacío sin transformar", got)
		}
	})
}

func TestOperationsChatsAPIServesEmptyArrayWhenFileMissing(t *testing.T) {
	dir := t.TempDir()
	api, cookie, _ := newOperationsChatsTestAPI(t, filepath.Join(dir, "no-existe.json"))

	for _, path := range []string{operationsChatsPath, mobileOperationsChatsPath} {
		recorder := chatsDo(api, http.MethodGet, path, cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s: status = %d (cuerpo %q)", path, recorder.Code, recorder.Body.String())
		}
		assertChatsJSONHeaders(t, recorder)
		if got := recorder.Body.String(); got != "{\"data\":[]}\n" {
			t.Fatalf("%s: cuerpo = %q, se esperaba data vacía", path, got)
		}
		if strings.Contains(recorder.Body.String(), dir) {
			t.Fatalf("%s: la respuesta no debe exponer la ruta del archivo", path)
		}
	}
}

func TestOperationsChatsAPIRejectsInvalidSnapshot(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "chat_threads_v1.json")
	for name, content := range map[string]string{
		"truncado":      `[{"id":"th-1"}`,
		"objeto":        `{"id":"th-1"}`,
		"cadena":        `"hilos"`,
		"null":          `null`,
		"número":        `42`,
		"solo apertura": `[`,
		"coma final":    `[{"id":"th-1"},]`,
		"basura final":  `[] extra`,
		"texto plano":   `no es json`,
	} {
		t.Run(name, func(t *testing.T) {
			writeChatsFile(t, file, content)
			api, cookie, _ := newOperationsChatsTestAPI(t, file)
			recorder := chatsDo(api, http.MethodGet, operationsChatsPath, cookie)
			if recorder.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, se esperaba 503 (cuerpo %q)", recorder.Code, recorder.Body.String())
			}
			assertChatsJSONHeaders(t, recorder)
			if status := decodeChatsStatus(t, recorder); status != "unavailable" {
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
		api, cookie, _ := newOperationsChatsTestAPI(t, dir)
		recorder := chatsDo(api, http.MethodGet, operationsChatsPath, cookie)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, se esperaba 503 (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		assertChatsJSONHeaders(t, recorder)
		if status := decodeChatsStatus(t, recorder); status != "unavailable" {
			t.Fatalf("status = %q, se esperaba unavailable", status)
		}
	})
}

func TestOperationsChatsAPIAcceptsMaxSizeAndRejectsOversizedSnapshot(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "chat_threads_v1.json")

	exact := chatsArrayOfSize(maxChatsSnapshotBytes)
	if !json.Valid(exact) {
		t.Fatal("el arreglo de tamaño máximo debe ser JSON válido")
	}
	writeChatsFile(t, file, string(exact))
	api, cookie, _ := newOperationsChatsTestAPI(t, file)
	recorder := chatsDo(api, http.MethodGet, operationsChatsPath, cookie)
	if recorder.Code != http.StatusOK {
		t.Fatalf("tamaño máximo: status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	assertChatsJSONHeaders(t, recorder)
	if got := decodeChatsData(t, recorder); len(got) != maxChatsSnapshotBytes {
		t.Fatalf("data mide %d bytes, se esperaban %d", len(got), maxChatsSnapshotBytes)
	}

	oversized := chatsArrayOfSize(maxChatsSnapshotBytes + 1)
	writeChatsFile(t, file, string(oversized))
	api, cookie, _ = newOperationsChatsTestAPI(t, file)
	recorder = chatsDo(api, http.MethodGet, operationsChatsPath, cookie)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("tamaño excedido: status = %d, se esperaba 503 (cuerpo %q)",
			recorder.Code, recorder.Body.String())
	}
	assertChatsJSONHeaders(t, recorder)
	if status := decodeChatsStatus(t, recorder); status != "unavailable" {
		t.Fatalf("status = %q, se esperaba unavailable", status)
	}
	if strings.Contains(recorder.Body.String(), dir) {
		t.Fatal("la respuesta no debe exponer la ruta del archivo")
	}
}

func TestOperationsChatsAPIRequiresSession(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "chat_threads_v1.json")
	writeChatsFile(t, file, `[{"id":"th-1","title":"Soporte"}]`)

	api, _, now := newOperationsChatsTestAPI(t, file)
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
			for _, path := range []string{operationsChatsPath, mobileOperationsChatsPath} {
				recorder := chatsDo(api, http.MethodGet, path, cookie)
				if recorder.Code != http.StatusUnauthorized {
					t.Fatalf("%s: status = %d, se esperaba 401 (cuerpo %q)",
						path, recorder.Code, recorder.Body.String())
				}
				assertChatsJSONHeaders(t, recorder)
				if status := decodeChatsStatus(t, recorder); status != "unauthenticated" {
					t.Fatalf("%s: status = %q, se esperaba unauthenticated", path, status)
				}
				if strings.Contains(recorder.Body.String(), "th-1") {
					t.Fatalf("%s: una petición no autenticada no debe ver el snapshot", path)
				}
			}
		})
	}

	t.Run("sin manejador de sesión", func(t *testing.T) {
		withoutSessions := &OperationsAPI{File: file}
		recorder := chatsDo(
			withoutSessions, http.MethodGet, operationsChatsPath,
			&http.Cookie{Name: CookieName, Value: "cualquiera"},
		)
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, se esperaba 401 (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		assertChatsJSONHeaders(t, recorder)
	})
}

func TestOperationsChatsAPIRejectsNonGET(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "chat_threads_v1.json")
	writeChatsFile(t, file, `[]`)
	api, cookie, _ := newOperationsChatsTestAPI(t, file)

	for _, path := range []string{operationsChatsPath, mobileOperationsChatsPath} {
		for _, method := range []string{
			http.MethodPost, http.MethodPut, http.MethodPatch,
			http.MethodDelete, http.MethodHead, http.MethodOptions,
		} {
			recorder := chatsDo(api, method, path, cookie)
			if recorder.Code != http.StatusMethodNotAllowed {
				t.Fatalf("%s %s: status = %d, se esperaba 405 (cuerpo %q)",
					method, path, recorder.Code, recorder.Body.String())
			}
			if got := recorder.Header().Get("Allow"); got != http.MethodGet {
				t.Fatalf("%s %s: Allow = %q, se esperaba GET", method, path, got)
			}
			assertChatsJSONHeaders(t, recorder)
			if status := decodeChatsStatus(t, recorder); status != "method_not_allowed" {
				t.Fatalf("%s %s: status = %q", method, path, status)
			}
		}
	}
}

func TestOperationsChatsAPIRejectsUnknownRoutes(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "chat_threads_v1.json")
	writeChatsFile(t, file, `[]`)
	api, cookie, _ := newOperationsChatsTestAPI(t, file)

	for _, target := range []string{
		"/api/operations", "/api/operations/", "/api/operations/chats/",
		"/api/operations/chats/th-1", "/api/operations/messages",
		"/api/mobile/operations", "/api/mobile/operations/",
		"/api/mobile/operations/chats/", "/api/mobile/operations/chats/th-1",
		"/api/mobile/operations/chats/../chats", "/api/session",
	} {
		recorder := chatsDo(api, http.MethodGet, target, cookie)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s: status = %d, se esperaba 404 (cuerpo %q)",
				target, recorder.Code, recorder.Body.String())
		}
		assertChatsJSONHeaders(t, recorder)
		if status := decodeChatsStatus(t, recorder); status != "not_found" {
			t.Fatalf("%s: status = %q", target, status)
		}
	}

	// La ruta se resuelve antes que el método: una ruta desconocida es 404.
	recorder := chatsDo(api, http.MethodPost, "/api/operations/messages", cookie)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("POST desconocido: status = %d, se esperaba 404", recorder.Code)
	}

	// La query no altera la ruta servida.
	for _, path := range []string{operationsChatsPath, mobileOperationsChatsPath} {
		recorder = chatsDo(api, http.MethodGet, path+"?limit=5&x=1", cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s con query: status = %d (cuerpo %q)",
				path, recorder.Code, recorder.Body.String())
		}
	}
}
