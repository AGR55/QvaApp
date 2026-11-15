package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/core"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

type tradeExecutor interface {
	Apply(ctx context.Context, offerUUID string, amount *decimal.Value) (string, error)
}

type qvapayTradeExecutor struct {
	client *qvapay.MutationClient
}

// Apply envía la orden flexible y exige que QvaPay devuelva el UUID de la
// orden, el importe solicitado exacto y una recepción positiva. Si la respuesta
// no coincide, la operación queda incierta: el dinero pudo haberse movido.
func (executor *qvapayTradeExecutor) Apply(ctx context.Context, offerUUID string, amount *decimal.Value) (string, error) {
	result, err := executor.client.Apply(ctx, offerUUID, amount)
	if err != nil {
		return "", err
	}
	decoder := json.NewDecoder(bytes.NewReader(result.Body))
	decoder.UseNumber()
	var body struct {
		Order   string      `json:"order"`
		Amount  json.Number `json:"amount"`
		Receive json.Number `json:"receive"`
	}
	if len(result.Body) > 0 {
		if err := decoder.Decode(&body); err != nil {
			return "", fmt.Errorf("respuesta de aplicación inválida: %w", err)
		}
	}
	order := strings.TrimSpace(body.Order)
	if order == "" {
		return "", errors.New("QvaPay no devolvió el UUID de la orden")
	}
	if amount == nil {
		return "", errors.New("aplicación sin importe solicitado")
	}
	applied, err := decimal.Parse(body.Amount.String())
	if err != nil || applied.Cmp(*amount) != 0 {
		return "", fmt.Errorf("QvaPay aplicó %q y se solicitaron %s", body.Amount.String(), amount.Format(8))
	}
	receive, err := decimal.Parse(body.Receive.String())
	if err != nil || receive.Sign() <= 0 {
		return "", errors.New("QvaPay no devolvió una recepción positiva")
	}
	return order, nil
}

type operationTransitioner interface {
	Get(ctx context.Context, id string) (core.Operation, error)
	SetOrder(ctx context.Context, id, orderUUID string) error
	Transition(ctx context.Context, id string, state core.OperationState, now int64) (core.Operation, error)
}

// autoTrader ejecuta el ciclo reserved -> submitted -> confirmed/rejected/
// uncertain. En dry-run no llama a QvaPay y deja la operación confirmada como
// simulación explícita.
type autoTrader struct {
	executor tradeExecutor
	dryRun   bool
	logger   *slog.Logger
	now      func() time.Time
}

func (trader *autoTrader) Execute(
	ctx context.Context,
	repository operationTransitioner,
	operationID, offerUUID string,
	amount decimal.Value,
) (core.OperationState, error) {
	if trader == nil {
		return "", errors.New("autotrader no configurado")
	}
	operation, err := repository.Get(ctx, operationID)
	if err != nil {
		return "", err
	}
	switch operation.State {
	case core.StateConfirmed, core.StateRejected, core.StateReconciled:
		return operation.State, nil
	case core.StateUncertain:
		return operation.State, nil
	case core.StateReserved:
		operation, err = repository.Transition(ctx, operationID, core.StateSubmitted, trader.timestamp())
		if err != nil {
			return "", err
		}
	case core.StateSubmitted:
	default:
		return "", errors.New("operación en estado no aplicable")
	}

	if trader.dryRun {
		simulated, err := repository.Transition(ctx, operationID, core.StateDryRun, trader.timestamp())
		if err != nil {
			return "", err
		}
		if trader.logger != nil {
			trader.logger.Info("autotrade dry-run simulado", "operation_id", operationID, "offer_uuid", offerUUID)
		}
		return simulated.State, nil
	}

	if trader.executor == nil {
		return "", errors.New("executor QvaPay no configurado")
	}
	orderUUID, applyErr := trader.executor.Apply(ctx, offerUUID, &amount)
	if applyErr != nil {
		target := core.StateUncertain
		var mutationError *qvapay.MutationError
		if errors.As(applyErr, &mutationError) && mutationError.Status >= 400 && mutationError.Status < 500 {
			target = core.StateRejected
		}
		if _, transitionErr := repository.Transition(ctx, operationID, target, trader.timestamp()); transitionErr != nil {
			return "", errors.Join(applyErr, transitionErr)
		}
		if trader.logger != nil {
			trader.logger.Warn("aplicación QvaPay falló", "operation_id", operationID, "state", target, "error", applyErr)
		}
		return target, nil
	}
	if err := repository.SetOrder(ctx, operationID, orderUUID); err != nil {
		// La orden existe en QvaPay pero no se pudo persistir: se marca incierta
		// para que el conciliador la resuelva con la referencia remota.
		if _, transitionErr := repository.Transition(ctx, operationID, core.StateUncertain, trader.timestamp()); transitionErr != nil {
			return "", errors.Join(err, transitionErr)
		}
		return core.StateUncertain, err
	}
	confirmed, err := repository.Transition(ctx, operationID, core.StateConfirmed, trader.timestamp())
	if err != nil {
		return "", err
	}
	if trader.logger != nil {
		trader.logger.Info("aplicación QvaPay confirmada",
			"operation_id", operationID, "offer_uuid", offerUUID, "order_uuid", orderUUID)
	}
	return confirmed.State, nil
}

func (trader *autoTrader) timestamp() int64 {
	if trader.now != nil {
		return trader.now().UnixMilli()
	}
	return time.Now().UnixMilli()
}
