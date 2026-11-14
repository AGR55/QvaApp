// Package runner ejecuta el corpus replay completo de F2.
package runner

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/AGR55/QvaApp/services/trading-core/internal/replay/corpus"
	"github.com/AGR55/QvaApp/services/trading-core/internal/replay/marketsession"
	"github.com/AGR55/QvaApp/services/trading-core/internal/replay/moneycore"
)

// Report resume la ejecución.
type Report struct {
	Cases    int
	Steps    int
	Matched  int
	Failures []string
}

// RunCorpus carga y ejecuta el corpus.
func RunCorpus(dir string) (Report, error) {
	loaded, err := corpus.Load(dir)
	if err != nil {
		return Report{}, err
	}
	return RunLoaded(loaded)
}

// RunLoaded ejecuta un corpus ya cargado.
func RunLoaded(loaded *corpus.Corpus) (Report, error) {
	decisions := map[string][]corpus.Decision{}
	for _, decision := range loaded.Decisions {
		if decision.Op == "trading.final" {
			continue
		}
		decisions[decision.CaseID] = append(decisions[decision.CaseID], decision)
	}
	var start int64
	var defaults struct {
		Session struct {
			Clock struct {
				Start int64 `json:"start"`
			} `json:"clock"`
		} `json:"session"`
	}
	if err := json.Unmarshal(loaded.Scenarios.Defaults, &defaults); err != nil {
		return Report{}, err
	}
	start = defaults.Session.Clock.Start

	report := Report{}
	for _, replayCase := range loaded.Scenarios.Cases {
		expected := decisions[replayCase.CaseID]
		if len(expected) == 0 {
			return Report{}, fmt.Errorf("sin decisiones para %s", replayCase.CaseID)
		}
		report.Cases++
		if strings.HasPrefix(replayCase.CaseID, "replay/market-ingest/") {
			if err := runMarket(replayCase, expected, loaded.Events, &report); err != nil {
				return report, err
			}
		} else {
			if err := runMoney(replayCase, expected, start, &report); err != nil {
				return report, err
			}
		}
	}
	return report, nil
}

func runMarket(replayCase corpus.Case, expected []corpus.Decision, events []corpus.Event, report *Report) error {
	session := marketsession.New()
	for index, step := range replayCase.Steps {
		var result any
		var upstream any = []any{}
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
				return err
			}
			value, state, hash, err := session.Ingest(events, input.Ingest.Events, input.Observation)
			if err != nil {
				return err
			}
			result, digest = value, hash
			_ = state
		case "trading.state":
			result = session.State()
			digest = session.Digest()
		default:
			return fmt.Errorf("%s: operación desconocida %s", replayCase.CaseID, step.Op)
		}
		if err := compare(replayCase.CaseID, index, expected[index], result, upstream, digest, report); err != nil {
			return err
		}
	}
	return nil
}

func runMoney(replayCase corpus.Case, expected []corpus.Decision, start int64, report *Report) error {
	session := moneycore.New(start)
	for index, step := range replayCase.Steps {
		var input map[string]any
		if err := json.Unmarshal(step.Input, &input); err != nil {
			return err
		}
		var result map[string]any
		var upstream []map[string]any
		var digest string
		var err error
		switch step.Op {
		case "trading.decide":
			result, upstream, digest, err = session.Decide(input)
		case "trading.reconcile":
			result, upstream, digest, err = session.Reconcile(input)
		case "trading.state":
			result, upstream, digest = session.State(), []map[string]any{}, session.Digest()
		default:
			return fmt.Errorf("%s: operación desconocida %s", replayCase.CaseID, step.Op)
		}
		if err != nil {
			return err
		}
		if err := compare(replayCase.CaseID, index, expected[index], result, upstream, digest, report); err != nil {
			return err
		}
	}
	return nil
}

func compare(caseID string, index int, expected corpus.Decision, result, upstream any, digest string, report *Report) error {
	report.Steps++
	if !jsonEqual(expected.Result, result) {
		report.Failures = append(report.Failures, fmt.Sprintf("%s paso %d resultado", caseID, index+1))
		return fmt.Errorf("%s paso %d resultado distinto", caseID, index+1)
	}
	if !jsonEqual(expected.Upstream, upstream) {
		report.Failures = append(report.Failures, fmt.Sprintf("%s paso %d upstream", caseID, index+1))
		return fmt.Errorf("%s paso %d upstream distinto", caseID, index+1)
	}
	if expected.StateDigest != digest {
		report.Failures = append(report.Failures, fmt.Sprintf("%s paso %d digest", caseID, index+1))
		return fmt.Errorf("%s paso %d digest %s != %s", caseID, index+1, digest, expected.StateDigest)
	}
	report.Matched++
	return nil
}

func jsonEqual(expectedRaw json.RawMessage, actual any) bool {
	var expected any
	if err := json.Unmarshal(expectedRaw, &expected); err != nil {
		return false
	}
	expectedBytes, _ := json.Marshal(expected)
	actualBytes, err := json.Marshal(actual)
	if err != nil {
		return false
	}
	var normalized any
	if err := json.Unmarshal(actualBytes, &normalized); err != nil {
		return false
	}
	actualNormalized, _ := json.Marshal(normalized)
	return string(expectedBytes) == string(actualNormalized)
}
