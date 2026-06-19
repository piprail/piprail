/**
 * Config layer — turn process env into a validated {@link Config}, then into
 * {@link PipRailClientOptions} for the SDK.
 *
 * PURE + side-effect-free: `parseConfig` takes an env object (you pass it in —
 * it never touches `process.env` itself), so it's trivially unit-testable with
 * a fake env. No SDK client is constructed here, no network is touched.
 *
 * The wallet secret is read once, never logged, and mapped to the SDK's
 * per-family {@link WalletInput} shape by {@link walletInputFor}.
 */
import { z } from 'zod'
import { CHAINS } from '@piprail/sdk'
import type {
  ChainSelector,
  PaymentPolicy,
  PaymentScheme,
  PipRailClientOptions,
  WalletInput,
} from '@piprail/sdk'

/** One funded (or read-only) chain account in multi-chain mode — built from
 *  `PIPRAIL_<CHAIN>_KEY` / `PIPRAIL_<CHAIN>_RPC_URL` for each chain in
 *  `PIPRAIL_CHAINS`. The SDK binds one {@link PipRailClient} per account, behind a
 *  single `MultiChainPayer`. */
export interface ChainAccount {
  /** Chain selector string (EVM preset name or a non-EVM family name). */
  chain: string
  /** This chain's key/seed/mnemonic, in its native format. NEVER logged. Absent ⇒
   *  this chain is read-only (it can plan/quote but not pay). */
  walletSecret?: string
  /** Override this chain's default RPC. */
  rpcUrl?: string
  /** Required only when `chain === 'near'` (shared PIPRAIL_NEAR_ACCOUNT_ID). */
  nearAccountId?: string
  /** True when no key was supplied for this chain. */
  readOnly: boolean
  /** Which env var supplied this chain's key — banner only, never the value. */
  keySource?: string
}

/** Validated, normalized configuration — the single source the rest of the package reads. */
export interface Config {
  /** Chain selector string (EVM preset name or a non-EVM family name). In
   *  multi-chain mode this is the PRIMARY (first) chain; the full set is `chains`. */
  chain: string
  /** Multi-chain mode (PIPRAIL_CHAINS set): one funded account per chain — the
   *  server builds a `MultiChainPayer` over them so the model pays whichever chain a
   *  402 asks for. ABSENT ⇒ single-chain mode (the scalar fields below), byte-identical
   *  to before. */
  chains?: ChainAccount[]
  /** The wallet key/seed/mnemonic, in the chosen chain's native format. NEVER logged.
   *  Absent ⇒ READ-ONLY mode: discover/quote/register/budget/guide work; paying does not.
   *  In multi-chain mode this is the primary chain's key (per-chain keys live in `chains`). */
  walletSecret?: string
  /** True when no wallet secret was supplied for ANY chain — the server runs read-only. */
  readOnly: boolean
  /** Required only when `chain === 'near'`. */
  nearAccountId?: string
  /** Override the chain's default RPC. */
  rpcUrl?: string
  /** Per-payment ceiling (human units). */
  maxAmount: string
  /** Lifetime ceiling per distinct token (human units). */
  maxTotal: string
  /** Allowed token symbols, plus the alias `native` for the chain's coin. */
  tokens: string[]
  /** Optional host allowlist (exact or `*.example.com`). */
  hosts?: string[]
  /** Pay tokens the SDK can't price? Default false (safe). */
  allowUnknownTokens: boolean
  /** Which payment schemes to settle. Absent ⇒ the SDK default (`onchain-proof` only,
   *  so the MCP zero-config posture is byte-identical). Set via PIPRAIL_SCHEMES. */
  schemes?: PaymentScheme[]
  /** Session TTL in seconds (PIPRAIL_TTL). Absent ⇒ no time limit. */
  ttlSeconds?: number
  /** Rolling-window cap, human units (PIPRAIL_WINDOW_TOTAL). Set WITH windowSeconds. */
  windowTotal?: string
  /** Rolling-window width in seconds (PIPRAIL_WINDOW_SECONDS). Shared by windowTotal +
   *  maxPaymentsPerWindow. */
  windowSeconds?: number
  /** Cross-token GRAND TOTAL per denomination (PIPRAIL_MAX_TOTAL_DENOM, CSV `USD:20.00,EUR:5.00`).
   *  One budget across every stablecoin of that unit and every funded chain. */
  maxTotalPerDenom?: Record<string, string>
  /** Lifetime cap on the NUMBER of payments, across every chain + token (PIPRAIL_MAX_PAYMENTS). */
  maxPayments?: number
  /** Rolling-window cap on the NUMBER of payments (PIPRAIL_MAX_PAYMENTS_PER_WINDOW; needs windowSeconds). */
  maxPaymentsPerWindow?: number
  /** Warn (via the event log) when spend crosses this fraction of any cap (PIPRAIL_WARN_AT_FRACTION, 0–1). */
  warnAtFraction?: number
  /** Durable spend-log file path (PIPRAIL_SPEND_LOG) — make the budget survive a restart. */
  spendLog?: string
  /** Where to mirror payment events (PIPRAIL_EVENT_LOG): `stderr` or a file path. Absent ⇒ no event sink. */
  eventLog?: string
  /** Ask the human to approve each payment via MCP elicitation (PIPRAIL_CONFIRM).
   *  Default false — Mode A (the spend policy IS the consent). True ⇒ Mode B (supervised). */
  confirm: boolean
  /** Override the elicitation approval window in ms (PIPRAIL_CONFIRM_TIMEOUT_MS). Default 55000. */
  confirmTimeoutMs?: number
  /** Expose the PIPRAIL_AGENT_GUIDE prompt + resource (PIPRAIL_GUIDE). Default true. */
  guide: boolean
  /** Which env var supplied the key — surfaced in the banner (never the value).
   *  Absent in read-only mode (no key). */
  keySource?: string
}

type Env = Record<string, string | undefined>

/** Thrown on any invalid/missing config — the message is already human-friendly. */
export class ConfigError extends Error {
  override name = 'ConfigError'
}

/** Every recognized `PIPRAIL_*` var — used to catch typos via a strict guard.
 *  Multi-chain mode ALSO accepts per-chain `PIPRAIL_<CHAIN>_KEY` /
 *  `PIPRAIL_<CHAIN>_RPC_URL` vars for each chain listed in `PIPRAIL_CHAINS`
 *  (validated dynamically — see {@link parseConfig}). */
const KNOWN_PIPRAIL_VARS = [
  'PIPRAIL_PRIVATE_KEY',
  'PIPRAIL_WALLET_KEY',
  'PIPRAIL_CHAIN',
  'PIPRAIL_CHAINS',
  'PIPRAIL_RPC_URL',
  'PIPRAIL_MAX_AMOUNT',
  'PIPRAIL_MAX_TOTAL',
  'PIPRAIL_TOKENS',
  'PIPRAIL_HOSTS',
  'PIPRAIL_ALLOW_UNKNOWN_TOKENS',
  'PIPRAIL_SCHEMES',
  'PIPRAIL_NEAR_ACCOUNT_ID',
  // Time envelope (Feature A): a session TTL + an optional rolling window.
  'PIPRAIL_TTL',
  'PIPRAIL_WINDOW_TOTAL',
  'PIPRAIL_WINDOW_SECONDS',
  // Cross-token grand total + payment-count caps + threshold warning.
  'PIPRAIL_MAX_TOTAL_DENOM',
  'PIPRAIL_MAX_PAYMENTS',
  'PIPRAIL_MAX_PAYMENTS_PER_WINDOW',
  'PIPRAIL_WARN_AT_FRACTION',
  // Durable budget + an operator event sink (both opt-in; no backend).
  'PIPRAIL_SPEND_LOG',
  'PIPRAIL_EVENT_LOG',
  // Ask-before-pay (Feature B, Mode B) + the agent guide (Feature C).
  'PIPRAIL_CONFIRM',
  'PIPRAIL_CONFIRM_TIMEOUT_MS',
  'PIPRAIL_GUIDE',
] as const

/** The payment schemes the MCP may enable via PIPRAIL_SCHEMES. */
const VALID_SCHEMES = ['onchain-proof', 'exact'] as const

/** Non-EVM family selectors the SDK accepts as a `chain` string. */
const NON_EVM_CHAINS = [
  'solana',
  'ton',
  'tron',
  'near',
  'sui',
  'aptos',
  'algorand',
  'stellar',
  'xrpl',
] as const

/** All chain strings valid from an env var (EVM presets + non-EVM families). */
const KNOWN_CHAINS = new Set<string>([...Object.keys(CHAINS), ...NON_EVM_CHAINS])

const csv = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

const decimal = (name: string) =>
  z
    .string()
    .trim()
    .refine((v) => /^\d+(\.\d+)?$/.test(v) && Number.isFinite(Number(v)), {
      message: `${name} must be a non-negative decimal like "0.10"`,
    })

/** A positive integer number of SECONDS whose `*1000` ms deadline stays a safe
 *  integer, capped at 10 years — the time-envelope knobs (PIPRAIL_TTL / window). */
const intSeconds = (name: string) =>
  z
    .string()
    .trim()
    .refine(
      (v) =>
        /^\d+$/.test(v) &&
        Number.isSafeInteger(Number(v)) &&
        Number(v) > 0 &&
        Number.isSafeInteger(Number(v) * 1000) &&
        Number(v) <= 315_360_000,
      { message: `${name} must be a positive integer number of seconds (<= 10 years)` }
    )

/** A positive integer number of MILLISECONDS — the elicitation timeout override. */
const intMs = (name: string) =>
  z
    .string()
    .trim()
    .refine((v) => /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) && Number(v) > 0, {
      message: `${name} must be a positive integer number of milliseconds`,
    })

/** The boolean-knob coercion shared by PIPRAIL_CONFIRM + PIPRAIL_GUIDE. */
const boolKnob = () => z.string().transform((v) => /^(1|true|yes)$/i.test(v.trim()))

/** Read the first set, non-empty value among `names`; also report which one matched. */
function pick(env: Env, ...names: string[]): { value?: string; source?: string } {
  for (const name of names) {
    const v = env[name]
    if (v !== undefined && v.trim() !== '') return { value: v.trim(), source: name }
  }
  return {}
}

/** The ENV-name fragment for a chain's per-chain vars: uppercase, non-alphanumerics
 *  → '_'. `base` → `BASE` (PIPRAIL_BASE_KEY); a hyphenated preset → `WORLD_CHAIN`. */
const envChainKey = (chain: string): string => chain.toUpperCase().replace(/[^A-Z0-9]/g, '_')

/** A usable JSON-RPC endpoint URL — http(s) for HTTP RPC, ws(s) for WebSocket RPC.
 *  Rejects parseable-but-unusable URIs (mailto:/ftp:/foo:bar) at config time, with a
 *  clear error, instead of an opaque network failure later. */
const RPC_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:'])
function isRpcUrl(value: string): boolean {
  try {
    return RPC_SCHEMES.has(new URL(value).protocol)
  } catch {
    return false
  }
}

/**
 * Multi-chain mode — parse `PIPRAIL_CHAINS` into one {@link ChainAccount} per chain,
 * reading each chain's own `PIPRAIL_<CHAIN>_KEY` (+ optional `PIPRAIL_<CHAIN>_RPC_URL`).
 * NEAR shares the single `PIPRAIL_NEAR_ACCOUNT_ID`. A chain with no key is read-only
 * (it can plan/quote but not pay). Throws {@link ConfigError} on an unknown chain, a
 * malformed per-chain RPC, or a keyed NEAR without its account id.
 */
function parseChainAccounts(env: Env, chainsRaw: string): ChainAccount[] {
  const list = [...new Set(csv(chainsRaw.toLowerCase()))]
  if (list.length === 0) {
    throw new ConfigError('PIPRAIL_CHAINS is empty — list at least one chain, e.g. "base,solana".')
  }
  const nearAccountId = pick(env, 'PIPRAIL_NEAR_ACCOUNT_ID', 'NEAR_ACCOUNT_ID').value
  return list.map((chain) => {
    if (!KNOWN_CHAINS.has(chain)) {
      throw new ConfigError(
        `Unknown chain "${chain}" in PIPRAIL_CHAINS. Use EVM presets (e.g. base, arbitrum, polygon, bnb) ` +
          `or a non-EVM family (${NON_EVM_CHAINS.join(', ')}).`
      )
    }
    const evk = envChainKey(chain)
    const k = pick(env, `PIPRAIL_${evk}_KEY`)
    const rpc = pick(env, `PIPRAIL_${evk}_RPC_URL`).value
    if (rpc !== undefined && !isRpcUrl(rpc)) {
      throw new ConfigError(`PIPRAIL_${evk}_RPC_URL must be an http(s) or ws(s) URL.`)
    }
    if (chain === 'near' && k.value && !nearAccountId) {
      throw new ConfigError(
        'chain "near" in PIPRAIL_CHAINS requires PIPRAIL_NEAR_ACCOUNT_ID (your NEAR account id, e.g. you.near).'
      )
    }
    return {
      chain,
      ...(k.value ? { walletSecret: k.value } : {}),
      ...(rpc ? { rpcUrl: rpc } : {}),
      ...(chain === 'near' && nearAccountId ? { nearAccountId } : {}),
      readOnly: !k.value,
      ...(k.source ? { keySource: k.source } : {}),
    }
  })
}

/**
 * Parse + validate the environment into a {@link Config}. Throws {@link ConfigError}
 * (with an actionable message) on anything missing or malformed — the caller
 * prints it to stderr and exits non-zero. Defaults: chain=base, maxAmount=0.10,
 * maxTotal=10.00, tokens=USDC, allowUnknownTokens=false.
 */
export function parseConfig(env: Env = process.env): Config {
  // 0) Multi-chain mode? PIPRAIL_CHAINS lists the chains, each with its own
  //    PIPRAIL_<CHAIN>_KEY (+ optional _RPC_URL). Parsed FIRST so the typo guard knows
  //    which per-chain vars are legal. Absent ⇒ single-chain mode (byte-identical to before).
  const chainsRaw = pick(env, 'PIPRAIL_CHAINS').value
  const accounts = chainsRaw !== undefined ? parseChainAccounts(env, chainsRaw) : null

  // 1) Typo guard: reject any unrecognized PIPRAIL_* var so a mistyped name
  //    fails loudly instead of being silently ignored. In multi-chain mode, the
  //    per-chain PIPRAIL_<CHAIN>_KEY / _RPC_URL for each LISTED chain are legal too.
  const allowedDynamic = new Set(
    (accounts ?? []).flatMap((a) => {
      const evk = envChainKey(a.chain)
      return [`PIPRAIL_${evk}_KEY`, `PIPRAIL_${evk}_RPC_URL`]
    })
  )
  const unknown = Object.keys(env).filter(
    (k) =>
      k.startsWith('PIPRAIL_') &&
      !KNOWN_PIPRAIL_VARS.includes(k as never) &&
      !allowedDynamic.has(k)
  )
  if (unknown.length) {
    throw new ConfigError(
      `Unknown PipRail config var(s): ${unknown.join(', ')}.\n` +
        `Valid vars: ${KNOWN_PIPRAIL_VARS.join(', ')}` +
        (accounts ? ` plus per-chain PIPRAIL_<CHAIN>_KEY / _RPC_URL for: ${accounts.map((a) => a.chain).join(', ')}.` : '.')
    )
  }

  // 1b) Reject mixing the two modes — keys/chain/RPC are EITHER global (single) OR
  //     per-chain (multi), never both, so a stray global key can't silently win.
  if (accounts) {
    if (pick(env, 'PIPRAIL_CHAIN', 'CHAIN').value) {
      throw new ConfigError('Use PIPRAIL_CHAINS (multi-chain) OR PIPRAIL_CHAIN (single) — not both.')
    }
    if (pick(env, 'PIPRAIL_PRIVATE_KEY', 'PIPRAIL_WALLET_KEY', 'AGENT_KEY').value) {
      throw new ConfigError(
        'In multi-chain mode keys are per-chain: set PIPRAIL_<CHAIN>_KEY for each chain, not the global PIPRAIL_PRIVATE_KEY.'
      )
    }
    if (pick(env, 'PIPRAIL_RPC_URL', 'RPC_URL').value) {
      throw new ConfigError(
        'In multi-chain mode RPC is per-chain: set PIPRAIL_<CHAIN>_RPC_URL, not the global PIPRAIL_RPC_URL.'
      )
    }
  }

  // 2) The wallet secret + chain. Single mode: the global vars (absent key ⇒ READ-ONLY:
  //    the server still boots + serves the read-only tools). Multi mode: the PRIMARY
  //    (first) chain's values; the full set rides in `accounts`. Read-only iff NO chain
  //    has a key. Supplying a single key is byte-identical to before.
  const primary = accounts ? accounts[0]! : null
  const key = primary
    ? { value: primary.walletSecret, source: primary.keySource }
    : pick(env, 'PIPRAIL_PRIVATE_KEY', 'PIPRAIL_WALLET_KEY', 'AGENT_KEY')
  const readOnly = accounts ? accounts.every((a) => a.readOnly) : !key.value

  // Normalize single-mode casing to match multi-mode (which lowercases the list) — chain
  // selectors are all lowercase, so `PIPRAIL_CHAIN=Base` should resolve like `base`.
  const chain = primary
    ? primary.chain
    : (pick(env, 'PIPRAIL_CHAIN', 'CHAIN').value?.toLowerCase() ?? 'base')

  // The default stablecoin tracks what actually EXISTS on the chain — a USDC-only
  // default would silently block every payment on a chain without native USDC. Tron &
  // TON ship USD₮ (no native USDC); Kaia likewise (and any future USDC-less EVM preset
  // is caught data-driven from the SDK's own token set, so this never drifts).
  // Overridable via PIPRAIL_TOKENS. Multi-chain ⇒ the UNION across the funded chains.
  const stableFor = (c: string) => {
    if (c === 'tron' || c === 'ton') return 'USDT' // non-EVM families without native USDC
    const toks = (CHAINS[c as keyof typeof CHAINS]?.tokens ?? {}) as Record<string, unknown>
    return CHAINS[c as keyof typeof CHAINS] && !toks.USDC && toks.USDT ? 'USDT' : 'USDC'
  }
  const defaultStable = accounts
    ? [...new Set(accounts.map((a) => stableFor(a.chain)))].join(',')
    : stableFor(chain)

  // 3) Validate + coerce everything else.
  const Schema = z.object({
    chain: z.string().trim().min(1),
    walletSecret: z.string().min(1).optional(),
    nearAccountId: z.string().trim().min(1).optional(),
    rpcUrl: z
      .string()
      .trim()
      .refine(isRpcUrl, 'PIPRAIL_RPC_URL must be an http(s) or ws(s) URL')
      .optional(),
    maxAmount: decimal('PIPRAIL_MAX_AMOUNT'),
    maxTotal: decimal('PIPRAIL_MAX_TOTAL'),
    tokens: z.string().transform(csv),
    hosts: z.string().transform(csv).optional(),
    allowUnknownTokens: z
      .string()
      .transform((v) => /^(1|true|yes)$/i.test(v.trim())),
    ttlSeconds: intSeconds('PIPRAIL_TTL').transform(Number).optional(),
    windowTotal: decimal('PIPRAIL_WINDOW_TOTAL').optional(),
    windowSeconds: intSeconds('PIPRAIL_WINDOW_SECONDS').transform(Number).optional(),
    confirm: boolKnob(),
    confirmTimeoutMs: intMs('PIPRAIL_CONFIRM_TIMEOUT_MS').transform(Number).optional(),
    guide: boolKnob(),
  })

  let parsed: z.infer<typeof Schema>
  try {
    parsed = Schema.parse({
      chain,
      walletSecret: key.value,
      nearAccountId: primary?.nearAccountId ?? pick(env, 'PIPRAIL_NEAR_ACCOUNT_ID', 'NEAR_ACCOUNT_ID').value,
      rpcUrl: primary?.rpcUrl ?? pick(env, 'PIPRAIL_RPC_URL', 'RPC_URL').value,
      maxAmount: pick(env, 'PIPRAIL_MAX_AMOUNT', 'MAX_AMOUNT').value ?? '0.10',
      maxTotal: pick(env, 'PIPRAIL_MAX_TOTAL', 'MAX_TOTAL').value ?? '10.00',
      tokens: pick(env, 'PIPRAIL_TOKENS', 'TOKENS').value ?? defaultStable,
      hosts: pick(env, 'PIPRAIL_HOSTS', 'HOSTS').value,
      allowUnknownTokens: pick(env, 'PIPRAIL_ALLOW_UNKNOWN_TOKENS').value ?? 'false',
      // Optional fields receive `undefined` safely; the boolean knobs need a default
      // string here or a zero-config boot would hit a ZodError on every startup.
      ttlSeconds: pick(env, 'PIPRAIL_TTL').value,
      windowTotal: pick(env, 'PIPRAIL_WINDOW_TOTAL').value,
      windowSeconds: pick(env, 'PIPRAIL_WINDOW_SECONDS').value,
      confirm: pick(env, 'PIPRAIL_CONFIRM').value ?? 'false',
      confirmTimeoutMs: pick(env, 'PIPRAIL_CONFIRM_TIMEOUT_MS').value,
      guide: pick(env, 'PIPRAIL_GUIDE').value ?? 'true',
    })
  } catch (e) {
    if (e instanceof z.ZodError) {
      throw new ConfigError(
        'Invalid PipRail config:\n' +
          e.issues.map((i) => `  - ${i.message}`).join('\n')
      )
    }
    throw e
  }

  // 4) Chain must be one the SDK recognizes from a string (fail fast on a typo).
  if (!KNOWN_CHAINS.has(parsed.chain)) {
    throw new ConfigError(
      `Unknown chain "${parsed.chain}". Use an EVM preset (e.g. base, ethereum, arbitrum, polygon, bnb) ` +
        `or a non-EVM family (${NON_EVM_CHAINS.join(', ')}). ` +
        `For a custom EVM chain, run the SDK directly with a viem Chain.`
    )
  }

  // 5) NEAR needs an account id alongside the key (only when a key is set — read-only needs neither).
  if (parsed.chain === 'near' && parsed.walletSecret && !parsed.nearAccountId) {
    throw new ConfigError(
      'chain "near" requires PIPRAIL_NEAR_ACCOUNT_ID (your NEAR account id, e.g. you.near).'
    )
  }

  // 5b) The rolling window: `windowSeconds` is the shared width for the money cap
  //     (windowTotal) AND the count cap (maxPaymentsPerWindow). A money cap needs the
  //     width; a width alone bounds nothing. Mirror the SDK guard.
  const wantsWindowCount = pick(env, 'PIPRAIL_MAX_PAYMENTS_PER_WINDOW').value !== undefined
  if (parsed.windowTotal !== undefined && parsed.windowSeconds === undefined) {
    throw new ConfigError(
      'PIPRAIL_WINDOW_TOTAL needs PIPRAIL_WINDOW_SECONDS — a rolling-window cap needs a window width.'
    )
  }
  if (parsed.windowSeconds !== undefined && parsed.windowTotal === undefined && !wantsWindowCount) {
    throw new ConfigError(
      'PIPRAIL_WINDOW_SECONDS must accompany PIPRAIL_WINDOW_TOTAL and/or PIPRAIL_MAX_PAYMENTS_PER_WINDOW — ' +
        'a window width alone bounds nothing.'
    )
  }
  if (wantsWindowCount && parsed.windowSeconds === undefined) {
    throw new ConfigError(
      'PIPRAIL_MAX_PAYMENTS_PER_WINDOW needs PIPRAIL_WINDOW_SECONDS (the window it counts within).'
    )
  }

  const tokens = parsed.tokens.length ? parsed.tokens : [defaultStable]

  // 6) Optional payment schemes (comma-separated). ABSENT ⇒ leave it off so the SDK
  //    default ('onchain-proof' only) holds and the MCP zero-config posture is
  //    byte-identical. Add 'exact' to also pay standard x402 servers (EVM/EIP-3009).
  const schemesRaw = pick(env, 'PIPRAIL_SCHEMES').value
  let schemes: PaymentScheme[] | undefined
  if (schemesRaw !== undefined) {
    const requested = csv(schemesRaw.toLowerCase())
    const bad = requested.filter((s) => !VALID_SCHEMES.includes(s as (typeof VALID_SCHEMES)[number]))
    if (requested.length === 0 || bad.length) {
      throw new ConfigError(
        `Invalid PIPRAIL_SCHEMES "${schemesRaw}". Use a comma-separated subset of ` +
          `${VALID_SCHEMES.join(', ')} (e.g. "onchain-proof,exact").`
      )
    }
    schemes = [...new Set(requested)] as PaymentScheme[]
  }

  // 7) Cross-token grand total + count caps + threshold + log sinks (all opt-in; absent ⇒
  //    byte-identical zero-config posture).
  const denomRaw = pick(env, 'PIPRAIL_MAX_TOTAL_DENOM').value
  let maxTotalPerDenom: Record<string, string> | undefined
  if (denomRaw !== undefined) {
    const map: Record<string, string> = {}
    for (const pair of csv(denomRaw)) {
      const m = /^([A-Za-z][A-Za-z0-9]*)\s*:\s*(\d+(?:\.\d+)?)$/.exec(pair)
      if (!m) {
        throw new ConfigError(
          `Invalid PIPRAIL_MAX_TOTAL_DENOM entry "${pair}". Use DENOM:amount pairs, e.g. "USD:20.00,EUR:5.00".`
        )
      }
      const denom = m[1]!.toUpperCase()
      const amount = m[2]!
      // A repeated denom keeps the STRICTEST (smallest) cap — never silently relax the leash.
      if (map[denom] === undefined || Number(amount) < Number(map[denom])) map[denom] = amount
    }
    if (Object.keys(map).length) maxTotalPerDenom = map
  }

  const posInt = (name: string, raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) {
      throw new ConfigError(`${name} must be a positive integer.`)
    }
    return Number(raw)
  }
  const maxPayments = posInt('PIPRAIL_MAX_PAYMENTS', pick(env, 'PIPRAIL_MAX_PAYMENTS').value)
  const maxPaymentsPerWindow = posInt(
    'PIPRAIL_MAX_PAYMENTS_PER_WINDOW',
    pick(env, 'PIPRAIL_MAX_PAYMENTS_PER_WINDOW').value
  )

  const warnRaw = pick(env, 'PIPRAIL_WARN_AT_FRACTION').value
  let warnAtFraction: number | undefined
  if (warnRaw !== undefined) {
    const n = Number(warnRaw)
    if (!Number.isFinite(n) || !(n > 0 && n <= 1)) {
      throw new ConfigError('PIPRAIL_WARN_AT_FRACTION must be a number in (0, 1] (e.g. 0.8).')
    }
    warnAtFraction = n
  }

  const spendLog = pick(env, 'PIPRAIL_SPEND_LOG').value
  const eventLog = pick(env, 'PIPRAIL_EVENT_LOG').value

  return {
    chain: parsed.chain,
    ...(accounts ? { chains: accounts } : {}),
    ...(parsed.walletSecret ? { walletSecret: parsed.walletSecret } : {}),
    readOnly,
    ...(parsed.nearAccountId ? { nearAccountId: parsed.nearAccountId } : {}),
    ...(parsed.rpcUrl ? { rpcUrl: parsed.rpcUrl } : {}),
    maxAmount: parsed.maxAmount,
    maxTotal: parsed.maxTotal,
    tokens,
    ...(parsed.hosts && parsed.hosts.length ? { hosts: parsed.hosts } : {}),
    allowUnknownTokens: parsed.allowUnknownTokens,
    ...(schemes ? { schemes } : {}),
    ...(parsed.ttlSeconds != null ? { ttlSeconds: parsed.ttlSeconds } : {}),
    ...(parsed.windowTotal != null ? { windowTotal: parsed.windowTotal } : {}),
    ...(parsed.windowSeconds != null ? { windowSeconds: parsed.windowSeconds } : {}),
    ...(maxTotalPerDenom ? { maxTotalPerDenom } : {}),
    ...(maxPayments != null ? { maxPayments } : {}),
    ...(maxPaymentsPerWindow != null ? { maxPaymentsPerWindow } : {}),
    ...(warnAtFraction != null ? { warnAtFraction } : {}),
    ...(spendLog ? { spendLog } : {}),
    ...(eventLog ? { eventLog } : {}),
    confirm: parsed.confirm,
    ...(parsed.confirmTimeoutMs != null ? { confirmTimeoutMs: parsed.confirmTimeoutMs } : {}),
    guide: parsed.guide,
    ...(key.source ? { keySource: key.source } : {}),
  }
}

/**
 * Map a chain + its secret to the SDK's {@link WalletInput}. Every chain takes a
 * single `{ key }` (the secret string, in that chain's native format); NEAR also
 * needs `{ accountId }`.
 *
 * Takes just the chain + secret (+ NEAR account id), so it serves BOTH the single
 * {@link Config} and each multi-chain {@link ChainAccount}.
 */
export function walletInputFor(account: {
  chain: string
  walletSecret?: string
  nearAccountId?: string
}): WalletInput | undefined {
  if (!account.walletSecret) return undefined // read-only — no key supplied
  if (account.chain === 'near') {
    // The parse layer already enforces this (parseConfig / parseChainAccounts), but guard
    // locally too — walletInputFor is a public export, so don't trust a non-local invariant.
    if (!account.nearAccountId) {
      throw new ConfigError('NEAR wallet needs an accountId (PIPRAIL_NEAR_ACCOUNT_ID).')
    }
    return { accountId: account.nearAccountId, key: account.walletSecret }
  }
  return { key: account.walletSecret }
}

/** The shared spend policy — the budget knobs every chain's client enforces. With a
 *  SHARED ledger (multi-chain), the cross-token grand total + the payment-count caps
 *  span every funded chain as ONE budget. */
function policyFromConfig(config: Config): PaymentPolicy {
  return {
    maxAmount: config.maxAmount,
    maxTotal: config.maxTotal,
    tokens: config.tokens,
    allowUnknownTokens: config.allowUnknownTokens,
    ...(config.hosts ? { hosts: config.hosts } : {}),
    // Time envelope — spread only when set so a zero-config MCP yields a byte-identical policy.
    ...(config.ttlSeconds != null ? { ttlSeconds: config.ttlSeconds } : {}),
    ...(config.windowTotal != null ? { windowTotal: config.windowTotal } : {}),
    ...(config.windowSeconds != null ? { windowSeconds: config.windowSeconds } : {}),
    // Cross-token grand total + count caps + threshold warning (all opt-in).
    ...(config.maxTotalPerDenom ? { maxTotalPerDenom: config.maxTotalPerDenom } : {}),
    ...(config.maxPayments != null ? { maxPayments: config.maxPayments } : {}),
    ...(config.maxPaymentsPerWindow != null ? { maxPaymentsPerWindow: config.maxPaymentsPerWindow } : {}),
    ...(config.warnAtFraction != null ? { warnAtFraction: config.warnAtFraction } : {}),
  }
}

/** Build the SDK client options for ONE chain account (the single chain, or one of
 *  the multi-chain accounts) under the shared `policy`. */
function accountToClientOptions(
  account: { chain: string; walletSecret?: string; rpcUrl?: string; nearAccountId?: string },
  policy: PaymentPolicy,
  schemes: PaymentScheme[] | undefined
): PipRailClientOptions {
  const wallet = walletInputFor(account)
  return {
    chain: account.chain as ChainSelector,
    // Read-only (no key) ⇒ omit `wallet`; that chain's SDK client is then read-only.
    ...(wallet ? { wallet } : {}),
    policy,
    ...(account.rpcUrl ? { rpcUrl: account.rpcUrl } : {}),
    // Only set when PIPRAIL_SCHEMES was provided — otherwise omit so the SDK default
    // ('onchain-proof' only) applies and the zero-config MCP posture is unchanged.
    ...(schemes ? { schemes } : {}),
  }
}

/** Build the SINGLE-chain SDK client options from validated config — the budget
 *  becomes the spend policy. NOTE: `confirm`/`guide` are MCP-SERVER concerns and
 *  deliberately do NOT appear here — the `onBeforePay` seam is wired in
 *  `createMcpServer`, never via the client options. THROWS on a multi-chain config
 *  (`PIPRAIL_CHAINS`) — use {@link configToClientOptionsList} for that, so the other
 *  funded accounts aren't silently dropped. */
export function configToClientOptions(config: Config): PipRailClientOptions {
  if (config.chains) {
    throw new ConfigError(
      'This is a multi-chain config (PIPRAIL_CHAINS) — call configToClientOptionsList() ' +
        'instead; configToClientOptions() is single-chain only and would drop the other accounts.'
    )
  }
  return accountToClientOptions(
    { chain: config.chain, ...(config.walletSecret ? { walletSecret: config.walletSecret } : {}), ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}), ...(config.nearAccountId ? { nearAccountId: config.nearAccountId } : {}) },
    policyFromConfig(config),
    config.schemes
  )
}

/** Build ONE {@link PipRailClientOptions} per chain — the multi-chain accounts when
 *  `PIPRAIL_CHAINS` is set, else a single-element list (so callers can treat both modes
 *  uniformly). `createMcpServer` builds one client per entry behind a `MultiChainPayer`. */
export function configToClientOptionsList(config: Config): PipRailClientOptions[] {
  const policy = policyFromConfig(config)
  const accounts = config.chains ?? [
    {
      chain: config.chain,
      ...(config.walletSecret ? { walletSecret: config.walletSecret } : {}),
      ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
      ...(config.nearAccountId ? { nearAccountId: config.nearAccountId } : {}),
    },
  ]
  return accounts.map((a) => accountToClientOptions(a, policy, config.schemes))
}
