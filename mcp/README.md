# @piprail/mcp

**Hand any AI agent a budget-bound payment wallet.** An [MCP](https://modelcontextprotocol.io) server that wraps [`@piprail/sdk`](https://www.npmjs.com/package/@piprail/sdk) so any MCP client — Claude Desktop, Cursor, Claude Code, Windsurf, VS Code, Cline — can pay [x402](https://x402.org) payment-gated URLs **on its own**, capped by a spend policy the model **cannot exceed**.

Runs on **your** machine with **your** wallet and **your** limits. No backend, no custody, no facilitator — PipRail never touches your funds.

```bash
npx -y @piprail/mcp        # speaks MCP over stdio
```

It exposes five tools:

| Tool | What it does |
| --- | --- |
| `piprail_discover` | Find payable resources on the **open** x402 indexes (CDP Bazaar + 402 Index, free) — the phone book. No paying. |
| `piprail_quote_payment` | Price a gated URL **without** paying. |
| `piprail_plan_payment` | Check you *can* pay — balance, gas, recipient-readiness — across every rail, without paying. |
| `piprail_pay_request` | Fetch a URL, paying the `402` automatically (within the budget). |
| `piprail_register` | List a resource you run on the open indexes (402 Index, no signature) so other agents can find it. |

---

## Quick start

Add it to your MCP client with two things: your **wallet private key** and (optionally) a **budget**. The defaults are deliberately small and safe: **0.10 per payment, 10.00 lifetime per token, USDC on Base.**

> **Never commit your key.** Put it in your client's `env` block, or export it and use `${env:…}` interpolation where the client supports it (Cursor, Claude Code, Windsurf, VS Code do; Claude Desktop does **not** — treat that config file as a secret).

### Claude Desktop

Settings → Developer → Edit Config, or edit directly:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "piprail": {
      "command": "npx",
      "args": ["-y", "@piprail/mcp"],
      "env": {
        "PIPRAIL_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY",
        "PIPRAIL_CHAIN": "base",
        "PIPRAIL_MAX_AMOUNT": "0.10",
        "PIPRAIL_MAX_TOTAL": "10.00",
        "PIPRAIL_TOKENS": "USDC"
      }
    }
  }
}
```

Restart Claude Desktop — the three `piprail_*` tools appear.

### Cursor — `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global)

```json
{
  "mcpServers": {
    "piprail": {
      "command": "npx",
      "args": ["-y", "@piprail/mcp"],
      "env": {
        "PIPRAIL_PRIVATE_KEY": "${env:PIPRAIL_PRIVATE_KEY}",
        "PIPRAIL_CHAIN": "base"
      }
    }
  }
}
```

### Claude Code — `.mcp.json` (project) or `~/.claude/.mcp.json`

```json
{
  "mcpServers": {
    "piprail": {
      "command": "npx",
      "args": ["-y", "@piprail/mcp"],
      "env": { "PIPRAIL_PRIVATE_KEY": "${env:PIPRAIL_PRIVATE_KEY}", "PIPRAIL_CHAIN": "base" }
    }
  }
}
```

### Windsurf — `~/.codeium/windsurf/mcp_config.json`

```json
{
  "mcpServers": {
    "piprail": {
      "command": "npx",
      "args": ["-y", "@piprail/mcp"],
      "env": { "PIPRAIL_PRIVATE_KEY": "${env:PIPRAIL_PRIVATE_KEY}", "PIPRAIL_CHAIN": "base" }
    }
  }
}
```

### VS Code (Copilot) — `.vscode/mcp.json` (note: top-level key is `servers`)

```json
{
  "servers": {
    "piprail": {
      "command": "npx",
      "args": ["-y", "@piprail/mcp"],
      "env": { "PIPRAIL_PRIVATE_KEY": "${env:PIPRAIL_PRIVATE_KEY}", "PIPRAIL_CHAIN": "base" }
    }
  }
}
```

### Cline — CLI-managed

```bash
export PIPRAIL_PRIVATE_KEY=0xYOUR_PRIVATE_KEY
export PIPRAIL_CHAIN=base
cline mcp add piprail npx -y @piprail/mcp
```

---

## Configuration

All configuration is via environment variables — **never CLI arguments** (a key in `argv` leaks in process listings and shell history). Canonical names are `PIPRAIL_*`; the legacy aliases below are also accepted.

| Variable | Alias | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `PIPRAIL_PRIVATE_KEY` | `PIPRAIL_WALLET_KEY`, `AGENT_KEY` | **yes** | — | Wallet key/seed for the chosen chain (see *Wallet formats* below). |
| `PIPRAIL_CHAIN` | `CHAIN` | no | `base` | Chain to pay on (any PipRail chain). |
| `PIPRAIL_MAX_AMOUNT` | `MAX_AMOUNT` | no | `0.10` | Max spend **per payment** (token units). |
| `PIPRAIL_MAX_TOTAL` | `MAX_TOTAL` | no | `10.00` | Lifetime cap **per token** (token units). |
| `PIPRAIL_TOKENS` | `TOKENS` | no | `USDC` *(USDT on Tron/TON)* | Comma-separated allowed token symbols, plus `native` for the chain's coin. |
| `PIPRAIL_HOSTS` | `HOSTS` | no | (any) | Comma-separated host allowlist (`api.x.com`, `*.y.com`). |
| `PIPRAIL_RPC_URL` | `RPC_URL` | no | chain default | Override the RPC endpoint. |
| `PIPRAIL_ALLOW_UNKNOWN_TOKENS` | — | no | `false` | Pay tokens the SDK can't price? Keep `false`. |
| `PIPRAIL_NEAR_ACCOUNT_ID` | `NEAR_ACCOUNT_ID` | only on NEAR | — | Your NEAR account id (e.g. `you.near`). |

### Wallet formats

`PIPRAIL_PRIVATE_KEY` holds your secret in the chosen chain's native form — the server maps it to the right shape automatically:

| Chain(s) | Format |
| --- | --- |
| EVM (base, ethereum, …), Tron | private key — `0x…` 32-byte hex |
| Sui | private key — `suiprivkey1…` (bech32) |
| Aptos | private key — `ed25519-priv-0x…` (AIP-80) or raw `0x…` hex |
| Solana | secret key — base58 |
| TON | mnemonic — 24 words, space-separated |
| Algorand | mnemonic — 25 words, space-separated |
| Stellar | secret seed — `S…` |
| XRPL | seed — `s…` |
| NEAR | private key — `ed25519:…` **+** `PIPRAIL_NEAR_ACCOUNT_ID` |

---

## Chains

**EVM chains work out of the box** — `npx -y @piprail/mcp` ships with `viem`, so `base`, `ethereum`, `arbitrum`, `polygon`, `bnb`, and every other EVM preset just run.

**Non-EVM chains** (Solana, TON, Tron, NEAR, Sui, Aptos, Algorand, Stellar, XRPL) need their SDK peer library available — the SDK keeps them as optional lazy peers so EVM installs stay lean. Install the matching peer alongside the server, e.g. for Solana:

```bash
npx -y -p @piprail/mcp -p @solana/web3.js -p @solana/spl-token -p bs58 piprail-mcp
```

(The per-family peers are listed in [`@piprail/sdk`'s `peerDependencies`](https://www.npmjs.com/package/@piprail/sdk).)

### The default token is chain-aware

`PIPRAIL_TOKENS` defaults to the canonical stablecoin that actually **exists** on the chain: **USDC** everywhere, but **USDT** on **Tron** and **TON** (native USDC doesn't exist there, so a USDC-only policy would silently block every payment). Override it anytime, e.g. `PIPRAIL_TOKENS=USDC,native` to also allow the chain's coin. The allowlist takes token **symbols** (`USDC`, `USDT`, `EURC`, …) plus the chain-agnostic alias **`native`** — the same word the accept side uses (`token: 'native'`) — which allows the chain's own coin (ETH on Base, TRX on Tron, XLM on Stellar, …) without naming the ticker. (Its real ticker works too.)

### Per-chain caveats

The server prints a `⚠ notes:` block on startup where these apply. The full per-chain list lives in the SDK's [CHAINS.md](https://github.com/piprail/piprail/blob/main/sdk/CHAINS.md).

- **API keys go in the RPC URL.** The SDK has **no separate API-key field** — fold any key into `PIPRAIL_RPC_URL`.
- **TON** — a keyed RPC is **effectively required**: the keyless public endpoint is rate-limited (~1 req/s) and stalls verification. Use `PIPRAIL_RPC_URL=https://toncenter.com/api/v2/jsonRPC?api_key=YOUR_KEY`. Pays **USDT**; wallet key is the 24-word mnemonic.
- **Tron** — the default public RPC (TronGrid) is rate-limited. For production point `PIPRAIL_RPC_URL` at a higher-limit endpoint; note the SDK passes it as the node URL and has no header field, so use a provider that accepts a URL-embedded key (or your own node) rather than a header-only TronGrid key. Gas is **real TRX** (a USDT transfer burns Energy), so the wallet needs **TRX as well as USDT** — `piprail_plan_payment` budgets both. Pays **USDT**; wallet key is a 32-byte hex private key (like EVM).
- **NEAR** — set `PIPRAIL_NEAR_ACCOUNT_ID` (your `you.near`); the key is the `ed25519:…` secret.
- **Stellar / XRPL / Algorand** — receiving needs a one-time trustline/opt-in on the *recipient* side; `piprail_plan_payment` reports `recipientReady` so the agent knows before it pays.

### Paying on multiple chains at once

Each server instance is **one wallet on one chain.** To give an agent several rails, register the server once per chain — each MCP entry is namespaced, so the agent gets all of them:

```json
{
  "mcpServers": {
    "piprail-base": {
      "command": "npx", "args": ["-y", "@piprail/mcp"],
      "env": { "PIPRAIL_PRIVATE_KEY": "0xYOUR_EVM_KEY", "PIPRAIL_CHAIN": "base" }
    },
    "piprail-solana": {
      "command": "npx", "args": ["-y", "@piprail/mcp"],
      "env": { "PIPRAIL_PRIVATE_KEY": "<solana-secret-base58>", "PIPRAIL_CHAIN": "solana" }
    },
    "piprail-tron": {
      "command": "npx", "args": ["-y", "@piprail/mcp"],
      "env": {
        "PIPRAIL_PRIVATE_KEY": "<tron-hex-key>",
        "PIPRAIL_CHAIN": "tron",
        "PIPRAIL_TOKENS": "USDT",
        "PIPRAIL_RPC_URL": "https://api.trongrid.io"
      }
    }
  }
}
```

(On Tron, `PIPRAIL_TOKENS=USDT` is the default anyway — shown for clarity; swap the TronGrid URL for your own higher-limit endpoint in production, and keep TRX in the wallet for gas.)

---

## Why it's safe

- **The spend policy is the boundary.** `PIPRAIL_MAX_AMOUNT` / `PIPRAIL_MAX_TOTAL` / `PIPRAIL_TOKENS` / `PIPRAIL_HOSTS` are enforced by the SDK **before any on-chain send** — an over-budget request comes back as `{ declined: true, reason }` and **nothing moves**. The model cannot overspend even if it tries.
- **No custody, no backend.** This server runs locally with your key; funds settle wallet-to-wallet against your own RPC. PipRail runs no service and holds nothing.
- **Caps are checked against the token's true decimals**, so a malicious server can't slip past a limit by understating a price.

---

## Use it as a library

```ts
import { createMcpServer, parseConfig, configToClientOptions } from '@piprail/mcp'

const config = parseConfig(process.env)
const { server } = createMcpServer(configToClientOptions(config))
// connect your own transport…
```

---

## Links

[PipRail](https://piprail.com) · [`@piprail/sdk`](https://www.npmjs.com/package/@piprail/sdk) · [SDK docs](https://github.com/piprail/piprail/blob/main/sdk/README.md) · [x402](https://x402.org) · [Model Context Protocol](https://modelcontextprotocol.io)

MIT · no backend, no fee, ever.
