package corpus

import (
	"path/filepath"
	"testing"
)

func TestLoadFrozenCorpus(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "..", "..", "parity", "fixtures", "replay", "2026-11-12")
	loaded, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Manifest.Counts.Events != 10 ||
		loaded.Manifest.Counts.Scenarios != 4 ||
		loaded.Manifest.Counts.Steps != 14 ||
		loaded.Manifest.Counts.Decisions != 18 {
		t.Fatalf("conteos inesperados: %+v", loaded.Manifest.Counts)
	}
	if len(loaded.Events) != 10 || len(loaded.Decisions) != 18 {
		t.Fatalf("eventos/decisiones = %d/%d", len(loaded.Events), len(loaded.Decisions))
	}
	if loaded.Scenarios.Cases[0].CaseID == "" {
		t.Fatal("caso sin id")
	}
}
