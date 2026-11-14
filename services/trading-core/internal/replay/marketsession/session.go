// Package marketsession reproduce el escenario market.ingest del corpus F2.
package marketsession

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"

	"github.com/AGR55/QvaApp/services/trading-core/internal/replay/corpus"
)

// FeedEntry es un evento aceptado en el feed.
type FeedEntry struct {
	Key        string `json:"key"`
	Event      string `json:"event"`
	State      string `json:"state"`
	ReceivedAt int64  `json:"receivedAt"`
}

// Observation es una observación normalizada.
type Observation struct {
	Coin        string `json:"coin"`
	OpenOffers  int    `json:"openOffers"`
	Eligible    int    `json:"eligible"`
	AverageBuy  string `json:"averageBuy,omitempty"`
	AverageSell string `json:"averageSell,omitempty"`
	MedianBuy   string `json:"medianBuy,omitempty"`
	MedianSell  string `json:"medianSell,omitempty"`
	BestBuy     string `json:"bestBuy,omitempty"`
	BestSell    string `json:"bestSell,omitempty"`
}

// Session es el estado mínimo del escenario de ingesta.
type Session struct {
	feed         []FeedEntry
	seen         map[string]bool
	observations []Observation
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
		session.feed = append(session.feed, FeedEntry{
			Key:        key,
			Event:      payload.Event,
			State:      "pending",
			ReceivedAt: events[index].ReceivedAt,
		})
		accepted++
	}
	if observation != nil {
		normalized, err := normalizeObservation(observation)
		if err != nil {
			return nil, nil, "", err
		}
		session.observations = append(session.observations, normalized)
	}
	state := session.State()
	return map[string]any{
		"accepted":     accepted,
		"duplicates":   duplicates,
		"observations": len(session.observations),
		"pending":      len(session.feed),
	}, state, session.Digest(), nil
}

// State devuelve el estado canónico observable.
func (session *Session) State() map[string]any {
	ordered := append([]FeedEntry(nil), session.feed...)
	sort.Slice(ordered, func(left, right int) bool { return ordered[left].Key < ordered[right].Key })
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

type digestSnapshot struct {
	Operations   []any         `json:"operations"`
	ReservedQusd string        `json:"reservedQusd"`
	Workflows    []any         `json:"workflows"`
	OwnOffers    []any         `json:"ownOffers"`
	Intents      []any         `json:"intents"`
	Feed         []FeedEntry   `json:"feed"`
	Observations []Observation `json:"observations"`
}

// Digest reproduce el stateDigest del oráculo (orden de claves del snapshot).
func (session *Session) Digest() string {
	ordered := append([]FeedEntry(nil), session.feed...)
	sort.Slice(ordered, func(left, right int) bool { return ordered[left].Key < ordered[right].Key })
	observations := session.observations
	if observations == nil {
		observations = []Observation{}
	}
	snapshot := digestSnapshot{
		Operations:   []any{},
		ReservedQusd: "0.00000000",
		Workflows:    []any{},
		OwnOffers:    []any{},
		Intents:      []any{},
		Feed:         ordered,
		Observations: observations,
	}
	encoded, _ := json.Marshal(snapshot)
	sum := sha256.Sum256(encoded)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func normalizeObservation(input map[string]any) (Observation, error) {
	coin, _ := input["coin"].(string)
	if coin == "" {
		return Observation{}, fmt.Errorf("observación sin coin")
	}
	return Observation{
		Coin:        coin,
		OpenOffers:  intValue(input["openOffers"]),
		Eligible:    intValue(input["eligible"]),
		AverageBuy:  textValue(input["averageBuy"]),
		AverageSell: textValue(input["averageSell"]),
		MedianBuy:   textValue(input["medianBuy"]),
		MedianSell:  textValue(input["medianSell"]),
		BestBuy:     textValue(input["bestBuy"]),
		BestSell:    textValue(input["bestSell"]),
	}, nil
}

func intValue(value any) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	case json.Number:
		parsed, _ := typed.Int64()
		return int(parsed)
	default:
		return 0
	}
}

func textValue(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case float64:
		return strconv.FormatFloat(typed, 'f', 8, 64)
	case nil:
		return ""
	default:
		return fmt.Sprint(typed)
	}
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
