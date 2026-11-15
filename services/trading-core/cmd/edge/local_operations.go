package main

import (
	"context"
	"errors"

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

func (mover *runtimeFiatMover) fee(ctx context.Context, coin string) (float64, error) {
	config, _, err := mover.repo.Load(ctx)
	if err != nil {
		return 0, err
	}
	for _, market := range config.Markets {
		if market.Code == coin {
			return market.OutgoingTransferFee, nil
		}
	}
	return 0, errors.New("mercado no configurado para movimiento fiat")
}

func (mover *runtimeFiatMover) DebitOperation(
	ctx context.Context,
	operation edge.OperationRecord,
	key, source string,
	now int64,
) error {
	fee, err := mover.fee(ctx, operation.Coin)
	if err != nil {
		return err
	}
	_, err = mover.repo.ApplyFiatMovement(ctx, runtimeconfig.FiatMovement{
		Key: key, Coin: operation.Coin, Direction: "debit",
		Amount: operation.Receive + fee, Source: source, At: now,
	})
	return err
}

func (mover *runtimeFiatMover) CreditOperation(
	ctx context.Context,
	operation edge.OperationRecord,
	key, source string,
	now int64,
) error {
	_, err := mover.repo.ApplyFiatMovement(ctx, runtimeconfig.FiatMovement{
		Key: key, Coin: operation.Coin, Direction: "credit",
		Amount: operation.Receive, Source: source, At: now,
	})
	return err
}

func (mover *runtimeFiatMover) ReverseOperation(
	ctx context.Context,
	operation edge.OperationRecord,
	key, source string,
	now int64,
) error {
	fee, err := mover.fee(ctx, operation.Coin)
	if err != nil {
		return err
	}
	_, err = mover.repo.ApplyFiatMovement(ctx, runtimeconfig.FiatMovement{
		Key: key, Coin: operation.Coin, Direction: "credit",
		Amount: operation.Receive + fee, Source: source, At: now,
	})
	return err
}
