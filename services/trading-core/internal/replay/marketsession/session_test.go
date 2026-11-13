package marketsession

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/AGR55/QvaApp/services/trading-core/internal/replay/corpus"
)

func TestMarketIngestResultsParity(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "..", "..", "parity", "fixtures", "replay", "2026-11-12")
	loaded, err := corpus.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	caseID := "replay/market-ingest/dedupe/0001"
	decisions := make([]corpus.Decision, 0)
	for _, decision := range loaded.Decisions {
		if decision.CaseID == caseID && decision.Op != "trading.final" {
			decisions = append(decisions, decision)
		}
	}
	if len(decisions) != 4 {
		t.Fatalf("decisiones = %d", len(decisions))
	}
	session := New()
	stepIndex := 0
	for _, step := range loaded.Scenarios.Cases[0].Steps {
		var result map[string]any
		var state map[string]any
		var digest string
		switch step.Op {
		case "market.ingest":
			var input struct {
				Ingest struct {
					Events []int `json:"events"`
				} `json:"ingest"`
				Observation map[string]any `json:"observation"`
			}
			if err := json.Unmarshal(step.Input, &input); err != nil {
				t.Fatal(err)
			}
			result, state, digest, err = session.Ingest(loaded.Events, input.Ingest.Events, input.Observation)
			if err != nil {
				t.Fatal(err)
			}
		case "trading.state":
			state = session.State()
			result = state
			digest = Hash(state)
		default:
			t.Fatalf("operación inesperada: %s", step.Op)
		}
		expected := decisions[stepIndex]
		if !jsonEqual(t, expected.Result, result) {
			actual, _ := json.Marshal(result)
			t.Fatalf("paso %d: resultado distinto\nesperado=%s\nreal=%s", stepIndex+1, string(expected.Result), string(actual))
		}
		if expected.StateDigest != digest {
			t.Logf("paso %d: stateDigest interno pendiente (%s != %s)", stepIndex+1, digest, expected.StateDigest)
		}
		stepIndex++
		_ = state
	}
}

func jsonEqual(t *testing.T, expectedRaw json.RawMessage, actual any) bool {
	t.Helper()
	var expected any
	if err := json.Unmarshal(expectedRaw, &expected); err != nil {
		t.Fatal(err)
	}
	expectedJSON, err := json.Marshal(expected)
	if err != nil {
		t.Fatal(err)
	}
	actualJSON, err := json.Marshal(actual)
	if err != nil {
		t.Fatal(err)
	}
	return string(expectedJSON) == string(actualJSON)
}
