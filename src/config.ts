import "dotenv/config";
import { resolve } from "node:path";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

function numberValue(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min)
    throw new Error(`${name} debe ser un número mayor o igual a ${min}`);
  return value;
}

function dashboardHost(): "127.0.0.1" | "0.0.0.0" {
  const value = process.env.DASHBOARD_HOST?.trim() || "127.0.0.1";
  if (value !== "127.0.0.1" && value !== "0.0.0.0")
    throw new Error("DASHBOARD_HOST debe ser 127.0.0.1 o 0.0.0.0");
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function absoluteUrl(name: string, fallback?: string): string | undefined {
  const value = optional(name) ?? fallback;
  if (!value) return undefined;
  try {
    return new URL(value).toString();
  } catch {
    throw new Error(`${name} debe ser una URL absoluta válida`);
  }
}

const syncEnabled = process.env.SYNC_ENABLED === "true";
const syncBaseUrl = absoluteUrl("SYNC_BASE_URL");
const syncNatsUrl = absoluteUrl("SYNC_NATS_URL", "nats://127.0.0.1:4222");
const syncEmail = optional("SYNC_EMAIL");
const syncPassword = optional("SYNC_PASSWORD");
if (syncEnabled && (!syncBaseUrl || !syncNatsUrl || !syncEmail || !syncPassword))
  throw new Error(
    "SYNC_ENABLED=true exige SYNC_BASE_URL, SYNC_NATS_URL, SYNC_EMAIL y SYNC_PASSWORD",
  );

export type PaymentDetail = { name: string; value: string };

export const config = {
  telegramToken: required("TELEGRAM_BOT_TOKEN"),
  adminChatId: BigInt(required("TELEGRAM_ADMIN_CHAT_ID")),
  encryptionKey: required("LOCAL_ENCRYPTION_KEY"),
  buyQusdMaxRate: numberValue("BUY_QUSD_MAX_RATE", 930),
  sellQusdMinRate: numberValue("SELL_QUSD_MIN_RATE", 980),
  buyQusdUsdMaxRate: numberValue("BUY_QUSD_USD_MAX_RATE", 1.06),
  sellQusdUsdMinRate: numberValue("SELL_QUSD_USD_MIN_RATE", 1.13),
  cupPurchaseMaxQusd: numberValue("CUP_PURCHASE_MAX_QUSD", 150, 0.01),
  initialUsdFiatBalance: numberValue("INITIAL_USD_FIAT_BALANCE", 110),
  scanIntervalMs:
    Math.max(5, numberValue("SCAN_INTERVAL_SECONDS", 15, 5)) * 1_000,
  autoCancelMs: numberValue("AUTO_CANCEL_MINUTES", 10, 1) * 60_000,
  offerRefreshIntervalMs:
    numberValue("OFFER_REFRESH_INTERVAL_MINUTES", 5, 1) * 60_000,
  offerRefreshSpacingMs:
    numberValue("OFFER_REFRESH_SPACING_SECONDS", 20, 20) * 1_000,
  maxOpenOwnOffers: numberValue("MAX_OPEN_OWN_OFFERS", 10, 1),
  qusdReserve: numberValue("QUSD_RESERVE", 0),
  priceGuardPercent: numberValue("PRICE_GUARD_PERCENT", 15, 1),
  realTradingAllowed: process.env.CONFIRM_REAL_TRADING === "true",
  dataDir: resolve(process.env.DATA_DIR ?? "data"),
  dashboardPort: numberValue("DASHBOARD_PORT", 3000, 1),
  dashboardHost: dashboardHost(),
  dashboardAdminPassword: required("DASHBOARD_ADMIN_PASSWORD"),
  dashboardTrustedOrigin:
    process.env.DASHBOARD_TRUSTED_ORIGIN?.trim() ||
    `http://127.0.0.1:${numberValue("DASHBOARD_PORT", 3000, 1)}`,
  dashboardSecureCookies: process.env.DASHBOARD_SECURE_COOKIES === "true",
  huntingSync: syncEnabled
    ? {
        enabled: true as const,
        baseUrl: syncBaseUrl!,
        natsUrl: syncNatsUrl!,
        email: syncEmail!,
        password: syncPassword!,
      }
    : { enabled: false as const },
  welcomeMessage:
    process.env.P2P_WELCOME_MESSAGE?.trim() ||
    "Esta oferta ha sido aplicada por un bot, en los proximos minutos atendera el usuario, de no ser asi en los proximos 10 minutos se cancelara la aplicacion automaticamente.",
  paymentDetails: {
    BANK_CUP: parseDetails(
      process.env.PAYMENT_DETAILS_CUP_JSON ??
        process.env.PAYMENT_DETAILS_JSON ??
        "[]",
    ),
    BANDECPREPAGO: parseDetails(process.env.PAYMENT_DETAILS_USD_JSON ?? "[]"),
  },
};

function parseDetails(raw: string): PaymentDetail[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("PAYMENT_DETAILS_JSON debe ser JSON válido");
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (d) =>
        typeof d === "object" &&
        d !== null &&
        typeof d.name === "string" &&
        typeof d.value === "string",
    )
  ) {
    throw new Error("PAYMENT_DETAILS_JSON debe ser una lista de {name, value}");
  }
  return parsed as PaymentDetail[];
}
