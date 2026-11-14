// Package corpus carga y valida el corpus de replay congelado de F0/F2.
package corpus

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Manifest es el manifiesto del corpus.
type Manifest struct {
	Schema string              `json:"schema"`
	Corpus string              `json:"corpus"`
	Counts Counts              `json:"counts"`
	Files  map[string]FileInfo `json:"files"`
}

// Counts son los totales declarados.
type Counts struct {
	Events    int `json:"events"`
	Scenarios int `json:"scenarios"`
	Steps     int `json:"steps"`
	Decisions int `json:"decisions"`
}

// FileInfo es la huella de un archivo.
type FileInfo struct {
	SHA256 string `json:"sha256"`
	Bytes  int    `json:"bytes"`
	Lines  int    `json:"lines"`
}

// Scenarios es el archivo de escenarios.
type Scenarios struct {
	Schema   string          `json:"schema"`
	Corpus   string          `json:"corpus"`
	Defaults json.RawMessage `json:"defaults"`
	Cases    []Case          `json:"cases"`
}

// Case es un escenario replay.
type Case struct {
	CaseID string `json:"caseId"`
	Source string `json:"source"`
	Steps  []Step `json:"steps"`
}

// Step es un paso de replay.
type Step struct {
	Op    string          `json:"op"`
	Input json.RawMessage `json:"input"`
}

// Event es un evento del feed.
type Event struct {
	Channel    string          `json:"channel"`
	DurableSeq int             `json:"durableSeq"`
	Event      string          `json:"event"`
	ReceivedAt int64           `json:"receivedAt"`
	Payload    json.RawMessage `json:"payload"`
}

// Decision es una línea de la traza canónica.
type Decision struct {
	CaseID      string          `json:"caseId"`
	Op          string          `json:"op"`
	Seq         json.RawMessage `json:"seq"`
	Result      json.RawMessage `json:"result"`
	Upstream    json.RawMessage `json:"upstream"`
	StateDigest string          `json:"stateDigest"`
}

// Corpus es el material cargado y validado.
type Corpus struct {
	Dir       string
	Manifest  Manifest
	Scenarios Scenarios
	Events    []Event
	Decisions []Decision
}

// Load lee y valida el corpus de un directorio.
func Load(dir string) (*Corpus, error) {
	manifestBytes, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return nil, err
	}
	var manifest Manifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		return nil, fmt.Errorf("manifest: %w", err)
	}
	if manifest.Schema != "qvaapply.replay-manifest/v1" {
		return nil, fmt.Errorf("schema de manifest inesperado: %s", manifest.Schema)
	}
	for name, info := range manifest.Files {
		path := filepath.Join(dir, name+".json")
		if name == "events" || name == "decisions" {
			path = filepath.Join(dir, name+".ndjson")
		}
		if err := verifyFile(path, info); err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
	}

	scenarioBytes, err := os.ReadFile(filepath.Join(dir, "scenarios.json"))
	if err != nil {
		return nil, err
	}
	var scenarios Scenarios
	if err := json.Unmarshal(scenarioBytes, &scenarios); err != nil {
		return nil, fmt.Errorf("scenarios: %w", err)
	}
	if scenarios.Schema != "qvaapply.replay-scenarios/v1" {
		return nil, fmt.Errorf("schema de escenarios inesperado: %s", scenarios.Schema)
	}
	steps := 0
	for _, item := range scenarios.Cases {
		steps += len(item.Steps)
	}
	if len(scenarios.Cases) != manifest.Counts.Scenarios || steps != manifest.Counts.Steps {
		return nil, fmt.Errorf(
			"conteos de escenarios no coinciden: manifest=%d/%d real=%d/%d",
			manifest.Counts.Scenarios, manifest.Counts.Steps, len(scenarios.Cases), steps,
		)
	}

	events, err := readEvents(filepath.Join(dir, "events.ndjson"))
	if err != nil {
		return nil, err
	}
	if len(events) != manifest.Counts.Events {
		return nil, fmt.Errorf("eventos: manifest=%d real=%d", manifest.Counts.Events, len(events))
	}
	decisions, err := readDecisions(filepath.Join(dir, "decisions.ndjson"))
	if err != nil {
		return nil, err
	}
	if len(decisions) != manifest.Counts.Decisions {
		return nil, fmt.Errorf("decisiones: manifest=%d real=%d", manifest.Counts.Decisions, len(decisions))
	}

	return &Corpus{
		Dir:       dir,
		Manifest:  manifest,
		Scenarios: scenarios,
		Events:    events,
		Decisions: decisions,
	}, nil
}

func verifyFile(path string, info FileInfo) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	if got := "sha256:" + hex.EncodeToString(sum[:]); got != info.SHA256 {
		return fmt.Errorf("sha256 distinto: %s != %s", got, info.SHA256)
	}
	if info.Bytes > 0 && len(data) != info.Bytes {
		return fmt.Errorf("bytes distintos: %d != %d", len(data), info.Bytes)
	}
	if info.Lines > 0 {
		lines := bytes.Count(data, []byte("\n"))
		if lines != info.Lines {
			return fmt.Errorf("líneas distintas: %d != %d", lines, info.Lines)
		}
	}
	return nil
}

func readEvents(path string) ([]Event, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	events := make([]Event, 0)
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var event Event
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			return nil, fmt.Errorf("evento: %w", err)
		}
		events = append(events, event)
	}
	return events, scanner.Err()
}

func readDecisions(path string) ([]Decision, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	decisions := make([]Decision, 0)
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var decision Decision
		if err := json.Unmarshal([]byte(line), &decision); err != nil {
			return nil, fmt.Errorf("decisión: %w", err)
		}
		decisions = append(decisions, decision)
	}
	return decisions, scanner.Err()
}
