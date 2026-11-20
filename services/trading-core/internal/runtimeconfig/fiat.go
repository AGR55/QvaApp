package runtimeconfig

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// FiatMovement es un débito o crédito fiat idempotente. Key suele ser el UUID
// de la orden (o de la oferta si no hay orden) y evita duplicar el movimiento
// en reintentos y conciliaciones.
type FiatMovement struct {
	Key       string
	Coin      string
	Direction string
	Amount    float64
	Source    string
	At        int64
}

// ApplyFiatMovement registra el movimiento y ajusta fiatBalance del mercado en
// una sola transacción. Devuelve false si la clave ya estaba registrada.
func (repository *Repository) ApplyFiatMovement(
	ctx context.Context,
	movement FiatMovement,
) (bool, error) {
	if repository == nil || repository.Pool == nil {
		return false, errors.New("runtimeconfig: repositorio sin pool")
	}
	if err := validateFiatMovement(movement); err != nil {
		return false, err
	}

	tx, err := repository.Pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // el rollback tras commit es inocuo

	tag, err := tx.Exec(ctx, `
		INSERT INTO shadow.fiat_ledger
			(operation_uuid, coin, direction, amount, source, created_at)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (operation_uuid) DO NOTHING`,
		movement.Key, movement.Coin, movement.Direction, movement.Amount,
		truncate(movement.Source, MaxReasonLength), movement.At,
	)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}

	var (
		payload []byte
		version int64
	)
	err = tx.QueryRow(ctx, `
		SELECT config_json, version FROM shadow.runtime_config WHERE id = 1 FOR UPDATE`,
	).Scan(&payload, &version)
	if err != nil {
		return false, err
	}
	var config Config
	if err := json.Unmarshal(payload, &config); err != nil {
		return false, fmt.Errorf("runtimeconfig: configuración ilegible: %w", err)
	}
	if err := AdjustFiatBalance(&config, movement.Coin, movement.Direction, movement.Amount); err != nil {
		return false, err
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		return false, err
	}
	version++
	if _, err := tx.Exec(ctx, `
		UPDATE shadow.runtime_config
		SET config_json = $1::jsonb, version = $2, reason = $3,
		    updated_by = 'fiat-ledger', updated_at = $4
		WHERE id = 1`,
		string(encoded), version, movement.Source, movement.At,
	); err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO shadow.runtime_config_revisions
			(version, config_json, reason, updated_by, created_at)
		VALUES ($1, $2::jsonb, $3, 'fiat-ledger', $4)`,
		version, string(encoded), movement.Source, movement.At,
	); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

// AdjustFiatBalance aplica el movimiento al mercado correspondiente.
func AdjustFiatBalance(config *Config, coin, direction string, amount float64) error {
	if config == nil {
		return errors.New("configuración vacía")
	}
	for index := range config.Markets {
		market := &config.Markets[index]
		if market.Code != coin {
			continue
		}
		switch direction {
		case "debit":
			market.FiatBalance -= amount
		case "credit":
			market.FiatBalance += amount
		default:
			return fmt.Errorf("dirección fiat inválida: %q", direction)
		}
		return nil
	}
	return fmt.Errorf("mercado %q no configurado para movimiento fiat", coin)
}

// RecordOperationFiat registra el movimiento que corresponde al estado remoto
// de una operación. Es idempotente por clave (orden u oferta).
func (repository *Repository) RecordOperationFiat(
	ctx context.Context,
	coin, key, offerType string,
	receive float64,
	status, source string,
	now int64,
) (bool, error) {
	fee, err := repository.marketFee(ctx, coin)
	if err != nil {
		return false, err
	}
	direction, amount, ok := operationFiatMovement(offerType, status, receive, fee)
	if !ok {
		return false, nil
	}
	return repository.ApplyFiatMovement(ctx, FiatMovement{
		Key: key, Coin: coin, Direction: direction, Amount: amount,
		Source: source, At: now,
	})
}

// ReverseOperationFiat revierte un débito previo (cancelación tras pago).
func (repository *Repository) ReverseOperationFiat(
	ctx context.Context,
	coin, key, offerType string,
	receive float64,
	source string,
	now int64,
) (bool, error) {
	fee, err := repository.marketFee(ctx, coin)
	if err != nil {
		return false, err
	}
	amount := receive
	if offerType == "sell" {
		amount += fee
	}
	if amount <= 0 {
		return false, nil
	}
	return repository.ApplyFiatMovement(ctx, FiatMovement{
		Key: "reversal:" + key, Coin: coin, Direction: "credit", Amount: amount,
		Source: source, At: now,
	})
}

// operationFiatMovement traduce el estado remoto a un movimiento fiat.
func operationFiatMovement(offerType, status string, receive, fee float64) (string, float64, bool) {
	if receive <= 0 {
		return "", 0, false
	}
	switch {
	case offerType == "sell" && (status == "paid" || status == "completed"):
		return "debit", receive + fee, true
	case offerType == "buy" && status == "completed":
		return "credit", receive, true
	default:
		return "", 0, false
	}
}

func (repository *Repository) marketFee(ctx context.Context, coin string) (float64, error) {
	config, _, err := repository.Load(ctx)
	if err != nil {
		return 0, err
	}
	for _, market := range config.Markets {
		if market.Code == coin {
			return market.OutgoingTransferFee, nil
		}
	}
	return 0, fmt.Errorf("mercado %q no configurado para movimiento fiat", coin)
}

func validateFiatMovement(movement FiatMovement) error {
	if strings.TrimSpace(movement.Key) == "" {
		return errors.New("movimiento fiat sin clave idempotente")
	}
	if strings.TrimSpace(movement.Coin) == "" {
		return errors.New("movimiento fiat sin mercado")
	}
	if movement.Direction != "debit" && movement.Direction != "credit" {
		return fmt.Errorf("dirección fiat inválida: %q", movement.Direction)
	}
	if movement.Amount <= 0 {
		return fmt.Errorf("importe fiat inválido: %v", movement.Amount)
	}
	if movement.At <= 0 {
		return errors.New("movimiento fiat sin fecha")
	}
	return nil
}
