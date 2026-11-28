package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/mobileoperator"
)

type mobileStorage struct {
	saved     string
	audits    []string
	auditFunc func(action, detail string)
}

func (storage *mobileStorage) Get(string) (string, bool) {
	if storage.saved == "" {
		return "", false
	}
	return storage.saved, true
}

func (storage *mobileStorage) Set(_ string, value string) {
	storage.saved = value
}

func (storage *mobileStorage) Audit(action, detail string, _ string) {
	storage.audits = append(storage.audits, action)
	if storage.auditFunc != nil {
		storage.auditFunc(action, detail)
	}
}

func mobileNumber(fields map[string]any, key string, fallback float64) (float64, *opError) {
	if fields[key] == nil {
		return fallback, nil
	}
	number, ok := fields[key].(json.Number)
	if !ok {
		return 0, validation(fmt.Sprintf("El campo %s debe ser un número.", key))
	}
	parsed, err := strconv.ParseFloat(number.String(), 64)
	if err != nil {
		return 0, validation(fmt.Sprintf("El campo %s debe ser un número.", key))
	}
	return parsed, nil
}

func mobileObjects(fields map[string]any, key string) ([]map[string]any, *opError) {
	raw, ok := fields[key].([]any)
	if !ok {
		return []map[string]any{}, nil
	}
	result := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		object, ok := item.(map[string]any)
		if !ok {
			return nil, validation(fmt.Sprintf("Cada elemento de %s debe ser un objeto.", key))
		}
		result = append(result, object)
	}
	return result, nil
}

func parseMobileOperations(raw []map[string]any) ([]mobileoperator.Operation, *opError) {
	result := make([]mobileoperator.Operation, 0, len(raw))
	for _, item := range raw {
		uuid, failure := stringField(item, "uuid")
		if failure != nil {
			return nil, failure
		}
		orderUUID, failure := optionalStringField(item, "orderUuid", "")
		if failure != nil {
			return nil, failure
		}
		offerType, failure := stringField(item, "offerType")
		if failure != nil {
			return nil, failure
		}
		coin, failure := stringField(item, "coin")
		if failure != nil {
			return nil, failure
		}
		state, failure := stringField(item, "state")
		if failure != nil {
			return nil, failure
		}
		amount, failure := mobileNumber(item, "amount", 0)
		if failure != nil {
			return nil, failure
		}
		receive, failure := mobileNumber(item, "receive", 0)
		if failure != nil {
			return nil, failure
		}
		createdAt, failure := integerField(item, "createdAt")
		if failure != nil {
			return nil, failure
		}
		result = append(result, mobileoperator.Operation{
			UUID:      uuid,
			OrderUUID: orderUUID,
			OfferType: offerType,
			Coin:      coin,
			Amount:    amount,
			Receive:   receive,
			State:     state,
			CreatedAt: createdAt,
		})
	}
	return result, nil
}

func parseMobileThreads(raw []map[string]any) ([]mobileoperator.Thread, *opError) {
	result := make([]mobileoperator.Thread, 0, len(raw))
	for _, item := range raw {
		id, failure := stringField(item, "id")
		if failure != nil {
			return nil, failure
		}
		uuid, failure := stringField(item, "uuid")
		if failure != nil {
			return nil, failure
		}
		orderUUID, failure := optionalStringField(item, "orderUuid", "")
		if failure != nil {
			return nil, failure
		}
		offerType, failure := stringField(item, "offerType")
		if failure != nil {
			return nil, failure
		}
		role, failure := stringField(item, "role")
		if failure != nil {
			return nil, failure
		}
		coin, failure := stringField(item, "coin")
		if failure != nil {
			return nil, failure
		}
		state, failure := stringField(item, "state")
		if failure != nil {
			return nil, failure
		}
		amount, failure := mobileNumber(item, "amount", 0)
		if failure != nil {
			return nil, failure
		}
		receive, failure := mobileNumber(item, "receive", 0)
		if failure != nil {
			return nil, failure
		}
		createdAt, failure := integerField(item, "createdAt")
		if failure != nil {
			return nil, failure
		}
		discoveredAt, failure := integerField(item, "discoveredAt")
		if failure != nil {
			return nil, failure
		}
		result = append(result, mobileoperator.Thread{
			ID:           id,
			UUID:         uuid,
			OrderUUID:    orderUUID,
			OfferType:    offerType,
			Role:         role,
			Coin:         coin,
			Amount:       amount,
			Receive:      receive,
			State:        state,
			CreatedAt:    createdAt,
			DiscoveredAt: discoveredAt,
		})
	}
	return result, nil
}

func parseMobileAlerts(raw []map[string]any) ([]mobileoperator.Alert, *opError) {
	result := make([]mobileoperator.Alert, 0, len(raw))
	for _, item := range raw {
		id, failure := stringField(item, "id")
		if failure != nil {
			return nil, failure
		}
		alertType, failure := stringField(item, "type")
		if failure != nil {
			return nil, failure
		}
		message, failure := stringField(item, "message")
		if failure != nil {
			return nil, failure
		}
		createdAt, failure := integerField(item, "createdAt")
		if failure != nil {
			return nil, failure
		}
		operationUUID, failure := optionalStringField(item, "operationUuid", "")
		if failure != nil {
			return nil, failure
		}
		result = append(result, mobileoperator.Alert{ID: id, Type: alertType, Message: message, CreatedAt: createdAt, OperationUUID: operationUUID})
	}
	return result, nil
}

func parseMobileMarkets(raw []map[string]any) ([]mobileoperator.Market, *opError) {
	result := make([]mobileoperator.Market, 0, len(raw))
	for _, item := range raw {
		code, failure := stringField(item, "code")
		if failure != nil {
			return nil, failure
		}
		label, failure := stringField(item, "label")
		if failure != nil {
			return nil, failure
		}
		currency, failure := stringField(item, "currency")
		if failure != nil {
			return nil, failure
		}
		result = append(result, mobileoperator.Market{Code: code, Label: label, Currency: currency})
	}
	return result, nil
}

func mobileDependencies(markPaid func(string, string) error) mobileoperator.Dependencies {
	if markPaid == nil {
		markPaid = func(string, string) error { return nil }
	}
	return mobileoperator.Dependencies{
		Operations:      func() []mobileoperator.Operation { return nil },
		Alerts:          func() []mobileoperator.Alert { return nil },
		Markets:         func() []mobileoperator.Market { return nil },
		MarkPaid:        markPaid,
		ConfirmReceived: func(string) error { return nil },
		Cancel:          func(string) error { return nil },
	}
}

func mobileCredentials() (any, *opError) {
	storage := &mobileStorage{}
	now := int64(100_000)
	service := mobileoperator.New(storage, mobileDependencies(nil), func() int64 { return now }, func() string { return strings.Repeat("A", 48) }, func() string { return "operator-1" })
	operator, token, _ := service.Pair("Pixel")
	tokenLength := len(token)
	tokenStored := strings.Contains(storage.saved, token)
	first := service.Check(token, false).OK
	for count := 1; count < 60; count++ {
		service.Check(token, false)
	}
	rateLimitedAfter60 := service.Check(token, false).RateLimited
	readOkAfterWriteLimit := service.Check(token, true).OK
	for count := 1; count < 20; count++ {
		service.Check(token, true)
	}
	readRateLimitedAfter20 := service.Check(token, true).RateLimited
	writeStillLimited := !service.Check(token, false).OK
	now += 60_001
	okAfterWindow := service.Check(token, false).OK
	revoked := service.Revoke(operator.ID)
	checkAfterRevoke := service.Check(token, false).OK
	return map[string]any{
		"tokenLength":            tokenLength,
		"tokenStored":            tokenStored,
		"first":                  first,
		"rateLimitedAfter60":     rateLimitedAfter60,
		"readOkAfterWriteLimit":  readOkAfterWriteLimit,
		"readRateLimitedAfter20": readRateLimitedAfter20,
		"writeStillLimited":      writeStillLimited,
		"okAfterWindow":          okAfterWindow,
		"revoked":                revoked,
		"checkAfterRevoke":       checkAfterRevoke,
		"audit":                  storage.audits,
	}, nil
}

func mobileActionUncertain() (any, *opError) {
	storage := &mobileStorage{}
	dependencies := mobileDependencies(func(string, string) error { return errors.New("QvaPay timeout") })
	service := mobileoperator.New(storage, dependencies, func() int64 { return 100_000 }, func() string { return "token" }, func() string { return "operator" })
	err := service.Act("operator-1", "operation-1", "paid", "REF-1")
	message := ""
	if err != nil {
		message = err.Error()
	}
	return map[string]any{"error": message, "audit": storage.audits}, nil
}

func mobileActionAuditFailure() (any, *opError) {
	storage := &mobileStorage{}
	timings := make([]map[string]any, 0)
	storage.auditFunc = func(action, detail string) {
		if action == "mobile_action_timing" {
			var timing map[string]any
			if json.Unmarshal([]byte(detail), &timing) == nil {
				timings = append(timings, timing)
			}
		}
		if action == "mobile_paid_confirmed" {
			panic("audit unavailable")
		}
	}
	mutations := 0
	dependencies := mobileDependencies(func(string, string) error {
		mutations++
		return nil
	})
	service := mobileoperator.New(storage, dependencies, func() int64 { return 100_000 }, func() string { return "token" }, func() string { return "operator" })
	if err := service.Act("operator", "operation", "paid", "SECRET"); err != nil {
		return nil, validation(err.Error())
	}
	var outcome any
	totalAtLeastZero := false
	if len(timings) > 0 {
		outcome = timings[0]["outcome"]
		if total, ok := timings[0]["totalMs"].(float64); ok {
			totalAtLeastZero = total >= 0
		}
	}
	timingJSON, _ := json.Marshal(timings)
	return map[string]any{
		"mutations":          mutations,
		"outcome":            outcome,
		"totalMsAtLeastZero": totalAtLeastZero,
		"secretLeaked":       strings.Contains(string(timingJSON), "SECRET"),
	}, nil
}

func mobileOperationsList(fields map[string]any) (any, *opError) {
	rawOperations, failure := mobileObjects(fields, "operations")
	if failure != nil {
		return nil, failure
	}
	operations, failure := parseMobileOperations(rawOperations)
	if failure != nil {
		return nil, failure
	}
	rawAlerts, failure := mobileObjects(fields, "alerts")
	if failure != nil {
		return nil, failure
	}
	alerts, failure := parseMobileAlerts(rawAlerts)
	if failure != nil {
		return nil, failure
	}
	rawMarkets, failure := mobileObjects(fields, "markets")
	if failure != nil {
		return nil, failure
	}
	markets, failure := parseMobileMarkets(rawMarkets)
	if failure != nil {
		return nil, failure
	}
	dependencies := mobileDependencies(nil)
	dependencies.Operations = func() []mobileoperator.Operation { return operations }
	dependencies.Alerts = func() []mobileoperator.Alert { return alerts }
	dependencies.Markets = func() []mobileoperator.Market { return markets }
	service := mobileoperator.New(&mobileStorage{}, dependencies, func() int64 { return 100_000 }, func() string { return "token" }, func() string { return "operator" })
	limit := int64(10)
	if fields["limit"] != nil {
		limit, failure = integerField(fields, "limit")
		if failure != nil {
			return nil, failure
		}
	}
	items := service.Operations(int(limit))
	operationsResult := make([]any, 0, len(items))
	for _, item := range items {
		entry := map[string]any{"uuid": item["uuid"], "actions": item["actions"]}
		if orderUUID, ok := item["orderUuid"].(string); ok && orderUUID != "" {
			entry["orderUuid"] = orderUUID
		}
		operationsResult = append(operationsResult, entry)
	}
	return map[string]any{"operations": operationsResult, "alerts": service.Alerts()}, nil
}

func mobileThreadsList(fields map[string]any) (any, *opError) {
	rawOperations, failure := mobileObjects(fields, "operations")
	if failure != nil {
		return nil, failure
	}
	operations, failure := parseMobileOperations(rawOperations)
	if failure != nil {
		return nil, failure
	}
	rawThreads, failure := mobileObjects(fields, "threads")
	if failure != nil {
		return nil, failure
	}
	threads, failure := parseMobileThreads(rawThreads)
	if failure != nil {
		return nil, failure
	}
	rawMarkets, failure := mobileObjects(fields, "markets")
	if failure != nil {
		return nil, failure
	}
	markets, failure := parseMobileMarkets(rawMarkets)
	if failure != nil {
		return nil, failure
	}
	dependencies := mobileDependencies(nil)
	dependencies.Operations = func() []mobileoperator.Operation { return operations }
	dependencies.Threads = func() []mobileoperator.Thread { return threads }
	dependencies.Markets = func() []mobileoperator.Market { return markets }
	service := mobileoperator.New(&mobileStorage{}, dependencies, func() int64 { return 100_000 }, func() string { return "token" }, func() string { return "operator" })
	limit := int64(100)
	if fields["limit"] != nil {
		limit, failure = integerField(fields, "limit")
		if failure != nil {
			return nil, failure
		}
	}
	items := service.Operations(int(limit))
	result := make([]any, 0, len(items))
	for _, item := range items {
		entry := map[string]any{
			"id":            item["id"],
			"uuid":          item["uuid"],
			"side":          item["side"],
			"role":          item["role"],
			"chatAvailable": item["chatAvailable"],
			"actions":       item["actions"],
		}
		if orderUUID, ok := item["orderUuid"].(string); ok && orderUUID != "" {
			entry["orderUuid"] = orderUUID
		}
		result = append(result, entry)
	}
	return map[string]any{"operations": result}, nil
}
