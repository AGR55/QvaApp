package main

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDurableSpoolPersisteYCompacta(t *testing.T) {
	directory := t.TempDir()
	spool, err := openDurableSpool(directory)
	if err != nil {
		t.Fatal(err)
	}
	first := &pollResult{PolledAt: time.Now().Unix(), Source: "stream"}
	second := &pollResult{PolledAt: time.Now().Unix(), Source: "stream"}
	if err := spool.Append(first); err != nil {
		t.Fatal(err)
	}
	if err := spool.Append(second); err != nil {
		t.Fatal(err)
	}
	if first.SpoolID == "" || second.SpoolID == "" || first.SpoolID == second.SpoolID {
		t.Fatalf("ids = %q %q", first.SpoolID, second.SpoolID)
	}
	if pending := spool.Pending(); len(pending) != 2 {
		t.Fatalf("pending = %d", len(pending))
	}
	if err := spool.Acknowledge([]*pollResult{first}); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(filepath.Join(directory, "events.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	scanner := bufio.NewScanner(file)
	lines := 0
	for scanner.Scan() {
		if strings.TrimSpace(scanner.Text()) != "" {
			lines++
		}
	}
	file.Close()
	if lines != 1 {
		t.Fatalf("líneas tras compactar = %d", lines)
	}
	reopened, err := openDurableSpool(directory)
	if err != nil {
		t.Fatal(err)
	}
	if pending := reopened.Pending(); len(pending) != 1 || pending[0].SpoolID != second.SpoolID {
		t.Fatalf("pending reabierto = %+v", pending)
	}
}
