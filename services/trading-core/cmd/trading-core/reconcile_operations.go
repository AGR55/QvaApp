package main

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/trading-core/internal/core"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

type offerReader interface {
	Offer(ctx context.Context, uuid string) (qvapay.Offer, error)
}

type operationReconciler struct {
	pool   *pgxpool.Pool
	reader offerReader
	repo   operationTransitioner
	logger *slog.Logger
	now    func() time.Time
}

type uncertainOperation struct {
	operationID string
	offerUUID   string
}

func (reconciler *operationReconciler) loop(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		reconciler.runOnce(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (reconciler *operationReconciler) runOnce(ctx context.Context) {
	if reconciler == nil || reconciler.pool == nil || reconciler.reader == nil || reconciler.repo == nil {
		return
	}
	rows, err := reconciler.pool.Query(ctx, `
		SELECT o.operation_id, d.offer_uuid
		FROM shadow.core_operations o
		JOIN shadow.core_decisions d ON d.event_id = o.operation_id
		WHERE o.state = 'uncertain'
		ORDER BY o.updated_at ASC LIMIT 20`)
	if err != nil {
		return
	}
	defer rows.Close()
	pending := make([]uncertainOperation, 0, 20)
	for rows.Next() {
		var item uncertainOperation
		if rows.Scan(&item.operationID, &item.offerUUID) == nil {
			pending = append(pending, item)
		}
	}
	rows.Close()
	for _, item := range pending {
		reconciler.reconcileOne(ctx, item.operationID, item.offerUUID)
	}
}

func (reconciler *operationReconciler) reconcileOne(ctx context.Context, operationID, offerUUID string) {
	offer, err := reconciler.reader.Offer(ctx, offerUUID)
	if err != nil {
		if reconciler.logger != nil {
			reconciler.logger.Warn("conciliación QvaPay falló", "operation_id", operationID, "error", err)
		}
		return
	}
	target := core.OperationState("")
	switch offer.Status {
	case "processing", "paid", "completed", "applied":
		target = core.StateReconciled
	case "open", "cancelled", "canceled", "rejected":
		target = core.StateRejected
	default:
		return
	}
	if _, err := reconciler.repo.Transition(ctx, operationID, target, reconciler.timestamp()); err != nil {
		if reconciler.logger != nil {
			reconciler.logger.Warn("transición de conciliación falló", "operation_id", operationID, "state", target, "error", err)
		}
		return
	}
	if reconciler.logger != nil {
		reconciler.logger.Info("operación conciliada", "operation_id", operationID, "state", target, "remote_status", offer.Status)
	}
}

func (reconciler *operationReconciler) timestamp() int64 {
	if reconciler != nil && reconciler.now != nil {
		return reconciler.now().UnixMilli()
	}
	return time.Now().UnixMilli()
}
