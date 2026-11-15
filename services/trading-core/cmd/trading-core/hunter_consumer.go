package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/core"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/postgres"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/vault"
	"github.com/AGR55/QvaApp/services/trading-core/internal/runtimeconfig"
)

type hunterConsumer struct {
	pool *pgxpool.Pool
	// configMu protege config y configErr: reloadRuntime reemplaza el snapshot
	// mientras consume lo lee desde otro goroutine.
	configMu       sync.RWMutex
	config         core.Config
	configErr      error
	runtime        *runtimeconfig.Repository
	runtimeAt      atomic.Int64
	runtimeVersion atomic.Int64
	logger         *slog.Logger
	worker         string
	shadowRepo     *postgres.ShadowRepository
	operationRepo  *postgres.CoreOperationRepository
	processed      atomic.Uint64
	allowed        atomic.Uint64
	blocked        atomic.Uint64
	executions     atomic.Uint64
	operations     atomic.Uint64
	failed         atomic.Uint64
	pending        atomic.Int64
	applied        atomic.Uint64
	trader         *autoTrader
	reconciler     *operationReconciler
}

type hunterPayload struct {
	OfferUUID string `json:"offerUuid"`
	Coin      string `json:"coin"`
	Side      string `json:"side"`
	Decision  string `json:"decision"`
	Amount    string `json:"amount"`
	Receive   string `json:"receive"`
	Rate      string `json:"rate"`
	// Metadatos de ofertas por rango: el core dimensiona el importe antes de
	// decidir en vez de aplicar el total publicado.
	OfferKind string `json:"offerKind,omitempty"`
	Available string `json:"available,omitempty"`
	OrderMin  string `json:"orderMin,omitempty"`
	OrderMax  string `json:"orderMax,omitempty"`
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
	consumer := &hunterConsumer{
		pool: pool, logger: logger, worker: worker, config: config,
		configErr: configErr, runtime: &runtimeconfig.Repository{Pool: pool},
		shadowRepo:    postgres.NewShadowRepository(pool),
		operationRepo: postgres.NewCoreOperationRepository(pool),
	}
	consumer.trader = buildAutoTrader(logger)
	if token, ok := decryptQvaToken(logger); ok {
		if reader, err := qvapay.New(envOrDefault("QVAPAY_API_BASE_URL", "https://api.qvapay.com"), token); err == nil {
			consumer.reconciler = &operationReconciler{
				pool: pool, reader: reader, repo: consumer.operationRepo, logger: logger,
			}
			logger.Info("conciliador QvaPay habilitado")
		} else {
			logger.Warn("conciliador QvaPay deshabilitado", "error", err)
		}
	}
	return consumer
}

func decryptQvaToken(logger *slog.Logger) (string, bool) {
	tokenCipher := strings.TrimSpace(os.Getenv("QVA_TOKEN_CIPHERTEXT"))
	key := strings.TrimSpace(os.Getenv("LOCAL_ENCRYPTION_KEY"))
	if tokenCipher == "" || key == "" {
		return "", false
	}
	vaultClient, err := vault.New(key)
	if err != nil {
		logger.Warn("token QvaPay no disponible: clave inválida", "error", err)
		return "", false
	}
	token, err := vaultClient.Decrypt(tokenCipher)
	if err != nil {
		logger.Warn("token QvaPay no disponible: descifrado falló", "error", err)
		return "", false
	}
	return token, true
}

func buildAutoTrader(logger *slog.Logger) *autoTrader {
	enabled, _ := strconv.ParseBool(strings.TrimSpace(os.Getenv("CORE_AUTOTRADE")))
	if !enabled {
		return nil
	}
	dryRun := true
	if raw := strings.TrimSpace(os.Getenv("CORE_AUTOTRADE_DRY_RUN")); raw != "" {
		parsed, err := strconv.ParseBool(raw)
		if err != nil {
			logger.Warn("CORE_AUTOTRADE_DRY_RUN inválido; se usa true", "error", err)
		} else {
			dryRun = parsed
		}
	}
	trader := &autoTrader{dryRun: dryRun, logger: logger}
	if dryRun {
		logger.Info("autotrade habilitado en dry-run")
		return trader
	}
	token, ok := decryptQvaToken(logger)
	if !ok {
		logger.Warn("autotrade live deshabilitado: token no disponible")
		return nil
	}
	client := qvapay.NewMutationClient(envOrDefault("QVAPAY_API_BASE_URL", "https://api.qvapay.com"), token)
	client.Enable()
	trader.executor = &qvapayTradeExecutor{client: client}
	logger.Info("autotrade LIVE habilitado")
	return trader
}

func (consumer *hunterConsumer) run(ctx context.Context) {
	repository := postgres.NewHunterEventRepository(consumer.pool)
	if consumer.reconciler != nil {
		go consumer.reconciler.loop(ctx)
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		consumer.reloadRuntime(ctx, time.Now())
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
	// La configuración del panel puede cambiar en cualquier momento; se
	// refresca (con throttle) antes de decidir con el snapshot vigente.
	consumer.reloadRuntime(ctx, time.Now())
	config, configErr := consumer.configSnapshot()
	if configErr != nil {
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
	nowMS := postgres.NowMS()
	usage := consumer.currentUsage(ctx, nowMS)
	sizedAmount, sizedReceive, sized, sizeReason := sizePayloadAmount(payload, config, usage, rate)
	if sized {
		if sizedAmount.Sign() <= 0 {
			consumer.persistBlockedEvent(ctx, repository, event, payload, sizeReason, nowMS)
			return
		}
		amount = sizedAmount
		receive = sizedReceive
		consumer.logger.Info("oferta dimensionada",
			"event_id", event.EventID, "offer_uuid", payload.OfferUUID,
			"qusd", amount.Format(2), "fiat", receive.Format(2), "reason", sizeReason)
	}
	result, err := core.Decide(core.Event{
		OfferUUID: payload.OfferUUID, Coin: payload.Coin, Side: payload.Side,
		Decision: payload.Decision, Amount: amount, Receive: receive, Rate: rate,
		Usage: usage,
	}, config, balance, nowMS)
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
			ReserveQusd: config.Limits.MinQusdReserve,
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
		now := postgres.NowMS()
		operation, operationErr := core.NewOperation(event.EventID, amount, receive, now)
		if operationErr != nil {
			consumer.logger.Warn("crear operación shadow falló", "event_id", event.EventID, "error", operationErr)
		} else {
			if err := consumer.operationRepo.Create(ctx, operation); err != nil {
				consumer.logger.Debug("operación shadow ya existía", "event_id", event.EventID)
			}
			if _, err := consumer.operationRepo.Transition(ctx, event.EventID, core.StateReserved, now); err != nil {
				consumer.logger.Warn("reservar operación shadow falló", "event_id", event.EventID, "error", err)
			} else {
				consumer.operations.Add(1)
				if consumer.trader != nil {
					state, executeErr := consumer.trader.Execute(ctx, consumer.operationRepo, event.EventID, payload.OfferUUID, amount)
					if executeErr != nil {
						consumer.logger.Warn("autotrade falló", "event_id", event.EventID, "error", executeErr)
					} else if state == core.StateConfirmed {
						consumer.applied.Add(1)
					}
				}
			}
		}
	} else {
		consumer.blocked.Add(1)
	}
}

// sizePayloadAmount calcula el importe ejecutable de una oferta por rango.
// Devuelve sized=false para ofertas fijas o eventos sin metadatos de rango.
func sizePayloadAmount(
	payload hunterPayload,
	config core.Config,
	usage core.Usage,
	rate decimal.Value,
) (decimal.Value, decimal.Value, bool, string) {
	if payload.Side != "buy" {
		return decimal.Zero(), decimal.Zero(), false, ""
	}
	if payload.OfferKind != "flexible" && strings.TrimSpace(payload.Available) == "" {
		return decimal.Zero(), decimal.Zero(), false, ""
	}
	if rate.Sign() <= 0 {
		return decimal.Zero(), decimal.Zero(), true, "tasa inválida para dimensionar la oferta"
	}
	available, _ := decimal.Parse(strings.TrimSpace(payload.Available))
	if available.Sign() <= 0 {
		available, _ = decimal.Parse(strings.TrimSpace(payload.Amount))
	}
	orderMin, _ := decimal.Parse(strings.TrimSpace(payload.OrderMin))
	orderMax, _ := decimal.Parse(strings.TrimSpace(payload.OrderMax))
	market := config.Markets[payload.Coin]
	size, err := core.SizeTake(core.TakeInput{
		AvailableQusd:     available,
		OrderMin:          orderMin,
		OrderMax:          orderMax,
		FiatAvailable:     config.Fiat[payload.Coin],
		OutgoingFee:       market.OutgoingFee,
		Rate:              rate,
		PerOperationMax:   config.Limits.MaxQusdPerOperation,
		MarketMaxQusd:     market.PurchaseMaxQusd,
		ExposureRemaining: remaining(config.Limits.MaxConcurrentQusdExposure, usage.ConcurrentQusdExposure),
		DailyRemaining:    remaining(config.Limits.MaxDailyAppliedQusd, usage.DailyAppliedQusd),
	})
	if err != nil {
		return decimal.Zero(), decimal.Zero(), true, err.Error()
	}
	if size.Amount.Sign() <= 0 {
		return decimal.Zero(), decimal.Zero(), true, size.Reason
	}
	return size.Amount, size.Amount.Mul(rate), true, size.Reason
}

// remaining devuelve cuánto margen queda de un límite. Cero significa sin
// tope configurado y no se recorta.
func remaining(limit, used decimal.Value) decimal.Value {
	if limit.Sign() <= 0 {
		return decimal.Zero()
	}
	left := limit.Sub(used)
	if left.Sign() < 0 {
		return decimal.Zero()
	}
	return left
}

// currentUsage lee el consumo persistido. Si falla, devuelve ceros y deja que
// los límites por operación sigan aplicando.
func (consumer *hunterConsumer) currentUsage(ctx context.Context, nowMS int64) core.Usage {
	dayStart := nowMS - nowMS%86_400_000
	usage, err := consumer.operationRepo.Usage(ctx, dayStart)
	if err != nil {
		if consumer.logger != nil && ctx.Err() == nil {
			consumer.logger.Warn("no se pudo leer el uso de riesgo", "error", err)
		}
		return core.Usage{}
	}
	return usage
}

// persistBlockedEvent cierra el evento sin aplicar y sin reintentarlo.
func (consumer *hunterConsumer) persistBlockedEvent(
	ctx context.Context,
	repository *postgres.HunterEventRepository,
	event postgres.HunterEvent,
	payload hunterPayload,
	reason string,
	nowMS int64,
) {
	result := core.Result{Kind: "blocked", Allowed: false, Reasons: []string{reason}}
	checksJSON, _ := json.Marshal(result.Checks)
	amount, _ := decimal.Parse(payload.Amount)
	receive, _ := decimal.Parse(payload.Receive)
	rate, _ := decimal.Parse(payload.Rate)
	if err := repository.CompleteWithDecision(ctx, postgres.CoreDecision{
		EventID: event.EventID, OfferUUID: payload.OfferUUID, Coin: payload.Coin,
		Side: payload.Side, HunterDecision: payload.Decision, CoreKind: result.Kind,
		Allowed: false, Amount: amount.Format(8), Receive: receive.Format(8),
		Rate: rate.Format(8), Reason: reason, ChecksJSON: string(checksJSON),
		CreatedAt: nowMS,
	}, nowMS); err != nil {
		consumer.failed.Add(1)
		_ = repository.Fail(ctx, event.EventID, event.Attempts, nowMS, err.Error())
		consumer.logger.Warn("persistir bloqueo por dimensionado falló", "event_id", event.EventID, "error", err)
		return
	}
	consumer.processed.Add(1)
	consumer.blocked.Add(1)
	consumer.logger.Info("oferta no aplicable por dimensionado",
		"event_id", event.EventID, "offer_uuid", payload.OfferUUID, "reason", reason)
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
