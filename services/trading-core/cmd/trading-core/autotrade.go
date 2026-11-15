package main

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/core"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

type tradeExecutor interface {
	Apply(ctx context.Context, offerUUID string, amount *decimal.Value) error
}

type qvapayTradeExecutor struct {
	client *qvapay.MutationClient
}

func (executor *qvapayTradeExecutor) Apply(ctx context.Context, offerUUID string, amount *decimal.Value) error {
	_, err := executor.client.Apply(ctx, offerUUID, amount)
	return err
}

type operationTransitioner interface {
	Get(ctx context.Context, id string) (core.Operation, error)
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
		confirmed, err := repository.Transition(ctx, operationID, core.StateConfirmed, trader.timestamp())
		if err != nil {
			return "", err
		}
		if trader.logger != nil {
			trader.logger.Info("autotrade dry-run confirmado", "operation_id", operationID, "offer_uuid", offerUUID)
		}
		return confirmed.State, nil
	}

	if trader.executor == nil {
		return "", errors.New("executor QvaPay no configurado")
	}
	if err := trader.executor.Apply(ctx, offerUUID, &amount); err != nil {
		target := core.StateUncertain
		var mutationError *qvapay.MutationError
		if errors.As(err, &mutationError) && mutationError.Status >= 400 && mutationError.Status < 500 {
			target = core.StateRejected
		}
		if _, transitionErr := repository.Transition(ctx, operationID, target, trader.timestamp()); transitionErr != nil {
			return "", errors.Join(err, transitionErr)
		}
		if trader.logger != nil {
			trader.logger.Warn("aplicación QvaPay falló", "operation_id", operationID, "state", target, "error", err)
		}
		return target, nil
	}
	confirmed, err := repository.Transition(ctx, operationID, core.StateConfirmed, trader.timestamp())
	if err != nil {
		return "", err
	}
	if trader.logger != nil {
		trader.logger.Info("aplicación QvaPay confirmada", "operation_id", operationID, "offer_uuid", offerUUID)
	}
	return confirmed.State, nil
}

func (trader *autoTrader) timestamp() int64 {
	if trader.now != nil {
		return trader.now().UnixMilli()
	}
	return time.Now().UnixMilli()
}
