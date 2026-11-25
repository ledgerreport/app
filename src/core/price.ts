import { ethers } from "ethers";
import {
  EvmBlockchain,
  NonEvmBlockchain,
  isBtcBlockchain,
  type Blockchain,
  type Snapshot,
  type SupportedAsset,
} from "../types";
import { getEstvBtcChf } from "../utils/estvTaxValues";
import { cacheKey } from "../utils/cacheKey";
import { blockchainLabel } from "../utils/blockchainLabel";
import { evmRpc } from "./balance";
import type { Runtime } from "./runtime";

// Historical fiat price of an asset for the snapshot instant of a date.
// Framework-free: used by the useCurrencyPrice hook and by the headless CLI.
//
// Every price is historical. There is deliberately no fallback to a current
// price: a report must never show today's price under a past date, so a
// missing price is an error.
//
// Point in time: CoinGecko's /coins/{id}/history value for day X is the price
// at 00:00:00 UTC of X. "start" (00:00:00 UTC of D) uses day D; "end"
// (23:59:59 UTC of D) uses day D+1, one second after the balance snapshot.
// For End of day, an official ESTV year-end CHF rate, where one exists,
// takes precedence; Start of day always uses CoinGecko's value of D.

export type PriceCurrency = "usd" | "eur" | "chf";

export interface PriceQuote {
  usd: number;
  eur: number;
  chf: number;
  // Human-readable origin of each price, printed in the report, e.g.
  // "CoinGecko, 01.01.2026 00:00 UTC" or "ESTV year-end rate 31.12.2025".
  source: Record<PriceCurrency, string>;
}

export interface FetchPriceParams {
  // The chain comes from the asset itself (asset.blockchain), the same one
  // the balance is read on, so balance and price can never be from two
  // different chains.
  asset: SupportedAsset;
  // Calendar day YYYY-MM-DD.
  date: string;
  snapshot: Snapshot;
  // Block number / height the balance was read at.
  blockNumber: number;
}

type FiatPrices = Record<PriceCurrency, number>;

const COINGECKO_API = "https://api.coingecko.com/api/v3";

// CoinGecko publishes the 00:00 UTC value of a day roughly 35 minutes later.
const COINGECKO_PUBLISH_DELAY_MS = 60 * 60 * 1000;

// Map blockchain names to CoinGecko platform IDs for token contracts.
const platformMap: Partial<Record<Blockchain, string>> = {
  [EvmBlockchain.ETH]: "ethereum",
  [EvmBlockchain.BSC]: "binance-smart-chain",
  [EvmBlockchain.POLYGON]: "polygon-pos",
  [EvmBlockchain.ARB]: "arbitrum-one",
  [EvmBlockchain.OPT]: "optimistic-ethereum",
  [EvmBlockchain.BASE]: "base",
  [EvmBlockchain.GNOSIS]: "xdai",
};

// CoinGecko coin IDs of the native coins (asset type "Coin"). Their chainId
// in the asset list is the wrapped token's contract, which is not used here.
const nativeCoinMap: Record<Blockchain, string> = {
  [NonEvmBlockchain.BTC]: "bitcoin",
  [EvmBlockchain.ETH]: "ethereum",
  [EvmBlockchain.ARB]: "ethereum",
  [EvmBlockchain.OPT]: "ethereum",
  [EvmBlockchain.BASE]: "ethereum",
  [EvmBlockchain.BSC]: "binancecoin",
  [EvmBlockchain.POLYGON]: "polygon-ecosystem-token",
  [EvmBlockchain.GNOSIS]: "xdai",
  [EvmBlockchain.HAQQ]: "islamic-coin",
};

// Frankencoin pool share: priced by its own contract, in ZCHF (1 ZCHF = 1 CHF
// is the Frankencoin peg the app has always assumed).
const FPS_CONTRACT = "0x1ba26788dfde592fec8bcb0eaff472a42be341b2";

function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${date}`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// YYYY-MM-DD -> DD-MM-YYYY (CoinGecko query format).
const coinGeckoDate = (day: string) => day.split("-").reverse().join("-");
// YYYY-MM-DD -> DD.MM.YYYY (report format).
const swissDate = (day: string) => day.split("-").reverse().join(".");

function requirePrice(source: Record<string, unknown>, key: PriceCurrency, subject: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`CoinGecko has no ${key.toUpperCase()} price for ${subject}`);
  }
  return value;
}

async function coinGeckoErrorText(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const status = (body as { error?: { status?: { error_message?: unknown } } | string }).error;
    if (typeof status === "string") return `: ${status}`;
    const message = status?.status?.error_message;
    return typeof message === "string" ? `: ${message.trim()}` : "";
  } catch {
    return "";
  }
}

// Resolves a token contract to its CoinGecko coin id (cached per contract).
async function resolveCoinId(rt: Runtime, asset: SupportedAsset, blockchain: Blockchain): Promise<string> {
  const platform = platformMap[blockchain];
  if (!platform) {
    throw new Error(`No CoinGecko price source for tokens on ${blockchainLabel(blockchain)} (${asset.name})`);
  }
  const contract = asset.chainId;
  if (!contract || !ethers.isAddress(contract)) {
    throw new Error(`Token ${asset.name} on ${blockchainLabel(blockchain)} has no contract address to price it`);
  }
  const address = contract.toLowerCase();

  const key = cacheKey(["cg-id", platform, address]);
  const cached = rt.cache.get(key);
  if (cached) return cached;

  const response = await rt.fetchCoinGecko(`${COINGECKO_API}/coins/${platform}/contract/${address}`);
  if (response.status === 404) {
    throw new Error(`CoinGecko does not list ${asset.name} (${address}) on ${blockchainLabel(blockchain)} — no price available`);
  }
  if (!response.ok) {
    throw new Error(
      `CoinGecko lookup for ${asset.name} on ${blockchainLabel(blockchain)} failed (HTTP ${response.status})${await coinGeckoErrorText(response)}`,
    );
  }
  const data: unknown = await response.json();
  const id = (data as { id?: unknown }).id;
  if (typeof id !== "string" || !id) {
    throw new Error(`CoinGecko returned no coin id for ${asset.name} on ${blockchainLabel(blockchain)}`);
  }
  rt.cache.set(key, id);
  return id;
}

// CoinGecko's price of a coin at 00:00 UTC of `day` (cached per coin id and
// day, so the same coin reached from several chains is fetched once).
async function coinHistory(rt: Runtime, coinId: string, day: string, subject: string): Promise<FiatPrices> {
  const key = cacheKey(["price-coin", coinId, day]);
  const cached = rt.cache.get(key);
  if (cached) return JSON.parse(cached) as FiatPrices;

  const response = await rt.fetchCoinGecko(`${COINGECKO_API}/coins/${coinId}/history?date=${coinGeckoDate(day)}`);
  if (!response.ok) {
    throw new Error(
      `CoinGecko price of ${subject} for ${swissDate(day)} unavailable (HTTP ${response.status})${await coinGeckoErrorText(response)}`,
    );
  }
  const data: unknown = await response.json();
  const current = (data as { market_data?: { current_price?: Record<string, unknown> } }).market_data?.current_price;
  if (!current) throw new Error(`CoinGecko has no price of ${subject} for ${swissDate(day)}`);

  const what = `${subject} on ${swissDate(day)}`;
  const prices: FiatPrices = {
    usd: requirePrice(current, "usd", what),
    eur: requirePrice(current, "eur", what),
    chf: requirePrice(current, "chf", what),
  };
  rt.cache.set(key, JSON.stringify(prices));
  return prices;
}

// FPS price() in ZCHF (18 decimals) at the balance block.
async function fpsPriceAtBlock(rt: Runtime, blockNumber: number): Promise<number> {
  const iface = new ethers.Interface(["function price() view returns (uint256)"]);
  const result = await evmRpc(
    rt,
    EvmBlockchain.ETH,
    "eth_call",
    [{ to: FPS_CONTRACT, data: iface.encodeFunctionData("price") }, `0x${blockNumber.toString(16)}`],
    "Reading the FPS price",
  );
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(result)) {
    throw new Error("Unexpected FPS price() response");
  }
  const price = parseFloat(ethers.formatUnits(BigInt(result), 18));
  if (!(price > 0)) throw new Error("FPS price() returned zero");
  return price;
}

export async function fetchCurrencyPrice(
  rt: Runtime,
  { asset, date, snapshot, blockNumber }: FetchPriceParams,
): Promise<PriceQuote> {
  const blockchain: Blockchain = asset.blockchain;
  const priceDay = snapshot === "start" ? date : addDays(date, 1);
  const publishedAt = new Date(priceDay + "T00:00:00Z").getTime() + COINGECKO_PUBLISH_DELAY_MS;
  if (Date.now() < publishedAt) {
    throw new Error(
      `The price for ${snapshot === "end" ? "the end of " : ""}${swissDate(date)} is not published yet: ` +
        `it is CoinGecko's ${swissDate(priceDay)} 00:00 UTC value, available from about 01:00 UTC that day.`,
    );
  }
  const coinGeckoSource = `CoinGecko, ${swissDate(priceDay)} 00:00 UTC`;

  // FPS: the contract's own price() at the balance block, converted to USD
  // and EUR with CoinGecko's exchange rates of the price day (the ratio of
  // Bitcoin's fiat prices at the same instant).
  if (asset.type === "Token" && blockchain === EvmBlockchain.ETH && asset.chainId?.toLowerCase() === FPS_CONTRACT) {
    const chf = await fpsPriceAtBlock(rt, blockNumber);
    const fx = await coinHistory(rt, "bitcoin", priceDay, "Bitcoin (exchange rate)");
    const viaFx = `FPS price() at Ethereum block ${blockNumber}, converted with CoinGecko rates ${swissDate(priceDay)} 00:00 UTC`;
    return {
      chf,
      usd: (chf * fx.usd) / fx.chf,
      eur: (chf * fx.eur) / fx.chf,
      source: { chf: `FPS price() at Ethereum block ${blockNumber}`, usd: viaFx, eur: viaFx },
    };
  }

  let coinId: string;
  if (asset.type === "Coin") {
    coinId = nativeCoinMap[blockchain];
  } else if (asset.type === "Token") {
    coinId = await resolveCoinId(rt, asset, blockchain);
  } else {
    throw new Error(`Asset ${asset.name} on ${blockchainLabel(blockchain)} has an unknown type — please report this on GitHub.`);
  }

  const prices = await coinHistory(rt, coinId, priceDay, asset.name);
  const quote: PriceQuote = {
    ...prices,
    source: { usd: coinGeckoSource, eur: coinGeckoSource, chf: coinGeckoSource },
  };

  // For BTC the Swiss wealth tax uses ESTV's official ICTax year-end rate,
  // not a market-aggregator price; it takes precedence where published. It is
  // the closing rate of the record date, so it only fits the End of day
  // snapshot; Start of day (00:00:00 UTC) keeps CoinGecko's value of D.
  if (snapshot === "end" && isBtcBlockchain(blockchain)) {
    const estvChf = getEstvBtcChf(date);
    if (estvChf !== undefined) {
      quote.chf = estvChf;
      quote.source.chf = `ESTV year-end rate ${swissDate(date)}`;
    }
  }
  return quote;
}
