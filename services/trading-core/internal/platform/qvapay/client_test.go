package qvapay

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type recordedRequest struct {
	method string
	path   string
	query  string
	auth   string
}

func TestClientReadEndpoints(t *testing.T) {
	var mu sync.Mutex
	seen := make([]recordedRequest, 0, 6)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, recordedRequest{
			method: r.Method,
			path:   r.URL.EscapedPath(),
			query:  r.URL.RawQuery,
			auth:   r.Header.Get("Authorization"),
		})
		mu.Unlock()

		if r.Method != http.MethodGet {
			t.Errorf("método inesperado: %s", r.Method)
		}
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("Authorization inesperado: %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")

		switch r.URL.Path {
		case "/user":
			io.WriteString(w, `{"uuid":"user-1","username":"alice","name":"Alice","balance":"12.3400"}`)
		case "/p2p":
			query := r.URL.Query()
			if query.Get("coin") != "QUSD" || query.Get("type") != "sell" || query.Get("page") != "2" {
				t.Errorf("query P2P inesperada: %s", r.URL.RawQuery)
			}
			io.WriteString(w, `{"data":[{"uuid":"offer-1","type":"sell","coin":"QUSD",`+
				`"amount":"100.5000","receive":110.0,"rate":"1.0950","status":"open",`+
				`"available_amount":"100.5000","reserved_amount":0,`+
				`"User":{"uuid":"peer-1"},"Peer":null}],"total":1,"current_page":2}`)
		case "/p2p/offer-1":
			io.WriteString(w, `{"p2p":{"uuid":"offer-1","type":"sell","coin":"QUSD",`+
				`"amount":50,"receive":"55.5","rate":"1.11","status":"open",`+
				`"available_amount":null,"reserved_amount":"0",`+
				`"User":{"uuid":"peer-1"},"Peer":{"uuid":"peer-2"}}}`)
		case "/p2p/averages":
			io.WriteString(w, `{"QUSD":{"average":"1.01","average_buy":1.02,`+
				`"average_sell":"1.03","median_buy":"1.00","median_sell":1.04,`+
				`"count":"7","updated_at":"2026-11-13T00:00:00Z","extra":"ignored"}}`)
		case "/transaction":
			query := r.URL.Query()
			if query.Get("take") != "20" || query.Get("page") != "1" ||
				query.Get("status") != "paid" || query.Get("order") != "desc" ||
				query.Get("include_total") != "true" {
				t.Errorf("query de transacciones inesperada: %s", r.URL.RawQuery)
			}
			io.WriteString(w, `{"transactions":[{"uuid":"tx-1","amount":"10.25",`+
				`"status":"paid","description":"venta","created_at":"2026-11-13T00:00:00Z",`+
				`"User":{"uuid":"user-1"},"P2P":{"uuid":"p2p-1","coin":"QUSD"}}],"total":"2"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	client, err := New(server.URL+"/", "test-token")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx := context.Background()

	user, err := client.User(ctx)
	if err != nil {
		t.Fatalf("User: %v", err)
	}
	if user.UUID != "user-1" || user.Username != "alice" {
		t.Fatalf("usuario inesperado: %+v", user)
	}
	if got := user.Balance.Format(4); got != "12.3400" {
		t.Fatalf("balance inesperado: %s", got)
	}

	offers, err := client.Offers(ctx, url.Values{
		"coin": []string{"QUSD"},
		"type": []string{"sell"},
		"page": []string{"2"},
	})
	if err != nil {
		t.Fatalf("Offers: %v", err)
	}
	if len(offers) != 1 {
		t.Fatalf("ofertas inesperadas: %d", len(offers))
	}
	offer := offers[0]
	if offer.UUID != "offer-1" || offer.Type != "sell" || offer.Coin != "QUSD" || offer.Status != "open" {
		t.Fatalf("oferta inesperada: %+v", offer)
	}
	if got := offer.Amount.Format(4); got != "100.5000" {
		t.Fatalf("amount inesperado: %s", got)
	}
	if got := offer.Receive.Format(2); got != "110.00" {
		t.Fatalf("receive inesperado: %s", got)
	}
	if got := offer.Rate.Format(4); got != "1.0950" {
		t.Fatalf("rate inesperado: %s", got)
	}
	if got := offer.AvailableAmount.Format(4); got != "100.5000" {
		t.Fatalf("available_amount inesperado: %s", got)
	}
	if got := offer.ReservedAmount.Format(2); got != "0.00" {
		t.Fatalf("reserved_amount inesperado: %s", got)
	}
	if len(offer.User) == 0 || !strings.Contains(string(offer.User), "peer-1") {
		t.Fatalf("User crudo inesperado: %s", offer.User)
	}

	single, err := client.Offer(ctx, "offer-1")
	if err != nil {
		t.Fatalf("Offer: %v", err)
	}
	if single.UUID != "offer-1" || single.Peer == nil {
		t.Fatalf("oferta individual inesperada: %+v", single)
	}
	if got := single.Receive.Format(1); got != "55.5" {
		t.Fatalf("receive individual inesperado: %s", got)
	}
	if got := single.Rate.Format(2); got != "1.11" {
		t.Fatalf("rate individual inesperado: %s", got)
	}

	averages, err := client.Averages(ctx)
	if err != nil {
		t.Fatalf("Averages: %v", err)
	}
	qusd, ok := averages["QUSD"]
	if !ok {
		t.Fatalf("falta el promedio QUSD: %+v", averages)
	}
	if got := qusd.Average.Format(2); got != "1.01" {
		t.Fatalf("average inesperado: %s", got)
	}
	if got := qusd.AverageBuy.Format(2); got != "1.02" {
		t.Fatalf("average_buy inesperado: %s", got)
	}
	if qusd.Count != 7 || qusd.UpdatedAt != "2026-11-13T00:00:00Z" {
		t.Fatalf("promedio inesperado: %+v", qusd)
	}

	page, err := client.Transactions(ctx, 1, 20)
	if err != nil {
		t.Fatalf("Transactions: %v", err)
	}
	if len(page.Transactions) != 1 {
		t.Fatalf("transacciones inesperadas: %d", len(page.Transactions))
	}
	if page.Total == nil || *page.Total != 2 {
		t.Fatalf("total inesperado: %+v", page.Total)
	}
	transaction := page.Transactions[0]
	if transaction.UUID != "tx-1" || transaction.Status != "paid" {
		t.Fatalf("transacción inesperada: %+v", transaction)
	}
	if got := transaction.Amount.Format(2); got != "10.25" {
		t.Fatalf("importe inesperado: %s", got)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 5 {
		t.Fatalf("peticiones inesperadas: %d (%+v)", len(seen), seen)
	}
	wantQueries := map[string]string{
		"/user":         "",
		"/p2p":          "coin=QUSD&page=2&type=sell",
		"/p2p/offer-1":  "",
		"/p2p/averages": "",
		"/transaction":  "include_total=true&order=desc&page=1&status=paid&take=20",
	}
	for _, request := range seen {
		if request.method != http.MethodGet {
			t.Errorf("%s usó %s", request.path, request.method)
		}
		if request.auth != "Bearer test-token" {
			t.Errorf("%s sin Authorization correcto: %q", request.path, request.auth)
		}
		want, ok := wantQueries[request.path]
		if !ok {
			t.Errorf("ruta inesperada: %s", request.path)
			continue
		}
		if request.query != want {
			t.Errorf("%s query=%q, se esperaba %q", request.path, request.query, want)
		}
	}
}

func TestOffersAcceptsLegacyEnvelope(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/p2p" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"data":{},"offers":[{"uuid":"legacy-1","type":"buy",`+
			`"coin":"QUSD","amount":1,"receive":2,"rate":2,"status":"open"}]}`)
	}))
	t.Cleanup(server.Close)

	client, err := New(server.URL, "test-token")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	offers, err := client.Offers(context.Background(), nil)
	if err != nil {
		t.Fatalf("Offers: %v", err)
	}
	if len(offers) != 1 || offers[0].UUID != "legacy-1" {
		t.Fatalf("ofertas legacy inesperadas: %+v", offers)
	}
}

func TestAPIError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/user":
			w.WriteHeader(http.StatusUnauthorized)
			io.WriteString(w, `{"error":"no autorizado"}`)
		case "/p2p":
			w.Header().Set("Retry-After", "3")
			w.WriteHeader(http.StatusTooManyRequests)
			io.WriteString(w, strings.Repeat("x", 600))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	client, err := New(server.URL, "test-token")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx := context.Background()

	_, err = client.User(ctx)
	if err == nil {
		t.Fatal("se esperaba error 401")
	}
	var unauthorized *APIError
	if !errors.As(err, &unauthorized) {
		t.Fatalf("error no tipado: %T %v", err, err)
	}
	if unauthorized.Status != http.StatusUnauthorized {
		t.Fatalf("status inesperado: %d", unauthorized.Status)
	}
	if unauthorized.Body != `{"error":"no autorizado"}` {
		t.Fatalf("cuerpo inesperado: %q", unauthorized.Body)
	}

	_, err = client.Offers(ctx, nil)
	if err == nil {
		t.Fatal("se esperaba error 429")
	}
	var rateLimited *APIError
	if !errors.As(err, &rateLimited) {
		t.Fatalf("error no tipado: %T %v", err, err)
	}
	if rateLimited.Status != http.StatusTooManyRequests {
		t.Fatalf("status inesperado: %d", rateLimited.Status)
	}
	if rateLimited.RetryAfter != 3*time.Second {
		t.Fatalf("RetryAfter inesperado: %v", rateLimited.RetryAfter)
	}
	if len(rateLimited.Body) != 512 {
		t.Fatalf("cuerpo sin truncar: %d bytes", len(rateLimited.Body))
	}
}

func TestInvalidJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"uuid":"user-1",`)
	}))
	t.Cleanup(server.Close)

	client, err := New(server.URL, "test-token")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_, err = client.User(context.Background())
	if err == nil {
		t.Fatal("se esperaba error de JSON inválido")
	}
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		t.Fatalf("el JSON inválido no debe ser APIError: %v", err)
	}
	if !strings.Contains(err.Error(), "JSON") {
		t.Fatalf("error inesperado: %v", err)
	}
}

func TestResponseTooLarge(t *testing.T) {
	chunk := strings.Repeat("x", 64<<10)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		remaining := MaxResponseBytes + 1
		for remaining > 0 {
			size := int64(len(chunk))
			if size > remaining {
				size = remaining
			}
			if _, err := io.WriteString(w, chunk[:int(size)]); err != nil {
				return
			}
			remaining -= size
		}
	}))
	t.Cleanup(server.Close)

	client, err := New(server.URL, "test-token")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_, err = client.User(context.Background())
	if err == nil {
		t.Fatal("se esperaba error por respuesta demasiado grande")
	}
	if !strings.Contains(err.Error(), "demasiado grande") {
		t.Fatalf("error inesperado: %v", err)
	}
}

func TestTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	t.Cleanup(server.Close)

	client, err := New(server.URL, "test-token")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	client.HTTP = &http.Client{Timeout: 40 * time.Millisecond}

	_, err = client.User(context.Background())
	if err == nil {
		t.Fatal("se esperaba timeout")
	}
	var connectionErr *ConnectionError
	if !errors.As(err, &connectionErr) {
		t.Fatalf("error no tipado: %T %v", err, err)
	}
	if connectionErr.Reason != "timeout" {
		t.Fatalf("reason inesperado: %q", connectionErr.Reason)
	}
}

func TestNetworkError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	baseURL := server.URL
	server.Close()

	client, err := New(baseURL, "test-token")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_, err = client.User(context.Background())
	if err == nil {
		t.Fatal("se esperaba error de red")
	}
	var connectionErr *ConnectionError
	if !errors.As(err, &connectionErr) {
		t.Fatalf("error no tipado: %T %v", err, err)
	}
	if connectionErr.Reason != "network" {
		t.Fatalf("reason inesperado: %q", connectionErr.Reason)
	}
}

func TestInvalidPaginationDoesNotDispatch(t *testing.T) {
	var hits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
	}))
	t.Cleanup(server.Close)

	client, err := New(server.URL, "test-token")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx := context.Background()
	cases := []struct{ page, take int }{
		{page: 0, take: 1},
		{page: 1, take: 0},
		{page: 1, take: 31},
		{page: -1, take: 10},
	}
	for _, testCase := range cases {
		if _, err := client.Transactions(ctx, testCase.page, testCase.take); err == nil {
			t.Fatalf("paginación %+v debería fallar", testCase)
		}
	}
	if got := atomic.LoadInt32(&hits); got != 0 {
		t.Fatalf("se enviaron %d peticiones con paginación inválida", got)
	}
}

func TestUserBalance(t *testing.T) {
	cases := []struct {
		name      string
		body      string
		wantError bool
		want      string
	}{
		{name: "string", body: `{"uuid":"u","balance":"3.50"}`, want: "3.50"},
		{name: "number", body: `{"uuid":"u","balance":4}`, want: "4.00"},
		{name: "nested", body: `{"uuid":"u","data":{"balance":"5.25"}}`, want: "5.25"},
		{name: "available", body: `{"uuid":"u","balance":null,"available":"6.75"}`, want: "6.75"},
		{name: "missing", body: `{"uuid":"u"}`, wantError: true},
		{name: "invalid", body: `{"uuid":"u","balance":"abc"}`, wantError: true},
		{name: "negative", body: `{"uuid":"u","balance":-1}`, wantError: true},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				io.WriteString(w, testCase.body)
			}))
			t.Cleanup(server.Close)

			client, err := New(server.URL, "test-token")
			if err != nil {
				t.Fatalf("New: %v", err)
			}
			user, err := client.User(context.Background())
			if testCase.wantError {
				if err == nil {
					t.Fatalf("se esperaba error: %+v", user)
				}
				return
			}
			if err != nil {
				t.Fatalf("User: %v", err)
			}
			if got := user.Balance.Format(2); got != testCase.want {
				t.Fatalf("balance=%s, se esperaba %s", got, testCase.want)
			}
		})
	}
}

func TestInternalGetRejectsNonReadPaths(t *testing.T) {
	var hits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
	}))
	t.Cleanup(server.Close)

	client, err := New(server.URL, "test-token")
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	paths := []string{
		"/p2p/create",
		"/p2p/offer-1/apply",
		"/p2p/offer-1/cancel",
		"/p2p/offer-1/edit",
		"/transaction/1",
		"/user/1",
		"/p2p/",
		"/p2p/../user",
		"/p2p/a%2Fb",
	}
	for _, path := range paths {
		var out any
		if err := client.get(context.Background(), path, nil, &out); err == nil {
			t.Errorf("se aceptó ruta no permitida %q", path)
		}
	}
	if got := atomic.LoadInt32(&hits); got != 0 {
		t.Fatalf("se enviaron %d peticiones a rutas no permitidas", got)
	}
}

func TestNoMutationMethods(t *testing.T) {
	clientType := reflect.TypeOf((*Client)(nil))
	want := map[string]bool{
		"Averages":     true,
		"Offer":        true,
		"Offers":       true,
		"Transactions": true,
		"User":         true,
	}
	got := make(map[string]bool, clientType.NumMethod())
	for index := 0; index < clientType.NumMethod(); index++ {
		got[clientType.Method(index).Name] = true
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("API exportada inesperada: %v", got)
	}
}

func TestRedirectToAnotherHostIsRejected(t *testing.T) {
	var targetHits int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&targetHits, 1)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"uuid":"target","balance":"1"}`)
	}))
	t.Cleanup(target.Close)

	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+r.URL.Path, http.StatusFound)
	}))
	t.Cleanup(source.Close)

	client, err := New(source.URL, "test-token")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := client.User(context.Background()); err == nil {
		t.Fatal("se esperaba rechazo de redirección a otro host")
	}
	if got := atomic.LoadInt32(&targetHits); got != 0 {
		t.Fatalf("el host de destino recibió %d peticiones", got)
	}
}

func TestNewValidatesBaseURL(t *testing.T) {
	valid := []string{
		"http://127.0.0.1:8080",
		"http://127.0.0.1:8080/",
		"https://api.qvapay.com",
		"https://api.qvapay.com/",
		"https://api.qvapay.com/api/",
	}
	for _, raw := range valid {
		client, err := New(raw, "token")
		if err != nil {
			t.Errorf("New(%q): %v", raw, err)
			continue
		}
		if strings.HasSuffix(client.BaseURL, "/") {
			t.Errorf("BaseURL conserva / final: %q", client.BaseURL)
		}
	}

	invalid := []string{
		"",
		"api.qvapay.com",
		"ftp://api.qvapay.com",
		"http:///sin-host",
		"https://user:pass@api.qvapay.com",
		"https://api.qvapay.com/?x=1",
		"https://api.qvapay.com/#fragment",
	}
	for _, raw := range invalid {
		if _, err := New(raw, "token"); err == nil {
			t.Errorf("New(%q) debería fallar", raw)
		}
	}
}

func TestDecimalFrom(t *testing.T) {
	valid := []struct {
		name  string
		value any
		want  string
	}{
		{name: "json.Number", value: json.Number("1.25"), want: "1.25"},
		{name: "float64", value: 2.5, want: "2.50"},
		{name: "string", value: "3.75", want: "3.75"},
	}
	for _, testCase := range valid {
		t.Run(testCase.name, func(t *testing.T) {
			value, err := decimalFrom(testCase.value)
			if err != nil {
				t.Fatalf("decimalFrom: %v", err)
			}
			if got := value.Format(2); got != testCase.want {
				t.Fatalf("decimal=%s, se esperaba %s", got, testCase.want)
			}
		})
	}

	invalid := []any{nil, "", "abc", true, math.NaN(), math.Inf(1), math.Inf(-1)}
	for _, value := range invalid {
		if _, err := decimalFrom(value); err == nil {
			t.Errorf("decimalFrom(%v) debería fallar", value)
		}
	}
}
