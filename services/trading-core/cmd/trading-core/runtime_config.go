package main

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/core"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/riskpolicy"
	"github.com/AGR55/QvaApp/services/trading-core/internal/runtimeconfig"
)

// runtimeReloadInterval acota cada cuánto se consulta la configuración editable
// desde el panel. Con 10s una edición web se aplica sin reiniciar el proceso.
const runtimeReloadInterval = 10 * time.Second

// coreConfigFromRuntime traduce la configuración del panel (camelCase) al
// snapshot que consume core. Los mercados sin código válido se descartan y el
// fiat se publica para todos los mercados, activos o no.
func coreConfigFromRuntime(config runtimeconfig.Config) core.Config {
	result := core.Config{
		Limits: riskpolicy.Limits{
			MaxQusdPerOperation:         decimalValueFromFloat(config.Risk.MaxQusdPerOperation),
			MaxConcurrentQusdExposure:   decimalValueFromFloat(config.Risk.MaxConcurrentQusdExposure),
			MaxDailyAppliedQusd:         decimalValueFromFloat(config.Risk.MaxDailyAppliedQusd),
			MaxConcurrentOperations:     decimal.FromInt(int64(config.Risk.MaxConcurrentOperations)),
			MinQusdReserve:              decimalValueFromFloat(config.Risk.MinQusdReserve),
			MaxQuoteAgeSeconds:          decimalValueFromFloat(config.Risk.MaxQuoteAgeSeconds),
			MinExpectedMarginPercent:    decimalValueFromFloat(config.Risk.MinExpectedMarginPercent),
			MaxSlippagePercent:          decimalValueFromFloat(config.Risk.MaxSlippagePercent),
			MaxConsecutiveErrors:        decimal.FromInt(int64(config.Risk.MaxConsecutiveErrors)),
			MarketCooldownSeconds:       decimalValueFromFloat(config.Risk.MarketCooldownSeconds),
			CounterpartyCooldownSeconds: decimalValueFromFloat(config.Risk.CounterpartyCooldownSeconds),
		},
		Markets: make(map[string]core.Market, len(config.Markets)),
		Fiat:    make(map[string]decimal.Value, len(config.Markets)),
	}
	for _, market := range config.Markets {
		code := strings.TrimSpace(market.Code)
		if code == "" {
			continue
		}
		result.Markets[code] = core.Market{
			Code:            code,
			Active:          market.Active,
			BuyMaxRate:      decimalValueFromFloat(market.BuyMaxRate),
			SellMinRate:     decimalValueFromFloat(market.SellMinRate),
			PurchaseMaxQusd: decimalValueFromFloat(market.PurchaseMaxQusd),
			SellFeePercent:  decimalValueFromFloat(market.SellFeePercent),
			OutgoingFee:     decimalValueFromFloat(market.OutgoingTransferFee),
			HuntBuy:         config.Hunting.BuyRunning && market.HuntBuyEnabled,
			HuntSell:        config.Hunting.SellRunning && market.HuntSellEnabled,
		}
		result.Fiat[code] = decimalValueFromFloat(market.FiatBalance)
	}
	return result
}

// reloadRuntime refresca el snapshot desde la base de datos como mucho una vez
// por runtimeReloadInterval. Si todavía no hay configuración persistida
// (ErrNotFound) mantiene el snapshot cargado del archivo y su configErr.
func (consumer *hunterConsumer) reloadRuntime(ctx context.Context, now time.Time) {
	if consumer == nil || consumer.runtime == nil {
		return
	}
	nowMS := now.UnixMilli()
	last := consumer.runtimeAt.Load()
	// Un reloj que retrocede (elapsed negativo) fuerza recarga en vez de
	// bloquear la ventana indefinidamente.
	if elapsed := nowMS - last; last != 0 && elapsed >= 0 &&
		elapsed < runtimeReloadInterval.Milliseconds() {
		return
	}
	// Reclama la ventana con CAS: si otro goroutine ganó, ya hay una carga en
	// curso y no hace falta duplicar la consulta.
	if !consumer.runtimeAt.CompareAndSwap(last, nowMS) {
		return
	}

	config, version, err := consumer.runtime.Load(ctx)
	switch {
	case err == nil:
		consumer.applyConfig(coreConfigFromRuntime(config))
		consumer.runtimeVersion.Store(version)
	case errors.Is(err, runtimeconfig.ErrNotFound):
		// Sin configuración del panel sigue vigente el archivo.
	default:
		if consumer.logger != nil && ctx.Err() == nil {
			consumer.logger.Warn("no se pudo recargar la configuración runtime", "error", err)
		}
	}
}

// applyConfig publica un snapshot nuevo y deja de depender del archivo.
func (consumer *hunterConsumer) applyConfig(config core.Config) {
	consumer.configMu.Lock()
	defer consumer.configMu.Unlock()
	consumer.config = config
	consumer.configErr = nil
}

// currentConfig devuelve el snapshot vigente bajo lock.
func (consumer *hunterConsumer) currentConfig() core.Config {
	config, _ := consumer.configSnapshot()
	return config
}

// configSnapshot devuelve el snapshot y el error del arranque por archivo.
func (consumer *hunterConsumer) configSnapshot() (core.Config, error) {
	consumer.configMu.RLock()
	defer consumer.configMu.RUnlock()
	return consumer.config, consumer.configErr
}

// decimalValueFromFloat convierte un float64 del panel al decimal exacto de
// core usando su representación más corta (1.076 se convierte en "1.076").
func decimalValueFromFloat(value float64) decimal.Value {
	parsed, err := decimal.Parse(strconv.FormatFloat(value, 'f', -1, 64))
	if err != nil {
		return decimal.Zero()
	}
	return parsed
}
