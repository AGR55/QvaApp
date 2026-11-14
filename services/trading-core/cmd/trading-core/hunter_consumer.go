package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/postgres"
)

type hunterConsumer struct {
	pool      *pgxpool.Pool
	logger    *slog.Logger
	worker    string
	processed atomic.Uint64
	failed    atomic.Uint64
	pending   atomic.Int64
}

type hunterPayload struct {
	OfferUUID string `json:"offerUuid"`
	Coin      string `json:"coin"`
	Side      string `json:"side"`
	Decision  string `json:"decision"`
	Rate      string `json:"rate"`
}

func newHunterConsumer(pool *pgxpool.Pool, logger *slog.Logger) *hunterConsumer {
	worker := strings.TrimSpace(os.Getenv("HUNTER_CONSUMER_WORKER"))
	if worker == "" {
		worker = "trading-core"
	}
	return &hunterConsumer{pool: pool, logger: logger, worker: worker}
}

func (consumer *hunterConsumer) run(ctx context.Context) {
	repository := postgres.NewHunterEventRepository(consumer.pool)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		events, err := repository.Claim(ctx, consumer.worker, postgres.NowMS(), 50)
		if err != nil {
			if ctx.Err() == nil {
				consumer.logger.Warn("claim de hunter_events falló", "error", err)
			}
		} else {
			for _, event := range events {
				if err := validateHunterPayload(event.PayloadJSON); err != nil {
					consumer.failed.Add(1)
					_ = repository.Fail(ctx, event.EventID, event.Attempts, postgres.NowMS(), err.Error())
					consumer.logger.Warn("evento hunter inválido", "event_id", event.EventID, "error", err)
					continue
				}
				if err := repository.Complete(ctx, event.EventID, postgres.NowMS()); err != nil {
					consumer.failed.Add(1)
					_ = repository.Fail(ctx, event.EventID, event.Attempts, postgres.NowMS(), err.Error())
					consumer.logger.Warn("completar evento hunter falló", "event_id", event.EventID, "error", err)
					continue
				}
				consumer.processed.Add(1)
			}
		}
		if pending, err := repository.Pending(ctx); err == nil {
			consumer.pending.Store(pending)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func validateHunterPayload(payload string) error {
	var event hunterPayload
	if err := json.Unmarshal([]byte(payload), &event); err != nil {
		return fmt.Errorf("payload inválido: %w", err)
	}
	if strings.TrimSpace(event.OfferUUID) == "" || strings.TrimSpace(event.Coin) == "" {
		return fmt.Errorf("payload sin oferta o mercado")
	}
	if event.Side != "buy" && event.Side != "sell" {
		return fmt.Errorf("side inválido: %q", event.Side)
	}
	if event.Decision != "auto_buy" && event.Decision != "manual_sell" {
		return fmt.Errorf("decision inválida: %q", event.Decision)
	}
	rate, err := decimal.Parse(strings.TrimSpace(event.Rate))
	if err != nil || rate.Sign() <= 0 {
		return fmt.Errorf("rate inválida: %q", event.Rate)
	}
	return nil
}
