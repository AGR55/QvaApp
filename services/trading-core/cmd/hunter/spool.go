package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type spoolRecord struct {
	ID     string     `json:"id"`
	Result pollResult `json:"result"`
}

// durableSpool journaliza los eventos antes de ponerlos en la cola de memoria.
// La ruta debe estar en un volumen persistente del contenedor.
const (
	spoolSyncEvery    = 32
	spoolSyncInterval = 50 * time.Millisecond
)

type durableSpool struct {
	mu       sync.Mutex
	path     string
	file     *os.File
	encoder  *json.Encoder
	seq      uint64
	records  []*pollResult
	unsynced int
	lastSync time.Time
}

func (spool *durableSpool) openAppend() error {
	file, err := os.OpenFile(spool.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("abrir journal SSE: %w", err)
	}
	spool.file = file
	spool.encoder = json.NewEncoder(file)
	return nil
}

func openDurableSpool(directory string) (*durableSpool, error) {
	directory = strings.TrimSpace(directory)
	if directory == "" {
		return nil, errors.New("HUNTER_SPOOL_DIR vacío")
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, fmt.Errorf("crear directorio spool: %w", err)
	}
	spool := &durableSpool{
		path: filepath.Join(directory, "events.jsonl"), lastSync: time.Now(),
	}
	file, err := os.OpenFile(spool.path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("abrir spool: %w", err)
	}
	reader := bufio.NewReaderSize(file, 64*1024)
	line := 0
	validBytes := int64(0)
	for {
		data, readErr := reader.ReadBytes('\n')
		if readErr == io.EOF {
			if len(data) > 0 {
				// Una caída durante Encode puede dejar solo el último registro
				// incompleto. Los anteriores ya están fsync'd y se conservan.
				if err := file.Truncate(validBytes); err != nil {
					_ = file.Close()
					return nil, fmt.Errorf("recuperar cola incompleta del spool: %w", err)
				}
				if err := file.Sync(); err != nil {
					_ = file.Close()
					return nil, fmt.Errorf("sincronizar recuperación del spool: %w", err)
				}
			}
			break
		}
		if readErr != nil {
			_ = file.Close()
			return nil, fmt.Errorf("leer spool: %w", readErr)
		}
		line++
		var record spoolRecord
		if err := json.Unmarshal(data, &record); err != nil {
			_ = file.Close()
			return nil, fmt.Errorf("spool dañado en línea %d: %w", line, err)
		}
		if record.ID == "" {
			_ = file.Close()
			return nil, fmt.Errorf("spool dañado en línea %d: falta id", line)
		}
		result := record.Result
		result.SpoolID = record.ID
		spool.records = append(spool.records, &result)
		validBytes += int64(len(data))
	}
	if err := file.Close(); err != nil {
		return nil, err
	}
	if err := syncDirectory(directory); err != nil {
		return nil, fmt.Errorf("sincronizar directorio spool: %w", err)
	}
	if err := spool.openAppend(); err != nil {
		return nil, err
	}
	return spool, nil
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	err = directory.Sync()
	_ = directory.Close()
	return err
}

func (spool *durableSpool) Append(result *pollResult) error {
	if spool == nil || result == nil {
		return errors.New("spool o evento vacío")
	}
	spool.mu.Lock()
	defer spool.mu.Unlock()
	if result.SpoolID != "" {
		return nil
	}
	spool.seq++
	id := fmt.Sprintf("%d-%d", time.Now().UnixNano(), spool.seq)
	if spool.file == nil || spool.encoder == nil {
		if err := spool.openAppend(); err != nil {
			return err
		}
	}
	if err := spool.encoder.Encode(spoolRecord{ID: id, Result: *result}); err != nil {
		return fmt.Errorf("escribir journal SSE: %w", err)
	}
	// El write ya está en la caché del sistema. Un fsync por evento cuesta
	// varios milisegundos en el camino SSE; se agrupa sin perder eventos ante
	// una caída del proceso (solo una caída física podría perder el último
	// intervalo).
	spool.unsynced++
	if spool.unsynced >= spoolSyncEvery || time.Since(spool.lastSync) >= spoolSyncInterval {
		if err := spool.file.Sync(); err != nil {
			return fmt.Errorf("sincronizar journal SSE: %w", err)
		}
		spool.unsynced = 0
		spool.lastSync = time.Now()
	}
	result.SpoolID = id
	spool.records = append(spool.records, result)
	return nil
}

func (spool *durableSpool) Pending() []*pollResult {
	if spool == nil {
		return nil
	}
	spool.mu.Lock()
	defer spool.mu.Unlock()
	return append([]*pollResult(nil), spool.records...)
}

func (spool *durableSpool) Acknowledge(results []*pollResult) error {
	if spool == nil || len(results) == 0 {
		return nil
	}
	acked := make(map[string]struct{}, len(results))
	for _, result := range results {
		if result != nil && result.SpoolID != "" {
			acked[result.SpoolID] = struct{}{}
		}
	}
	if len(acked) == 0 {
		return nil
	}

	spool.mu.Lock()
	defer spool.mu.Unlock()
	if spool.file != nil {
		if err := spool.file.Close(); err != nil {
			return err
		}
		spool.file = nil
		spool.encoder = nil
	}
	temporary := spool.path + ".tmp"
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("crear journal temporal: %w", err)
	}
	remaining := make([]*pollResult, 0, len(spool.records))
	encoder := json.NewEncoder(file)
	for _, result := range spool.records {
		if _, ok := acked[result.SpoolID]; ok {
			continue
		}
		if err := encoder.Encode(spoolRecord{ID: result.SpoolID, Result: *result}); err != nil {
			_ = file.Close()
			_ = os.Remove(temporary)
			return fmt.Errorf("reescribir journal SSE: %w", err)
		}
		remaining = append(remaining, result)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return fmt.Errorf("sincronizar journal temporal: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if err := os.Rename(temporary, spool.path); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("activar journal compacto: %w", err)
	}
	if err := syncDirectory(filepath.Dir(spool.path)); err != nil {
		return fmt.Errorf("sincronizar directorio spool: %w", err)
	}
	spool.records = remaining
	spool.unsynced = 0
	spool.lastSync = time.Now()
	return spool.openAppend()
}
