// Everything the report logic needs from its host environment. The browser
// (src/browserRuntime.ts) backs it with localStorage and import.meta.env, the
// headless CLI (src/cli/) with an in-memory cache and process.env — the
// balance, price and PDF code itself never touches either directly.

export interface KeyValueCache {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface Runtime {
  // Returns the Alchemy key or throws a human-readable error when it is not
  // configured. Only called when an EVM request is actually made.
  getAlchemyApiKey: () => string;
  // Esplora base URL without trailing slash.
  esploraBase: string;
  cache: KeyValueCache;
  // Every CoinGecko request goes through here, so a host can space calls
  // out or retry on rate limits.
  fetchCoinGecko: (url: string) => Promise<Response>;
  // Progress and retry notes for long lookups (e.g. a long Bitcoin history).
  log: (message: string) => void;
}

export const DEFAULT_ESPLORA_BASE = "https://mempool.space/api";

export function esploraBaseFrom(override: string | undefined): string {
  const trimmed = override?.replace(/\/$/, "");
  return trimmed ? trimmed : DEFAULT_ESPLORA_BASE;
}

export class MemoryCache implements KeyValueCache {
  private readonly entries = new Map<string, string>();

  get(key: string): string | null {
    const value = this.entries.get(key);
    return value === undefined ? null : value;
  }

  set(key: string, value: string): void {
    this.entries.set(key, value);
  }
}
