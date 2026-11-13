// Package marketsession reproduce el escenario market.ingest del corpus F2.
package marketsession

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/AGR55/QvaApp/services/trading-core/internal/replay/corpus"
)

// Session es el estado mínimo del escenario de ingesta.
type Session struct {
	feed         []map[string]any
	seen         map[string]bool
	observations []map[string]any
}

// New crea una sesión vacía.
func New() *Session {
	return &Session{seen: map[string]bool{}}
}

type eventPayload struct {
	Event string `json:"event"`
	Data  struct {
		UUID            string `json:"uuid"`
		UpdatedAt       string `json:"updated_at"`
		AvailableAmount string `json:"available_amount"`
	} `json:"data"`
	SentAt string `json:"sent_at"`
}

// Ingest procesa índices de eventos. Devuelve el resultado del paso y el estado.
func (session *Session) Ingest(events []corpus.Event, indexes []int, observation map[string]any) (map[string]any, map[string]any, string, error) {
	accepted := 0
	duplicates := 0
	for _, index := range indexes {
		if index < 0 || index >= len(events) {
			return nil, nil, "", fmt.Errorf("evento fuera de rango: %d", index)
		}
		var payload eventPayload
		if err := json.Unmarshal(events[index].Payload, &payload); err != nil {
			return nil, nil, "", fmt.Errorf("payload del evento %d: %w", index, err)
		}
		key := feedKey(payload)
		if session.seen[key] {
			duplicates++
			continue
		}
		session.seen[key] = true
		session.feed = append(session.feed, map[string]any{
			"event":      payload.Event,
			"key":        key,
			"receivedAt": events[index].ReceivedAt,
			"state":      "pending",
		})
		accepted++
	}
	if observation != nil {
		copy := make(map[string]any, len(observation))
		for key, value := range observation {
			copy[key] = value
		}
		session.observations = append(session.observations, copy)
	}
	state := session.State()
	return map[string]any{
		"accepted":     accepted,
		"duplicates":   duplicates,
		"observations": len(session.observations),
		"pending":      len(session.feed),
	}, state, Hash(state), nil
}

// State devuelve el estado canónico observable.
func (session *Session) State() map[string]any {
	ordered := append([]map[string]any(nil), session.feed...)
	sort.Slice(ordered, func(left, right int) bool {
		return ordered[left]["key"].(string) < ordered[right]["key"].(string)
	})
	feed := make([]any, 0, len(ordered))
	for _, entry := range ordered {
		feed = append(feed, entry)
	}
	observations := make([]any, 0, len(session.observations))
	for _, observation := range session.observations {
		observations = append(observations, observation)
	}
	return map[string]any{
		"feed":         feed,
		"intents":      []any{},
		"observations": observations,
		"operations":   []any{},
		"ownOffers":    []any{},
		"reservedQusd": "0.00000000",
		"workflows":    []any{},
	}
}

// Hash canoniza el estado y devuelve sha256:<hex>.
func Hash(value any) string {
	encoded, _ := json.Marshal(value)
	sum := sha256.Sum256(encoded)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func feedKey(payload eventPayload) string {
	version := payload.Data.UpdatedAt
	if version == "" {
		version = payload.SentAt
	}
	if len(payload.Event) >= 10 && payload.Event[:10] == "p2p.range_" {
		return fmt.Sprintf("%s:%s:%s:%s:%s",
			payload.Event, payload.Data.UUID, version, payload.SentAt, payload.Data.AvailableAmount)
	}
	if payload.Event == "p2p.paused" || payload.Event == "p2p.resumed" {
		return fmt.Sprintf("%s:%s:%s:%s", payload.Event, payload.Data.UUID, version, payload.SentAt)
	}
	return fmt.Sprintf("%s:%s:%s", payload.Event, payload.Data.UUID, version)
}
