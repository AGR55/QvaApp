import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { config as RuntimeConfig } from "./config.js";
import {
  conservativeRiskLimits,
  type RiskLimits,
} from "./core/risk-policy.js";
import type { Store } from "./store.js";

export type PaymentDetail = { name: string; value: string };

export interface MarketConfig {
  code: string;
  label: string;
  currency: string;
  active: boolean;
  fiatBalance: number;
  buyMaxRate: number;
  sellMinRate: number;
  purchaseMaxQusd: number;
  sellFeePercent: number;
  outgoingTransferFee: number;
  paymentDetails: PaymentDetail[];
}

export interface TradingConfig {
  version: 3;
  qusdReserve: number;
  maxOpenOffers: number;
  automation: {
    scanIntervalSeconds: number;
    autoCancelMinutes: number;
    offerRefreshIntervalMinutes: number;
    priceGuardPercent: number;
    welcomeMessage: string;
  };
  risk: RiskLimits & { reviewedAt: number | null };
  markets: MarketConfig[];
}

export type PublicMarketConfig = Omit<MarketConfig, "paymentDetails"> & {
  paymentDetailsCount: number;
};

type LegacyConfig = typeof RuntimeConfig;

export class MarketConfigService {
  private value: TradingConfig;
  readonly path: string;

  constructor(
    dataDir: string,
    legacy: LegacyConfig,
    private readonly store: Store,
  ) {
    this.path = join(dataDir, "trading-config.json");
    const hadBotConfig = this.store.hasBotConfig();
    const persisted = this.store.loadTradingConfig();
    const loaded =
      persisted ??
      (existsSync(this.path) ? this.read() : this.createInitial(legacy));
    this.value = harmonize(loaded);
    if (persisted && !hadBotConfig) {
      this.value.automation = automationFromRuntime(legacy);
      this.store.saveTradingConfig(
        this.value,
        "migration",
        "Configuración operativa importada a SQLite",
      );
    }
    else if (persisted && JSON.stringify(persisted) !== JSON.stringify(this.value))
      this.store.saveTradingConfig(
        this.value,
        "migration",
        "Reserva QUSD heredada unificada con el límite global de riesgo",
      );
    if (!persisted) {
      for (const market of this.value.markets) {
        const existingBalance = Number(
          this.store.get(`fiat_balance:${market.code}`),
        );
        if (Number.isFinite(existingBalance))
          market.fiatBalance = existingBalance;
      }
      this.store.saveTradingConfig(this.value);
    }
  }

  current(): TradingConfig {
    return structuredClone(this.value);
  }
  markets(): MarketConfig[] {
    return this.value.markets.map((market) => structuredClone(market));
  }
  activeMarkets(): MarketConfig[] {
    return this.markets().filter((market) => market.active);
  }
  find(code: string): MarketConfig | undefined {
    return this.value.markets.find((market) => market.code === code);
  }
  publicMarkets(): PublicMarketConfig[] {
    return this.value.markets.map(({ paymentDetails, ...market }) => ({
      ...market,
      paymentDetailsCount: paymentDetails.length,
    }));
  }

  save(
    next: TradingConfig,
    source = "system",
    reason?: string,
  ): TradingConfig {
    validate(next);
    const normalized = harmonize(next);
    this.store.saveTradingConfig(normalized, source, reason);
    this.value = structuredClone(normalized);
    return this.current();
  }

  updateBalance(code: string, fiatBalance: number): void {
    const next = this.current();
    for (const configured of next.markets) {
      const stored = Number(this.store.get(`fiat_balance:${configured.code}`));
      if (Number.isFinite(stored)) configured.fiatBalance = stored;
    }
    const market = next.markets.find((candidate) => candidate.code === code);
    if (!market) throw new Error(`Mercado no configurado: ${code}`);
    market.fiatBalance = fiatBalance;
    this.save(next);
  }

  private read(): TradingConfig {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      const normalized = normalize(raw);
      validate(normalized);
      return normalized;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "JSON inválido";
      throw new Error(`No se pudo cargar ${this.path}: ${detail}`);
    }
  }

  private createInitial(cfg: LegacyConfig): TradingConfig {
    return {
      version: 3,
      qusdReserve: conservativeRiskLimits.minQusdReserve,
      maxOpenOffers: numberOr(cfg.maxOpenOwnOffers, 10),
      automation: automationFromRuntime(cfg),
      risk: { ...conservativeRiskLimits, reviewedAt: null },
      markets: [
        {
          code: "BANK_CUP",
          label: "Transferencia CUP",
          currency: "CUP",
          active: true,
          fiatBalance: 0,
          buyMaxRate: numberOr(cfg.buyQusdMaxRate, 930),
          sellMinRate: numberOr(cfg.sellQusdMinRate, 980),
          purchaseMaxQusd: Math.min(
            numberOr(cfg.cupPurchaseMaxQusd, 0),
            conservativeRiskLimits.maxQusdPerOperation,
          ),
          sellFeePercent: 0,
          outgoingTransferFee: 0,
          paymentDetails: cfg.paymentDetails?.BANK_CUP ?? [],
        },
        {
          code: "BANDECPREPAGO",
          label: "USD Prepago",
          currency: "USD",
          active: true,
          fiatBalance: numberOr(cfg.initialUsdFiatBalance, 110),
          buyMaxRate: numberOr(cfg.buyQusdUsdMaxRate, 1.06),
          sellMinRate: numberOr(cfg.sellQusdUsdMinRate, 1.12),
          purchaseMaxQusd: 0,
          sellFeePercent: 0,
          outgoingTransferFee: 0,
          paymentDetails: cfg.paymentDetails?.BANDECPREPAGO ?? [],
        },
        {
          code: "CLASICA",
          label: "Tarjeta Clásica",
          currency: "USD",
          active: true,
          fiatBalance: 40,
          buyMaxRate: 1.04,
          sellMinRate: 1.12,
          purchaseMaxQusd: 0,
          sellFeePercent: 0,
          outgoingTransferFee: 0.08,
          paymentDetails: [],
        },
      ],
    };
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function validate(value: unknown): asserts value is TradingConfig {
  if (!value || typeof value !== "object")
    throw new Error("La configuración debe ser un objeto.");
  const config = value as Partial<TradingConfig>;
  if (config.version !== 3 || !Array.isArray(config.markets))
    throw new Error("Versión o lista de mercados inválida.");
  finite(config.qusdReserve, "Reserva QUSD");
  finite(config.maxOpenOffers, "Máximo de ofertas", 1);
  validateRisk(config.risk);
  validateAutomation(config.automation);
  const codes = new Set<string>();
  for (const market of config.markets) {
    if (!market || typeof market !== "object")
      throw new Error("Mercado inválido.");
    if (!/^[A-Z0-9_]{2,40}$/.test(market.code))
      throw new Error(
        "El código del mercado debe usar mayúsculas, números o guion bajo.",
      );
    if (codes.has(market.code))
      throw new Error(`Código de mercado repetido: ${market.code}`);
    codes.add(market.code);
    if (!market.label?.trim() || !market.currency?.trim())
      throw new Error(`Nombre o moneda inválidos para ${market.code}.`);
    if (typeof market.active !== "boolean")
      throw new Error(`Estado inválido para ${market.code}.`);
    finite(market.fiatBalance, `Saldo de ${market.code}`);
    finite(market.buyMaxRate, `Máximo de compra de ${market.code}`, 0.0000001);
    finite(market.sellMinRate, `Mínimo de venta de ${market.code}`, 0.0000001);
    finite(market.purchaseMaxQusd, `Límite por compra de ${market.code}`);
    finite(market.sellFeePercent, `Comisión de venta de ${market.code}`);
    finite(market.outgoingTransferFee, `Comisión fija de salida de ${market.code}`);
    if (market.sellFeePercent >= 100)
      throw new Error(`La comisión de ${market.code} debe ser menor de 100%.`);
    if (
      market.sellMinRate * (1 - market.sellFeePercent / 100) <=
      market.buyMaxRate
    )
      throw new Error(
        `El mínimo de venta neto de ${market.code} debe superar su máximo de compra.`,
      );
    if (
      market.purchaseMaxQusd > 0 &&
      market.purchaseMaxQusd > config.risk!.maxQusdPerOperation
    )
      throw new Error(
        `El límite de compra de ${market.code} supera el máximo global por operación.`,
      );
    if (
      !Array.isArray(market.paymentDetails) ||
      !market.paymentDetails.every(
        (detail) =>
          detail &&
          typeof detail.name === "string" &&
          typeof detail.value === "string",
      )
    )
      throw new Error(`Datos de cobro inválidos para ${market.code}.`);
  }
}

function normalize(value: unknown): TradingConfig {
  if (!value || typeof value !== "object")
    throw new Error("La configuración debe ser un objeto.");
  const raw = value as Partial<TradingConfig> & { version?: number };
  if (raw.version === 3) {
    const config = structuredClone(raw) as TradingConfig;
    config.markets = withOutgoingFees(config.markets);
    return config;
  }
  if (raw.version !== 1 && raw.version !== 2)
    throw new Error("Versión de configuración no compatible.");
  const config = {
    ...(raw as Omit<TradingConfig, "version" | "risk" | "automation">),
    version: 3,
    automation: defaultAutomation(),
    risk: raw.version === 2 && raw.risk
      ? raw.risk
      : {
          ...conservativeRiskLimits,
          minQusdReserve: numberOr(raw.qusdReserve, conservativeRiskLimits.minQusdReserve),
          reviewedAt: null,
        },
  } as TradingConfig;
  config.markets = withOutgoingFees(config.markets);
  return config;
}

function withOutgoingFees(markets: MarketConfig[]): MarketConfig[] {
  return markets.map((market) => ({
    ...market,
    outgoingTransferFee: numberOr(
      market.outgoingTransferFee,
      market.code === "CLASICA" ? 0.08 : 0,
    ),
  }));
}

function automationFromRuntime(cfg: LegacyConfig): TradingConfig["automation"] {
  return {
    scanIntervalSeconds: numberOr(cfg.scanIntervalMs, 15_000) / 1_000,
    autoCancelMinutes: numberOr(cfg.autoCancelMs, 600_000) / 60_000,
    offerRefreshIntervalMinutes:
      numberOr(cfg.offerRefreshIntervalMs, 300_000) / 60_000,
    priceGuardPercent: numberOr(cfg.priceGuardPercent, 15),
    welcomeMessage: (
      typeof cfg.welcomeMessage === "string"
        ? cfg.welcomeMessage
        : defaultAutomation().welcomeMessage
    ).slice(0, 79),
  };
}

function defaultAutomation(): TradingConfig["automation"] {
  return {
    scanIntervalSeconds: 15,
    autoCancelMinutes: 10,
    offerRefreshIntervalMinutes: 5,
    priceGuardPercent: 15,
    welcomeMessage:
      "Oferta aplicada por bot. El usuario atenderá y realizará el pago manualmente.",
  };
}

function validateAutomation(value: unknown): asserts value is TradingConfig["automation"] {
  if (!value || typeof value !== "object")
    throw new Error("La configuración de automatización es obligatoria.");
  const automation = value as Record<string, unknown>;
  finite(automation.scanIntervalSeconds, "Intervalo de escaneo", 5);
  finite(automation.autoCancelMinutes, "Plazo de cancelación", 1);
  finite(automation.offerRefreshIntervalMinutes, "Intervalo de refresco", 1);
  finite(automation.priceGuardPercent, "Cortafuegos de precio", 1);
  if (Number(automation.priceGuardPercent) > 100)
    throw new Error("El cortafuegos de precio no puede superar 100%.");
  if (
    typeof automation.welcomeMessage !== "string" ||
    automation.welcomeMessage.length > 79
  ) throw new Error("El mensaje P2P debe tener como máximo 79 caracteres.");
}

function validateRisk(value: unknown): asserts value is TradingConfig["risk"] {
  if (!value || typeof value !== "object")
    throw new Error("Los límites globales de riesgo son obligatorios.");
  const risk = value as Record<string, unknown>;
  for (const key of Object.keys(conservativeRiskLimits))
    finite(risk[key], `Riesgo: ${key}`);
  if (
    risk.reviewedAt !== null &&
    (typeof risk.reviewedAt !== "number" || !Number.isFinite(risk.reviewedAt))
  )
    throw new Error("La fecha de revisión de riesgo es inválida.");
  if (Number(risk.maxQusdPerOperation) <= 0)
    throw new Error("El máximo por operación debe ser mayor que cero.");
  if (Number(risk.maxConcurrentQusdExposure) <= 0)
    throw new Error("La exposición simultánea debe ser mayor que cero.");
  if (Number(risk.maxDailyAppliedQusd) <= 0)
    throw new Error("El volumen diario debe ser mayor que cero.");
  if (Number(risk.maxConcurrentOperations) < 1)
    throw new Error("Debe permitirse al menos una operación simultánea.");
  if (Number(risk.maxQusdPerOperation) > Number(risk.maxConcurrentQusdExposure))
    throw new Error("El máximo por operación no puede superar la exposición simultánea.");
  if (Number(risk.maxQusdPerOperation) > Number(risk.maxDailyAppliedQusd))
    throw new Error("El máximo por operación no puede superar el volumen diario.");
  if (Number(risk.maxSlippagePercent) > 100)
    throw new Error("El deslizamiento máximo no puede superar 100%.");
}

function harmonize(config: TradingConfig): TradingConfig {
  const normalized = structuredClone(config);
  normalized.qusdReserve = normalized.risk.minQusdReserve;
  for (const market of normalized.markets) {
    market.outgoingTransferFee = numberOr(market.outgoingTransferFee, 0);
    if (market.purchaseMaxQusd > normalized.risk.maxQusdPerOperation)
      market.purchaseMaxQusd = normalized.risk.maxQusdPerOperation;
  }
  return normalized;
}

function finite(value: unknown, label: string, minimum = 0): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum)
    throw new Error(`${label} debe ser un número mayor o igual a ${minimum}.`);
}
