import { ethers } from "ethers";
import { validate as isValidBtcAddress, Network as BtcNetwork } from "bitcoin-address-validation";
import {
  EvmBlockchain,
  NonEvmBlockchain,
  isBtcBlockchain,
  isEvmBlockchain,
  type Snapshot,
  type SupportedAsset,
} from "../types";
import { formatTokenAmount } from "../utils/formatNumber";
import { END_OF_DAY_NOT_REACHED_MESSAGE, snapshotTimestamp } from "../utils/snapshot";
import { cacheKey } from "../utils/cacheKey";
import { blockchainLabel } from "../utils/blockchainLabel";
import { canonicalBitcoinAddress, isBech32MainnetForm } from "../utils/bitcoinAddress";
import type { Runtime } from "./runtime";

// Balance lookup for one asset/address at the snapshot instant of a date.
// Framework-free: used by the useWalletBalance hook and by the headless CLI.

export interface FetchBalanceParams {
  asset: SupportedAsset;
  walletAddress: string;
  // Calendar day YYYY-MM-DD, read as UTC.
  date: string;
  snapshot: Snapshot;
}

export interface BalanceAtBlock {
  // Human-readable decimal amount (no trailing zeros).
  balance: string;
  // EVM block number / Bitcoin block height the balance was read at.
  blockNumber: number;
}

const evmRpcHost: Record<EvmBlockchain, string> = {
  [EvmBlockchain.ETH]: "eth-mainnet",
  [EvmBlockchain.POLYGON]: "polygon-mainnet",
  [EvmBlockchain.BSC]: "bnb-mainnet",
  [EvmBlockchain.ARB]: "arb-mainnet",
  [EvmBlockchain.OPT]: "opt-mainnet",
  [EvmBlockchain.BASE]: "base-mainnet",
  [EvmBlockchain.HAQQ]: "haqq-mainnet",
  [EvmBlockchain.GNOSIS]: "gnosis-mainnet",
};

function evmRpcUrl(rt: Runtime, blockchain: EvmBlockchain): string {
  return `https://${evmRpcHost[blockchain]}.g.alchemy.com/v2/${rt.getAlchemyApiKey()}`;
}

// Retries for transient Alchemy failures: HTTP 429/500/502/503/504, network
// errors and JSON-RPC rate-limit errors (code 429 or -32005). JSON-RPC calls
// here only read chain state, so repeating one is safe. Without Retry-After
// the wait doubles from 1 s up to 30 s: 1+2+4+8+16 s ≈ 31 s in total before
// giving up. Other JSON-RPC errors (bad params, reverted call) are final.
const EVM_MAX_RETRIES = 5;
const EVM_BACKOFF_START_MS = 1_000;
const EVM_BACKOFF_CAP_MS = 30_000;
const EVM_MAX_RETRY_AFTER_MS = 60_000;
const EVM_RETRY_STATUSES = [429, 500, 502, 503, 504];
const EVM_RETRY_RPC_CODES = [429, -32005];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

// One JSON-RPC call to Alchemy with bounded retries on transient failures.
// Returns `result`; a final JSON-RPC error throws "<context>: <message>".
// Error messages never include the request URL, which carries the API key.
export async function evmRpc(
  rt: Runtime,
  blockchain: EvmBlockchain,
  method: string,
  params: unknown[],
  context: string,
): Promise<unknown> {
  const label = blockchainLabel(blockchain);
  for (let retry = 0; ; retry++) {
    let reason: string;
    let requestedWait: number | undefined;
    try {
      const response = await fetch(evmRpcUrl(rt, blockchain), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (response.ok) {
        const data: unknown = await response.json();
        if (typeof data !== "object" || data === null) {
          throw new Error(`${context}: unexpected response from Alchemy on ${label}`);
        }
        const { error, result } = data as { error?: unknown; result?: unknown };
        if (error === undefined || error === null) return result;
        const { code, message } = (typeof error === "object" ? error : {}) as { code?: unknown; message?: unknown };
        if (!EVM_RETRY_RPC_CODES.includes(Number(code))) {
          throw new Error(`${context}: ${String(message)}`);
        }
        reason = `rate limit (${String(message)})`;
      } else if (EVM_RETRY_STATUSES.includes(response.status)) {
        reason = `HTTP ${response.status}`;
        requestedWait = retryAfterMs(response.headers.get("retry-after"));
      } else {
        throw new Error(`${context}: Alchemy answered HTTP ${response.status} on ${label}`);
      }
    } catch (e) {
      // `fetch` rejects with TypeError on network-level failures.
      if (!(e instanceof TypeError)) throw e;
      reason = "network error";
    }

    if (retry >= EVM_MAX_RETRIES) {
      throw new Error(
        `${context}: ${label} node provider (Alchemy) still failing after ${EVM_MAX_RETRIES} retries (${reason}). Try again later.`,
      );
    }
    if (requestedWait !== undefined && requestedWait > EVM_MAX_RETRY_AFTER_MS) {
      throw new Error(
        `${context}: ${label} node provider (Alchemy) asks to wait ${Math.ceil(requestedWait / 1000)} s (${reason}). Try again later.`,
      );
    }
    const waitMs = requestedWait ?? Math.min(EVM_BACKOFF_START_MS * 2 ** retry, EVM_BACKOFF_CAP_MS);
    rt.log(`Alchemy on ${label}: ${reason}, retry ${retry + 1}/${EVM_MAX_RETRIES} in ${Math.round(waitMs / 1000)} s`);
    await sleep(waitMs);
  }
}

const BTC_DECIMALS = 8;

export async function fetchWalletBalance(
  rt: Runtime,
  { asset, walletAddress, date, snapshot }: FetchBalanceParams,
): Promise<BalanceAtBlock> {
  // "start" = 00:00:00 UTC, "end" = 23:59:59 UTC. The block lookups below
  // resolve the last block at or before this instant, and their caches are
  // keyed by it, so both modes never share a cache entry.
  const targetTimestamp = snapshotTimestamp(date, snapshot);

  // An end-of-day instant in the future (e.g. today) would silently resolve
  // to the chain tip, i.e. the current balance. Refuse instead. The form
  // blocks this case too; this guard covers every other caller. "start" is
  // left untouched: future dates are rejected by the date validation.
  if (snapshot === "end" && targetTimestamp * 1000 > Date.now()) {
    throw new Error(END_OF_DAY_NOT_REACHED_MESSAGE);
  }

  if (isBtcBlockchain(asset.blockchain)) {
    return fetchBitcoinBalance(rt, walletAddress, targetTimestamp);
  }
  if (isEvmBlockchain(asset.blockchain)) {
    return fetchEvmBalance(rt, asset, walletAddress, targetTimestamp, date);
  }
  throw new Error(`Unsupported blockchain: ${asset.blockchain}`);
}

// ---------- EVM ----------

async function fetchEvmBalance(
  rt: Runtime,
  asset: SupportedAsset,
  walletAddress: string,
  targetTimestamp: number,
  date: string,
): Promise<BalanceAtBlock> {
  if (!ethers.isAddress(walletAddress)) throw new Error("Invalid Ethereum address");

  const blockchain = asset.blockchain as EvmBlockchain;
  const blockNumber = await findEvmBlockByTimestamp(rt, blockchain, targetTimestamp);
  if (isNaN(blockNumber)) throw new Error(`Failed to find block for timestamp: ${date}`);

  const label = blockchainLabel(blockchain);
  if (asset.decimals === undefined || asset.decimals === null) {
    throw new Error(`Asset ${asset.name} on ${label} has no decimals — please report this on GitHub.`);
  }

  const normalizedAddress = ethers.getAddress(walletAddress.toLowerCase());
  const blockTag = `0x${blockNumber.toString(16)}`;

  // Native coins (ETH, BNB, POL, xDAI, ...) are not ERC-20 contracts. The DFX
  // asset list carries the *wrapped* token's address as their chainId (WETH
  // for ETH etc.), so balanceOf on it would report the wrapped balance, not
  // the native one. Read the account balance itself instead.
  let rpcRequest: { method: string; params: unknown[] };
  if (asset.type === "Coin") {
    rpcRequest = { method: "eth_getBalance", params: [normalizedAddress, blockTag] };
  } else if (asset.type === "Token") {
    if (!asset.chainId || !ethers.isAddress(asset.chainId)) {
      throw new Error(`Token ${asset.name} on ${label} has no contract address — please report this on GitHub.`);
    }
    const iface = new ethers.Interface(["function balanceOf(address account)"]);
    const edata = iface.encodeFunctionData("balanceOf", [normalizedAddress]);
    rpcRequest = { method: "eth_call", params: [{ to: asset.chainId, data: edata }, blockTag] };
  } else {
    throw new Error(`Asset ${asset.name} on ${label} has an unknown type — please report this on GitHub.`);
  }

  const result = await evmRpc(
    rt,
    blockchain,
    rpcRequest.method,
    rpcRequest.params,
    `Reading the ${asset.name} balance on ${label}`,
  );

  // eth_getBalance returns a quantity: "0x" + at least one hex digit.
  // balanceOf via eth_call returns an ABI uint256: exactly 32 bytes (64 hex
  // digits); any other length is not a balance. eth_call against an address
  // without contract code answers a bare "0x" — that is not a zero balance.
  const expected = rpcRequest.method === "eth_call" ? /^0x[0-9a-fA-F]{64}$/ : /^0x[0-9a-fA-F]+$/;
  if (typeof result !== "string" || !expected.test(result)) {
    throw new Error(`Unexpected ${rpcRequest.method} response for ${asset.name} on ${label}`);
  }
  const balanceFormatted = ethers.formatUnits(BigInt(result), asset.decimals);
  return { balance: formatTokenAmount(balanceFormatted), blockNumber };
}

async function findEvmBlockByTimestamp(
  rt: Runtime,
  blockchain: EvmBlockchain,
  targetTimestamp: number,
): Promise<number> {
  const key = cacheKey(["block", blockchain, targetTimestamp]);

  const cached = rt.cache.get(key);
  if (cached) {
    const parsed = parseInt(cached, 10);
    if (!isNaN(parsed)) return parsed;
  }

  const currentBlock = await getEvmCurrentBlockNumber(rt, blockchain);
  if (isNaN(currentBlock) || currentBlock <= 0) {
    throw new Error(`Invalid current block number for ${blockchainLabel(blockchain)}`);
  }

  let low = 0;
  let high = currentBlock;
  let bestBlock: number | undefined;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const blockTimestamp = await getEvmBlockTimestamp(rt, blockchain, mid);

    if (isNaN(blockTimestamp)) {
      throw new Error(`Failed to get timestamp for block ${mid} on ${blockchainLabel(blockchain)}`);
    }

    if (blockTimestamp <= targetTimestamp) {
      bestBlock = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  // No block at or before the target: the date lies before the chain's
  // genesis. Falling back to any block would report another day's balance.
  // Some chains (Ethereum, Arbitrum) give their genesis block timestamp 0,
  // so it matches any date; such a block 0 does not mean the chain existed.
  if (bestBlock === undefined || (bestBlock === 0 && (await getEvmBlockTimestamp(rt, blockchain, 0)) === 0)) {
    throw new Error(`Date is before ${blockchainLabel(blockchain)} existed`);
  }

  // The result is only final once the chain has a block *after* the target
  // instant: until then a block still to come may carry a timestamp at or
  // before it and would supersede bestBlock. Check the next block explicitly
  // and refuse (without caching) when it does not exist yet.
  const nextTimestamp =
    bestBlock < currentBlock ? await getEvmBlockTimestamp(rt, blockchain, bestBlock + 1) : undefined;
  if (nextTimestamp === undefined || nextTimestamp <= targetTimestamp) {
    throw new Error(
      `${blockchainLabel(blockchain)} has not produced a block after this instant yet, so the balance is not final. Try again in a few minutes.`,
    );
  }

  rt.cache.set(key, bestBlock.toString());
  return bestBlock;
}

async function getEvmCurrentBlockNumber(rt: Runtime, blockchain: EvmBlockchain): Promise<number> {
  const result = await evmRpc(rt, blockchain, "eth_blockNumber", [], "Failed to get current block number");
  const height = typeof result === "string" ? parseInt(result, 16) : NaN;
  if (isNaN(height)) throw new Error("Invalid block number response");
  return height;
}

async function getEvmBlockTimestamp(rt: Runtime, blockchain: EvmBlockchain, blockNumber: number): Promise<number> {
  const result = await evmRpc(
    rt,
    blockchain,
    "eth_getBlockByNumber",
    [`0x${blockNumber.toString(16)}`, false],
    "Failed to get block timestamp",
  );
  const timestamp = (result as { timestamp?: unknown } | null)?.timestamp;
  if (typeof timestamp !== "string") throw new Error("Invalid block response");
  const parsed = parseInt(timestamp, 16);
  if (isNaN(parsed)) throw new Error("Invalid timestamp in block");
  return parsed;
}

// ---------- Bitcoin (Esplora) ----------

// The fields of a confirmed Esplora transaction the balance calculation
// reads, after validation (see parseEsploraPage).
interface EsploraOutput {
  address: string | undefined;
  value: number;
}

interface EsploraTx {
  txid: string;
  blockHeight: number;
  // Outputs paid by this TX, and the previous outputs its inputs spend
  // (none for a coinbase input).
  vout: EsploraOutput[];
  prevouts: EsploraOutput[];
}

const INVALID_HISTORY = "Invalid response from the Bitcoin data provider while reading the address history";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isSats = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

// scriptpubkey_type values that may come without scriptpubkey_address.
// Source: TxOutValue::new in src/rest.rs of Blockstream/electrs and
// mempool/electrs. The address is rust-bitcoin's Address::from_script, which
// only exists for p2pkh, p2sh and witness programs (v0_p2wpkh, v0_p2wsh,
// v1_p2tr, mempool's "anchor" = witness v1 P2A); it is absent for
// "empty", "op_return", "p2pk", "multisig" (mempool), "provably_unspendable"
// (Blockstream) and possibly "unknown" (non-standard scripts; a future witness
// version would carry one). "fee" is Liquid-only. A missing address on any
// other (or a missing) type is rejected, so an output to the wallet can never
// be skipped silently.
const ADDRESSLESS_OUTPUT_TYPES = ["empty", "op_return", "p2pk", "multisig", "provably_unspendable", "unknown"];

function parseOutput(v: unknown): EsploraOutput {
  if (!isRecord(v) || !isSats(v.value)) throw new Error(INVALID_HISTORY);
  const address = v.scriptpubkey_address;
  if (address === undefined) {
    if (typeof v.scriptpubkey_type !== "string" || !ADDRESSLESS_OUTPUT_TYPES.includes(v.scriptpubkey_type)) {
      throw new Error(INVALID_HISTORY);
    }
  } else if (typeof address !== "string") {
    throw new Error(INVALID_HISTORY);
  }
  return { address, value: v.value };
}

// Validates one page of /address/{a}/txs/chain: every value the calculation
// reads must be present and well-formed (amounts as non-negative safe
// integers of satoshis), otherwise the page is rejected as a whole — a
// malformed amount must never turn into NaN or a concatenated string.
function parseEsploraPage(data: unknown): EsploraTx[] {
  if (!Array.isArray(data)) throw new Error(INVALID_HISTORY);
  return data.map((tx): EsploraTx => {
    if (!isRecord(tx) || typeof tx.txid !== "string" || !tx.txid || !isRecord(tx.status)) {
      throw new Error(INVALID_HISTORY);
    }
    if (tx.status.confirmed !== true) {
      throw new Error("Esplora returned an unconfirmed transaction in the confirmed history");
    }
    const height = tx.status.block_height;
    if (typeof height !== "number" || !Number.isSafeInteger(height) || height < 0) {
      throw new Error(INVALID_HISTORY);
    }
    if (!Array.isArray(tx.vout) || !Array.isArray(tx.vin)) throw new Error(INVALID_HISTORY);
    const prevouts: EsploraOutput[] = [];
    for (const input of tx.vin) {
      if (!isRecord(input) || typeof input.is_coinbase !== "boolean") throw new Error(INVALID_HISTORY);
      // Only a coinbase input spends no previous output; Esplora sends it
      // with is_coinbase true and prevout null. Every other input must carry
      // a valid prevout (parseOutput throws on a missing or malformed one),
      // otherwise a spend from the wallet would silently not be deducted.
      if (input.is_coinbase) {
        if (input.prevout !== null) throw new Error(INVALID_HISTORY);
      } else {
        prevouts.push(parseOutput(input.prevout));
      }
    }
    return { txid: tx.txid, blockHeight: height, vout: tx.vout.map(parseOutput), prevouts };
  });
}

interface EsploraChainStats {
  funded_txo_sum: number;
  spent_txo_sum: number;
  tx_count: number;
}

// Gap between two history pages. An unpaced walk through hundreds of pages
// runs into mempool.space's rate limit (HTTP 429); two requests per second
// stays below it while a 500-page history still finishes in a few minutes.
const ESPLORA_PAGE_DELAY_MS = 500;
// Retries for HTTP 429, 502/503/504 and network failures. All Esplora calls
// are idempotent GETs, so repeating one is safe. Without Retry-After the wait
// doubles from 5 s up to 120 s: 5+10+20+40+80+120 s ≈ 4.5 min in total
// before giving up.
const ESPLORA_MAX_RETRIES = 6;
const ESPLORA_BACKOFF_START_MS = 5_000;
const ESPLORA_BACKOFF_CAP_MS = 120_000;
// A Retry-After beyond this is not waited out (a browser tab would look
// frozen); the request fails with the provider's requested wait instead.
const ESPLORA_MAX_RETRY_AFTER_MS = 300_000;
const ESPLORA_PROGRESS_EVERY_PAGES = 20;
// How often the history is re-read when the address changes while paging.
const BTC_SNAPSHOT_ATTEMPTS = 3;

const PROVIDER_UNREACHABLE = "Bitcoin data provider unreachable. Check VITE_ESPLORA_URL or retry.";

// GET an Esplora URL, retrying rate limits (429), gateway errors (502/503/504)
// and network failures with Retry-After or capped exponential backoff. Any
// other status is returned to the caller; exhausting the retries throws.
async function esploraFetch(rt: Runtime, url: string): Promise<Response> {
  for (let retry = 0; ; retry++) {
    let response: Response | undefined;
    try {
      response = await fetch(url);
    } catch (e) {
      // `fetch` rejects with TypeError for network-level failures: DNS, TLS,
      // CORS, the provider being down, an offline browser.
      if (!(e instanceof TypeError)) throw e;
    }
    const retryable = response === undefined || [429, 502, 503, 504].includes(response.status);
    if (!retryable) return response!;

    const reason = response === undefined ? "network error" : `HTTP ${response.status}`;
    if (retry >= ESPLORA_MAX_RETRIES) {
      if (response === undefined) throw new Error(PROVIDER_UNREACHABLE);
      throw new Error(
        response.status === 429
          ? `Bitcoin data provider is rate limiting requests (HTTP 429) and still did after ${ESPLORA_MAX_RETRIES} retries. Wait a few minutes and try again.`
          : `Bitcoin data provider failed with HTTP ${response.status} after ${ESPLORA_MAX_RETRIES} retries. Try again later.`,
      );
    }

    const requested = response === undefined ? undefined : retryAfterMs(response.headers.get("retry-after"));
    if (requested !== undefined && requested > ESPLORA_MAX_RETRY_AFTER_MS) {
      throw new Error(
        `Bitcoin data provider asks to wait ${Math.ceil(requested / 1000)} s (${reason}). Try again later.`,
      );
    }
    const waitMs =
      requested !== undefined
        ? requested
        : Math.min(ESPLORA_BACKOFF_START_MS * 2 ** retry, ESPLORA_BACKOFF_CAP_MS);
    rt.log(`Bitcoin data provider: ${reason}, retry ${retry + 1}/${ESPLORA_MAX_RETRIES} in ${Math.round(waitMs / 1000)} s`);
    await sleep(waitMs);
  }
}

// Address endpoints: a 400/404 means Esplora knows nothing about the address
// (its format is validated before), anything else non-OK is an error. The
// message never names the address: it ends up in the CLI's summary.csv and
// stderr, where an address may only appear as its hash.
async function esploraAddressJson(rt: Runtime, url: string): Promise<unknown> {
  const res = await esploraFetch(rt, url);
  if (!res.ok) {
    if (res.status === 400 || res.status === 404) {
      throw new Error("No on-chain activity found for this address. Double-check the address and try again.");
    }
    throw new Error(`Esplora request failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function fetchChainStats(rt: Runtime, walletAddress: string): Promise<EsploraChainStats> {
  const data = (await esploraAddressJson(rt, `${rt.esploraBase}/address/${walletAddress}`)) as {
    chain_stats?: Partial<EsploraChainStats>;
  };
  const stats = data.chain_stats;
  if (
    !stats ||
    !Number.isSafeInteger(stats.funded_txo_sum) ||
    !Number.isSafeInteger(stats.spent_txo_sum) ||
    !Number.isSafeInteger(stats.tx_count) ||
    (stats.tx_count as number) < 0
  ) {
    throw new Error("Invalid Esplora address response");
  }
  return stats as EsploraChainStats;
}

const sameStats = (a: EsploraChainStats, b: EsploraChainStats) =>
  a.funded_txo_sum === b.funded_txo_sum && a.spent_txo_sum === b.spent_txo_sum && a.tx_count === b.tx_count;

// Net satoshi effect on the address of all confirmed TXs above targetHeight.
// Esplora lists confirmed TXs newest-first, so paging stops at the first TX
// at or below targetHeight instead of walking the whole history. The only
// other stop is an empty page (end of history): the page size is the
// provider's choice, so a short page proves nothing and must not end the walk.
//
// An empty page is only trusted as the end of the history when the walk has
// read exactly the confirmed tx_count of the address totals: electrs answers
// [] also for a last_seen_txid it cannot resolve (Blockstream/electrs
// src/new_index/schema.rs `_history`: unknown txid -> `return Ok(vec![])`;
// mempool/electrs: skip_while consumes every row), and both electrs count
// tx_count as the distinct txids of the same scripthash history rows the
// /txs/chain pages list. A walk that stops at the snapshot height reads only
// part of the history, so this count check cannot apply there.
async function netSatsAfterHeight(
  rt: Runtime,
  walletAddress: string,
  targetHeight: number,
  expectedTxCount: number,
): Promise<{ net: number; wholeHistory: boolean }> {
  let net = 0;
  let pages = 0;
  let lastSeenTxid: string | undefined;
  let previousHeight = Number.POSITIVE_INFINITY;
  let txCount = 0;
  // Guards the paging cursor: a provider that ignored it would return the
  // same transactions again and, without a size-based stop, never end.
  const seenTxids = new Set<string>();
  const finish = (wholeHistory: boolean) => {
    if (pages >= ESPLORA_PROGRESS_EVERY_PAGES) rt.log(`Bitcoin history: done after ${pages} pages`);
    return { net, wholeHistory };
  };

  while (true) {
    if (pages > 0) await sleep(ESPLORA_PAGE_DELAY_MS);
    const url = lastSeenTxid
      ? `${rt.esploraBase}/address/${walletAddress}/txs/chain/${lastSeenTxid}`
      : `${rt.esploraBase}/address/${walletAddress}/txs/chain`;
    const page = parseEsploraPage(await esploraAddressJson(rt, url));
    pages++;
    if (page.length === 0) {
      if (txCount !== expectedTxCount) throw new Error(INVALID_HISTORY);
      return finish(true);
    }
    txCount += page.length;
    if (pages % ESPLORA_PROGRESS_EVERY_PAGES === 0) {
      rt.log(`Bitcoin history: ${pages} pages (${txCount} transactions) read`);
    }

    for (const tx of page) {
      if (seenTxids.has(tx.txid)) throw new Error(INVALID_HISTORY);
      seenTxids.add(tx.txid);
      const height = tx.blockHeight;
      // The early stop below is only correct for newest-first order; refuse
      // to compute anything if the provider ever returns another order.
      if (height > previousHeight) {
        throw new Error("Esplora transaction history is not ordered newest-first");
      }
      previousHeight = height;
      if (height <= targetHeight) return finish(false);

      // Every TX Esplora lists under /address/{a}/txs pays to or spends
      // from that address, so at least one output or spent prevout must
      // carry it. A TX touching neither is a provable inconsistency (e.g. an
      // address spelled differently than Esplora returns it) and would
      // otherwise silently count as 0, i.e. today's balance for a past date.
      let touchesAddress = false;
      for (const out of tx.vout) {
        if (out.address === walletAddress) {
          net += out.value;
          touchesAddress = true;
        }
      }
      for (const prev of tx.prevouts) {
        if (prev.address === walletAddress) {
          net -= prev.value;
          touchesAddress = true;
        }
      }
      if (!touchesAddress) throw new Error(INVALID_HISTORY);
    }

    lastSeenTxid = page[page.length - 1].txid;
  }
}

async function fetchBitcoinBalance(
  rt: Runtime,
  enteredAddress: string,
  targetTimestamp: number,
): Promise<BalanceAtBlock> {
  // Bech32 is case-insensitive but mixed case is invalid (BIP-173); reject it
  // explicitly instead of relying on the validator. All-uppercase bech32 is
  // lowercased, the spelling Esplora returns, and this one value is used for
  // the totals URL, the history URLs and every comparison below, so the two
  // terms of the balance can never disagree. Base58 stays as entered.
  if (
    isBech32MainnetForm(enteredAddress) &&
    enteredAddress !== enteredAddress.toLowerCase() &&
    enteredAddress !== enteredAddress.toUpperCase()
  ) {
    throw new Error("Invalid Bitcoin address");
  }
  const walletAddress = canonicalBitcoinAddress(enteredAddress);
  if (!isValidBtcAddress(walletAddress, BtcNetwork.mainnet)) {
    throw new Error("Invalid Bitcoin address");
  }

  const targetHeight = await findBtcBlockByTimestamp(rt, targetTimestamp);

  // Balance at targetHeight = today's confirmed balance (chain_stats: sum of
  // all confirmed outputs to the address minus all confirmed spends of them)
  // minus the net effect of every confirmed TX above targetHeight. That only
  // needs the TXs after the snapshot, not the whole history.
  //
  // Both terms must describe the same set of confirmed TXs. The totals are
  // read before and after paging; if they are identical, no TX for the
  // address was confirmed in between, so the pages saw exactly the TXs the
  // totals include. If they differ, the whole read is repeated. Any failed
  // request throws — a partially read history never yields a number.
  for (let attempt = 1; attempt <= BTC_SNAPSHOT_ATTEMPTS; attempt++) {
    const before = await fetchChainStats(rt, walletAddress);
    const { net: netAfter, wholeHistory } = await netSatsAfterHeight(
      rt,
      walletAddress,
      targetHeight,
      before.tx_count,
    );
    const after = await fetchChainStats(rt, walletAddress);
    if (!sameStats(before, after)) {
      rt.log("Bitcoin address received new transactions while reading its history, reading again");
      continue;
    }

    const satsBalance = before.funded_txo_sum - before.spent_txo_sum - netAfter;
    // All terms are validated safe integers; this also guards the arithmetic
    // so that no NaN or rounded value can ever be formatted into a report.
    if (!Number.isSafeInteger(satsBalance)) throw new Error(INVALID_HISTORY);
    // The whole history lies after the snapshot, so the address held nothing
    // at that height: totals and transactions must cancel out exactly.
    if (wholeHistory && satsBalance !== 0) throw new Error(INVALID_HISTORY);
    if (satsBalance < 0) {
      throw new Error("Computed negative Bitcoin balance — chain data inconsistent");
    }
    const btc = satsBalance / 10 ** BTC_DECIMALS;
    return { balance: formatTokenAmount(btc.toFixed(BTC_DECIMALS)), blockNumber: targetHeight };
  }
  throw new Error("Bitcoin address kept receiving new transactions while its history was read. Try again.");
}

// Bitcoin genesis block timestamp (2009-01-03 18:15:05 UTC). Any earlier
// timestamp can't resolve to a real block; Esplora answers with a 500 and
// the raw status code leaked into the UI before this client-side check.
const BTC_GENESIS_TIMESTAMP = 1230940800;

// Bitcoin block timestamps can lag real time: a block mined after the
// target instant can still carry an earlier timestamp. Consensus only needs
// it above the median of the last 11 blocks (the 2-hour rule bounds how far
// a timestamp may run ahead, not behind), so there is no protocol limit; in
// practice the lag stays well under 2 hours. The block at or before an
// instant is therefore only treated as final 2 hours after it.
const BTC_TIMESTAMP_SAFETY_MS = 2 * 60 * 60 * 1000;

async function findBtcBlockByTimestamp(rt: Runtime, targetTimestamp: number): Promise<number> {
  if (targetTimestamp < BTC_GENESIS_TIMESTAMP) {
    throw new Error("Date is before Bitcoin existed");
  }
  // Checked before the cache and the lookup, so a not-yet-final height is
  // neither returned nor cached.
  const finalAt = targetTimestamp * 1000 + BTC_TIMESTAMP_SAFETY_MS;
  if (Date.now() < finalAt) {
    const at = new Date(finalAt).toISOString().slice(0, 16).replace("T", " ");
    throw new Error(
      `The Bitcoin balance for this instant is not final yet: block timestamps can lag real time ` +
        `(in practice by well under 2 hours), so a block mined later can still belong to it. ` +
        `Bitcoin snapshots are only reported 2 hours after the instant; try again after ${at} UTC.`,
    );
  }

  const key = cacheKey(["block", NonEvmBlockchain.BTC, targetTimestamp]);
  const cached = rt.cache.get(key);
  if (cached) {
    const parsed = parseInt(cached, 10);
    if (!isNaN(parsed)) return parsed;
  }

  // mempool.space answers with the block whose timestamp is the latest one
  // at or before targetTimestamp (`WHERE blockTimestamp <= ? ORDER BY
  // blockTimestamp DESC LIMIT 1`), so both the 00:00:00 and the 23:59:59
  // snapshot resolve to the last block at or before that instant.
  const res = await esploraFetch(rt, `${rt.esploraBase}/v1/mining/blocks/timestamp/${targetTimestamp}`);
  if (!res.ok) throw new Error(`Failed to resolve Bitcoin block for timestamp: ${res.status}`);
  const data: unknown = await res.json();
  const height = (data as { height?: unknown } | null)?.height;
  if (typeof height !== "number" || !Number.isSafeInteger(height) || height < 0) {
    throw new Error("Invalid response from the Bitcoin data provider when resolving the block for this date");
  }

  rt.cache.set(key, height.toString());
  return height;
}
