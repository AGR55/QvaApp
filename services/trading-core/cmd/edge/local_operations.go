package main

import (
	"context"

	"github.com/AGR55/QvaApp/services/trading-core/internal/edge"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/postgres"
	"github.com/AGR55/QvaApp/services/trading-core/internal/runtimeconfig"
)

// localOperationAdapter expone shadow.local_operations al edge.
type localOperationAdapter struct {
	repo *postgres.LocalOperationRepository
}

func (adapter *localOperationAdapter) Get(
	ctx context.Context,
	uuid string,
) (edge.OperationRecord, bool, error) {
	operation, found, err := adapter.repo.Get(ctx, uuid)
	if err != nil || !found {
		return edge.OperationRecord{}, found, err
	}
	return edge.OperationRecord{
		UUID: operation.UUID, OfferType: operation.OfferType, Coin: operation.Coin,
		State: operation.State, OrderUUID: operation.OrderUUID,
		Amount: operation.Amount, Receive: operation.Receive, Rate: operation.Rate,
	}, true, nil
}

func (adapter *localOperationAdapter) SetState(
	ctx context.Context,
	uuid, state string,
	now int64,
) error {
	return adapter.repo.SetState(ctx, uuid, state, now)
}

// runtimeFiatMover aplica movimientos fiat al runtime config y al ledger.
type runtimeFiatMover struct {
	repo *runtimeconfig.Repository
}

func (mover *runtimeFiatMover) DebitOperation(
	ctx context.Context,
	operation edge.OperationRecord,
	key, source string,
	now int64,
) error {
	_, err := mover.repo.RecordOperationFiat(ctx, operation.Coin, key, "sell",
		operation.Receive, "paid", source, now)
	return err
}

func (mover *runtimeFiatMover) CreditOperation(
	ctx context.Context,
	operation edge.OperationRecord,
	key, source string,
	now int64,
) error {
	_, err := mover.repo.RecordOperationFiat(ctx, operation.Coin, key, "buy",
		operation.Receive, "completed", source, now)
	return err
}

func (mover *runtimeFiatMover) ReverseOperation(
	ctx context.Context,
	operation edge.OperationRecord,
	key, source string,
	now int64,
) error {
	_, err := mover.repo.ReverseOperationFiat(ctx, operation.Coin, key, "sell",
		operation.Receive, source, now)
	return err
}
