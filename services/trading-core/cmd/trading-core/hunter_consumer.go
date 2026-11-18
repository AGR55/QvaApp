package main

import (
	"context"
	"encoding/json"
	"errors"
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
	runtime        runtimeConfigLoader
	runtimeAt      atomic.Int64
	runtimeVersion atomic.Int64
	logger         *slog.Logger
	worker         string
	shadowRepo     *postgres.ShadowRepository
	operationRepo  *postgres.CoreOperationRepository
	localOps       *postgres.LocalOperationRepository
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
	notifier       *operationNotifier
	applyQueue     chan executionTask
	chat           operationChat
	identityMu     sync.Mutex
	ownerUUID      string

	balanceMu    sync.Mutex
	balanceValue decimal.Value
	balanceAt    time.Time
	usageMu      sync.Mutex
	usageValue   core.Usage
	usageAt      time.Time
}

type executionTask struct {
	eventID  string
	payload  hunterPayload
	amount   decimal.Value
	receive  decimal.Value
	flexible bool
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
	OfferKind        string `json:"offerKind,omitempty"`
	Available        string `json:"available,omitempty"`
	OrderMin         string `json:"orderMin,omitempty"`
	OrderMax         string `json:"orderMax,omitempty"`
	OfferType        string `json:"offerType,omitempty"`
	CounterpartyID   string `json:"counterpartyId,omitempty"`
	CounterpartyName string `json:"counterpartyName,omitempty"`
	ObservedAt       int64  `json:"observedAt"`
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
		localOps:      postgres.NewLocalOperationRepository(pool),
	}
	consumer.applyQueue = make(chan executionTask, 1024)
	consumer.trader = buildAutoTrader(logger)
	consumer.notifier = newOperationNotifier()
	if consumer.trader != nil {
		consumer.trader.onApplied = consumer.sendApplyMessage
	}
	if token, ok := decryptQvaToken(logger); ok {
		if reader, err := qvapay.New(envOrDefault("QVAPAY_API_BASE_URL", "https://api.qvapay.com"), token); err == nil {
			consumer.reconciler = &operationReconciler{
				pool: pool, reader: reader, repo: consumer.operationRepo,
				localOps: consumer.localOps,
				fiat:     &runtimeconfig.Repository{Pool: pool},
				notifier: consumer.notifier,
				logger:   logger,
			}
			logger.Info("conciliador QvaPay habilitado")
		} else {
			logger.Warn("conciliador QvaPay deshabilitado", "error", err)
		}
		if chatClient, err := qvapay.NewChatClient(
			envOrDefault("QVAPAY_API_BASE_URL", "https://api.qvapay.com"), token,
		); err == nil {
			consumer.chat = chatClient
		} else {
			logger.Warn("chat P2P deshabilitado: no se enviará el mensaje automático", "error", err)
		}
	}
	return consumer
}

// operationChat aísla el envío del mensaje automático para poder probarlo.
type operationChat interface {
	SendChat(ctx context.Context, offerUUID, order, message string) (qvapay.ChatMessage, error)
}

type runtimeConfigLoader interface {
	Load(ctx context.Context) (runtimeconfig.Config, int64, error)
}

// sendApplyMessage publica en el chat P2P el mensaje configurado desde la web
// justo después de una aplicación real confirmada.
func (consumer *hunterConsumer) sendApplyMessage(
	ctx context.Context,
	operationID, offerUUID, orderUUID string,
) {
	if consumer == nil || consumer.chat == nil {
		return
	}
	config, _, err := consumer.runtime.Load(ctx)
	if err != nil {
		if consumer.logger != nil {
			consumer.logger.Warn("no se pudo leer el mensaje automático configurado",
				"operation_id", operationID, "offer_uuid", offerUUID, "error", err)
		}
		return
	}
	message := strings.TrimSpace(config.Automation.WelcomeMessage)
	if message == "" {
		return
	}
	if runes := []rune(message); len(runes) > 599 {
		message = string(runes[:599])
	}
	sendCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	sent, sendErr := consumer.chat.SendChat(sendCtx, offerUUID, orderUUID, message)
	if sendErr != nil {
		if consumer.logger != nil {
			consumer.logger.Warn("no se pudo enviar el mensaje automático al chat P2P",
				"operation_id", operationID, "offer_uuid", offerUUID, "error", sendErr)
		}
		if consumer.notifier != nil {
			_ = consumer.notifier.Send(ctx, fmt.Sprintf(
				"⚠️ La operación %s se aplicó, pero no se pudo enviar el mensaje automático al chat P2P.",
				offerUUID), "apply-chat:"+offerUUID)
		}
		return
	}
	if consumer.logger != nil {
		consumer.logger.Info("mensaje automático enviado al chat P2P",
			"operation_id", operationID, "offer_uuid", offerUUID,
			"order_uuid", orderUUID, "message_id", sent.ID)
	}
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
	if consumer.trader != nil {
		workers := applyConcurrency()
		for index := 0; index < workers; index++ {
			go consumer.applyWorker(ctx)
		}
		consumer.logger.Info("ejecución de applies en paralelo", "workers", workers)
	}
	wake := make(chan struct{}, 1)
	if databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL")); databaseURL != "" {
		go listenHunterEvents(ctx, databaseURL, wake, consumer.logger)
	}
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	lastPending := time.Time{}
	for {
		consumer.reloadRuntime(ctx, time.Now())
		events, err := repository.Claim(ctx, consumer.worker, postgres.NowMS(), 500)
		if err != nil {
			if ctx.Err() == nil {
				consumer.logger.Warn("claim de hunter_events falló", "error", err)
			}
		} else {
			for _, event := range events {
				consumer.consume(ctx, repository, event)
			}
		}
		if time.Since(lastPending) > 5*time.Second {
			lastPending = time.Now()
			if pending, err := repository.Pending(ctx); err == nil {
				consumer.pending.Store(pending)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-wake:
		case <-ticker.C:
		}
	}
}

func applyConcurrency() int {
	raw := strings.TrimSpace(os.Getenv("CORE_APPLY_CONCURRENCY"))
	if raw == "" {
		return 3
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 {
		return 3
	}
	if value > 6 {
		return 6
	}
	return value
}

func (consumer *hunterConsumer) applyWorker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case task := <-consumer.applyQueue:
			reason := ""
			if !consumer.canApplyNow(ctx, task.payload) {
				reason = "cacería pausada, control runtime no disponible o cotización vencida"
			}
			if reason == "" && consumer.trader != nil && !consumer.trader.dryRun {
				var eligible bool
				eligible, reason = consumer.offerStillEligible(ctx, task)
				if eligible {
					reason = ""
				}
			}
			if reason != "" {
				consumer.logger.Warn("apply omitido", "event_id", task.eventID,
					"offer_uuid", task.payload.OfferUUID, "reason", reason)
				if _, err := consumer.operationRepo.Transition(ctx, task.eventID, core.StateRejected, postgres.NowMS()); err != nil {
					consumer.logger.Warn("no se pudo cerrar operación bloqueada por pausa", "event_id", task.eventID, "error", err)
				}
				consumer.invalidateUsage()
				continue
			}
			state, err := consumer.trader.Execute(
				ctx, consumer.operationRepo, task.eventID, task.payload.OfferUUID,
				task.amount, task.flexible)
			if err != nil {
				consumer.logger.Warn("autotrade falló", "event_id", task.eventID, "error", err)
			} else if state == core.StateConfirmed {
				consumer.applied.Add(1)
			}
			consumer.invalidateBalance()
			consumer.recordLocalOperation(ctx, task.payload, task.eventID, task.amount, task.receive, time.Now().UnixMilli())
		}
	}
}

// offerStillEligible vuelve a leer la oferta remota para no aplicar una
// cotización que cambió o se cerró mientras el evento esperaba en la cola.
// Devuelve un motivo concreto para que los applies omitidos sean auditables.
func (consumer *hunterConsumer) offerStillEligible(ctx context.Context, task executionTask) (bool, string) {
	if consumer == nil || consumer.reconciler == nil || consumer.reconciler.reader == nil {
		return false, "conciliador QvaPay no configurado"
	}
	offer, err := consumer.reconciler.reader.Offer(ctx, task.payload.OfferUUID)
	if err != nil {
		return false, "lectura remota falló: " + err.Error()
	}
	if offer.Status != "open" {
		return false, "estado remoto " + offer.Status
	}
	if offer.OnlyVIP == nil {
		return false, "only_vip ausente en la lectura remota"
	}
	if *offer.OnlyVIP {
		return false, "la oferta remota es solo VIP"
	}
	if offer.Paused() {
		return false, "la oferta remota está pausada"
	}
	if offer.RequirementsMet != nil && !*offer.RequirementsMet {
		return false, "no cumple los requisitos del anunciante"
	}
	expectedType := "sell"
	if task.payload.Side == "sell" {
		expectedType = "buy"
	}
	if offer.Type != expectedType {
		return false, fmt.Sprintf("tipo remoto %q, esperado %q", offer.Type, expectedType)
	}
	ownerUUIDSelf := consumer.ownAccountUUID(ctx)
	if ownerUUIDSelf == "" {
		return false, "no se pudo leer el perfil propio"
	}
	ownerUUID := strings.TrimSpace(offer.OwnerUUID)
	for _, party := range []json.RawMessage{offer.User, offer.Peer} {
		var owner struct {
			UUID string `json:"uuid"`
		}
		if len(party) > 0 && json.Unmarshal(party, &owner) == nil {
			partyUUID := strings.TrimSpace(owner.UUID)
			if partyUUID == ownerUUIDSelf {
				return false, "la oferta remota es propia"
			}
			if ownerUUID == "" {
				ownerUUID = partyUUID
			}
		}
	}
	if ownerUUID == "" {
		return false, "la oferta remota no identifica contraparte"
	}
	expectedRate, err := decimal.Parse(task.payload.Rate)
	if err != nil {
		return false, "tasa del evento inválida"
	}
	// La tasa viaja serializada a 8 decimales; comparar el valor exacto de
	// QvaPay contra ese texto produce falsos cambios por el último dígito.
	if offer.Rate.Format(8) != expectedRate.Format(8) {
		return false, fmt.Sprintf("la tasa cambió (%s != %s)", offer.Rate.Format(8), expectedRate.Format(8))
	}
	available := offer.AvailableAmount
	if available.Sign() <= 0 {
		available = offer.Amount
	}
	if available.Cmp(task.amount) < 0 {
		return false, fmt.Sprintf("disponible remoto %s < %s", available.Format(8), task.amount.Format(8))
	}
	if offer.OfferKind == "flexible" {
		if offer.OrderMin.Sign() > 0 && task.amount.Cmp(offer.OrderMin) < 0 {
			return false, "importe por debajo del mínimo de la oferta flexible"
		}
		if offer.OrderMax.Sign() > 0 && task.amount.Cmp(offer.OrderMax) > 0 {
			return false, "importe por encima del máximo de la oferta flexible"
		}
	}
	return true, ""
}

func (consumer *hunterConsumer) ownAccountUUID(ctx context.Context) string {
	consumer.identityMu.Lock()
	defer consumer.identityMu.Unlock()
	if consumer.ownerUUID != "" {
		return consumer.ownerUUID
	}
	if consumer.reconciler == nil || consumer.reconciler.reader == nil {
		return ""
	}
	user, err := consumer.reconciler.reader.User(ctx)
	if err != nil {
		return ""
	}
	consumer.ownerUUID = strings.TrimSpace(user.UUID)
	return consumer.ownerUUID
}

// canApplyNow relee los interruptores persistidos justo antes del apply. La
// caché del consumidor sirve para decidir candidatos, pero no para autorizar
// una mutación que pudo quedar en cola mientras se pausaba la cacería.
func (consumer *hunterConsumer) canApplyNow(ctx context.Context, payload hunterPayload) bool {
	if consumer == nil || consumer.runtime == nil {
		return false
	}
	var paused, emergency bool
	if err := consumer.pool.QueryRow(ctx, `
		SELECT
			COALESCE((SELECT value::text IN ('true', '"true"', '1', '"1"') FROM shadow.runtime_settings WHERE key = 'control.paused'), false),
			COALESCE((SELECT value::text IN ('true', '"true"', '1', '"1"') FROM shadow.runtime_settings WHERE key = 'control.emergency_stop'), false)
	`).Scan(&paused, &emergency); err != nil || paused || emergency {
		return false
	}
	config, _, err := consumer.runtime.Load(ctx)
	maxQuoteAgeSeconds := 0.0
	if err != nil {
		if !errors.Is(err, runtimeconfig.ErrNotFound) {
			return false
		}
		coreConfig, configErr := consumer.configSnapshot()
		if configErr != nil {
			return false
		}
		market, ok := coreConfig.Markets[payload.Coin]
		if !ok || !market.Active {
			return false
		}
		maxQuoteAgeSeconds, _ = strconv.ParseFloat(coreConfig.Limits.MaxQuoteAgeSeconds.Format(4), 64)
		if payload.Side == "buy" {
			if !market.HuntBuy {
				return false
			}
		} else if payload.Side == "sell" {
			if !market.HuntSell {
				return false
			}
		} else {
			return false
		}
	} else {
		if payload.Side == "buy" && !config.Hunting.BuyRunning || payload.Side == "sell" && !config.Hunting.SellRunning {
			return false
		}
		for _, market := range config.Markets {
			if market.Code != payload.Coin {
				continue
			}
			if !market.Active {
				return false
			}
			if payload.Side == "buy" {
				if !market.HuntBuyEnabled {
					return false
				}
			} else if payload.Side == "sell" {
				if !market.HuntSellEnabled {
					return false
				}
			} else {
				return false
			}
			maxQuoteAgeSeconds = config.Risk.MaxQuoteAgeSeconds
			break
		}
	}
	if payload.ObservedAt <= 0 || maxQuoteAgeSeconds <= 0 {
		return false
	}
	age := time.Since(time.UnixMilli(payload.ObservedAt))
	return age >= 0 && age <= time.Duration(maxQuoteAgeSeconds*float64(time.Second))
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
	if !consumer.canApplyNow(ctx, payload) {
		consumer.persistBlockedEvent(ctx, repository, event, payload,
			"Cacería pausada, mercado desactivado o cotización vencida", postgres.NowMS())
		return
	}
	amount, _ := decimal.Parse(payload.Amount)
	receive, _ := decimal.Parse(payload.Receive)
	rate, _ := decimal.Parse(payload.Rate)
	balance := consumer.currentBalance(ctx)
	nowMS := postgres.NowMS()
	if active, activeErr := consumer.operationRepo.ActiveForOffer(ctx, payload.OfferUUID); activeErr == nil && active {
		consumer.persistBlockedEvent(ctx, repository, event, payload,
			"Ya existe una operación activa para esta oferta", nowMS)
		return
	}
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
		Usage: usage, ObservedAt: payload.ObservedAt,
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
				ObservedAt: payload.ObservedAt,
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
			operation.State = core.StateReserved
			operation.UpdatedAt = now
			if err := consumer.operationRepo.Create(ctx, operation); err != nil {
				consumer.logger.Debug("operación shadow ya existía", "event_id", event.EventID)
			} else {
				consumer.operations.Add(1)
				consumer.invalidateUsage()
				if consumer.trader != nil {
					task := executionTask{
						eventID: event.EventID, payload: payload,
						amount: amount, receive: receive,
						flexible: payload.OfferKind == "flexible",
					}
					select {
					case consumer.applyQueue <- task:
					case <-ctx.Done():
						return
					}
				}
			}
		}
	} else {
		consumer.blocked.Add(1)
	}
}

// recordLocalOperation publica la operación del motor Go en la tabla que lee
// el panel. Así las ofertas aplicadas por Go son visibles y accionables sin TS.
func (consumer *hunterConsumer) recordLocalOperation(
	ctx context.Context,
	payload hunterPayload,
	operationID string,
	amount, receive decimal.Value,
	now int64,
) {
	if consumer.localOps == nil {
		return
	}
	operation, err := consumer.operationRepo.Get(ctx, operationID)
	if err != nil {
		if consumer.logger != nil {
			consumer.logger.Warn("no se pudo leer la operación para el panel", "operation_id", operationID, "error", err)
		}
		return
	}
	state := localOperationState(operation.State)
	if state == "" {
		return
	}
	offerType := payload.OfferType
	if offerType == "" {
		switch payload.Side {
		case "buy":
			offerType = "sell"
		case "sell":
			offerType = "buy"
		}
	}
	rate := 0.0
	amountFloat := decimalFloat(amount)
	receiveFloat := decimalFloat(receive)
	if amountFloat > 0 {
		rate = receiveFloat / amountFloat
	}
	err = consumer.localOps.Upsert(ctx, postgres.LocalOperation{
		UUID: payload.OfferUUID, OfferType: offerType, Coin: payload.Coin,
		Amount: amountFloat, Receive: receiveFloat, Rate: rate,
		State: state, AutoApplied: true, OrderUUID: operation.OrderUUID,
		CounterpartyID: payload.CounterpartyID, CreatedAt: now, UpdatedAt: now,
	})
	if err != nil && consumer.logger != nil {
		consumer.logger.Warn("no se pudo publicar la operación en el panel", "operation_id", operationID, "error", err)
	}
	if state == "applied" {
		consumer.notifyApplied(ctx, payload, amount, receive, operation)
	}
}

func (consumer *hunterConsumer) notifyApplied(
	ctx context.Context,
	payload hunterPayload,
	amount, receive decimal.Value,
	operation core.Operation,
) {
	if consumer.notifier == nil {
		return
	}
	fee := decimal.Zero()
	if config, err := consumer.configSnapshot(); err == nil {
		fee = config.Markets[payload.Coin].OutgoingFee
	}
	total := receive.Add(fee)
	currency := marketCurrency(payload.Coin)
	linkUUID := payload.OfferUUID
	if operation.OrderUUID != "" {
		linkUUID = operation.OrderUUID
	}
	var builder strings.Builder
	if payload.Side == "sell" {
		builder.WriteString("🪙 Venta de QUSD aplicada\n\n")
		fmt.Fprintf(&builder, "🌐 Mercado: %s\n", payload.Coin)
		fmt.Fprintf(&builder, "💰 Importe: %s QUSD\n", amount.Format(2))
		fmt.Fprintf(&builder, "💵 Recibirás: %s %s\n", receive.Format(2), currency)
		fmt.Fprintf(&builder, "📈 Tasa: %s\n", payload.Rate)
		fmt.Fprintf(&builder, "🆔 ID: %s\n", payload.OfferUUID)
		fmt.Fprintf(&builder, "🔗 https://qvapay.com/p2p/%s\n\n", linkUUID)
		builder.WriteString("📌 Siguiente paso: confirma la recepción del fiat y pulsa «Confirmar recepción».")
	} else {
		builder.WriteString("🛒 Compra de QUSD aplicada\n\n")
		fmt.Fprintf(&builder, "🌐 Mercado: %s\n", payload.Coin)
		if payload.CounterpartyName != "" {
			fmt.Fprintf(&builder, "👤 Contraparte: @%s\n", payload.CounterpartyName)
		}
		fmt.Fprintf(&builder, "💰 Importe: %s QUSD\n", amount.Format(2))
		fmt.Fprintf(&builder, "💸 Debes enviar: %s %s\n", total.Format(2), currency)
		fmt.Fprintf(&builder, "📈 Tasa: %s\n", payload.Rate)
		if fee.Sign() > 0 {
			fmt.Fprintf(&builder, "🧾 Comisión: %s %s\n", fee.Format(2), currency)
		}
		fmt.Fprintf(&builder, "🆔 ID: %s\n", payload.OfferUUID)
		fmt.Fprintf(&builder, "🔗 https://qvapay.com/p2p/%s\n\n", linkUUID)
		builder.WriteString("📌 Siguiente paso: envía el pago fiat y pulsa «Registrar pago».")
	}
	if err := consumer.notifier.Send(ctx, builder.String(), "apply:"+payload.OfferUUID); err != nil && consumer.logger != nil {
		consumer.logger.Warn("no se pudo notificar la aplicación", "offer_uuid", payload.OfferUUID, "error", err)
	}
}

func marketCurrency(coin string) string {
	switch strings.ToUpper(coin) {
	case "BANK_CUP", "ETECSA":
		return "CUP"
	default:
		return "USD"
	}
}

func localOperationState(state core.OperationState) string {
	switch state {
	case core.StateConfirmed:
		return "applied"
	case core.StateDryRun:
		return "dry_run"
	case core.StateRejected:
		return "rejected"
	case core.StateUncertain:
		return "uncertain"
	case core.StateReconciled:
		return "completed"
	default:
		return ""
	}
}

func decimalFloat(value decimal.Value) float64 {
	parsed, err := strconv.ParseFloat(value.Format(8), 64)
	if err != nil {
		return 0
	}
	return parsed
}

// sizePayloadAmount calcula el importe ejecutable de una oferta por rango.
// Devuelve sized=false para ofertas fijas o eventos sin metadatos de rango.
func sizePayloadAmount(
	payload hunterPayload,
	config core.Config,
	usage core.Usage,
	rate decimal.Value,
) (decimal.Value, decimal.Value, bool, string) {
	if payload.Side != "buy" || payload.OfferKind != "flexible" {
		// Las ofertas fijas se aplican por su importe exacto y sin cuerpo; solo
		// las flexibles admiten dimensionado.
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
	fiatAvailable := config.Fiat[payload.Coin]
	if fiatAvailable.Sign() < 0 {
		fiatAvailable = decimal.Zero()
	}
	size, err := core.SizeTake(core.TakeInput{
		AvailableQusd:     available,
		OrderMin:          orderMin,
		OrderMax:          orderMax,
		FiatAvailable:     fiatAvailable,
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

// currentBalance cachea el saldo QUSD unos milisegundos para no consultar la
// base en cada evento. Se invalida después de cada aplicación.
func (consumer *hunterConsumer) currentBalance(ctx context.Context) decimal.Value {
	now := time.Now()
	consumer.balanceMu.Lock()
	if !consumer.balanceAt.IsZero() && now.Sub(consumer.balanceAt) < 500*time.Millisecond {
		value := consumer.balanceValue
		consumer.balanceMu.Unlock()
		return value
	}
	consumer.balanceMu.Unlock()
	value, err := consumer.shadowRepo.LatestQvapayBalance(ctx)
	if err != nil {
		value = decimal.Zero()
	}
	consumer.balanceMu.Lock()
	consumer.balanceValue = value
	consumer.balanceAt = now
	consumer.balanceMu.Unlock()
	return value
}

func (consumer *hunterConsumer) invalidateBalance() {
	consumer.balanceMu.Lock()
	consumer.balanceAt = time.Time{}
	consumer.balanceMu.Unlock()
}

// currentUsage cachea el consumo de riesgo un cuarto de segundo. Las
// operaciones nuevas invalidan la caché para no sobrepasar exposición.
func (consumer *hunterConsumer) currentUsage(ctx context.Context, nowMS int64) core.Usage {
	now := time.Now()
	consumer.usageMu.Lock()
	if !consumer.usageAt.IsZero() && now.Sub(consumer.usageAt) < 250*time.Millisecond {
		usage := consumer.usageValue
		consumer.usageMu.Unlock()
		return usage
	}
	consumer.usageMu.Unlock()
	dayStart := nowMS - nowMS%86_400_000
	usage, err := consumer.operationRepo.Usage(ctx, dayStart)
	if err != nil {
		if consumer.logger != nil && ctx.Err() == nil {
			consumer.logger.Warn("no se pudo leer el uso de riesgo", "error", err)
		}
		return core.Usage{}
	}
	consumer.usageMu.Lock()
	consumer.usageValue = usage
	consumer.usageAt = now
	consumer.usageMu.Unlock()
	return usage
}

func (consumer *hunterConsumer) invalidateUsage() {
	consumer.usageMu.Lock()
	consumer.usageAt = time.Time{}
	consumer.usageMu.Unlock()
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
