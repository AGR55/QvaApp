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
	"github.com/AGR55/QvaApp/services/trading-core/internal/core"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/postgres"
)

type hunterConsumer struct {
	pool       *pgxpool.Pool
	logger     *slog.Logger
	worker     string
	config     core.Config
	configErr  error
	shadowRepo *postgres.ShadowRepository
	processed  atomic.Uint64
	allowed    atomic.Uint64
	blocked    atomic.Uint64
	executions atomic.Uint64
	failed     atomic.Uint64
	pending    atomic.Int64
}

type hunterPayload struct {
	OfferUUID string `json:"offerUuid"`
	Coin      string `json:"coin"`
	Side      string `json:"side"`
	Decision  string `json:"decision"`
	Amount    string `json:"amount"`
	Receive   string `json:"receive"`
	Rate      string `json:"rate"`
}

func newHunterConsumer(pool *pgxpool.Pool, logger *slog.Logger) *hunterConsumer {
	worker := strings.TrimSpace(os.Getenv("HUNTER_CONSUMER_WORKER"))
	if worker == "" {
		worker = "trading-core"
	}
	config, configErr := core.LoadConfig(envOrDefault("CORE_CONFIG_FILE", "/config/core-config.json"))
	if configErr != nil {
		logger.Warn("configuración core no disponible; el consumidor fallará eventos", "error", configErr)
	}
	return &hunterConsumer{
		pool: pool, logger: logger, worker: worker, config: config,
		configErr: configErr, shadowRepo: postgres.NewShadowRepository(pool),
	}
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
				consumer.consume(ctx, repository, event)
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

func (consumer *hunterConsumer) consume(
	ctx context.Context,
	repository *postgres.HunterEventRepository,
	event postgres.HunterEvent,
) {
	payload, err := parseHunterPayload(event.PayloadJSON)
	if err != nil {
		consumer.failed.Add(1)
		_ = repository.Fail(ctx, event.EventID, event.Attempts, postgres.NowMS(), err.Error())
		consumer.logger.Warn("evento hunter inválido", "event_id", event.EventID, "error", err)
		return
	}
	if consumer.configErr != nil {
		consumer.failed.Add(1)
		_ = repository.Fail(ctx, event.EventID, event.Attempts, postgres.NowMS(), "configuración core no disponible")
		return
	}
	amount, _ := decimal.Parse(payload.Amount)
	receive, _ := decimal.Parse(payload.Receive)
	rate, _ := decimal.Parse(payload.Rate)
	balance, err := consumer.shadowRepo.LatestQvapayBalance(ctx)
	if err != nil {
		balance = decimal.Zero()
	}
	result, err := core.Decide(core.Event{
		OfferUUID: payload.OfferUUID, Coin: payload.Coin, Side: payload.Side,
		Decision: payload.Decision, Amount: amount, Receive: receive, Rate: rate,
	}, consumer.config, balance, postgres.NowMS())
	if err != nil {
		consumer.failed.Add(1)
		_ = repository.Fail(ctx, event.EventID, event.Attempts, postgres.NowMS(), err.Error())
		consumer.logger.Warn("decisión core falló", "event_id", event.EventID, "error", err)
		return
	}
	checksJSON, _ := json.Marshal(result.Checks)
	reason := strings.Join(result.Reasons, " · ")
	var execution *postgres.CoreExecution
	if result.Allowed {
		simulated, err := core.SimulateExecution(core.ExecutionInput{
			Event: core.Event{
				OfferUUID: payload.OfferUUID, Coin: payload.Coin, Side: payload.Side,
				Decision: payload.Decision, Amount: amount, Receive: receive, Rate: rate,
			},
			Result: result, AvailableQusd: balance,
			ReserveQusd: consumer.config.Limits.MinQusdReserve,
			OperationID: event.EventID,
		})
		if err != nil {
			consumer.failed.Add(1)
			_ = repository.Fail(ctx, event.EventID, event.Attempts, postgres.NowMS(), err.Error())
			consumer.logger.Warn("simulación ledger falló", "event_id", event.EventID, "error", err)
			return
		}
		ledgerJSON, _ := json.Marshal(simulated.LedgerEntries)
		execution = &postgres.CoreExecution{
			OperationID: simulated.OperationID,
			QusdAmount:  simulated.QusdAmount.Format(8), ReserveQusd: simulated.ReserveQusd.Format(8),
			RemainingQusd: simulated.RemainingQusd.Format(8), LedgerJSON: string(ledgerJSON),
			Reason: simulated.Reason, CreatedAt: postgres.NowMS(),
		}
	}
	if err := repository.CompleteWithDecision(ctx, postgres.CoreDecision{
		EventID: event.EventID, OfferUUID: payload.OfferUUID, Coin: payload.Coin,
		Side: payload.Side, HunterDecision: payload.Decision, CoreKind: result.Kind,
		Allowed: result.Allowed, Amount: amount.Format(8), Receive: receive.Format(8),
		Rate: rate.Format(8), Reason: reason, ChecksJSON: string(checksJSON),
		CreatedAt: postgres.NowMS(), Execution: execution,
	}, postgres.NowMS()); err != nil {
		consumer.failed.Add(1)
		_ = repository.Fail(ctx, event.EventID, event.Attempts, postgres.NowMS(), err.Error())
		consumer.logger.Warn("persistir decisión core falló", "event_id", event.EventID, "error", err)
		return
	}
	consumer.processed.Add(1)
	if result.Allowed {
		consumer.allowed.Add(1)
		if execution != nil {
			consumer.executions.Add(1)
		}
	} else {
		consumer.blocked.Add(1)
	}
}

func validateHunterPayload(payload string) error {
	_, err := parseHunterPayload(payload)
	return err
}

func parseHunterPayload(payload string) (hunterPayload, error) {
	var event hunterPayload
	if err := json.Unmarshal([]byte(payload), &event); err != nil {
		return hunterPayload{}, fmt.Errorf("payload inválido: %w", err)
	}
	if strings.TrimSpace(event.OfferUUID) == "" || strings.TrimSpace(event.Coin) == "" {
		return hunterPayload{}, fmt.Errorf("payload sin oferta o mercado")
	}
	if event.Side != "buy" && event.Side != "sell" {
		return hunterPayload{}, fmt.Errorf("side inválido: %q", event.Side)
	}
	if event.Decision != "auto_buy" && event.Decision != "manual_sell" {
		return hunterPayload{}, fmt.Errorf("decision inválida: %q", event.Decision)
	}
	amount, err := decimal.Parse(strings.TrimSpace(event.Amount))
	if err != nil || amount.Sign() <= 0 {
		return hunterPayload{}, fmt.Errorf("amount inválido: %q", event.Amount)
	}
	receive, err := decimal.Parse(strings.TrimSpace(event.Receive))
	if err != nil || receive.Sign() < 0 {
		return hunterPayload{}, fmt.Errorf("receive inválido: %q", event.Receive)
	}
	rate, err := decimal.Parse(strings.TrimSpace(event.Rate))
	if err != nil || rate.Sign() <= 0 {
		return hunterPayload{}, fmt.Errorf("rate inválida: %q", event.Rate)
	}
	return event, nil
}
