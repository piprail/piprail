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
  PipRailClientOptions,
  WalletInput,
} from '@piprail/sdk'

/** Validated, normalized configuration — the single source the rest of the package reads. */
export interface Config {
  /** Chain selector string (EVM preset name or a non-EVM family name). */
  chain: string
  /** The wallet key/seed/mnemonic, in the chosen chain's native format. NEVER logged. */
  walletSecret: string
  /** Required only when `chain === 'near'`. */
  nearAccountId?: string
  /** Override the chain's default RPC. */
  rpcUrl?: string
  /** Per-payment ceiling (human units). */
  maxAmount: string
  /** Lifetime ceiling per distinct token (human units). */
  maxTotal: string
  /** Allowed token symbols. */
  tokens: string[]
  /** Optional host allowlist (exact or `*.example.com`). */
  hosts?: string[]
  /** Pay tokens the SDK can't price? Default false (safe). */
  allowUnknownTokens: boolean
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
  'PIPRAIL_NEAR_ACCOUNT_ID',
] as const

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

  // 2) The wallet secret is the one hard requirement.
  const key = pick(env, 'PIPRAIL_PRIVATE_KEY', 'PIPRAIL_WALLET_KEY', 'AGENT_KEY')
  if (!key.value) {
    throw new ConfigError(
      'PIPRAIL_PRIVATE_KEY (alias: AGENT_KEY) is required — set it to your wallet key/seed for the chosen chain.\n' +
        "Put it in the MCP client config's \"env\" block or export it; never pass it as a CLI argument, and never commit it."
    )
  }

  const chain = pick(env, 'PIPRAIL_CHAIN', 'CHAIN').value ?? 'base'

  // The default stablecoin tracks what actually EXISTS on the chain: USDC
  // everywhere, but USDT on Tron & TON (native USDC doesn't exist there, so a
  // USDC-only policy would silently block every payment). Overridable via PIPRAIL_TOKENS.
  const defaultStable = chain === 'tron' || chain === 'ton' ? 'USDT' : 'USDC'

  // 3) Validate + coerce everything else.
  const Schema = z.object({
    chain: z.string().trim().min(1),
    walletSecret: z.string().min(1),
    nearAccountId: z.string().trim().min(1).optional(),
    rpcUrl: z.string().trim().url('PIPRAIL_RPC_URL must be a valid URL').optional(),
    maxAmount: decimal('PIPRAIL_MAX_AMOUNT'),
    maxTotal: decimal('PIPRAIL_MAX_TOTAL'),
    tokens: z.string().transform(csv),
    hosts: z.string().transform(csv).optional(),
    allowUnknownTokens: z
      .string()
      .transform((v) => /^(1|true|yes)$/i.test(v.trim())),
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

  // 5) NEAR needs an account id alongside the key.
  if (parsed.chain === 'near' && !parsed.nearAccountId) {
    throw new ConfigError(
      'chain "near" requires PIPRAIL_NEAR_ACCOUNT_ID (your NEAR account id, e.g. you.near).'
    )
  }

  const tokens = parsed.tokens.length ? parsed.tokens : [defaultStable]

  return {
    chain: parsed.chain,
    walletSecret: parsed.walletSecret,
    ...(parsed.nearAccountId ? { nearAccountId: parsed.nearAccountId } : {}),
    ...(parsed.rpcUrl ? { rpcUrl: parsed.rpcUrl } : {}),
    maxAmount: parsed.maxAmount,
    maxTotal: parsed.maxTotal,
    tokens,
    ...(parsed.hosts && parsed.hosts.length ? { hosts: parsed.hosts } : {}),
    allowUnknownTokens: parsed.allowUnknownTokens,
    keySource: key.source as string,
  }
}

/**
 * Map the chosen chain + secret to the SDK's per-family {@link WalletInput}:
 *   EVM / Tron / Sui / Aptos → { privateKey }
 *   Solana → { secretKey } · TON / Algorand → { mnemonic }
 *   Stellar → { secret } · XRPL → { seed } · NEAR → { accountId, privateKey }
 */
export function walletInputFor(config: Config): WalletInput {
  if (config.chain === 'near') {
    return { accountId: config.nearAccountId as string, privateKey: config.walletSecret }
  }
  switch (WALLET_FIELD[config.chain]) {
    case 'secretKey':
      return { secretKey: config.walletSecret }
    case 'mnemonic':
      return { mnemonic: config.walletSecret }
    case 'secret':
      return { secret: config.walletSecret }
    case 'seed':
      return { seed: config.walletSecret }
    default:
      return { privateKey: config.walletSecret }
  }
}

/** Build the SDK client options from validated config — the budget becomes the spend policy. */
export function configToClientOptions(config: Config): PipRailClientOptions {
  const policy: PaymentPolicy = {
    maxAmount: config.maxAmount,
    maxTotal: config.maxTotal,
    tokens: config.tokens,
    allowUnknownTokens: config.allowUnknownTokens,
    ...(config.hosts ? { hosts: config.hosts } : {}),
  }
  return {
    chain: config.chain as ChainSelector,
    wallet: walletInputFor(config),
    policy,
    ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
  }
}
