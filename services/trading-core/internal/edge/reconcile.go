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
	User(ctx context.Context) (qvapay.User, error)
}

// Reconciler consulta el estado remoto de una oferta/orden y registra la
// comprobación. No ejecuta compensaciones ni mutaciones.
type Reconciler struct {
	Reader ReconcileReader
	Store  MutationStore
	Now    func() time.Time
}

type ReconciliationReport struct {
	UUID        string `json:"uuid"`
	Coin        string `json:"coin,omitempty"`
	OrderUUID   string `json:"orderUuid,omitempty"`
	Status      string `json:"status"`
	Amount      string `json:"amount"`
	Receive     string `json:"receive"`
	Applied     bool   `json:"applied"`
	OwnerUUID   string `json:"ownerUuid,omitempty"`
	PeerUUID    string `json:"peerUuid,omitempty"`
	ProfileUUID string `json:"profileUuid,omitempty"`
	HasDetails  bool   `json:"hasDetails"`
	OfferType   string `json:"offerType,omitempty"`
	OfferKind   string `json:"offerKind,omitempty"`
	Available   string `json:"available,omitempty"`
	OrderMin    string `json:"orderMin,omitempty"`
	OrderMax    string `json:"orderMax,omitempty"`
	CheckedAt   int64  `json:"checkedAt"`
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
	peer := offerPeerUUID(offer)
	if order != "" {
		child := findOrder(offer.Orders, order)
		if child == nil {
			return ReconciliationReport{}, fmt.Errorf("orden no encontrada en QvaPay")
		}
		status = child.Status
		amount = child.Amount
		receive = child.Receive
		peer = offerRawUUID(child.Taker, "uuid")
	}
	profile := ""
	if user, err := reconciler.Reader.User(ctx); err == nil {
		profile = user.UUID
	}
	report := ReconciliationReport{
		UUID: uuid, Coin: offer.Coin, OrderUUID: order, Status: status,
		Amount: amount.Format(8), Receive: receive.Format(8),
		Applied:     status == "processing" || status == "paid" || status == "completed" || status == "applied",
		OwnerUUID:   offerOwnerUUID(offer),
		PeerUUID:    peer,
		ProfileUUID: profile,
		HasDetails:  len(offer.Details) > 0,
		OfferType:   offer.Type,
		OfferKind:   offer.OfferKind,
		Available:   offer.AvailableAmount.Format(8),
		OrderMin:    offer.OrderMin.Format(8),
		OrderMax:    offer.OrderMax.Format(8),
		CheckedAt:   reconciler.now().UnixMilli(),
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
