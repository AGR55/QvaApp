package moneycore

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/AGR55/QvaApp/services/trading-core/internal/replay/corpus"
)

func TestMoneyCoreParity(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "..", "..", "parity", "fixtures", "replay", "2026-11-12")
	loaded, err := corpus.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	var defaults struct {
		Session struct {
			Clock struct {
				Start int64 `json:"start"`
			} `json:"clock"`
		} `json:"session"`
	}
	if err := json.Unmarshal(loaded.Scenarios.Defaults, &defaults); err != nil {
		t.Fatal(err)
	}
	for _, replayCase := range loaded.Scenarios.Cases[1:] {
		decisions := make([]corpus.Decision, 0)
		for _, decision := range loaded.Decisions {
			if decision.CaseID == replayCase.CaseID && decision.Op != "trading.final" {
				decisions = append(decisions, decision)
			}
		}
		session := New(defaults.Session.Clock.Start)
		index := 0
		for _, step := range replayCase.Steps {
			var input map[string]any
			if err := json.Unmarshal(step.Input, &input); err != nil {
				t.Fatal(err)
			}
			var result map[string]any
			var upstream []map[string]any
			var digest string
			switch step.Op {
			case "trading.decide":
				result, upstream, digest, err = session.Decide(input)
			case "trading.reconcile":
				result, upstream, digest, err = session.Reconcile(input)
			case "trading.state":
				result = session.State()
				upstream = []map[string]any{}
				digest = session.Digest()
			default:
				t.Fatalf("%s: operación inesperada %s", replayCase.CaseID, step.Op)
			}
			if err != nil {
				t.Fatalf("%s paso %d: %v", replayCase.CaseID, index+1, err)
			}
			expected := decisions[index]
			if !jsonEqual(t, expected.Result, result) {
				actual, _ := json.Marshal(result)
				t.Fatalf("%s paso %d resultado:\nesperado=%s\nreal=%s", replayCase.CaseID, index+1, expected.Result, actual)
			}
			if !jsonEqual(t, expected.Upstream, upstream) {
				actual, _ := json.Marshal(upstream)
				t.Fatalf("%s paso %d upstream:\nesperado=%s\nreal=%s", replayCase.CaseID, index+1, expected.Upstream, actual)
			}
			if digest != expected.StateDigest {
				t.Fatalf("%s paso %d digest: %s != %s", replayCase.CaseID, index+1, digest, expected.StateDigest)
			}
			index++
		}
	}
}

func jsonEqual(t *testing.T, expectedRaw json.RawMessage, actual any) bool {
	t.Helper()
	var expected any
	if err := json.Unmarshal(expectedRaw, &expected); err != nil {
		t.Fatal(err)
	}
	expectedBytes, _ := json.Marshal(expected)
	actualBytes, err := json.Marshal(actual)
	if err != nil {
		t.Fatal(err)
	}
	var normalized any
	if err := json.Unmarshal(actualBytes, &normalized); err != nil {
		t.Fatal(err)
	}
	actualNormalized, _ := json.Marshal(normalized)
	return string(expectedBytes) == string(actualNormalized)
}
