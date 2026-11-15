package edge

import (
	"context"
	"fmt"
	"time"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

// ReconcileReader es la lectura QvaPay necesaria para conciliar una mutación.
type ReconcileReader interface {
	Offer(ctx context.Context, uuid string) (qvapay.Offer, error)
}

// Reconciler consulta el estado remoto de una oferta/orden y registra la
// comprobación. No ejecuta compensaciones ni mutaciones.
type Reconciler struct {
	Reader ReconcileReader
	Store  MutationStore
	Now    func() time.Time
}

type ReconciliationReport struct {
	UUID      string `json:"uuid"`
	OrderUUID string `json:"orderUuid,omitempty"`
	Status    string `json:"status"`
	Amount    string `json:"amount"`
	Receive   string `json:"receive"`
	Applied   bool   `json:"applied"`
	CheckedAt int64  `json:"checkedAt"`
}

func (reconciler *Reconciler) Check(ctx context.Context, uuid, order string) (ReconciliationReport, error) {
	if reconciler == nil || reconciler.Reader == nil {
		return ReconciliationReport{}, fmt.Errorf("conciliación no disponible")
	}
	offer, err := reconciler.Reader.Offer(ctx, uuid)
	if err != nil {
		return ReconciliationReport{}, err
	}
	status := offer.Status
	amount := offer.Amount
	receive := offer.Receive
	if order != "" {
		child := findOrder(offer.Orders, order)
		if child == nil {
			return ReconciliationReport{}, fmt.Errorf("orden no encontrada en QvaPay")
		}
		status = child.Status
		amount = child.Amount
		receive = child.Receive
	}
	report := ReconciliationReport{
		UUID: uuid, OrderUUID: order, Status: status,
		Amount: amount.Format(8), Receive: receive.Format(8),
		Applied:   status == "processing" || status == "paid" || status == "completed" || status == "applied",
		CheckedAt: reconciler.now().UnixMilli(),
	}
	if reconciler.Store != nil {
		payload := []byte(fmt.Sprintf(`{"status":%q,"applied":%t}`, status, report.Applied))
		_ = reconciler.Store.Record(ctx, "reconciliation_checked", uuid, payload, "panel", report.CheckedAt)
	}
	return report, nil
}

func (reconciler *Reconciler) now() time.Time {
	if reconciler != nil && reconciler.Now != nil {
		return reconciler.Now()
	}
	return time.Now()
}
