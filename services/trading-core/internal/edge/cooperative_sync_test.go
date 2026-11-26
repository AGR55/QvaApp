package edge

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/AGR55/QvaApp/services/trading-core/internal/runtimeconfig"
)

type fakeCooperativeFiat struct {
	fiat float64
}

func (source fakeCooperativeFiat) Load(context.Context) (runtimeconfig.Config, int64, error) {
	return runtimeconfig.Config{Markets: []runtimeconfig.Market{{
		Code: "BANK_CUP", Active: true, FiatBalance: source.fiat,
	}}}, 1, nil
}

type fakeCooperativeSettings struct {
	values map[string][]byte
}

func (settings *fakeCooperativeSettings) GetSetting(_ context.Context, key string) ([]byte, bool, error) {
	value, ok := settings.values[key]
	return value, ok, nil
}

func (settings *fakeCooperativeSettings) PutSetting(_ context.Context, key string, value []byte, _ int64) error {
	settings.values[key] = append([]byte(nil), value...)
	return nil
}

type cooperativeTestServer struct {
	mu         sync.Mutex
	putBodies  []map[string]any
	deletes    []string
	remoteFiat float64
}

func (server *cooperativeTestServer) handler(t *testing.T) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/auth/login":
			writeCooperativeJSON(w, map[string]any{"api_key": "csk_test"})
		case r.URL.Path == "/hunts/sync":
			writeCooperativeJSON(w, map[string]any{"data": map[string]any{}})
		case r.URL.Path == "/hunts" && r.Method == http.MethodGet:
			server.mu.Lock()
			fiat := server.remoteFiat
			server.mu.Unlock()
			writeCooperativeJSON(w, map[string]any{"data": []any{map[string]any{
				"coin": "BANK_CUP", "fiat": fiat, "minimal": 5.0, "price": 1.0,
				"updated_at": "2026-11-26T12:00:00Z",
			}}})
		case r.URL.Path == "/hunts" && r.Method == http.MethodPost:
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			server.mu.Lock()
			server.putBodies = append(server.putBodies, body)
			server.remoteFiat = numberValue(body["fiat"])
			server.mu.Unlock()
			writeCooperativeJSON(w, map[string]any{"data": body})
		case strings.HasPrefix(r.URL.Path, "/hunts/") && r.Method == http.MethodDelete:
			server.mu.Lock()
			server.deletes = append(server.deletes, strings.TrimPrefix(r.URL.Path, "/hunts/"))
			server.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Logf("ruta inesperada %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	})
}

func writeCooperativeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func newCooperativeSyncTest(t *testing.T, fiat float64, baseline *float64) (*CooperativeSync, *cooperativeTestServer, *fakeCooperativeSettings) {
	t.Helper()
	server := &cooperativeTestServer{remoteFiat: 100}
	httpServer := httptest.NewServer(server.handler(t))
	t.Cleanup(httpServer.Close)
	settings := &fakeCooperativeSettings{values: map[string][]byte{}}
	if baseline != nil {
		encoded, _ := json.Marshal(*baseline)
		settings.values[cooperativeBaselinePrefix+"BANK_CUP"] = encoded
	}
	sync := NewCooperativeSync(httpServer.URL, "", "bot@example.com", "secret", true, nil)
	sync.Fiat = fakeCooperativeFiat{fiat: fiat}
	sync.Baselines = settings
	return sync, server, settings
}

func TestCooperativeSyncCapacityAplicaLasDeltasLocales(t *testing.T) {
	cases := []struct {
		name       string
		local      float64
		baseline   float64
		remote     float64
		wantPut    *float64
		wantDelete bool
	}{
		{"pago reduce capacidad", 80, 100, 100, floatPtr(80), false},
		{"cobro aumenta capacidad", 120, 100, 100, floatPtr(120), false},
		{"no restaura lo gastado por la red", 120, 100, 30, floatPtr(50), false},
		{"bajo el mínimo se retira", 3, 100, 100, nil, true},
		{"sin cambio no publica", 100, 100, 100, nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sync, server, settings := newCooperativeSyncTest(t, tc.local, &tc.baseline)
			server.remoteFiat = tc.remote
			if err := sync.SyncCapacity(context.Background()); err != nil {
				t.Fatal(err)
			}
			server.mu.Lock()
			puts, deletes := append([]map[string]any(nil), server.putBodies...), append([]string(nil), server.deletes...)
			server.mu.Unlock()
			if tc.wantPut != nil {
				if len(puts) != 1 {
					t.Fatalf("puts = %+v", puts)
				}
				got := numberValue(puts[0]["fiat"])
				if math.Abs(got-*tc.wantPut) > 0.001 {
					t.Fatalf("fiat publicado = %v, quiero %v", got, *tc.wantPut)
				}
			} else if len(puts) != 0 {
				t.Fatalf("no debía publicar: %+v", puts)
			}
			if tc.wantDelete && (len(deletes) != 1 || deletes[0] != "BANK_CUP") {
				t.Fatalf("deletes = %v", deletes)
			}
			var stored float64
			_ = json.Unmarshal(settings.values[cooperativeBaselinePrefix+"BANK_CUP"], &stored)
			if math.Abs(stored-tc.local) > 0.001 {
				t.Fatalf("baseline = %v, quiero %v", stored, tc.local)
			}
		})
	}
}

func TestCooperativeSyncCapacityInicializaBaselineSinPublicar(t *testing.T) {
	sync, server, settings := newCooperativeSyncTest(t, 80, nil)
	if err := sync.SyncCapacity(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(server.putBodies) != 0 || len(server.deletes) != 0 {
		t.Fatalf("primera observación no debe mutar: puts=%v deletes=%v", server.putBodies, server.deletes)
	}
	var stored float64
	_ = json.Unmarshal(settings.values[cooperativeBaselinePrefix+"BANK_CUP"], &stored)
	if stored != 80 {
		t.Fatalf("baseline inicial = %v", stored)
	}
}

func floatPtr(value float64) *float64 { return &value }
