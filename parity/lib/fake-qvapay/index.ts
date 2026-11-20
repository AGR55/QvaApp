/**
 * API pública del fake QvaPay determinista (F0).
 *
 * Ejemplos:
 *
 *   import { startFakeQvaPay } from "./parity/lib/fake-qvapay/index.js";
 *   const fake = await startFakeQvaPay({ cassette: "ruta/al/cassette.json", port: 0 });
 *   // … requests contra fake.url …
 *   const log = fake.log();   // method/path/query/bodySha256/headers relevantes
 *   await fake.close();
 *
 * CLI equivalente:
 *   node --import tsx parity/lib/fake-qvapay/start.ts --cassette <ruta> --port 0
 */
export {
  startFakeQvaPay,
  DEFAULT_CLOCK_MS,
  DEFAULT_WEBHOOK_SECRET,
} from "./server.js";
export type { FakeQvaPayHandle, StartFakeQvaPayOptions } from "./server.js";
export { VirtualClock } from "./clock.js";
export {
  CassetteError,
  canonicalBodySha256,
  evaluateLogAssertions,
  loadCassette,
  matchesRequest,
  normalizePath,
  validateCassette,
} from "./cassette.js";
export {
  FakeWorld,
  MARKET_FEED_EVENTS,
  WebhookValidationError,
  parseFeedPayload,
  parseWebhookTimestamp,
  sha256Hex,
  signWebhookBody,
  verifyWebhookSignature,
} from "./world.js";
export type {
  AbortMode,
  Cassette,
  CassetteExchange,
  CassetteMatch,
  CassetteResponse,
  ExchangeReport,
  FakeQvaPayLog,
  HttpMethod,
  LogAssertions,
  RequestLogEntry,
  SseResponseSpec,
  WorldEffect,
  WorldSeed,
} from "./types.js";
