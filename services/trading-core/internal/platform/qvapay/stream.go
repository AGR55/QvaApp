// Package qvapay incluye el cliente de lectura y el feed SSE del mercado P2P.
package qvapay

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	StreamURL        = "https://api.qvapay.com/v2/p2p/stream"
	maxStreamEvent   = 64 * 1024
	streamBackoff    = 1 * time.Second
	streamMaxBackoff = 60 * time.Second
)

// StreamCredentials identifica la app suscrita al feed P2P.
type StreamCredentials struct {
	AppID     string
	AppSecret string
}

// StreamEvent es un evento SSE ya parseado.
type StreamEvent struct {
	Event string
	Data  json.RawMessage
}

// StreamState es el estado de la conexión para métricas.
type StreamState struct {
	Connected bool
	Phase     string
	Error     string
}

// Stream mantiene la conexión SSE con reconexión y backoff.
type Stream struct {
	HTTP *http.Client
	URL  string
}

// NewStream crea el cliente SSE. No usa timeout global porque el stream es
// long-lived; la cancelación se controla con context.
func NewStream() *Stream {
	return &Stream{
		URL: StreamURL,
		HTTP: &http.Client{
			CheckRedirect: checkSameHostRedirect,
			Transport: &http.Transport{
				Proxy:                 http.ProxyFromEnvironment,
				TLSHandshakeTimeout:   10 * time.Second,
				ResponseHeaderTimeout: 20 * time.Second,
				IdleConnTimeout:       90 * time.Second,
			},
		},
	}
}

// Run conecta y reconecta hasta que el contexto se cancele. onEvent recibe
// cada evento; onState recibe los cambios de conexión. Los errores no incluyen
// app-secret.
func (stream *Stream) Run(
	ctx context.Context,
	credentials StreamCredentials,
	onEvent func(StreamEvent),
	onState func(StreamState),
) error {
	if stream == nil {
		return errors.New("stream QvaPay nil")
	}
	backoff := streamBackoff
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		err := stream.runOnce(ctx, credentials, onEvent, onState)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		message := "conexión SSE interrumpida"
		if err != nil {
			message = safeStreamError(err)
		}
		if onState != nil {
			onState(StreamState{Phase: "backoff", Error: message})
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		if backoff < streamMaxBackoff {
			backoff *= 2
			if backoff > streamMaxBackoff {
				backoff = streamMaxBackoff
			}
		}
	}
}

func (stream *Stream) runOnce(
	ctx context.Context,
	credentials StreamCredentials,
	onEvent func(StreamEvent),
	onState func(StreamState),
) error {
	if onState != nil {
		onState(StreamState{Phase: "connecting"})
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, stream.URL, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "text/event-stream")
	request.Header.Set("app-id", credentials.AppID)
	request.Header.Set("app-secret", credentials.AppSecret)

	client := stream.HTTP
	if client == nil {
		client = NewStream().HTTP
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("conectar SSE: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		return fmt.Errorf("SSE QvaPay respondió %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	if onState != nil {
		onState(StreamState{Connected: true, Phase: "connected"})
	}

	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 4096), maxStreamEvent)
	var block bytes.Buffer
	flush := func() error {
		if block.Len() == 0 {
			return nil
		}
		text := strings.ReplaceAll(block.String(), "\r\n", "\n")
		block.Reset()
		event, data, retry := parseSSEBlock(text)
		if retry > 0 {
			// El intervalo se aplica en la siguiente reconexión; no se expone
			// aquí para no mezclar estado con la lógica del parser.
			_ = retry
		}
		if event == "" || len(data) == 0 {
			return nil
		}
		var raw json.RawMessage
		raw = append(raw, data...)
		if !json.Valid(raw) {
			return fmt.Errorf("evento SSE con JSON inválido")
		}
		if onEvent != nil {
			onEvent(StreamEvent{Event: event, Data: raw})
		}
		return nil
	}

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if err := flush(); err != nil {
				return err
			}
			continue
		}
		if block.Len()+len(line)+1 > maxStreamEvent {
			return fmt.Errorf("evento SSE demasiado grande")
		}
		block.WriteString(line)
		block.WriteByte('\n')
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return flush()
}

func parseSSEBlock(block string) (string, []byte, int) {
	event := "message"
	var data [][]byte
	retry := 0
	for _, line := range strings.Split(block, "\n") {
		if line == "" || strings.HasPrefix(line, ":") {
			continue
		}
		field, value, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "event":
			event = value
		case "data":
			data = append(data, []byte(value))
		case "retry":
			if parsed, err := parseRetryMilliseconds(value); err == nil {
				retry = parsed
			}
		}
	}
	joined := bytes.Join(data, []byte("\n"))
	return event, joined, retry
}

func parseRetryMilliseconds(value string) (int, error) {
	var milliseconds int
	if _, err := fmt.Sscanf(value, "%d", &milliseconds); err != nil || milliseconds < 0 {
		return 0, errors.New("retry inválido")
	}
	return milliseconds, nil
}

func safeStreamError(err error) string {
	message := err.Error()
	message = strings.ReplaceAll(message, "app-secret", "app-secret=[redacted]")
	if len(message) > 500 {
		message = message[:500]
	}
	return message
}
