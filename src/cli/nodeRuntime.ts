import { MemoryCache, esploraBaseFrom, type Runtime } from "../core/runtime";

// Node host for the shared report logic. Configuration comes from
// process.env (the CLI loads .env into it first). Caches live in memory for
// the duration of one run: a batch reuses block lookups and prices across
// rows, but nothing is persisted, so a later run never reads a stale entry.

const ALCHEMY_KEY_PLACEHOLDER = "your_alchemy_api_key_here";
const MAX_RATE_LIMIT_RETRIES = 4;
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface NodeRuntimeOptions {
  // Minimum gap between two CoinGecko requests.
  priceIntervalMs: number;
  log: (message: string) => void;
}

export function createNodeRuntime({ priceIntervalMs, log }: NodeRuntimeOptions): Runtime {
  let lastCoinGeckoRequest = 0;

  // A free CoinGecko demo key raises the rate limit; it is sent as a header
  // and never appears in URLs, logs or output.
  const coinGeckoKey = process.env.COINGECKO_DEMO_API_KEY;
  const coinGeckoHeaders: Record<string, string> = coinGeckoKey ? { "x-cg-demo-api-key": coinGeckoKey } : {};

  const fetchCoinGecko = async (url: string): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastCoinGeckoRequest + priceIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastCoinGeckoRequest = Date.now();

      const response = await fetch(url, { headers: coinGeckoHeaders });
      if (response.status !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) return response;

      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds * 1000
          : DEFAULT_RATE_LIMIT_WAIT_MS * (attempt + 1);
      log(`CoinGecko rate limit hit, waiting ${Math.round(waitMs / 1000)} s before retry ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}`);
      await sleep(waitMs);
    }
  };

  return {
    getAlchemyApiKey: () => {
      const key = process.env.VITE_ALCHEMY_API_KEY;
      if (!key || key === ALCHEMY_KEY_PLACEHOLDER) {
        throw new Error(
          "VITE_ALCHEMY_API_KEY is not set (environment or .env) — it is required for EVM balances.",
        );
      }
      return key;
    },
    esploraBase: esploraBaseFrom(process.env.VITE_ESPLORA_URL),
    cache: new MemoryCache(),
    fetchCoinGecko,
    log,
  };
}
