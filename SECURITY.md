# Security Policy

## Reporting a vulnerability

Please report security issues privately by opening a GitHub Security Advisory:

https://github.com/ledgerreport/app/security/advisories/new

Do not file public issues for vulnerabilities. We will acknowledge reports as
soon as we can and coordinate disclosure with you.

## Scope

LedgerReport has no server component. The web app runs entirely in the
user's browser, queries public RPC and pricing APIs, and never persists
wallet addresses server-side. Its deployment surface is a static bundle
uploaded via FTP to shared hosting.

The headless CLI (`npm run report`) is a local Node process started by the
user. It reads `.env` and the environment (the Alchemy key, optionally a
CoinGecko demo key), writes PDFs and `summary.csv` to the paths the user
gives, and talks to the same upstream APIs as the web app.

In-scope issues include: XSS or other code-execution paths in the bundled app,
incorrect balance or pricing logic that misleads the report, leaks of user
input to third parties beyond the documented upstream APIs, and supply-chain
issues in our direct dependencies.

## Out of scope

Vulnerabilities in third-party upstream services (Alchemy, CoinGecko,
mempool.space, the DFX backend) should be reported to the respective vendors.
Issues in transitive dev-only dependencies that do not affect the production
bundle are tracked but not treated as advisories here.
