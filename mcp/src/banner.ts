/**
 * Startup banner — confidence at a glance: the chain, the budget, the tools.
 *
 * `formatBanner` is PURE and **secret-free by contract** — it shows which env var
 * supplied the key, never the key itself; it shows "(custom)" for an RPC URL,
 * never the URL (it can embed an API key). `printBanner` writes to STDERR only:
 * stdout is the MCP protocol channel and a single stray byte there corrupts it.
 */
import { VERSION } from './version.js'
import type { Config } from './config.js'

/** The tool names this server exposes (from the SDK's paymentTools). */
export const TOOL_NAMES = [
  'piprail_discover',
  'piprail_quote_payment',
  'piprail_plan_payment',
  'piprail_pay_request',
  'piprail_register',
  'piprail_budget',
  'piprail_guide',
] as const

const row = (label: string, value: string): string => `  ${label.padEnd(15)}${value}`

/**
 * Advisory, non-fatal setup notes for chains with caveats — shown in the banner
 * (stderr). The SDK has no separate API-key field; keys are folded into the RPC URL.
 * Iterates every configured chain (one in single mode, N in multi-chain mode).
 */
export function chainWarnings(config: Config): string[] {
  const accounts = config.chains ?? [{ chain: config.chain, rpcUrl: config.rpcUrl }]
  const rpcVar = (chain: string) =>
    config.chains ? `PIPRAIL_${chain.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_RPC_URL` : 'PIPRAIL_RPC_URL'
  const notes: string[] = []
  for (const a of accounts) {
    if (a.chain === 'ton' && !a.rpcUrl) {
      notes.push(
        'TON: the keyless public RPC is rate-limited (~1 req/s) and can stall verification. ' +
          `Set ${rpcVar('ton')} to a keyed toncenter endpoint (fold ?api_key=… into the URL).`
      )
    }
    if (a.chain === 'tron' && !a.rpcUrl) {
      notes.push(
        "Tron: the default public RPC (TronGrid) is rate-limited. For production set " +
          `${rpcVar('tron')} to your own endpoint (no separate API-key field — fold any key into the URL).`
      )
    }
  }
  return notes
}

/** Build the human-readable banner string. NEVER includes the wallet secret. */
export function formatBanner(config: Config): string {
  const lines = [
    `PipRail MCP server v${VERSION} — ready on stdio${config.readOnly ? ' (READ-ONLY — no wallet key)' : ''}`,
    ``,
    config.chains
      ? row('chains', config.chains.map((a) => a.chain).join(', '))
      : row('chain', config.chain),
    row('per-payment', config.maxAmount),
    row('lifetime/token', config.maxTotal),
    row('tokens', config.tokens.join(', ')),
  ]
  if (config.hosts && config.hosts.length) lines.push(row('hosts', config.hosts.join(', ')))
  // Only shown when PIPRAIL_SCHEMES is set — so the zero-config banner stays byte-identical.
  if (config.schemes && config.schemes.length) lines.push(row('schemes', config.schemes.join(', ')))
  // Cross-token grand total — the "one number across every stablecoin + chain" leash.
  if (config.maxTotalPerDenom) {
    lines.push(
      row(
        'grand total',
        Object.entries(config.maxTotalPerDenom).map(([d, v]) => `${v} ${d}`).join(', ')
      )
    )
  }
  if (config.maxPayments != null) lines.push(row('max payments', String(config.maxPayments)))
  // Time envelope (Feature A) — only shown when configured.
  if (config.ttlSeconds != null) lines.push(row('session ttl', `${config.ttlSeconds}s`))
  if (config.windowTotal != null && config.windowSeconds != null) {
    lines.push(row('rate window', `${config.windowTotal} / ${config.windowSeconds}s`))
  }
  if (config.maxPaymentsPerWindow != null && config.windowSeconds != null) {
    lines.push(row('rate (count)', `${config.maxPaymentsPerWindow} / ${config.windowSeconds}s`))
  }
  if (config.warnAtFraction != null) {
    lines.push(row('warn at', `${Math.round(config.warnAtFraction * 100)}% of any cap`))
  }
  if (config.spendLog) lines.push(row('spend log', '(file — budget survives restart)'))
  if (config.eventLog) {
    lines.push(row('event log', config.eventLog.toLowerCase() === 'stderr' ? 'stderr' : '(file)'))
  }
  // Mode B (Feature B) — only shown when PIPRAIL_CONFIRM is on.
  if (config.confirm) {
    lines.push(
      row(
        'confirm',
        'ON — asks the human to approve each payment IF the client supports elicitation; otherwise policy-only (Mode A)'
      )
    )
  }
  if (config.rpcUrl) lines.push(row('rpc', '(custom)'))
  if (config.allowUnknownTokens) {
    lines.push(row('unknown tokens', 'ALLOWED — unpriced, risk accepted'))
  }
  lines.push(``)
  if (config.chains) {
    // Multi-chain: one wallet per chain — show each chain's key status (never the key).
    lines.push(row('wallet keys', config.readOnly ? 'NONE — read-only mode' : 'one per chain:'))
    for (const a of config.chains) {
      const status = a.readOnly ? 'read-only (no key)' : `set via ${a.keySource}`
      lines.push(`    - ${a.chain.padEnd(10)} ${status}${a.rpcUrl ? ' · custom rpc' : ''}`)
    }
  } else {
    lines.push(
      config.readOnly
        ? row(
            'wallet key',
            'NONE — read-only mode. discover/quote/register/budget/guide work; set PIPRAIL_PRIVATE_KEY to pay.'
          )
        : row('wallet key', `set via ${config.keySource}`)
    )
  }
  lines.push(row('tools', TOOL_NAMES.join(', ')))
  const notes = chainWarnings(config)
  if (notes.length) {
    lines.push(``, `  ⚠ notes:`)
    for (const n of notes) lines.push(`    - ${n}`)
  }
  lines.push(
    ``,
    `  The spend policy is enforced before any on-chain send — the model cannot overspend.`,
    `  Funds settle wallet-to-wallet; PipRail custodies nothing.`
  )
  return lines.join('\n')
}

/** Print the banner to STDERR (never stdout — that's the protocol channel). */
export function printBanner(config: Config): void {
  console.error(formatBanner(config))
}
