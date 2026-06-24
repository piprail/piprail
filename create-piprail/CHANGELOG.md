# Changelog

All notable changes to `create-piprail` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/).

## [0.1.0] — unreleased

Initial release — the seller's zero-code on-ramp, the mirror of the buyer's `npx -y @piprail/mcp`.
One command scaffolds a self-hosted, mainnet-by-default, agent-discoverable x402 merchant.

### Added

- **`npm create piprail` / `npx create-piprail`** — scaffold a self-hosted x402 merchant in one
  command. Flag-driven **and** interactive (Node `readline`; zero runtime dependencies).
- **What you sell:** `--sell api` (a paywalled endpoint), `--sell tip` (an open "pay ≥ a minimum" tip
  jar), or `--sell proxy` (gate an EXISTING API in any language via an edge proxy — pass `--origin`).
- **Where it runs:** `--host node` (Express), `--host cloudflare` (Worker), or `--host vercel` (Edge
  Function) — each a complete, runnable app whose only dependency is `@piprail/sdk` (+ `express` for
  node).
- **Mainnet by default** — the chain + your **public** `payTo` address are baked into `src/gate.mjs`
  as literals (no private key, no env); the scaffolder **never** emits a testnet config.
- **One-click Deploy buttons** in the Cloudflare / Vercel READMEs (deploy to *your own* account; the
  config is already baked in, no secret to set).
- Every generated app ships **`npm run verify`** — a read-only `gate.selfTest()` that confirms the
  config without signing or sending — and self-describes for agents: it emits the x402 **`bazaar`**
  block (`discovery: true` on the api/tip gate — the highest-leverage discoverability artifact, per the
  Phase 6 census) **and** serves **`/.well-known/x402`**, so an AI agent can both find AND invoke it.
- **Human landing page** — a browser GET gets a friendly HTML page; an agent or `curl` gets the
  machine-readable `402` JSON, from the same endpoint.
- **Shareable embed** — the api / tip README includes a copy-paste browser "Pay" button.
- Flags: `--chain`, `--token`, `--amount` / `--min`, `--pay-to`, `--origin`, `--name`, `--force`,
  `--yes`/`-y`, `--help`/`-h`, `--version`/`-v`.

> **Note:** the generated app depends on `@piprail/sdk` at `latest`. The merchant presets
> (`createPaywall` / `createTipJar`) + `gate.selfTest()` it uses ship in the SDK release that
> accompanies this package — install against that version or newer.
