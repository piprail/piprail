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

/** Validated, normalized configuration — the single source the rest of the package reads. */
export interface Config {
  /** Chain selector string (EVM preset name or a non-EVM family name). */
  chain: string
  /** The wallet key/seed/mnemonic, in the chosen chain's native format. NEVER logged.
   *  Absent ⇒ READ-ONLY mode: discover/quote/register/budget/guide work; paying does not. */
  walletSecret?: string
  /** True when no wallet secret was supplied — the server runs read-only (no key needed). */
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
  /** Rolling-window cap, human units (PIPRAIL_WINDOW_TOTAL). Set WITH windowSeconds or neither. */
  windowTotal?: string
  /** Rolling-window width in seconds (PIPRAIL_WINDOW_SECONDS). Set WITH windowTotal or neither. */
  windowSeconds?: number
  /** Ask the human to approve each payment via MCP elicitation (PIPRAIL_CONFIRM).
   *  Default false — Mode A (the spend policy IS the consent). True ⇒ Mode B (supervised). */
  confirm: boolean
  /** Override the elicitation approval window in ms (PIPRAIL_CONFIRM_TIMEOUT_MS). Default 55000. */
  confirmTimeoutMs?: number
  /** Expose the PIPRAIL_AGENT_GUIDE prompt + resource (PIPRAIL_GUIDE). Default true. */
  guide: boolean
  /** Which env var supplied the key — surfaced in the banner (never the value). */
  keySource: string
}

type Env = Record<string, string | undefined>

/** Thrown on any invalid/missing config — the message is already human-friendly. */
export class ConfigError extends Error {
  override name = 'ConfigError'
}

/** Every recognized `PIPRAIL_*` var — used to catch typos via a strict guard. */
const KNOWN_PIPRAIL_VARS = [
  'PIPRAIL_PRIVATE_KEY',
  'PIPRAIL_WALLET_KEY',
  'PIPRAIL_CHAIN',
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
  // Ask-before-pay (Feature B, Mode B) + the agent guide (Feature C).
  'PIPRAIL_CONFIRM',
  'PIPRAIL_CONFIRM_TIMEOUT_MS',
  'PIPRAIL_GUIDE',
] as const

/** The payment schemes the MCP may enable via PIPRAIL_SCHEMES. */
const VALID_SCHEMES = ['onchain-proof', 'exact'] as const

/**
 * Non-EVM families whose wallet secret is NOT a plain `privateKey`. Tron, Sui,
 * Aptos and every EVM chain use `{ privateKey }` (the default), so they're absent
 * here. NEAR is special-cased (it also needs an accountId). Keep in sync with the
 * SDK's {@link WalletInput} when a family is added (see add-chain-integration skill).
 */
const WALLET_FIELD: Record<string, 'secretKey' | 'mnemonic' | 'secret' | 'seed'> = {
  solana: 'secretKey',
  ton: 'mnemonic',
  algorand: 'mnemonic',
  stellar: 'secret',
  xrpl: 'seed',
}

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

/**
 * Parse + validate the environment into a {@link Config}. Throws {@link ConfigError}
 * (with an actionable message) on anything missing or malformed — the caller
 * prints it to stderr and exits non-zero. Defaults: chain=base, maxAmount=0.10,
 * maxTotal=10.00, tokens=USDC, allowUnknownTokens=false.
 */
export function parseConfig(env: Env = process.env): Config {
  // 1) Typo guard: reject any unrecognized PIPRAIL_* var so a mistyped name
  //    fails loudly instead of being silently ignored.
  const unknown = Object.keys(env).filter(
    (k) => k.startsWith('PIPRAIL_') && !KNOWN_PIPRAIL_VARS.includes(k as never)
  )
  if (unknown.length) {
    throw new ConfigError(
      `Unknown PipRail config var(s): ${unknown.join(', ')}.\n` +
        `Valid vars: ${KNOWN_PIPRAIL_VARS.join(', ')}.`
    )
  }

  // 2) The wallet secret. Optional — absent ⇒ READ-ONLY mode: the server still boots
  //    and serves the read-only tools (discover/quote/register/budget/guide); only paying
  //    needs a key. Supplying one is byte-identical to before.
  const key = pick(env, 'PIPRAIL_PRIVATE_KEY', 'PIPRAIL_WALLET_KEY', 'AGENT_KEY')
  const readOnly = !key.value

  const chain = pick(env, 'PIPRAIL_CHAIN', 'CHAIN').value ?? 'base'

  // The default stablecoin tracks what actually EXISTS on the chain: USDC
  // everywhere, but USDT on Tron & TON (native USDC doesn't exist there, so a
  // USDC-only policy would silently block every payment). Overridable via PIPRAIL_TOKENS.
  const defaultStable = chain === 'tron' || chain === 'ton' ? 'USDT' : 'USDC'

  // 3) Validate + coerce everything else.
  const Schema = z.object({
    chain: z.string().trim().min(1),
    walletSecret: z.string().min(1).optional(),
    nearAccountId: z.string().trim().min(1).optional(),
    rpcUrl: z.string().trim().url('PIPRAIL_RPC_URL must be a valid URL').optional(),
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
      nearAccountId: pick(env, 'PIPRAIL_NEAR_ACCOUNT_ID', 'NEAR_ACCOUNT_ID').value,
      rpcUrl: pick(env, 'PIPRAIL_RPC_URL', 'RPC_URL').value,
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

  // 5b) The rolling window needs BOTH bounds or NEITHER — a half-armed leash (a cap
  //     with no width, or a width with no cap) silently wouldn't bite. Mirror the SDK guard.
  if ((parsed.windowTotal === undefined) !== (parsed.windowSeconds === undefined)) {
    throw new ConfigError(
      'PIPRAIL_WINDOW_TOTAL and PIPRAIL_WINDOW_SECONDS must be set together (or neither) — ' +
        'a rolling-window cap needs both a budget and a window width.'
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

  return {
    chain: parsed.chain,
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
    confirm: parsed.confirm,
    ...(parsed.confirmTimeoutMs != null ? { confirmTimeoutMs: parsed.confirmTimeoutMs } : {}),
    guide: parsed.guide,
    keySource: key.source as string,
  }
}

/**
 * Map the chosen chain + secret to the SDK's per-family {@link WalletInput}:
 *   EVM / Tron / Sui / Aptos → { privateKey }
 *   Solana → { secretKey } · TON / Algorand → { mnemonic }
 *   Stellar → { secret } · XRPL → { seed } · NEAR → { accountId, privateKey }
 */
export function walletInputFor(config: Config): WalletInput | undefined {
  if (!config.walletSecret) return undefined // read-only client — no key supplied
  const secret = config.walletSecret
  if (config.chain === 'near') {
    return { accountId: config.nearAccountId as string, privateKey: secret }
  }
  switch (WALLET_FIELD[config.chain]) {
    case 'secretKey':
      return { secretKey: secret }
    case 'mnemonic':
      return { mnemonic: secret }
    case 'secret':
      return { secret }
    case 'seed':
      return { seed: secret }
    default:
      return { privateKey: secret }
  }
}

/** Build the SDK client options from validated config — the budget becomes the spend policy.
 *  NOTE: `confirm`/`guide` are MCP-SERVER concerns and deliberately do NOT appear here — the
 *  `onBeforePay` seam is wired in `createMcpServer`, never via the client options. */
export function configToClientOptions(config: Config): PipRailClientOptions {
  const policy: PaymentPolicy = {
    maxAmount: config.maxAmount,
    maxTotal: config.maxTotal,
    tokens: config.tokens,
    allowUnknownTokens: config.allowUnknownTokens,
    ...(config.hosts ? { hosts: config.hosts } : {}),
    // Time envelope — spread only when set so a zero-config MCP yields a byte-identical policy.
    ...(config.ttlSeconds != null ? { ttlSeconds: config.ttlSeconds } : {}),
    ...(config.windowTotal != null ? { windowTotal: config.windowTotal } : {}),
    ...(config.windowSeconds != null ? { windowSeconds: config.windowSeconds } : {}),
  }
  const wallet = walletInputFor(config)
  return {
    chain: config.chain as ChainSelector,
    // Read-only mode (no key) ⇒ omit `wallet`; the SDK client is then read-only.
    ...(wallet ? { wallet } : {}),
    policy,
    ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
    // Only set when PIPRAIL_SCHEMES was provided — otherwise omit so the SDK default
    // ('onchain-proof' only) applies and the zero-config MCP posture is unchanged.
    ...(config.schemes ? { schemes: config.schemes } : {}),
  }
}
