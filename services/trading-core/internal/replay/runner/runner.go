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

// StepRecord es el resultado detallado y persistible de un paso.
type StepRecord struct {
	CaseID         string
	Step           int
	Source         string
	ActualJSON     string
	ActualDigest   string
	ExpectedJSON   string
	ExpectedDigest string
	Matched        bool
}

// DetailedReport resume la ejecución e incluye cada paso comparado.
type DetailedReport struct {
	Cases    int
	Steps    int
	Matched  int
	Records  []StepRecord
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
	report := Report{}
	if err := runLoaded(loaded, reportRecorder{report: &report}); err != nil {
		return report, err
	}
	return report, nil
}

// RunCorpusDetailed carga y ejecuta el corpus registrando cada paso.
func RunCorpusDetailed(dir string) (DetailedReport, error) {
	loaded, err := corpus.Load(dir)
	if err != nil {
		return DetailedReport{}, err
	}
	return RunLoadedDetailed(loaded)
}

// RunLoadedDetailed ejecuta un corpus ya cargado registrando cada paso.
func RunLoadedDetailed(loaded *corpus.Corpus) (DetailedReport, error) {
	report := DetailedReport{}
	if err := runLoaded(loaded, &detailedRecorder{report: &report}); err != nil {
		return report, err
	}
	return report, nil
}

// recorder recibe la comparación de cada paso. Un error aborta la ejecución.
type recorder interface {
	startCase()
	record(caseID string, index int, expected corpus.Decision, result, upstream any, digest string) error
}

type reportRecorder struct {
	report *Report
}

func (recorder reportRecorder) startCase() {
	recorder.report.Cases++
}

func (recorder reportRecorder) record(caseID string, index int, expected corpus.Decision, result, upstream any, digest string) error {
	return compare(caseID, index, expected, result, upstream, digest, recorder.report)
}

type detailedRecorder struct {
	report *DetailedReport
}

func (recorder *detailedRecorder) startCase() {
	recorder.report.Cases++
}

func (recorder *detailedRecorder) record(caseID string, index int, expected corpus.Decision, result, upstream any, digest string) error {
	expectedJSON, actualJSON, err := canonicalStep(expected, result, upstream, digest)
	if err != nil {
		return err
	}
	resultMatched := jsonEqual(expected.Result, result)
	upstreamMatched := jsonEqual(expected.Upstream, upstream)
	digestMatched := expected.StateDigest == digest
	matched := resultMatched && upstreamMatched && digestMatched

	recorder.report.Steps++
	if matched {
		recorder.report.Matched++
	} else {
		if !resultMatched {
			recorder.report.Failures = append(recorder.report.Failures, fmt.Sprintf("%s paso %d resultado", caseID, index+1))
		}
		if !upstreamMatched {
			recorder.report.Failures = append(recorder.report.Failures, fmt.Sprintf("%s paso %d upstream", caseID, index+1))
		}
		if !digestMatched {
			recorder.report.Failures = append(recorder.report.Failures, fmt.Sprintf("%s paso %d digest", caseID, index+1))
		}
	}
	recorder.report.Records = append(recorder.report.Records, StepRecord{
		CaseID:         caseID,
		Step:           index + 1,
		Source:         caseSource(caseID),
		ActualJSON:     actualJSON,
		ActualDigest:   digest,
		ExpectedJSON:   expectedJSON,
		ExpectedDigest: expected.StateDigest,
		Matched:        matched,
	})
	return nil
}

func runLoaded(loaded *corpus.Corpus, sink recorder) error {
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
		return err
	}
	start = defaults.Session.Clock.Start

	for _, replayCase := range loaded.Scenarios.Cases {
		expected := decisions[replayCase.CaseID]
		if len(expected) == 0 {
			return fmt.Errorf("sin decisiones para %s", replayCase.CaseID)
		}
		sink.startCase()
		if strings.HasPrefix(replayCase.CaseID, "replay/market-ingest/") {
			if err := runMarketRecord(replayCase, expected, loaded.Events, sink); err != nil {
				return err
			}
		} else {
			if err := runMoneyRecord(replayCase, expected, start, sink); err != nil {
				return err
			}
		}
	}
	return nil
}

func runMarketRecord(replayCase corpus.Case, expected []corpus.Decision, events []corpus.Event, sink recorder) error {
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
		if err := sink.record(replayCase.CaseID, index, expected[index], result, upstream, digest); err != nil {
			return err
		}
	}
	return nil
}

func runMoneyRecord(replayCase corpus.Case, expected []corpus.Decision, start int64, sink recorder) error {
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
		if err := sink.record(replayCase.CaseID, index, expected[index], result, upstream, digest); err != nil {
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

// stepPayload fija el orden y el conjunto exacto de campos canónicos.
type stepPayload struct {
	Result      any    `json:"result"`
	Upstream    any    `json:"upstream"`
	StateDigest string `json:"stateDigest"`
}

func canonicalStep(expected corpus.Decision, result, upstream any, digest string) (string, string, error) {
	expectedResult, err := normalizeRawJSON(expected.Result)
	if err != nil {
		return "", "", fmt.Errorf("result esperado: %w", err)
	}
	expectedUpstream, err := normalizeRawJSON(expected.Upstream)
	if err != nil {
		return "", "", fmt.Errorf("upstream esperado: %w", err)
	}
	actualResult, err := normalizeValue(result)
	if err != nil {
		return "", "", fmt.Errorf("result actual: %w", err)
	}
	actualUpstream, err := normalizeValue(upstream)
	if err != nil {
		return "", "", fmt.Errorf("upstream actual: %w", err)
	}
	expectedBytes, err := json.Marshal(stepPayload{
		Result:      expectedResult,
		Upstream:    expectedUpstream,
		StateDigest: expected.StateDigest,
	})
	if err != nil {
		return "", "", err
	}
	actualBytes, err := json.Marshal(stepPayload{
		Result:      actualResult,
		Upstream:    actualUpstream,
		StateDigest: digest,
	})
	if err != nil {
		return "", "", err
	}
	return string(expectedBytes), string(actualBytes), nil
}

// normalizeRawJSON convierte JSON en valores Go normales para que mapas y
// structs se serialicen con el mismo orden de claves. Los números se tratan
// como float64, igual que en jsonEqual.
func normalizeRawJSON(raw json.RawMessage) (any, error) {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return normalizeValue(value)
}

func normalizeValue(value any) (any, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var normalized any
	if err := json.Unmarshal(encoded, &normalized); err != nil {
		return nil, err
	}
	return normalized, nil
}

func caseSource(caseID string) string {
	if strings.HasPrefix(caseID, "replay/market-ingest/") {
		return "marketsession"
	}
	return "moneycore"
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
