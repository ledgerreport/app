import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { isSupportedBlockchain, type Blockchain, type Currency, type Snapshot } from "../types";
import { isParsableDay, isSnapshot } from "../utils/snapshot";
import { blockchainLabel } from "../utils/blockchainLabel";
import { fetchAssetMap, resolveAsset, type AssetMap, type AssetType } from "../core/assets";
import { fetchWalletBalance } from "../core/balance";
import { fetchCurrencyPrice } from "../core/price";
import {
  addressHashForReport,
  buildWalletBalancePdf,
  reportPriceFromQuote,
  reportValue,
  type ReportPrice,
} from "../core/pdf";
import type { Runtime } from "../core/runtime";
import { createNodeRuntime } from "./nodeRuntime";
import { formatCsv, parseCsv } from "./csv";

// Headless report generation: the same balance, price and PDF code as the
// web app, driven from the command line. See README.md ("Headless reports").

const USAGE = `Usage:
  npm run report -- --network <chain> --token <name> [--token-type Coin|Token]
                    --address <address> --date YYYY-MM-DD --snapshot start|end
                    --currency CHF|EUR|USD --out <file.pdf>
                    [--price <decimal> --price-source "<text>"]

  npm run report -- --batch <items.csv> --out-dir <dir>

Batch CSV columns: network, token, address, date, snapshot, currency
(optional: token_type, price, price_source). Writes one PDF per row plus
summary.csv into --out-dir.

--price/--price-source (CSV: price, price_source) supply the price of one
unit in the chosen currency yourself, for assets CoinGecko cannot price.
Both or neither; LedgerReport does not verify a supplied price, and the PDF
says it was provided by the report creator.

Options:
  --overwrite               Replace existing output files (--out, or the row
                            PDFs and summary.csv in --out-dir); without it a
                            run refuses to start when any of them exists
  --price-interval-ms <ms>  Minimum gap between CoinGecko requests (default 6000)
  --help                    Show this help

Exit code: 0 all reports written, 1 at least one report failed, 2 usage error.`;

const DEFAULT_PRICE_INTERVAL_MS = 6000;
const CSV_REQUIRED_COLUMNS = ["network", "token", "address", "date", "snapshot", "currency"] as const;
const CSV_OPTIONAL_COLUMNS = ["token_type", "price", "price_source"] as const;
const PRICE_SOURCE_MAX_LENGTH = 200;
const SUMMARY_HEADER = [
  "row",
  "network",
  "token",
  "token_type",
  "date",
  "snapshot",
  "block",
  "balance",
  "currency",
  "price",
  "price_source",
  "value",
  "address_hash",
  "pdf",
  "status",
  "error",
];

class UsageError extends Error {}

// One requested report exactly as given (CLI flags or one CSV row).
interface RawRequest {
  network: string;
  token: string;
  tokenType: string;
  address: string;
  date: string;
  snapshot: string;
  currency: string;
  // Creator-supplied price; both empty when not given.
  price: string;
  priceSource: string;
}

interface SuppliedPrice {
  value: number;
  // The validated input exactly as given, printed and summarised unchanged.
  text: string;
  source: string;
}

interface ValidRequest {
  network: Blockchain;
  token: string;
  tokenType: AssetType | undefined;
  address: string;
  date: string;
  snapshot: Snapshot;
  currency: Currency;
  suppliedPrice: SuppliedPrice | undefined;
}

interface ReportResult {
  // The resolved asset's own chain, which balance and price were read on.
  network: Blockchain;
  assetType: string;
  blockNumber: number;
  balance: string;
  // As written to summary.csv and stdout: a supplied price exactly as given.
  price: string;
  priceSource: string;
  value: string;
}

function validateRequest(raw: RawRequest): ValidRequest {
  if (!isSupportedBlockchain(raw.network)) {
    throw new Error(`Unsupported network "${raw.network}"`);
  }
  if (!raw.token) throw new Error("Token is missing");
  if (!raw.address) throw new Error("Address is missing");

  // Same rules as the form: a real calendar day, not in the future.
  if (!isParsableDay(raw.date) || new Date(raw.date + "T00:00:00Z").toISOString().slice(0, 10) !== raw.date) {
    throw new Error(`Invalid date "${raw.date}" — expected YYYY-MM-DD`);
  }
  if (new Date(raw.date) > new Date()) throw new Error(`Date ${raw.date} is in the future`);

  if (!isSnapshot(raw.snapshot)) {
    throw new Error(`Invalid snapshot "${raw.snapshot}" — use "start" or "end"`);
  }
  if (!["CHF", "EUR", "USD"].includes(raw.currency)) {
    throw new Error(`Invalid currency "${raw.currency}" — use CHF, EUR or USD`);
  }

  let tokenType: AssetType | undefined;
  const typeInput = raw.tokenType.toLowerCase();
  if (typeInput === "coin") tokenType = "Coin";
  else if (typeInput === "token") tokenType = "Token";
  else if (typeInput !== "") throw new Error(`Invalid token type "${raw.tokenType}" — use Coin or Token`);

  return {
    network: raw.network,
    token: raw.token,
    tokenType,
    address: raw.address,
    date: raw.date,
    snapshot: raw.snapshot,
    currency: raw.currency as Currency,
    suppliedPrice: validateSuppliedPrice(raw),
  };
}

const PRICE_PAIR_MESSAGE = "price and price_source (--price and --price-source) must be given together";

function validateSuppliedPrice(raw: RawRequest): SuppliedPrice | undefined {
  const hasPrice = raw.price !== "";
  const hasSource = raw.priceSource !== "";
  if (!hasPrice && !hasSource) return undefined;
  if (!hasPrice) throw new Error(`price_source given without price — ${PRICE_PAIR_MESSAGE}`);
  if (!hasSource) throw new Error(`price given without price_source — ${PRICE_PAIR_MESSAGE}`);

  const value = Number(raw.price);
  if (!/^\d+(\.\d+)?$/.test(raw.price) || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid price "${raw.price}" — expected a positive decimal such as 0.9311`);
  }
  if (raw.priceSource.length > PRICE_SOURCE_MAX_LENGTH) {
    throw new Error(`price_source is longer than ${PRICE_SOURCE_MAX_LENGTH} characters`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw.priceSource)) {
    throw new Error("price_source must be a single line of text");
  }
  return { value, text: raw.price, source: raw.priceSource };
}

async function produceReport(
  rt: Runtime,
  assetMap: AssetMap,
  request: ValidRequest,
  outFile: string,
): Promise<ReportResult> {
  const asset = resolveAsset(assetMap, request.network, request.token, request.tokenType);
  // The web app gets this guarantee from the price lookup, which rejects an
  // unknown type; a row with a supplied price skips that lookup, so check
  // here once, before anything is fetched or written.
  const assetType = asset.type;
  if (assetType !== "Coin" && assetType !== "Token") {
    throw new Error(
      `Asset ${asset.name} on ${blockchainLabel(request.network)} has an unknown type — please report this on GitHub.`,
    );
  }

  const { balance, blockNumber } = await fetchWalletBalance(rt, {
    asset,
    walletAddress: request.address,
    date: request.date,
    snapshot: request.snapshot,
  });

  // A creator-supplied price replaces every lookup (CoinGecko, ESTV, FPS
  // contract) for this row; the PDF marks it as supplied.
  const price: ReportPrice = request.suppliedPrice
    ? {
        currency: request.currency,
        value: request.suppliedPrice.value,
        exactText: request.suppliedPrice.text,
        source: request.suppliedPrice.source,
        supplied: true,
      }
    : reportPriceFromQuote(
        await fetchCurrencyPrice(rt, {
          asset,
          date: request.date,
          snapshot: request.snapshot,
          blockNumber,
        }),
        request.currency,
      );
  const value = reportValue(balance, price);

  // Only reached when balance and price are known — a failed lookup above
  // throws and no PDF is written.
  const doc = await buildWalletBalancePdf({
    formData: {
      date: request.date,
      snapshot: request.snapshot,
      asset,
      address: request.address,
    },
    balance,
    price,
  });
  await writeFile(outFile, new Uint8Array(doc.output("arraybuffer")));

  return {
    network: asset.blockchain,
    assetType,
    blockNumber,
    balance,
    price: price.supplied ? price.exactText : String(price.value),
    priceSource: price.supplied ? `supplied: ${price.source}` : price.source,
    value,
  };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// The asset list is loaded once per run; if that fails, every report fails
// with the same error.
function assetMapLoader(): () => Promise<AssetMap> {
  let pending: Promise<AssetMap> | undefined;
  return () => {
    if (!pending) pending = fetchAssetMap();
    return pending;
  };
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

// Every PDF in the output must belong to an ok row of this run. Without
// --overwrite a run refuses to start when it would write over an existing
// file; with it, a row's target file is removed before the row is processed,
// so a row that now fails can never leave the PDF of an earlier run behind.
function refuseExisting(paths: string[]): void {
  const existing = paths.filter((p) => existsSync(p));
  if (existing.length) {
    const shown = existing.slice(0, 3).join(", ") + (existing.length > 3 ? `, … (${existing.length} files)` : "");
    throw new UsageError(`Output file(s) already exist: ${shown}. Use --overwrite to replace them.`);
  }
}

async function runSingle(rt: Runtime, raw: RawRequest, outFile: string, overwrite: boolean): Promise<number> {
  if (overwrite) await rm(outFile, { force: true });
  else refuseExisting([outFile]);
  const loadAssets = assetMapLoader();
  try {
    const request = validateRequest(raw);
    const result = await produceReport(rt, await loadAssets(), request, outFile);
    const lines = [
      `network:      ${result.network}`,
      `token:        ${request.token} (${result.assetType})`,
      `date:         ${request.date} (${request.snapshot} of day, UTC)`,
      `block:        ${result.blockNumber}`,
      `balance:      ${result.balance}`,
      `price:        ${result.price} ${request.currency} (${result.priceSource})`,
      `value:        ${result.value} ${request.currency}`,
      `address hash: ${await addressHashForReport(request.address)}`,
      `pdf:          ${outFile}`,
    ];
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  } catch (e) {
    process.stderr.write(`Report failed: ${errorMessage(e)}\n`);
    return 1;
  }
}

function readBatchRows(text: string): RawRequest[] {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new UsageError("Batch CSV is empty");
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const known: readonly string[] = [...CSV_REQUIRED_COLUMNS, ...CSV_OPTIONAL_COLUMNS];
  const unknown = header.filter((h) => !known.includes(h));
  if (unknown.length) throw new UsageError(`Batch CSV: unknown column(s) ${unknown.join(", ")}`);
  const missing = CSV_REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) throw new UsageError(`Batch CSV: missing column(s) ${missing.join(", ")}`);
  if (new Set(header).size !== header.length) throw new UsageError("Batch CSV: duplicate column");

  return rows.slice(1).map((cells, i) => {
    if (cells.length !== header.length) {
      throw new UsageError(`Batch CSV row ${i + 1}: expected ${header.length} fields, got ${cells.length}`);
    }
    const get = (column: string): string => {
      const index = header.indexOf(column);
      return index === -1 ? "" : cells[index].trim();
    };
    return {
      network: get("network"),
      token: get("token"),
      tokenType: get("token_type"),
      address: get("address"),
      date: get("date"),
      snapshot: get("snapshot"),
      currency: get("currency"),
      price: get("price"),
      priceSource: get("price_source"),
    };
  });
}

async function runBatch(rt: Runtime, csvPath: string, outDir: string, overwrite: boolean): Promise<number> {
  const requests = readBatchRows(await readFile(csvPath, "utf8"));
  if (requests.length === 0) throw new UsageError("Batch CSV has no data rows");

  const width = String(requests.length).length;
  const rowNos = requests.map((_, i) => String(i + 1).padStart(width, "0"));
  const fileNames = requests.map(
    (raw, i) =>
      `${rowNos[i]}-${safeFilePart(raw.network)}-${safeFilePart(raw.token)}-${safeFilePart(raw.date)}-${safeFilePart(raw.snapshot)}.pdf`,
  );
  const summaryPath = join(outDir, "summary.csv");
  if (!overwrite) refuseExisting([...fileNames.map((f) => join(outDir, f)), summaryPath]);
  await mkdir(outDir, { recursive: true });
  // An aborted run must not leave the earlier summary next to PDFs it has
  // already removed or replaced: drop it before the first row.
  if (overwrite) await rm(summaryPath, { force: true });

  const loadAssets = assetMapLoader();
  const summary: string[][] = [SUMMARY_HEADER];
  let failed = 0;

  for (const [i, raw] of requests.entries()) {
    const rowNo = rowNos[i];
    const label = `[${rowNo}/${requests.length}] ${raw.network} ${raw.token} ${raw.date} ${raw.snapshot}`;
    const fileName = fileNames[i];
    if (overwrite) await rm(join(outDir, fileName), { force: true });
    const addressHash = await addressHashForReport(raw.address);
    try {
      const request = validateRequest(raw);
      const result = await produceReport(rt, await loadAssets(), request, join(outDir, fileName));
      summary.push([
        rowNo,
        result.network,
        request.token,
        result.assetType,
        request.date,
        request.snapshot,
        String(result.blockNumber),
        result.balance,
        request.currency,
        result.price,
        result.priceSource,
        result.value,
        addressHash,
        fileName,
        "ok",
        "",
      ]);
      process.stderr.write(`${label} ok\n`);
    } catch (e) {
      failed++;
      summary.push([
        rowNo,
        raw.network,
        raw.token,
        raw.tokenType,
        raw.date,
        raw.snapshot,
        "",
        "",
        raw.currency,
        "",
        "",
        "",
        addressHash,
        "",
        "failed",
        errorMessage(e),
      ]);
      process.stderr.write(`${label} FAILED: ${errorMessage(e)}\n`);
    }
  }

  // Written to a temp file in the same directory and renamed, so the
  // summary appears complete or not at all.
  const tempSummaryPath = join(outDir, `.summary.csv.${process.pid}.tmp`);
  await writeFile(tempSummaryPath, formatCsv(summary));
  await rename(tempSummaryPath, summaryPath);
  process.stderr.write(
    `${requests.length - failed} of ${requests.length} reports written, ${failed} failed. Summary: ${summaryPath}\n`,
  );
  return failed > 0 ? 1 : 0;
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      network: { type: "string" },
      token: { type: "string" },
      "token-type": { type: "string" },
      address: { type: "string" },
      date: { type: "string" },
      snapshot: { type: "string" },
      currency: { type: "string" },
      out: { type: "string" },
      batch: { type: "string" },
      "out-dir": { type: "string" },
      "price-interval-ms": { type: "string" },
      price: { type: "string" },
      "price-source": { type: "string" },
      help: { type: "boolean" },
      overwrite: { type: "boolean" },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }

  let priceIntervalMs = DEFAULT_PRICE_INTERVAL_MS;
  if (values["price-interval-ms"] !== undefined) {
    priceIntervalMs = Number(values["price-interval-ms"]);
    if (!Number.isInteger(priceIntervalMs) || priceIntervalMs < 0) {
      throw new UsageError("--price-interval-ms must be a non-negative integer");
    }
  }

  // Load .env from the working directory (the repo root under `npm run`)
  // without overriding variables that are already set.
  if (existsSync(".env")) process.loadEnvFile(".env");
  const rt = createNodeRuntime({ priceIntervalMs, log: (m) => process.stderr.write(m + "\n") });

  const singleOptions = ["network", "token", "token-type", "address", "date", "snapshot", "currency", "out", "price", "price-source"] as const;

  if (values.batch !== undefined) {
    const used = singleOptions.filter((o) => values[o] !== undefined);
    if (used.length) throw new UsageError(`--batch cannot be combined with --${used.join(", --")}`);
    if (!values["out-dir"]) throw new UsageError("--batch requires --out-dir");
    return runBatch(rt, values.batch, values["out-dir"], values.overwrite === true);
  }

  if (values["out-dir"] !== undefined) throw new UsageError("--out-dir is only valid with --batch");
  if ((values.price === undefined) !== (values["price-source"] === undefined)) {
    throw new UsageError("--price and --price-source must be given together");
  }
  const currency = values.currency;
  const required: Record<string, string | undefined> = {
    network: values.network,
    token: values.token,
    address: values.address,
    date: values.date,
    snapshot: values.snapshot,
    currency,
    out: values.out,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => `--${k}`);
  if (missing.length) throw new UsageError(`Missing ${missing.join(", ")}`);

  return runSingle(
    rt,
    {
      network: values.network!,
      token: values.token!,
      tokenType: values["token-type"] ?? "",
      price: values.price?.trim() ?? "",
      priceSource: values["price-source"]?.trim() ?? "",
      address: values.address!,
      date: values.date!,
      snapshot: values.snapshot!,
      currency: currency!,
    },
    values.out!,
    values.overwrite === true,
  );
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    // Argument parsing errors from node:util are usage errors too.
    const usage = e instanceof UsageError || (e instanceof TypeError && "code" in e);
    process.stderr.write(`${errorMessage(e)}\n${usage ? `\n${USAGE}\n` : ""}`);
    process.exitCode = usage ? 2 : 1;
  },
);
