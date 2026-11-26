package main

import (
	"context"
	"fmt"
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
		if enabled, found, err := configs.SettingBool(ctx, "control.refresh"); err == nil && found && !enabled {
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
type autoCancelReader interface {
	Offer(ctx context.Context, uuid string) (qvapay.Offer, error)
}

type autoCancelMutator interface {
	Cancel(ctx context.Context, uuid, order string) (qvapay.MutationResult, error)
}

type autoCancelLocalOps interface {
	SetState(ctx context.Context, uuid, state string, now int64) error
}

type autoCancelExclusions interface {
	ExcludeOffer(ctx context.Context, uuid, source string, now int64) error
}

func runAutoCancel(
	ctx context.Context,
	logger *slog.Logger,
	reader *qvapay.Client,
	mutations *qvapay.MutationClient,
	configs *runtimeconfig.Repository,
	localOps *postgres.LocalOperationRepository,
	exclusions *postgres.OfferExclusionRepository,
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
			if err := cancelExpiredOperation(
				ctx, logger, reader, mutations, localOps, exclusions, operation, now,
			); err != nil {
				logger.Warn("autocancelación no aplicada",
					"offer_uuid", operation.UUID, "error", err)
			}
		}
	}
}

// cancelExpiredOperation excluye la oferta antes de cancelarla: una orden
// vencida no debe volver a ser tomada automáticamente por el bot.
func cancelExpiredOperation(
	ctx context.Context,
	logger *slog.Logger,
	reader autoCancelReader,
	mutations autoCancelMutator,
	localOps autoCancelLocalOps,
	exclusions autoCancelExclusions,
	operation edge.PendingOperation,
	now time.Time,
) error {
	offer, err := reader.Offer(ctx, operation.UUID)
	if err != nil {
		return fmt.Errorf("leer oferta: %w", err)
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
			return fmt.Errorf("orden %s no encontrada", operation.OrderUUID)
		}
	}
	if !edge.ShouldAutoCancel(offer.Status, orderStatus) {
		return nil
	}
	if exclusions != nil {
		if err := exclusions.ExcludeOffer(ctx, operation.UUID, "auto_cancel", now.UnixMilli()); err != nil {
			return fmt.Errorf("registrar exclusión: %w", err)
		}
	}
	if _, err := mutations.Cancel(ctx, operation.UUID, operation.OrderUUID); err != nil {
		return fmt.Errorf("QvaPay rechazó la cancelación: %w", err)
	}
	if err := localOps.SetState(ctx, operation.UUID, "cancelled", now.UnixMilli()); err != nil {
		return fmt.Errorf("persistir estado cancelado: %w", err)
	}
	if logger != nil {
		logger.Info("operación cancelada por vencimiento y oferta excluida", "offer_uuid", operation.UUID)
	}
	return nil
}
