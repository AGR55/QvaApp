package edge

import (
	"context"
	"errors"
	"log/slog"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

// FiatSyncReader son las lecturas QvaPay necesarias para conciliar las órdenes
// hijas de ofertas por rango.
type FiatSyncReader interface {
	User(ctx context.Context) (qvapay.User, error)
	Offers(ctx context.Context, params url.Values) ([]qvapay.Offer, error)
	Offer(ctx context.Context, uuid string) (qvapay.Offer, error)
}

// FiatSyncRecorder registra un movimiento fiat idempotente por UUID de orden.
type FiatSyncRecorder interface {
	RecordOperationFiat(
		ctx context.Context,
		coin, key, offerType string,
		receive float64,
		status, source string,
		now int64,
	) (bool, error)
}

// FiatSyncer concilia las órdenes hijas de ofertas por rango (propias y
// tomadas como contraparte). Cada orden aporta su propio importe fiat; la
// oferta padre no sirve porque varias órdenes comparten el mismo UUID.
type FiatSyncer struct {
	Reader    FiatSyncReader
	Recorder  FiatSyncRecorder
	StartedAt func(ctx context.Context) int64
	Logger    *slog.Logger
	Now       func() time.Time

	hydratedAt map[string]time.Time
}

const (
	fiatSyncInterval = 30 * time.Second
	fiatHydrateAfter = 60 * time.Second
	fiatHydrateLimit = 3
)

// Run ejecuta la conciliación mientras el contexto siga vivo.
func (syncer *FiatSyncer) Run(ctx context.Context) {
	if syncer == nil || syncer.Reader == nil || syncer.Recorder == nil {
		return
	}
	if syncer.hydratedAt == nil {
		syncer.hydratedAt = map[string]time.Time{}
	}
	ticker := time.NewTicker(fiatSyncInterval)
	defer ticker.Stop()
	for {
		if _, err := syncer.Sync(ctx); err != nil && ctx.Err() == nil && syncer.Logger != nil {
			syncer.Logger.Warn("conciliación fiat de ofertas por rango falló", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// Sync recorre las ofertas propias y las que tenemos como contraparte. Devuelve
// cuántos movimientos nuevos se registraron.
func (syncer *FiatSyncer) Sync(ctx context.Context) (int, error) {
	if syncer == nil || syncer.Reader == nil || syncer.Recorder == nil {
		return 0, errors.New("conciliador fiat no configurado")
	}
	if syncer.hydratedAt == nil {
		syncer.hydratedAt = map[string]time.Time{}
	}
	started := syncer.now().UnixMilli()
	if syncer.StartedAt != nil {
		started = syncer.StartedAt(ctx)
	}
	if started <= 0 {
		return 0, errors.New("fecha base del ledger fiat no disponible")
	}
	profile, err := syncer.Reader.User(ctx)
	if err != nil {
		return 0, err
	}
	ownUUID := strings.TrimSpace(profile.UUID)
	if ownUUID == "" {
		return 0, errors.New("QvaPay no devolvió el UUID del perfil")
	}
	base := url.Values{
		"take": {"50"}, "page": {"1"},
		"orderBy": {"updated_at"}, "orderType": {"desc"},
	}
	createdParams := cloneValues(base)
	createdParams.Set("my", "true")
	peerParams := cloneValues(base)
	peerParams.Set("peer", ownUUID)
	created, createdErr := syncer.Reader.Offers(ctx, createdParams)
	asPeer, peerErr := syncer.Reader.Offers(ctx, peerParams)
	if createdErr != nil && peerErr != nil {
		return 0, errors.Join(createdErr, peerErr)
	}
	offers := make(map[string]qvapay.Offer, len(created)+len(asPeer))
	for _, offer := range append(created, asPeer...) {
		if offer.UUID != "" {
			offers[offer.UUID] = offer
		}
	}
	movements := 0
	hydrations := 0
	for _, listed := range offers {
		if listed.OfferKind != "flexible" {
			continue
		}
		offer := listed
		if len(offer.Orders) == 0 {
			if hydrations >= fiatHydrateLimit || !syncer.shouldHydrate(offer.UUID) {
				continue
			}
			hydrations++
			detail, err := syncer.Reader.Offer(ctx, offer.UUID)
			if err != nil {
				if syncer.Logger != nil {
					syncer.Logger.Warn("no se pudo leer el detalle de la oferta por rango",
						"offer_uuid", offer.UUID, "error", err)
				}
				continue
			}
			offer = detail
		}
		if offer.OfferKind != "flexible" || len(offer.Orders) == 0 {
			continue
		}
		creator := offerOwnerUUID(offer) == ownUUID
		for _, order := range offer.Orders {
			taker := offerRawUUID(order.Taker, "uuid") == ownUUID
			if !creator && !taker {
				continue
			}
			status := strings.ToLower(strings.TrimSpace(order.Status))
			paysFiat := creator && offer.Type == "buy" || taker && offer.Type == "sell"
			receivesFiat := creator && offer.Type == "sell" || taker && offer.Type == "buy"
			needsDebit := paysFiat && (status == "paid" || status == "completed")
			needsCredit := receivesFiat && status == "completed"
			if !needsDebit && !needsCredit {
				continue
			}
			occurredAt := orderOccurredAt(order, needsDebit)
			if occurredAt <= 0 || occurredAt < started {
				continue
			}
			amount, err := strconv.ParseFloat(order.Receive.Format(8), 64)
			if err != nil || amount <= 0 {
				continue
			}
			movementType := "buy"
			if needsDebit {
				movementType = "sell"
			}
			changed, err := syncer.Recorder.RecordOperationFiat(
				ctx, offer.Coin, order.UUID, movementType, amount, status,
				"Conciliación QvaPay de oferta por rango", syncer.now().UnixMilli(),
			)
			if err != nil {
				return movements, err
			}
			if changed {
				movements++
				if syncer.Logger != nil {
					syncer.Logger.Info("movimiento fiat de orden por rango registrado",
						"offer_uuid", offer.UUID, "order_uuid", order.UUID,
						"coin", offer.Coin, "status", status, "amount", amount,
						"direction", movementType)
				}
			}
		}
	}
	return movements, nil
}

func (syncer *FiatSyncer) shouldHydrate(uuid string) bool {
	now := syncer.now()
	if at, ok := syncer.hydratedAt[uuid]; ok && now.Sub(at) < fiatHydrateAfter {
		return false
	}
	syncer.hydratedAt[uuid] = now
	return true
}

func (syncer *FiatSyncer) now() time.Time {
	if syncer != nil && syncer.Now != nil {
		return syncer.Now()
	}
	return time.Now()
}

func orderOccurredAt(order qvapay.OfferOrder, paidMovement bool) int64 {
	if paidMovement && order.PaidAt > 0 {
		return order.PaidAt
	}
	if order.ReleasedAt > 0 {
		return order.ReleasedAt
	}
	if order.UpdatedAt > 0 {
		return order.UpdatedAt
	}
	return order.CreatedAt
}

func cloneValues(values url.Values) url.Values {
	clone := make(url.Values, len(values))
	for key, items := range values {
		clone[key] = append([]string(nil), items...)
	}
	return clone
}
