/**
 * ── THE ONE ENV LOADER ──────────────────────────────────────────────────────────────
 *
 *   import { loadEnv } from '<repo>/scripts/load-env.mjs'
 *   loadEnv()   // idempotent; populates process.env from the repo's .env
 *
 * PipRail's operational secrets used to live in three places — `.env`, `.secrets/x-api.env`
 * and `.secrets/live-matrix.env` — each with its own ad-hoc parser. That is how
 * `RPC_TON='https://…'` reached the SDK with the quotes still attached and produced
 * `TypeError: Invalid URL`: one loader stripped quotes, another didn't, and neither was the
 * one you were reading. Now there is exactly one parser and exactly one file.
 *
 * ── WHAT IS *NOT* HERE, AND WHY ─────────────────────────────────────────────────────
 * Two credential stores deliberately stay out of `.env`, because flattening them would make
 * things worse, not better:
 *
 *   1. `.secrets/wallets/<family>-wallet.json` — STRUCTURED, not key=value. Each file is one
 *      chain family holding a payer AND a recoverable merchant (address + secret + role), read
 *      by name by the audit harnesses. Flattening 12 families x 2 roles into flat vars would
 *      lose the structure, break every consumer, and put every chain's key in one blast radius.
 *   2. `~/.config/gcp/*-oauth.json` — a Google-issued OAuth token file for GSC/GA4, machine-level
 *      and shared with John's other sites. Not ours to relocate, and not a key=value secret.
 *
 * `.env.example` documents BOTH so "where is everything?" still has one answer.
 *
 * ── PARSING ─────────────────────────────────────────────────────────────────────────
 * `KEY=value`, `#` comments, blank lines, and OPTIONAL surrounding quotes (stripped — see
 * above). An existing `process.env` value always WINS, so a one-off
 * `RPC_TRON=… node …` override still works and CI never has its environment overwritten.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Parse dotenv text → object. Exported for tests; does not touch `process.env`. */
export function parseEnv(text) {
  const out = {}
  for (const line of text.split('\n')) {
    // `export ` is optional and ignored: plenty of .env files carry it (they double as a
    // shell `source` target), and silently skipping those lines would drop a credential
    // without a word — the worst possible failure for this file.
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m || line.trimStart().startsWith('#')) continue
    // Strip ONE matching pair of surrounding quotes. `.env` files routinely quote values and
    // the raw capture keeps them; an unstripped URL is not a URL.
    out[m[1]] = m[2].replace(/^(['"])([\s\S]*)\1$/, '$2')
  }
  return out
}

let loaded = false

/**
 * Populate `process.env` from the repo's `.env`. Idempotent, and never overwrites a variable
 * that is already set. Missing `.env` is NOT an error — every consumer must degrade to a
 * clear "credential missing" message of its own, so a fresh clone still runs.
 *
 * @returns {{ path: string, found: boolean, keys: string[] }}
 */
export function loadEnv({ force = false } = {}) {
  const path = join(REPO_ROOT, '.env')
  if (loaded && !force) return { path, found: existsSync(path), keys: [] }
  loaded = true
  if (!existsSync(path)) return { path, found: false, keys: [] }
  const parsed = parseEnv(readFileSync(path, 'utf8'))
  const keys = []
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) {
      process.env[k] = v
      keys.push(k)
    }
  }

  /*
   * TON convenience: the SDK keys toncenter through the URL (`?api_key=…`), but the
   * balance readers want the bare key as TONCENTER_API_KEY. Derive one from the other so
   * there is a single thing to configure. This was hand-duplicated in wallet-audit's
   * audit.mjs AND verify-tokens.mjs; two copies of a derivation is one too many.
   */
  if (!process.env.TONCENTER_API_KEY && process.env.RPC_TON) {
    const m = process.env.RPC_TON.match(/[?&]api_key=([^&]+)/)
    if (m) {
      process.env.TONCENTER_API_KEY = m[1]
      keys.push('TONCENTER_API_KEY (derived from RPC_TON)')
    }
  }
  return { path, found: true, keys }
}

/**
 * Read one required credential, or exit with an actionable message naming the variable and
 * `.env.example`. Never prints the VALUE. Use this instead of hand-rolling the check — the
 * point is that a missing key always fails the same, legible way.
 */
export function requireEnv(name, hint = '') {
  loadEnv()
  const v = process.env[name]
  if (!v) {
    console.error(
      `\n✗ Missing ${name}\n` +
        `  Add it to ${join(REPO_ROOT, '.env')} — see .env.example for what it is and where to get it.` +
        (hint ? `\n  ${hint}` : '') +
        '\n'
    )
    process.exit(1)
  }
  return v
}
