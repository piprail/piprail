---
title: Client setup
description: One config block per MCP client — where the file lives, the top-level key, and whether ${env:…} interpolation is supported.
sidebar:
  order: 3
---

## Introduction

Every MCP client runs the server the same way: it spawns `npx -y @piprail/mcp` over stdio and
hands it configuration through an `env` block. What differs per client is only **where the
config file lives**, **the top-level JSON key**, and **whether you can interpolate**
`${env:…}` rather than pasting the raw key.

This page is one row per client. For what goes *inside* `env`, see
[Configuration](/mcp/configuration/); for the wallet key format your chain expects, see
[Wallets by family](/making-payments/wallets-by-family/).

## The invocation is identical everywhere

`command` and `args` never change — only the config wrapper around them does:

```jsonc
{
  "command": "npx",
  "args": ["-y", "@piprail/mcp"],
  "env": { "PIPRAIL_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY", "PIPRAIL_CHAIN": "base" }
}
```

:::danger
Never commit your key. Put it in the client's `env` block, or export it to your shell and use
`${env:…}` interpolation where the client supports it. Clients that **don't** interpolate write
the raw key into the config file — treat that file as a secret.
:::

## Clients at a glance

| Client | Config file | Top-level key | `${env:…}` |
| --- | --- | --- | --- |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) · `%APPDATA%\Claude\claude_desktop_config.json` (Windows) | `mcpServers` | **No** — file is a secret |
| Cursor | `.cursor/mcp.json` (project) · `~/.cursor/mcp.json` (global) | `mcpServers` | Yes |
| Claude Code | `.mcp.json` (project) · `~/.claude.json` (user) | `mcpServers` | Yes |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` | Yes |
| VS Code (Copilot) | `.vscode/mcp.json` | **`servers`** | Yes |
| Cline | `cline_mcp_settings.json` (edited from the MCP Servers panel) | `mcpServers` | Yes |
| OpenClaw | `~/.openclaw/openclaw.json` | **`mcp.servers`** (nested) | **No** — file is a secret |
| Hermes | `~/.hermes/config.yaml` (**YAML**) | **`mcp_servers`** | Yes — `${VAR}` from `~/.hermes/.env` |
| Goose | `~/.config/goose/config.yaml` (**YAML**) | **`extensions`** (nested, `type: stdio`) | Yes |

Goose runs `@piprail/mcp` as a stdio **extension** — add it under `extensions:` with `cmd: npx`,
`args: [-y, @piprail/mcp]`, `type: stdio`, and the `PIPRAIL_*` env (or use `goose configure` →
Add Extension → Command-line). Every other MCP client works the same way via `npx -y @piprail/mcp`.

## Claude Desktop

Open Settings → Developer → Edit Config, or edit the file directly. Claude Desktop does **not**
interpolate `${env:…}`, so the key goes in the file — keep it out of version control.

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

Restart Claude Desktop and the `piprail_*` tools appear.

## Cursor

Project config at `.cursor/mcp.json`, or global at `~/.cursor/mcp.json`. Cursor interpolates
`${env:…}`, so export the key to your shell and reference it:

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

## Claude Code

Project config at `.mcp.json` (commit-safe with `${env:…}`); user config across all projects
lives in `~/.claude.json`. Same shape, same `${env:…}` support. You can also add it from the
CLI — `claude mcp add piprail --scope user --env PIPRAIL_CHAIN=base -- npx -y @piprail/mcp` —
which writes the same block for you.

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

## Windsurf

Config at `~/.codeium/windsurf/mcp_config.json`:

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

## VS Code (Copilot)

Config at `.vscode/mcp.json`. Note the top-level key is **`servers`**, not `mcpServers`:

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

## Cline

Cline stores servers in `cline_mcp_settings.json`. Open it from the MCP Servers icon →
**Configure** → **Configure MCP Servers**, then add the same `mcpServers` block:

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

## OpenClaw

OpenClaw nests MCP servers under **`mcp.servers`** in `~/.openclaw/openclaw.json` (not a top-level
`mcpServers`), and manages the block with `openclaw mcp set` / `openclaw mcp list`. Put the key in the
`env` block — treat the file as a secret. You can also `clawhub install piprail` to discover it. Full
guide: the [OpenClaw integration](/integrations/openclaw/).

```json
{
  "mcp": {
    "servers": {
      "piprail": {
        "command": "npx",
        "args": ["-y", "@piprail/mcp"],
        "env": { "PIPRAIL_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY", "PIPRAIL_CHAIN": "base" }
      }
    }
  }
}
```

## Hermes

[Hermes](https://github.com/NousResearch/hermes-agent) nests MCP servers under the top-level
**`mcp_servers`** key in `~/.hermes/config.yaml` — and it's **YAML**, not JSON. Hermes expands
`${VAR}` (but not bare `$VAR`) from `~/.hermes/.env`, and does **not** inherit your shell env into the
server, so the key must live in the `env:` block. After editing, run `/reload-mcp`. Full guide: the
[Hermes integration](/integrations/hermes/).

```yaml
mcp_servers:
  piprail:
    command: "npx"
    args: ["-y", "@piprail/mcp"]
    env:
      PIPRAIL_PRIVATE_KEY: "${PIPRAIL_PRIVATE_KEY}"
      PIPRAIL_CHAIN: "base"
```

## More than one chain

There are two ways. The simplest is **one server, several chains**: set `PIPRAIL_CHAINS` and give
each chain its own `PIPRAIL_<CHAIN>_KEY` — `piprail_pay_request` then pays whichever chain a 402
asks for (the first you listed that can settle), under one shared budget. See
[Configuration → pay on several chains](/mcp/configuration/#pay-on-several-chains-from-one-server).

Prefer **separate per-chain instances** when you want an independent budget (or token allowlist, or
confirm mode) per chain — register the server once per chain, each entry namespaced so the agent
gets all of them:

```json
{
  "mcpServers": {
    "piprail-base": {
      "command": "npx", "args": ["-y", "@piprail/mcp"],
      "env": { "PIPRAIL_PRIVATE_KEY": "0xYOUR_EVM_KEY", "PIPRAIL_CHAIN": "base" }
    },
    "piprail-solana": {
      "command": "npx", "args": ["-y", "@piprail/mcp"],
      "env": { "PIPRAIL_PRIVATE_KEY": "YOUR_SOLANA_SECRET_BASE58", "PIPRAIL_CHAIN": "solana" }
    }
  }
}
```

:::note
Non-EVM chains need their SDK peer library available alongside the server — see
[Chains](/mcp/chains/) for the per-family install. EVM chains run with no extra peers.
:::
