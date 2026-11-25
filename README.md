# LedgerReport

Wallet balance reports for Bitcoin and EVM tokens at any past date — for tax
filings, audits, and accounting. Enter a wallet address, pick a token and a
date, and get a downloadable PDF with the on-chain balance and its fiat
value (CHF/EUR/USD) on that day. Swiss wealth-tax filings use the official
ESTV ICTax CHF rate when one is published for the requested year-end.

The balance is taken at a chosen instant of the date (UTC): **End of day**
(23:59:59 UTC, default — the year-end record date) or **Start of day**
(00:00:00 UTC). The report uses the last block at or before that instant and
states the snapshot below the date. End of day is only available once that
day is over in UTC. A snapshot is only reported once it is final: on EVM
chains a block after the instant must exist, on Bitcoin 2 hours must have
passed (block timestamps can lag real time, in practice by well under 2
hours, so a Bitcoin snapshot is only reported 2 hours after the instant).

Every report carries a historical price and names it in the PDF. The value
is balance × price computed exactly in decimal and rounded once to 2
decimals, half-up (a half cent rounds up). CoinGecko's
history value for a day is the price at 00:00:00 UTC of that day, so Start
of day uses the date itself and End of day the following day (one second
after the snapshot). For BTC in CHF at End of day the official ESTV
year-end rate takes precedence where published. FPS uses its contract `price()` at the snapshot
block. There is no fallback to today's price: a token CoinGecko does not
list, a day it has no data for, or a price not yet published (End of day
of yesterday before about 01:00 UTC) is an error. CoinGecko's public API
only serves the last 365 days. URL parameters: `network`, `token`, `address`, `date`
(`YYYY-MM-DD`) and `snapshot` (`start` or `end`).

## Live

- Production: <https://ledgerreport.com>
- Development: <https://dev.ledgerreport.com>

## Stack

- Vite + React 19 + Tailwind 4 (TypeScript, strict mode)
- Bitcoin balances via mempool.space Esplora (override with `VITE_ESPLORA_URL`)
- EVM balances via Alchemy (requires `VITE_ALCHEMY_API_KEY`)
- Prices via CoinGecko `/coins/{id}/history` (token contracts resolved to
  their coin id via `/coins/{platform}/contract/{address}`)
- ESTV ICTax CHF override on known Swiss year-end record dates (End of day)

Supports 8 EVM chains today: Ethereum, BNB Smart Chain, Polygon, Arbitrum,
Optimism, Base, Haqq, Gnosis — plus Bitcoin.

## Local development

```bash
npm install
cp .env.example .env
# edit .env to add your VITE_ALCHEMY_API_KEY
npm run dev
```

Vite will serve the app on <http://localhost:5173>.

## Build

```bash
npm run build      # tsc -b && vite build
npm run lint
```

Both commands must be clean before pushing.

## Headless reports

The same balance, price and PDF code runs from the command line, without a
browser. `npm run report` builds the CLI (`vite build --ssr` into
`dist-cli/`) and runs it with Node (20.12 or newer, needed for
`process.loadEnvFile`). The Alchemy key is read from
`VITE_ALCHEMY_API_KEY` in the environment or `.env` (needed for EVM chains
only); `VITE_ESPLORA_URL` works as in the web app.

Single report:

```bash
npm run report -- --network Ethereum --token USDT \
  --address 0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe \
  --date 2025-12-31 --snapshot end --currency CHF --out report.pdf
```

Batch, one PDF per row plus `summary.csv` (block number/height, balance,
price and its source, value, address hash and status/error per row):

```bash
npm run report -- --batch items.csv --out-dir reports/
```

```csv
network,token,token_type,address,date,snapshot,currency
Ethereum,ETH,,0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe,2025-12-31,end,CHF
Bitcoin,BTC,,bc1q...,2025-12-31,end,CHF
```

- `network`: chain identifier as in the URL parameter (`Bitcoin`,
  `Ethereum`, `BinanceSmartChain`, `Polygon`, `Arbitrum`, `Optimism`, `Base`,
  `Haqq`, `Gnosis`).
- `token`: asset name from the [DFX asset list](https://api.dfx.swiss/v1/asset),
  matched exactly per chain like the `token` URL parameter. Optional
  `token_type` / `--token-type` (`Coin` or `Token`) narrows the match; an
  unknown or ambiguous token is an error.
- `snapshot`: `start` or `end`; `currency`: `CHF`, `EUR` or `USD`.
- `price` and `price_source` (optional, single mode `--price <decimal>
  --price-source "<text>"`): a price supplied by the report creator for
  assets CoinGecko cannot price. `price` is the price of one unit in the
  row's currency (positive decimal), `price_source` a single line of up to
  200 characters naming its origin; give both or neither. Such a row skips
  every price lookup. The PDF prints the price with the given source and a
  "Price source: Provided by the report creator — not fetched or verified
  by LedgerReport." row; `summary.csv` records `supplied: <text>`.
  **LedgerReport does not verify a supplied price.**

When the historical price is unavailable the report fails. A failed row gets no PDF,
is marked `failed` in `summary.csv`, and the run exits with code 1 (2 for
usage errors). Existing output is never overwritten silently: a run
refuses to start when `--out`, or a row PDF or `summary.csv` in `--out-dir`,
already exists. `--overwrite` replaces them; each row's PDF is then removed
before the row runs, so a row that now fails leaves no PDF from an earlier
run behind, and the old `summary.csv` is removed before the first row; the
new one is written only when the run completes. CoinGecko requests are spaced by `--price-interval-ms`
(default 6000) and retried on HTTP 429; per run, a token's coin id is
looked up once per chain and contract, and a price once per coin id and
day, even when several chains share the coin; set
`COINGECKO_DEMO_API_KEY` for a higher limit. Bitcoin balances read only the transactions after the
snapshot block (current confirmed totals minus everything newer), with
paced page requests and retries on HTTP 429, 502, 503 and 504; a history that cannot be
read completely is an error, never a partial balance. Alchemy calls are
retried on HTTP 429, 500, 502, 503 and 504, network errors and JSON-RPC rate limits (up to 5
retries, about 30 s); other JSON-RPC errors fail at once. Block numbers and
prices are cached in memory for one run only. The PDF shows the address only as a hash, as in the web app.

## Icons

`public/apple-touch-icon.png` is 180×180 PNG, regenerated from
`public/assets/logo-logomark.svg` whenever the logomark changes. The matching
favicon set (`favicon.ico`, `favicon-16x16.png`, `favicon-32x32.png`) lives
alongside it.

## Deployment

- `develop` → `dev.ledgerreport.com` (automatic, via GitHub Actions FTP)
- `main` → `ledgerreport.com` (automatic, via GitHub Actions FTP)

Both deploy jobs run `npm ci && npm run build` and ship `dist/` over FTP
with `dangerous-clean-slate: true` so the remote tree always reflects the
build output exactly. Hosting, secrets, and rotation procedure are
documented separately in the private infrastructure repo.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

MIT — see [`LICENSE`](./LICENSE).
