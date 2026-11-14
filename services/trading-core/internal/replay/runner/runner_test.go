package runner

import (
	"path/filepath"
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
