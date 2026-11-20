package main

import "github.com/AGR55/QvaApp/services/trading-core/internal/domain/reconciliation"

type mapState map[string]string

func (state mapState) Get(key string) (string, bool) {
	value, ok := state[key]
	return value, ok
}

func (state mapState) Set(key, value string) {
	state[key] = value
}

func reconciliationResult(record reconciliation.Record) map[string]any {
	return map[string]any{
		"attempts":      record.Attempts,
		"nextAttemptAt": record.NextAttemptAt,
	}
}
