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

type localOperationUpdater interface {
	SetState(ctx context.Context, uuid, state string, now int64) error
}

type operationReconciler struct {
	pool     *pgxpool.Pool
	reader   offerReader
	repo     operationTransitioner
	localOps localOperationUpdater
	logger   *slog.Logger
	now      func() time.Time
}

type uncertainOperation struct {
	operationID string
	offerUUID   string
	orderUUID   string
	state       string
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
	staleBefore := reconciler.timestamp() - 30_000
	rows, err := reconciler.pool.Query(ctx, `
		SELECT o.operation_id, d.offer_uuid, COALESCE(o.order_uuid, ''), o.state
		FROM shadow.core_operations o
		JOIN shadow.core_decisions d ON d.event_id = o.operation_id
		WHERE o.state = 'uncertain'
		   OR (o.state = 'confirmed' AND o.updated_at < $1)
		ORDER BY o.updated_at ASC LIMIT 20`, staleBefore)
	if err != nil {
		return
	}
	defer rows.Close()
	pending := make([]uncertainOperation, 0, 20)
	for rows.Next() {
		var item uncertainOperation
		if rows.Scan(&item.operationID, &item.offerUUID, &item.orderUUID, &item.state) == nil {
			pending = append(pending, item)
		}
	}
	rows.Close()
	for _, item := range pending {
		reconciler.reconcileOne(ctx, item.operationID, item.offerUUID, item.orderUUID, item.state)
	}
}

func (reconciler *operationReconciler) reconcileOne(
	ctx context.Context,
	operationID, offerUUID, orderUUID, coreState string,
) {
	offer, err := reconciler.reader.Offer(ctx, offerUUID)
	if err != nil {
		if reconciler.logger != nil {
			reconciler.logger.Warn("conciliación QvaPay falló", "operation_id", operationID, "error", err)
		}
		return
	}
	status := offer.Status
	if orderUUID != "" {
		found := false
		for _, order := range offer.Orders {
			if order.UUID == orderUUID {
				status = order.Status
				found = true
				break
			}
		}
		if !found {
			if reconciler.logger != nil {
				reconciler.logger.Warn("la orden no aparece en QvaPay; se conserva incierta",
					"operation_id", operationID, "order_uuid", orderUUID)
			}
			return
		}
	}
	target := core.OperationState("")
	switch status {
	case "processing", "paid", "completed", "applied":
		target = core.StateReconciled
	case "open", "cancelled", "canceled", "rejected":
		target = core.StateRejected
	default:
		return
	}
	// Una operación confirmada es terminal en el core; solo se refresca su
	// vista local para que el panel refleje pagos, recepciones o cancelaciones
	// remotas. Las inciertas sí transicionan en el core.
	if coreState != string(core.StateConfirmed) {
		if _, err := reconciler.repo.Transition(ctx, operationID, target, reconciler.timestamp()); err != nil {
			if reconciler.logger != nil {
				reconciler.logger.Warn("transición de conciliación falló", "operation_id", operationID, "state", target, "error", err)
			}
			return
		}
	}
	if reconciler.localOps != nil {
		localState := "reconciled"
		switch status {
		case "paid":
			localState = "paid"
		case "completed":
			localState = "completed"
		case "processing":
			localState = "applied"
		case "open", "cancelled", "canceled", "rejected":
			localState = "cancelled"
		}
		if err := reconciler.localOps.SetState(ctx, offerUUID, localState, reconciler.timestamp()); err != nil &&
			reconciler.logger != nil {
			reconciler.logger.Warn("no se pudo actualizar el estado local", "operation_id", operationID, "error", err)
		}
	}
	if reconciler.logger != nil {
		reconciler.logger.Info("operación conciliada",
			"operation_id", operationID, "state", target, "remote_status", status, "order_uuid", orderUUID)
	}
}

func (reconciler *operationReconciler) timestamp() int64 {
	if reconciler != nil && reconciler.now != nil {
		return reconciler.now().UnixMilli()
	}
	return time.Now().UnixMilli()
}
