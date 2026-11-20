package main

import (
	"errors"
	"fmt"

	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/monetary"
)

type memoryIntent struct {
	state string
}

type memoryRepository struct {
	intents    map[string]*memoryIntent
	events     []string
	failCreate bool
}

func newMemoryRepository() *memoryRepository {
	return &memoryRepository{intents: map[string]*memoryIntent{}}
}

func (repository *memoryRepository) Create(intent monetary.Intent) error {
	if repository.failCreate {
		return errors.New("sqlite unavailable")
	}
	repository.intents[intent.ID] = &memoryIntent{state: "submitted"}
	repository.events = append(repository.events, "created:"+intent.ID)
	return nil
}

func (repository *memoryRepository) Update(intentID, state string, _ any, _ string) error {
	intent, ok := repository.intents[intentID]
	if !ok {
		return errors.New("intent missing")
	}
	intent.state = state
	repository.events = append(repository.events, state+":"+intentID)
	return nil
}

func (repository *memoryRepository) Audit(action, _ string, _ string) {
	repository.events = append(repository.events, "audit:"+action)
}

func monetaryError(kind string) error {
	switch kind {
	case "4xx":
		return &monetary.APIError{Status: 409, Message: "conflict"}
	case "5xx":
		return &monetary.APIError{Status: 503, Message: "unavailable"}
	case "timeout":
		return &monetary.UncertainError{Kind: "apply", Message: "timeout"}
	default:
		return errors.New("unexpected response")
	}
}

func monetaryClassification(kinds []string) []any {
	results := make([]any, 0, len(kinds))
	for index, kind := range kinds {
		repository := newMemoryRepository()
		intentID := fmt.Sprintf("intent-classified-%d", index+3)
		expected := monetaryError(kind)
		_, err := monetary.Execute(repository, func() string { return intentID }, monetary.Mutation{
			Kind:          "apply",
			OperationUUID: "offer-1",
			Request:       map[string]any{},
			Action: func(string) (any, error) {
				return nil, expected
			},
		})
		results = append(results, map[string]any{
			"kind":      kind,
			"sameError": err == expected,
			"state":     repository.intents[intentID].state,
			"events":    repository.events,
		})
	}
	return results
}

func monetaryOutcomes(kinds []string) []any {
	results := make([]any, 0, len(kinds))
	for _, kind := range kinds {
		results = append(results, map[string]any{
			"kind":    kind,
			"outcome": monetary.Outcome(monetaryError(kind)),
		})
	}
	return results
}
