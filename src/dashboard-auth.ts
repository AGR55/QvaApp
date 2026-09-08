import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const SESSION_COOKIE = "qvaapply_session";

interface SessionRecord {
  csrfToken: string;
  expiresAt: number;
}

export interface DashboardAuthOptions {
  password: string;
  trustedOrigin: string;
  secureCookies?: boolean;
  now?: () => number;
  sessionDurationMs?: number;
}

/** In-memory, single-administrator authentication for the local operations desk. */
export class DashboardAuth {
  private readonly passwordDigest: Buffer;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly attempts = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly duration: number;
  private readonly trustedOriginUrl: URL;
  readonly trustedOrigin: string;
  readonly secureCookies: boolean;

  constructor(options: DashboardAuthOptions) {
    if (options.password.length < 14)
      throw new Error("DASHBOARD_ADMIN_PASSWORD debe tener al menos 14 caracteres.");
    this.passwordDigest = digest(options.password);
    this.trustedOriginUrl = new URL(options.trustedOrigin);
    this.trustedOrigin = this.trustedOriginUrl.origin;
    this.secureCookies = options.secureCookies ?? false;
    this.now = options.now ?? Date.now;
    this.duration = options.sessionDurationMs ?? 8 * 60 * 60 * 1_000;
  }

  login(password: string, clientId: string): {
    cookie: string;
    csrfToken: string;
    expiresAt: number;
  } {
    this.prune();
    const attempts = (this.attempts.get(clientId) ?? []).filter(
      (timestamp) => timestamp > this.now() - 15 * 60 * 1_000,
    );
    if (attempts.length >= 5)
      throw new DashboardAuthError(429, "Demasiados intentos. Espera 15 minutos.");
    if (!safeEqual(this.passwordDigest, digest(password))) {
      attempts.push(this.now());
      this.attempts.set(clientId, attempts);
      throw new DashboardAuthError(401, "Credenciales incorrectas.");
    }
    this.attempts.delete(clientId);
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const expiresAt = this.now() + this.duration;
    this.sessions.set(digest(token).toString("hex"), { csrfToken, expiresAt });
    return { cookie: this.cookie(token, Math.ceil(this.duration / 1_000)), csrfToken, expiresAt };
  }

  session(cookieHeader?: string): SessionRecord | undefined {
    this.prune();
    const token = parseCookies(cookieHeader)[SESSION_COOKIE];
    if (!token) return undefined;
    return this.sessions.get(digest(token).toString("hex"));
  }

  logout(cookieHeader?: string): string {
    const token = parseCookies(cookieHeader)[SESSION_COOKIE];
    if (token) this.sessions.delete(digest(token).toString("hex"));
    return this.cookie("", 0);
  }

  assertOrigin(origin?: string): void {
    if (!origin) throw new DashboardAuthError(403, "Origen de solicitud no autorizado.");
    let candidate: URL;
    try {
      candidate = new URL(origin);
    } catch {
      throw new DashboardAuthError(403, "Origen de solicitud no autorizado.");
    }
    const exact = candidate.origin === this.trustedOrigin;
    const equivalentLoopback =
      isLoopback(this.trustedOriginUrl.hostname) &&
      isLoopback(candidate.hostname) &&
      candidate.protocol === this.trustedOriginUrl.protocol &&
      candidate.port === this.trustedOriginUrl.port;
    if (!exact && !equivalentLoopback)
      throw new DashboardAuthError(403, "Origen de solicitud no autorizado.");
  }

  assertCsrf(cookieHeader: string | undefined, csrfHeader: string | undefined): void {
    const session = this.session(cookieHeader);
    if (!session) throw new DashboardAuthError(401, "Sesión no válida.");
    if (!csrfHeader || !safeEqual(digest(session.csrfToken), digest(csrfHeader)))
      throw new DashboardAuthError(403, "Token CSRF no válido.");
  }

  private cookie(value: string, maxAge: number): string {
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.secureCookies ? "; Secure" : ""}`;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, session] of this.sessions)
      if (session.expiresAt <= now) this.sessions.delete(key);
  }
}

function isLoopback(hostname: string): boolean {
  return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(
    hostname.toLowerCase(),
  );
}

export class DashboardAuthError extends Error {
  constructor(
    readonly status: 401 | 403 | 429,
    message: string,
  ) {
    super(message);
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseCookies(header?: string): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").flatMap((part) => {
      const separator = part.indexOf("=");
      if (separator < 1) return [];
      return [[part.slice(0, separator).trim(), part.slice(separator + 1).trim()]];
    }),
  );
}
