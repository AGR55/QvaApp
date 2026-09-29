export interface QvaPayStreamCredentials {
  appId: string;
  appSecret: string;
}

type QvaPayStreamPhase =
  | "idle"
  | "connecting"
  | "connected"
  | "backoff"
  | "unauthorized"
  | "subscription_required"
  | "expired";

export interface QvaPayStreamState {
  phase: QvaPayStreamPhase;
  error?: string;
  expiresAt?: string;
}

export interface QvaPayStreamRuntime {
  fetch?: typeof fetch;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  url?: string;
}

interface ParsedSseEvent {
  event: string;
  data: string;
}

export class QvaPayFeedStream {
  private active = false;
  private generation = 0;
  private controller: AbortController | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly url: string;

  constructor(
    private readonly onPayload: (payload: unknown) => void,
    private readonly onState: (state: QvaPayStreamState) => void,
    runtime: QvaPayStreamRuntime = {},
  ) {
    this.fetchImpl = runtime.fetch ?? fetch;
    this.wait = runtime.wait ?? abortableWait;
    this.random = runtime.random ?? Math.random;
    this.url = runtime.url ?? "https://api.qvapay.com/v2/p2p/stream";
  }

  start(credentials: QvaPayStreamCredentials): void {
    this.stop();
    this.active = true;
    const generation = ++this.generation;
    void this.run(credentials, generation).catch((error) => {
      if (!this.active || generation !== this.generation || isAbort(error)) return;
      this.onState({ phase: "backoff", error: safeStreamError(error) });
    });
  }

  stop(): void {
    this.active = false;
    this.generation += 1;
    this.controller?.abort();
    this.controller = undefined;
    this.onState({ phase: "idle" });
  }

  private async run(credentials: QvaPayStreamCredentials, generation: number): Promise<void> {
    let retryMilliseconds = 10_000;
    let failures = 0;
    while (this.active && generation === this.generation) {
      const controller = new AbortController();
      this.controller = controller;
      try {
        let subscriptionExpired = false;
        this.onState({ phase: "connecting" });
        const response = await this.fetchImpl(this.url, {
          method: "GET",
          headers: {
            accept: "text/event-stream",
            "app-id": credentials.appId,
            "app-secret": credentials.appSecret,
          },
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok) {
          const phase = response.status === 401
            ? "unauthorized"
            : response.status === 402
              ? "subscription_required"
              : "backoff";
          this.onState({
            phase,
            error: `QvaPay respondió HTTP ${response.status} al abrir el stream.`,
          });
          failures += 1;
          await this.pause(phase === "backoff" ? backoff(failures, this.random) : 60_000, controller.signal);
          continue;
        }
        if (!response.body)
          throw new Error("QvaPay abrió el stream sin cuerpo de respuesta.");

        failures = 0;
        this.onState({ phase: "connected" });
        await consumeSse(response.body, (event) => {
          if (event.event === "init") {
            const value = parseJsonRecord(event.data);
            this.onState({
              phase: "connected",
              ...(typeof value?.expires_at === "string" ? { expiresAt: value.expires_at } : {}),
            });
            return;
          }
          if (event.event === "subscription_expired") {
            subscriptionExpired = true;
            this.onState({ phase: "expired", error: "La suscripción del feed P2P venció." });
            return;
          }
          const payload = JSON.parse(event.data) as unknown;
          this.onPayload(payload);
        }, (retry) => {
          retryMilliseconds = Math.min(60_000, Math.max(1_000, retry));
        });
        if (subscriptionExpired) {
          await this.pause(60_000, controller.signal);
          continue;
        }
      } catch (error) {
        if (!this.active || generation !== this.generation || isAbort(error)) return;
        failures += 1;
        this.onState({ phase: "backoff", error: safeStreamError(error) });
      } finally {
        if (this.controller === controller) this.controller = undefined;
      }
      if (!this.active || generation !== this.generation) return;
      const delay = Math.max(retryMilliseconds, backoff(failures, this.random));
      const pauseController = new AbortController();
      this.controller = pauseController;
      this.onState({ phase: "backoff" });
      await this.pause(delay, pauseController.signal);
    }
  }

  private async pause(milliseconds: number, signal: AbortSignal): Promise<void> {
    try {
      await this.wait(milliseconds, signal);
    } catch (error) {
      if (!isAbort(error)) throw error;
    }
  }
}

export async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ParsedSseEvent) => void,
  onRetry: (milliseconds: number) => void = () => undefined,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        dispatchSseBlock(buffer.slice(0, boundary), onEvent, onRetry);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
      if (chunk.done) break;
      if (buffer.length > 64_000)
        throw new Error("El evento SSE excede el tamaño permitido.");
    }
    if (buffer.trim()) dispatchSseBlock(buffer, onEvent, onRetry);
  } finally {
    reader.releaseLock();
  }
}

function dispatchSseBlock(
  block: string,
  onEvent: (event: ParsedSseEvent) => void,
  onRetry: (milliseconds: number) => void,
): void {
  if (!block || block.startsWith(":")) return;
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const rawValue = separator >= 0 ? line.slice(separator + 1) : "";
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "retry" && /^\d+$/.test(value)) onRetry(Number(value));
  }
  if (data.length) onEvent({ event, data: data.join("\n") });
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function backoff(failures: number, random: () => number): number {
  const base = Math.min(60_000, 1_000 * 2 ** Math.min(6, Math.max(0, failures - 1)));
  return Math.round(base * (0.8 + random() * 0.4));
}

function abortableWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function safeStreamError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(app-secret|app-id)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 500);
}
