package main

import (
	"context"
	"log/slog"
	"net/url"
	"time"

	"github.com/AGR55/QvaApp/services/trading-core/internal/edge"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/postgres"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
	"github.com/AGR55/QvaApp/services/trading-core/internal/runtimeconfig"
)

// runOfferRefresh mantiene frescas las ofertas propias, igual que el scheduler
// de TS: una edición como máximo cada spacing y solo cuando la oferta superó
// el intervalo configurado.
func runOfferRefresh(
	ctx context.Context,
	logger *slog.Logger,
	reader *qvapay.Client,
	mutations *qvapay.MutationClient,
	configs *runtimeconfig.Repository,
) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	lastEdit := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		config, _, err := configs.Load(ctx)
		if err != nil {
			continue
		}
		interval := time.Duration(config.Automation.OfferRefreshIntervalMinutes * float64(time.Minute))
		spacing := time.Duration(config.Automation.OfferRefreshSpacingSeconds * float64(time.Second))
		offers, err := reader.Offers(ctx, url.Values{
			"my": {"true"}, "status": {"open"}, "page": {"1"}, "take": {"100"},
		})
		if err != nil {
			logger.Warn("refresco de ofertas: lectura falló", "error", err)
			continue
		}
		next, ok := edge.NextOfferToRefresh(offers, time.Now(), interval, spacing, lastEdit)
		if !ok {
			continue
		}
		if _, err := mutations.EditOffer(ctx, next.UUID, map[string]any{"message": next.Message}); err != nil {
			logger.Warn("refresco de oferta falló", "offer_uuid", next.UUID, "error", err)
			continue
		}
		lastEdit = time.Now()
		logger.Info("oferta propia refrescada", "offer_uuid", next.UUID)
	}
}

// runAutoCancel libera las órdenes que superaron la ventana de pago. Antes de
// cancelar exige que QvaPay siga mostrando la operación en processing.
func runAutoCancel(
	ctx context.Context,
	logger *slog.Logger,
	reader *qvapay.Client,
	mutations *qvapay.MutationClient,
	configs *runtimeconfig.Repository,
	localOps *postgres.LocalOperationRepository,
) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		config, _, err := configs.Load(ctx)
		if err != nil {
			continue
		}
		window := time.Duration(config.Automation.AutoCancelMinutes * float64(time.Minute))
		if window <= 0 {
			continue
		}
		now := time.Now()
		pending, err := localOps.PendingForCancel(ctx, now.Add(-window).UnixMilli())
		if err != nil {
			logger.Warn("autocancelación: no se pudo leer operaciones", "error", err)
			continue
		}
		due := make([]edge.PendingOperation, 0, len(pending))
		for _, operation := range pending {
			due = append(due, edge.PendingOperation{
				UUID: operation.UUID, OrderUUID: operation.OrderUUID,
				Coin: operation.Coin, State: operation.State, CreatedAt: operation.CreatedAt,
			})
		}
		for _, operation := range edge.DueForCancel(due, now, window) {
			offer, err := reader.Offer(ctx, operation.UUID)
			if err != nil {
				logger.Warn("autocancelación: no se pudo leer la oferta",
					"offer_uuid", operation.UUID, "error", err)
				continue
			}
			orderStatus := ""
			if operation.OrderUUID != "" {
				found := false
				for _, order := range offer.Orders {
					if order.UUID == operation.OrderUUID {
						orderStatus = order.Status
						found = true
						break
					}
				}
				if !found {
					continue
				}
			}
			if !edge.ShouldAutoCancel(offer.Status, orderStatus) {
				continue
			}
			if _, err := mutations.Cancel(ctx, operation.UUID, operation.OrderUUID); err != nil {
				logger.Warn("autocancelación rechazada por QvaPay",
					"offer_uuid", operation.UUID, "error", err)
				continue
			}
			if err := localOps.SetState(ctx, operation.UUID, "cancelled", now.UnixMilli()); err != nil {
				logger.Warn("autocancelación aplicada pero no persistida",
					"offer_uuid", operation.UUID, "error", err)
				continue
			}
			logger.Info("operación cancelada por vencimiento", "offer_uuid", operation.UUID)
		}
	}
}
