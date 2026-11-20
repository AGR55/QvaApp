package main

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/trading-core/internal/core"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/postgres"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

type offerReader interface {
	Offer(ctx context.Context, uuid string) (qvapay.Offer, error)
	User(ctx context.Context) (qvapay.User, error)
}

type localOperationStore interface {
	Get(ctx context.Context, uuid string) (postgres.LocalOperation, bool, error)
	SetState(ctx context.Context, uuid, state string, now int64) error
}

type operationFiat interface {
	RecordOperationFiat(ctx context.Context, coin, key, offerType string, receive float64, status, source string, now int64) (bool, error)
	ReverseOperationFiat(ctx context.Context, coin, key, offerType string, receive float64, source string, now int64) (bool, error)
}

type operationExclusionStore interface {
	ExcludeOffer(ctx context.Context, offerUUID, source string, now int64) error
}

type operationReconciler struct {
	pool       *pgxpool.Pool
	reader     offerReader
	repo       operationTransitioner
	localOps   localOperationStore
	fiat       operationFiat
	exclusions operationExclusionStore
	notifier   *operationNotifier
	logger     *slog.Logger
	now        func() time.Time
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
		   OR (o.state = 'confirmed' AND o.updated_at < $1
		       AND EXISTS (
		         SELECT 1 FROM shadow.local_operations l
		         WHERE l.uuid = d.offer_uuid AND l.state IN ('applied', 'paid')
		       ))
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
	// En ofertas por rango el importe fiat pertenece a la orden hija, no a la
	// oferta padre: varias órdenes comparten el mismo UUID de oferta.
	orderReceive := offer.Receive
	if orderUUID != "" {
		found := false
		for _, order := range offer.Orders {
			if order.UUID == orderUUID {
				status = order.Status
				orderReceive = order.Receive
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
		now := reconciler.timestamp()
		local, found, err := reconciler.localOps.Get(ctx, offerUUID)
		if err != nil {
			if reconciler.logger != nil {
				reconciler.logger.Warn("no se pudo leer la operación local", "operation_id", operationID, "error", err)
			}
			return
		}
		if found && reconciler.fiat != nil {
			key := orderUUID
			if key == "" {
				key = offerUUID
			}
			fiatReceive := local.Receive
			if orderUUID != "" {
				fiatReceive = decimalFloat(orderReceive)
			}
			normalized := strings.ToLower(status)
			// Una cancelación observada mientras la operación seguía activa
			// se trata como manual: no se vuelve a cazar esa oferta.
			if reconciler.exclusions != nil &&
				(local.State == "applied" || local.State == "paid") &&
				(normalized == "open" || normalized == "cancelled" || normalized == "canceled" || normalized == "rejected") {
				if err := reconciler.exclusions.ExcludeOffer(ctx, offerUUID, "remote_cancel", now); err != nil &&
					reconciler.logger != nil {
					reconciler.logger.Warn("no se pudo excluir la oferta cancelada",
						"operation_id", operationID, "error", err)
				}
			}
			var fiatErr error
			switch {
			case local.OfferType == "sell" && (normalized == "paid" || normalized == "completed"):
				_, fiatErr = reconciler.fiat.RecordOperationFiat(
					ctx, local.Coin, key, "sell", fiatReceive, normalized,
					"Conciliación QvaPay", now)
			case local.OfferType == "buy" && normalized == "completed":
				_, fiatErr = reconciler.fiat.RecordOperationFiat(
					ctx, local.Coin, key, "buy", fiatReceive, normalized,
					"Conciliación QvaPay", now)
			case local.OfferType == "sell" && local.State == "paid" &&
				(normalized == "open" || normalized == "cancelled" || normalized == "canceled" || normalized == "rejected"):
				_, fiatErr = reconciler.fiat.ReverseOperationFiat(
					ctx, local.Coin, key, "sell", fiatReceive,
					"Reversión por cancelación QvaPay", now)
			}
			if fiatErr != nil {
				if reconciler.logger != nil {
					reconciler.logger.Warn("no se pudo registrar el movimiento fiat",
						"operation_id", operationID, "error", fiatErr)
				}
				return
			}
		}
		if found {
			previousState := local.State
			localState := "reconciled"
			switch normalizedStatus(status) {
			case "paid":
				localState = "paid"
			case "completed":
				localState = "completed"
			case "processing":
				localState = "applied"
			case "open", "cancelled", "canceled", "rejected":
				localState = "cancelled"
			}
			if err := reconciler.localOps.SetState(ctx, offerUUID, localState, now); err != nil &&
				reconciler.logger != nil {
				reconciler.logger.Warn("no se pudo actualizar el estado local", "operation_id", operationID, "error", err)
			}
			if localState == "completed" && previousState != "completed" {
				notifyKey := orderUUID
				if notifyKey == "" {
					notifyKey = offerUUID
				}
				reconciler.notifyCompleted(ctx, local, notifyKey)
			}
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

func normalizedStatus(status string) string {
	return strings.ToLower(strings.TrimSpace(status))
}

func (reconciler *operationReconciler) notifyCompleted(ctx context.Context, local postgres.LocalOperation, key string) {
	if reconciler.notifier == nil {
		return
	}
	link := local.UUID
	if local.OrderUUID != "" {
		link = local.OrderUUID
	}
	var builder strings.Builder
	if local.OfferType == "buy" {
		builder.WriteString("✅ P2P Completado - Fiat Recibido\n\n")
		fmt.Fprintf(&builder, "💵 Monto recibido: %s %s\n", formatFloat(local.Receive), marketCurrency(local.Coin))
		fmt.Fprintf(&builder, "🪙 QUSD entregado: %s\n", formatFloat(local.Amount))
	} else {
		builder.WriteString("✅ P2P Completado - Fondos Recibidos\n\n")
		fmt.Fprintf(&builder, "💰 Monto recibido: %s QUSD\n", formatFloat(local.Amount))
		fmt.Fprintf(&builder, "💵 Fiat enviado: %s %s\n", formatFloat(local.Receive), marketCurrency(local.Coin))
	}
	fmt.Fprintf(&builder, "🪙 Moneda: %s\n", local.Coin)
	if local.CounterpartyID != "" {
		fmt.Fprintf(&builder, "👤 Contraparte: %s\n", local.CounterpartyID)
	}
	fmt.Fprintf(&builder, "🆔 ID: %s\n", local.UUID)
	fmt.Fprintf(&builder, "🔗 https://qvapay.com/p2p/%s", link)
	if err := reconciler.notifier.Send(ctx, builder.String(), "completed:"+key); err != nil && reconciler.logger != nil {
		reconciler.logger.Warn("no se pudo notificar la operación completada", "offer_uuid", local.UUID, "error", err)
	}
}

func formatFloat(value float64) string {
	return strconv.FormatFloat(value, 'f', 2, 64)
}
