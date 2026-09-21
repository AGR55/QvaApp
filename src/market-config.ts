import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { config as RuntimeConfig } from "./config.js";
import { conservativeRiskLimits, type RiskLimits } from "./core/risk-policy.js";
import type { Store } from "./store.js";

type PaymentDetail = { name: string; value: string };

export interface MarketConfig {
  code: string;
  label: string;
  currency: string;
  iconUrl?: string;
  color?: string;
  active: boolean;
  huntBuyEnabled: boolean;
  huntSellEnabled: boolean;
  fiatBalance: number;
  buyMaxRate: number;
  sellMinRate: number;
  /** Override opcional del cortafuegos global para mercados con volatilidad propia. */
  priceGuardPercent?: number;
  purchaseMaxQusd: number;
  sellFeePercent: number;
  outgoingTransferFee: number;
  paymentDetails: PaymentDetail[];
}

export interface TradingConfig {
  version: 3;
  qusdReserve: number;
  maxOpenOffers: number;
  hunting: {
    buyRunning: boolean;
    sellRunning: boolean;
  };
  automation: {
    scanIntervalSeconds: number;
    autoCancelMinutes: number;
    offerRefreshIntervalMinutes: number;
    offerRefreshSpacingSeconds: number;
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
  readonly iconDirectory: string;

  constructor(
    dataDir: string,
    legacy: LegacyConfig,
    private readonly store: Store,
  ) {
    this.path = join(dataDir, "trading-config.json");
    this.iconDirectory = join(dataDir, "market-icons");
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
    } else if (
      persisted &&
      JSON.stringify(persisted) !== JSON.stringify(this.value)
    )
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

  saveMarketIcon(
    originalName: string,
    declaredMime: string,
    content: Uint8Array,
  ): { url: string; path: string; mimeType: string } {
    if (!content.byteLength || content.byteLength > 512 * 1024)
      throw new Error("El icono debe pesar entre 1 byte y 512 KB.");
    const detected = detectIcon(content);
    if (!detected || detected.mimeType !== declaredMime)
      throw new Error(
        "El contenido no coincide con un formato de imagen permitido.",
      );
    if (detected.extension === "svg") validateSvg(content);
    const digest = createHash("sha256")
      .update(content)
      .digest("hex")
      .slice(0, 32);
    const name = `${digest}.${detected.extension}`;
    mkdirSync(this.iconDirectory, { recursive: true, mode: 0o700 });
    const path = join(this.iconDirectory, name);
    if (!existsSync(path)) writeFileSync(path, content, { mode: 0o600 });
    this.store.audit(
      "market_icon_uploaded",
      `Icono ${originalName.slice(0, 100)} guardado como recurso administrado`,
    );
    return { url: `/market-icons/${name}`, path, mimeType: detected.mimeType };
  }

  marketIcon(name: string): { path: string; mimeType: string } | undefined {
    const match = /^([a-f0-9]{32})\.(png|jpg|webp|svg)$/.exec(name);
    if (!match) return undefined;
    const path = join(this.iconDirectory, name);
    if (!existsSync(path)) return undefined;
    const mimeTypes: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      webp: "image/webp",
      svg: "image/svg+xml",
    };
    return { path, mimeType: mimeTypes[match[2]!]! };
  }

  save(next: TradingConfig, source = "system", reason?: string): TradingConfig {
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
          iconUrl: "/icons/cup.png",
          color: "#79b64a",
          active: true,
          huntBuyEnabled: true,
          huntSellEnabled: true,
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
          iconUrl: "/icons/tropical.png",
          color: "#3976b8",
          active: true,
          huntBuyEnabled: true,
          huntSellEnabled: true,
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
          iconUrl: "/icons/clasica.png",
          color: "#4f83a5",
          active: true,
          huntBuyEnabled: true,
          huntSellEnabled: true,
          fiatBalance: 40,
          buyMaxRate: 1.04,
          sellMinRate: 1.12,
          purchaseMaxQusd: 0,
          sellFeePercent: 0,
          outgoingTransferFee: 0.08,
          paymentDetails: [],
        },
      ],
      hunting: { buyRunning: true, sellRunning: true },
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
  validateHunting(config.hunting);
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
    if (
      market.iconUrl &&
      !/^\/(?:icons|market-icons)\/[a-zA-Z0-9._-]+$/.test(market.iconUrl)
    )
      throw new Error(`Icono inválido para ${market.code}.`);
    if (market.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(market.color))
      throw new Error(`Color inválido para ${market.code}.`);
    if (typeof market.active !== "boolean")
      throw new Error(`Estado inválido para ${market.code}.`);
    if (
      typeof market.huntBuyEnabled !== "boolean" ||
      typeof market.huntSellEnabled !== "boolean"
    )
      throw new Error(`Control de cacería inválido para ${market.code}.`);
    finite(market.fiatBalance, `Saldo de ${market.code}`);
    finite(market.buyMaxRate, `Máximo de compra de ${market.code}`, 0.0000001);
    finite(market.sellMinRate, `Mínimo de venta de ${market.code}`, 0.0000001);
    if (market.priceGuardPercent !== undefined) {
      finite(
        market.priceGuardPercent,
        `Cortafuegos de precio de ${market.code}`,
        1,
      );
      if (market.priceGuardPercent > 100)
        throw new Error(
          `El cortafuegos de precio de ${market.code} no puede superar 100%.`,
        );
    }
    finite(market.purchaseMaxQusd, `Límite por compra de ${market.code}`);
    finite(market.sellFeePercent, `Comisión de venta de ${market.code}`);
    finite(
      market.outgoingTransferFee,
      `Comisión fija de salida de ${market.code}`,
    );
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
    config.automation.offerRefreshSpacingSeconds = numberOr(
      config.automation.offerRefreshSpacingSeconds,
      20,
    );
    config.markets = withMarketDefaults(config.markets);
    config.hunting = withHuntingDefaults(config.hunting);
    return config;
  }
  if (raw.version !== 1 && raw.version !== 2)
    throw new Error("Versión de configuración no compatible.");
  const config = {
    ...(raw as Omit<TradingConfig, "version" | "risk" | "automation">),
    version: 3,
    automation: defaultAutomation(),
    risk:
      raw.version === 2 && raw.risk
        ? raw.risk
        : {
            ...conservativeRiskLimits,
            minQusdReserve: numberOr(
              raw.qusdReserve,
              conservativeRiskLimits.minQusdReserve,
            ),
            reviewedAt: null,
          },
  } as TradingConfig;
  config.markets = withMarketDefaults(config.markets);
  config.hunting = withHuntingDefaults(config.hunting);
  return config;
}

function withMarketDefaults(markets: MarketConfig[]): MarketConfig[] {
  return markets.map((market) => {
    const legacy = legacyMarketIdentity(market.code);
    const iconUrl =
      market.iconUrl !== undefined ? market.iconUrl : legacy.iconUrl;
    return {
      ...market,
      ...(iconUrl !== undefined ? { iconUrl } : {}),
      color: market.color ?? legacy.color,
      huntBuyEnabled: booleanOr(market.huntBuyEnabled, market.active),
      huntSellEnabled: booleanOr(market.huntSellEnabled, market.active),
      outgoingTransferFee: numberOr(
        market.outgoingTransferFee,
        market.code === "CLASICA" ? 0.08 : 0,
      ),
    };
  });
}

function legacyMarketIdentity(code: string): {
  iconUrl?: string;
  color: string;
} {
  if (code === "BANK_CUP")
    return { iconUrl: "/icons/cup.png", color: "#79b64a" };
  if (code === "BANDECPREPAGO")
    return { iconUrl: "/icons/tropical.png", color: "#3976b8" };
  if (code === "CLASICA")
    return { iconUrl: "/icons/clasica.png", color: "#4f83a5" };
  return { color: "#6f8494" };
}

function detectIcon(
  content: Uint8Array,
): { extension: "png" | "jpg" | "webp" | "svg"; mimeType: string } | undefined {
  const bytes = Buffer.from(content);
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { extension: "png", mimeType: "image/png" };
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return { extension: "jpg", mimeType: "image/jpeg" };
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return { extension: "webp", mimeType: "image/webp" };
  const text = bytes.toString("utf8").trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text))
    return { extension: "svg", mimeType: "image/svg+xml" };
  return undefined;
}

function validateSvg(content: Uint8Array): void {
  const svg = Buffer.from(content).toString("utf8");
  if (
    /<(?:script|foreignObject|iframe|object|embed|image|style)\b|\son[a-z]+\s*=|(?:href|src)\s*=|@import|url\s*\(/i.test(
      svg,
    )
  )
    throw new Error(
      "El SVG contiene elementos activos o referencias externas no permitidas.",
    );
}

function withHuntingDefaults(
  value: TradingConfig["hunting"] | undefined,
): TradingConfig["hunting"] {
  return {
    buyRunning: booleanOr(value?.buyRunning, true),
    sellRunning: booleanOr(value?.sellRunning, true),
  };
}

function automationFromRuntime(cfg: LegacyConfig): TradingConfig["automation"] {
  return {
    scanIntervalSeconds: numberOr(cfg.scanIntervalMs, 15_000) / 1_000,
    autoCancelMinutes: numberOr(cfg.autoCancelMs, 600_000) / 60_000,
    offerRefreshIntervalMinutes:
      numberOr(cfg.offerRefreshIntervalMs, 300_000) / 60_000,
    offerRefreshSpacingSeconds:
      numberOr(cfg.offerRefreshSpacingMs, 20_000) / 1_000,
    priceGuardPercent: numberOr(cfg.priceGuardPercent, 15),
    welcomeMessage: (typeof cfg.welcomeMessage === "string"
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
    offerRefreshSpacingSeconds: 20,
    priceGuardPercent: 15,
    welcomeMessage:
      "Oferta aplicada por bot. El usuario atenderá y realizará el pago manualmente.",
  };
}

function validateAutomation(
  value: unknown,
): asserts value is TradingConfig["automation"] {
  if (!value || typeof value !== "object")
    throw new Error("La configuración de automatización es obligatoria.");
  const automation = value as Record<string, unknown>;
  finite(automation.scanIntervalSeconds, "Intervalo de escaneo", 3);
  finite(automation.autoCancelMinutes, "Plazo de cancelación", 1);
  finite(automation.offerRefreshIntervalMinutes, "Intervalo de refresco", 1);
  finite(
    automation.offerRefreshSpacingSeconds,
    "Separación entre refrescos",
    10,
  );
  finite(automation.priceGuardPercent, "Cortafuegos de precio", 1);
  if (Number(automation.priceGuardPercent) > 100)
    throw new Error("El cortafuegos de precio no puede superar 100%.");
  if (
    typeof automation.welcomeMessage !== "string" ||
    automation.welcomeMessage.length > 79
  )
    throw new Error("El mensaje P2P debe tener como máximo 79 caracteres.");
}

function validateHunting(
  value: unknown,
): asserts value is TradingConfig["hunting"] {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as Record<string, unknown>).buyRunning !== "boolean" ||
    typeof (value as Record<string, unknown>).sellRunning !== "boolean"
  )
    throw new Error("Los controles generales de cacería son inválidos.");
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
    throw new Error(
      "El máximo por operación no puede superar la exposición simultánea.",
    );
  if (Number(risk.maxQusdPerOperation) > Number(risk.maxDailyAppliedQusd))
    throw new Error(
      "El máximo por operación no puede superar el volumen diario.",
    );
  if (Number(risk.maxSlippagePercent) > 100)
    throw new Error("El deslizamiento máximo no puede superar 100%.");
}

function harmonize(config: TradingConfig): TradingConfig {
  const normalized = structuredClone(config);
  normalized.automation.offerRefreshSpacingSeconds = numberOr(
    normalized.automation.offerRefreshSpacingSeconds,
    20,
  );
  normalized.qusdReserve = normalized.risk.minQusdReserve;
  normalized.hunting = withHuntingDefaults(normalized.hunting);
  normalized.markets = withMarketDefaults(normalized.markets);
  for (const market of normalized.markets) {
    market.huntBuyEnabled = booleanOr(market.huntBuyEnabled, market.active);
    market.huntSellEnabled = booleanOr(market.huntSellEnabled, market.active);
    market.outgoingTransferFee = numberOr(market.outgoingTransferFee, 0);
    if (market.purchaseMaxQusd > normalized.risk.maxQusdPerOperation)
      market.purchaseMaxQusd = normalized.risk.maxQusdPerOperation;
  }
  return normalized;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function finite(value: unknown, label: string, minimum = 0): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum)
    throw new Error(`${label} debe ser un número mayor o igual a ${minimum}.`);
}
