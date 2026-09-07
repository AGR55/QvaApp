import type { Store } from "./store.js";
import type { Vault } from "./vault.js";

const TOKEN_KEY = "qvapay_token";

export class Session {
  constructor(
    private readonly store: Store,
    private readonly vault: Vault,
  ) {}

  token(): string | undefined {
    const encrypted = this.store.get(TOKEN_KEY);
    if (!encrypted) return undefined;
    try {
      return this.vault.decrypt(encrypted);
    } catch {
      return undefined;
    }
  }

  save(token: string): void {
    this.store.set(TOKEN_KEY, this.vault.encrypt(token));
  }
  clear(): void {
    this.store.set(TOKEN_KEY, "");
  }
}
