// Package mobileoperator contiene el contrato móvil puro de
// `src/mobile-operator.ts`: tokens hasheados, cupos separados, acciones y
// composición de operaciones. No hace I/O de red.
package mobileoperator

//lint:file-ignore ST1005 los mensajes son contractuales y deben coincidir con el oráculo

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

const storageKey = "mobile_operators_v1"

// Storage es el almacén inyectado.
type Storage interface {
	Get(key string) (string, bool)
	Set(key, value string)
	Audit(action, detail string, uuid string)
}

// Operation es una operación local.
type Operation struct {
	UUID      string
	OrderUUID string
	OfferType string
	Coin      string
	Amount    float64
	Receive   float64
	State     string
	Role      string
	CreatedAt int64
}

// Thread es un hilo de chat remoto.
type Thread struct {
	ID           string
	UUID         string
	OrderUUID    string
	OfferType    string
	Role         string
	Coin         string
	Amount       float64
	Receive      float64
	State        string
	CreatedAt    int64
	DiscoveredAt int64
}

// Alert es una alerta móvil.
type Alert struct {
	ID            string
	Type          string
	Message       string
	CreatedAt     int64
	OperationUUID string
}

// Market es un mercado configurado.
type Market struct {
	Code     string
	Label    string
	Currency string
}

// Dependencies inyecta lecturas y mutaciones.
type Dependencies struct {
	Operations      func() []Operation
	Threads         func() []Thread
	Alerts          func() []Alert
	Markets         func() []Market
	MarkPaid        func(uuid, reference string) error
	ConfirmReceived func(uuid string) error
	Cancel          func(uuid string) error
}

// Service implementa el contrato móvil.
type Service struct {
	storage      Storage
	dependencies Dependencies
	now          func() int64
	createToken  func() string
	createID     func() string
}

// New crea el servicio.
func New(storage Storage, dependencies Dependencies, now func() int64, createToken, createID func() string) *Service {
	if now == nil {
		now = func() int64 { return time.Now().UnixMilli() }
	}
	if createToken == nil {
		createToken = func() string { return strings.Repeat("A", 48) }
	}
	if createID == nil {
		createID = func() string { return "operator-1" }
	}
	return &Service{storage: storage, dependencies: dependencies, now: now, createToken: createToken, createID: createID}
}

type record struct {
	ID              string   `json:"id"`
	Label           string   `json:"label"`
	TokenHash       string   `json:"tokenHash"`
	Scopes          []string `json:"scopes"`
	CreatedAt       int64    `json:"createdAt"`
	RevokedAt       *int64   `json:"revokedAt"`
	ReadRateWindow  int64    `json:"readRateWindowAt"`
	ReadRateCount   int64    `json:"readRateCount"`
	WriteRateWindow int64    `json:"writeRateWindowAt"`
	WriteRateCount  int64    `json:"writeRateCount"`
}

// Operator es la vista pública.
type Operator struct {
	ID        string   `json:"id"`
	Label     string   `json:"label"`
	Scopes    []string `json:"scopes"`
	CreatedAt int64    `json:"createdAt"`
	RevokedAt *int64   `json:"revokedAt"`
}

// CheckResult es el resultado de validar un token.
type CheckResult struct {
	OK          bool
	Scopes      []string
	OperatorID  string
	RateLimited bool
}

// Pair vincula un dispositivo.
func (service *Service) Pair(label string) (Operator, string, error) {
	clean := strings.TrimSpace(label)
	if clean == "" || len(clean) > 80 {
		return Operator{}, "", errors.New("Nombre de dispositivo inválido.")
	}
	token := service.createToken()
	record := record{
		ID:        service.createID(),
		Label:     clean,
		TokenHash: digest(token),
		Scopes:    []string{"read", "actions"},
		CreatedAt: service.now(),
	}
	records := service.records()
	records = append(records, record)
	service.save(records)
	service.storage.Audit("mobile_operator_created", fmt.Sprintf("Operador móvil vinculado: %s.", clean), "")
	return public(record), token, nil
}

// Check valida un token y aplica el cupo.
func (service *Service) Check(token string, write bool) CheckResult {
	records := service.records()
	index := -1
	for position, item := range records {
		if item.TokenHash == digest(token) && item.RevokedAt == nil {
			index = position
			break
		}
	}
	if index < 0 {
		return CheckResult{}
	}
	item := records[index]
	scope := "read"
	if write {
		scope = "actions"
	}
	allowed := false
	for _, candidate := range item.Scopes {
		if candidate == scope {
			allowed = true
			break
		}
	}
	if !allowed {
		return CheckResult{}
	}
	now := service.now()
	window := item.ReadRateWindow
	count := item.ReadRateCount
	limit := int64(60)
	if write {
		window = item.WriteRateWindow
		count = item.WriteRateCount
		limit = 20
	}
	if now-window < 60_000 && count >= limit {
		return CheckResult{RateLimited: true}
	}
	if now-window >= 60_000 {
		window = now
		count = 1
	} else {
		count++
	}
	if write {
		item.WriteRateWindow = window
		item.WriteRateCount = count
	} else {
		item.ReadRateWindow = window
		item.ReadRateCount = count
	}
	records[index] = item
	service.save(records)
	return CheckResult{OK: true, Scopes: item.Scopes, OperatorID: item.ID}
}

// Revoke revoca un operador.
func (service *Service) Revoke(id string) bool {
	records := service.records()
	changed := false
	now := service.now()
	for index, item := range records {
		if item.ID == id && item.RevokedAt == nil {
			item.RevokedAt = &now
			records[index] = item
			changed = true
		}
	}
	if changed {
		service.save(records)
		service.storage.Audit("mobile_operator_revoked", fmt.Sprintf("Operador móvil revocado: %s.", id), "")
	}
	return changed
}

// List devuelve los operadores públicos.
func (service *Service) List() []Operator {
	records := service.records()
	result := make([]Operator, 0, len(records))
	for _, item := range records {
		result = append(result, public(item))
	}
	return result
}

// Operations compone la lista móvil.
func (service *Service) Operations(limit int) []map[string]any {
	markets := map[string]Market{}
	for _, market := range service.dependencies.Markets() {
		markets[market.Code] = market
	}
	local := service.dependencies.Operations()
	managed := map[string]bool{}
	for _, operation := range local {
		managed[key(operation.UUID, operation.OrderUUID)] = true
	}
	merged := map[string]Operation{}
	if service.dependencies.Threads != nil {
		for _, thread := range service.dependencies.Threads() {
			id := thread.ID
			offerType := thread.OfferType
			if thread.Role == "creator" {
				if offerType == "buy" {
					offerType = "sell"
				} else {
					offerType = "buy"
				}
			}
			createdAt := thread.CreatedAt
			if createdAt == 0 {
				createdAt = thread.DiscoveredAt
			}
			merged[id] = Operation{
				UUID:      thread.UUID,
				OrderUUID: thread.OrderUUID,
				OfferType: offerType,
				Coin:      thread.Coin,
				Amount:    thread.Amount,
				Receive:   thread.Receive,
				State:     thread.State,
				Role:      thread.Role,
				CreatedAt: createdAt,
			}
		}
	}
	for _, operation := range local {
		id := key(operation.UUID, operation.OrderUUID)
		if existing, ok := merged[id]; ok && existing.Role != "" {
			operation.Role = existing.Role
		}
		merged[id] = operation
	}
	values := make([]Operation, 0, len(merged))
	if service.dependencies.Threads != nil {
		for _, operation := range merged {
			values = append(values, operation)
		}
		active := map[string]bool{"applied": true, "acknowledged": true, "processing": true, "paid": true, "revision": true}
		sort.SliceStable(values, func(left, right int) bool {
			leftActive := active[values[left].State]
			rightActive := active[values[right].State]
			if leftActive != rightActive {
				return leftActive
			}
			return values[left].CreatedAt > values[right].CreatedAt
		})
	} else {
		values = append(values, local...)
	}
	if limit < 0 {
		limit = 0
	}
	if limit < len(values) {
		values = values[:limit]
	}
	result := make([]map[string]any, 0, len(values))
	for _, operation := range values {
		id := key(operation.UUID, operation.OrderUUID)
		actions := actionsFor(operation)
		if !managed[id] {
			actions = []string{}
		}
		role := operation.Role
		if role == "" {
			role = "taker"
		}
		market := markets[operation.Coin]
		label := market.Label
		if label == "" {
			label = operation.Coin
		}
		result = append(result, map[string]any{
			"id":            id,
			"uuid":          operation.UUID,
			"orderUuid":     operation.OrderUUID,
			"role":          role,
			"chatAvailable": true,
			"side":          operation.OfferType,
			"market":        operation.Coin,
			"marketLabel":   label,
			"currency":      market.Currency,
			"amount":        operation.Amount,
			"receive":       operation.Receive,
			"status":        operation.State,
			"createdAt":     operation.CreatedAt,
			"actions":       actions,
		})
	}
	return result
}

// Alerts devuelve las alertas acotadas.
func (service *Service) Alerts() []map[string]any {
	alerts := service.dependencies.Alerts()
	if len(alerts) > 100 {
		alerts = alerts[:100]
	}
	result := make([]map[string]any, 0, len(alerts))
	for _, alert := range alerts {
		item := map[string]any{
			"id":        alert.ID,
			"type":      alert.Type,
			"message":   alert.Message,
			"createdAt": alert.CreatedAt,
		}
		if alert.OperationUUID != "" {
			item["operationUuid"] = alert.OperationUUID
		}
		result = append(result, item)
	}
	return result
}

// Act ejecuta una acción móvil y audita su resultado.
func (service *Service) Act(operatorID, uuid, action, reference string) error {
	if action == "paid" && strings.TrimSpace(reference) == "" {
		return errors.New("La referencia del pago es obligatoria.")
	}
	service.storage.Audit("mobile_"+action+"_requested", fmt.Sprintf("Acción %s solicitada desde app móvil por operador %s.", action, operatorID), uuid)
	started := time.Now()
	outcome := "not_confirmed"
	var err error
	switch action {
	case "paid":
		err = service.dependencies.MarkPaid(uuid, strings.TrimSpace(reference))
	case "received":
		err = service.dependencies.ConfirmReceived(uuid)
	default:
		err = service.dependencies.Cancel(uuid)
	}
	if err != nil {
		outcome = "not_confirmed"
		service.storage.Audit("mobile_"+action+"_uncertain", fmt.Sprintf("Acción móvil %s no confirmada: %s. No se debe reintentar sin conciliar.", action, err.Error()), uuid)
	} else {
		outcome = "confirmed"
	}
	timing, _ := json.Marshal(map[string]any{
		"action":  action,
		"outcome": outcome,
		"totalMs": float64(time.Since(started).Microseconds()) / 1_000,
	})
	safeAudit(service.storage, "mobile_action_timing", string(timing), uuid)
	if err != nil {
		return err
	}
	safeAudit(service.storage, "mobile_"+action+"_confirmed", fmt.Sprintf("Acción %s confirmada desde app móvil por operador %s.", action, operatorID), uuid)
	return nil
}

func safeAudit(storage Storage, action, detail, uuid string) {
	defer func() { _ = recover() }()
	storage.Audit(action, detail, uuid)
}

func (service *Service) records() []record {
	raw, ok := service.storage.Get(storageKey)
	if !ok {
		return []record{}
	}
	var records []record
	if err := json.Unmarshal([]byte(raw), &records); err != nil {
		return []record{}
	}
	return records
}

func (service *Service) save(records []record) {
	encoded, err := json.Marshal(records)
	if err != nil {
		return
	}
	service.storage.Set(storageKey, string(encoded))
}

func digest(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func key(uuid, orderUUID string) string {
	if orderUUID == "" {
		orderUUID = "fixed"
	}
	return uuid + ":" + orderUUID
}

func public(item record) Operator {
	return Operator{ID: item.ID, Label: item.Label, Scopes: item.Scopes, CreatedAt: item.CreatedAt, RevokedAt: item.RevokedAt}
}

func actionsFor(operation Operation) []string {
	if operation.OfferType == "buy" {
		if operation.State == "applied" || operation.State == "acknowledged" || operation.State == "paid" {
			actions := []string{"received"}
			if operation.State == "applied" || operation.State == "acknowledged" {
				actions = append(actions, "cancel")
			}
			return actions
		}
		return []string{}
	}
	if operation.State == "applied" || operation.State == "acknowledged" {
		return []string{"paid", "cancel"}
	}
	return []string{}
}
