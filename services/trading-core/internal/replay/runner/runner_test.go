package runner

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func TestFullCorpus(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "..", "..", "parity", "fixtures", "replay", "2026-11-12")
	report, err := RunCorpus(dir)
	if err != nil {
		t.Fatal(err)
	}
	if report.Cases != 4 || report.Steps != 14 || report.Matched != 14 {
		t.Fatalf("reporte inesperado: %+v", report)
	}
}

func TestDetailedCorpus(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "..", "..", "parity", "fixtures", "replay", "2026-11-12")
	report, err := RunCorpusDetailed(dir)
	if err != nil {
		t.Fatal(err)
	}
	if report.Cases != 4 || report.Steps != 14 || report.Matched != 14 {
		t.Fatalf("reporte inesperado: %+v", report)
	}
	if len(report.Records) != 14 {
		t.Fatalf("records = %d, quiero 14", len(report.Records))
	}
	if len(report.Failures) != 0 {
		t.Fatalf("fallos inesperados: %v", report.Failures)
	}

	sources := map[string]int{}
	lastStep := map[string]int{}
	for _, record := range report.Records {
		if record.CaseID == "" {
			t.Fatal("record sin caseId")
		}
		if record.Step != lastStep[record.CaseID]+1 {
			t.Fatalf("%s: paso %d no es consecutivo desde 1", record.CaseID, record.Step)
		}
		lastStep[record.CaseID] = record.Step
		if record.Source == "" {
			t.Fatalf("%s paso %d: source vacío", record.CaseID, record.Step)
		}
		sources[record.Source]++
		if !record.Matched {
			t.Fatalf("%s paso %d: no matched", record.CaseID, record.Step)
		}
		if record.ActualJSON == "" || record.ActualDigest == "" ||
			record.ExpectedJSON == "" || record.ExpectedDigest == "" {
			t.Fatalf("%s paso %d: JSON o digest vacío", record.CaseID, record.Step)
		}
		checkCanonicalStep(t, record.ActualJSON, record.ActualDigest)
		checkCanonicalStep(t, record.ExpectedJSON, record.ExpectedDigest)
	}
	if sources["marketsession"] != 4 || sources["moneycore"] != 10 {
		t.Fatalf("fuentes inesperadas: %v", sources)
	}
}

func checkCanonicalStep(t *testing.T, raw, digest string) {
	t.Helper()
	if !strings.HasPrefix(raw, `{"result":`) {
		t.Fatalf("JSON no canónico: %s", raw)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &fields); err != nil {
		t.Fatalf("JSON inválido: %v", err)
	}
	if len(fields) != 3 {
		t.Fatalf("campos inesperados: %s", raw)
	}
	var payload struct {
		StateDigest string `json:"stateDigest"`
	}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		t.Fatalf("JSON inválido: %v", err)
	}
	if payload.StateDigest != digest {
		t.Fatalf("digest embebido %q != %q", payload.StateDigest, digest)
	}
	for _, key := range []string{"result", "upstream", "stateDigest"} {
		if _, ok := fields[key]; !ok {
			t.Fatalf("falta el campo %s: %s", key, raw)
		}
	}
}
