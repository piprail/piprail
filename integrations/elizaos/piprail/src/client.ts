import { PipRailClient, type ChainSelector } from '@piprail/sdk'
import type { IAgentRuntime } from '@elizaos/core'

// One PipRailClient per agent, built lazily from the character's settings. The wallet field is
// `key` (PipRail v2 unified the secret to one field — the old `{ privateKey }` throws a migration
// error). The policy is the hard cap the model cannot exceed.
const clients = new Map<string, PipRailClient>()

// getSetting returns string | boolean | number | null. Coerce to a trimmed string (or a default)
// so a JSON number/boolean in the character config can't slip a non-string into the SDK — the
// spend-cap validator throws a TypeError on a non-string, and that throw would abort the agent run.
function setting(runtime: IAgentRuntime, key: string, fallback: string): string {
  const v = runtime.getSetting(key)
  if (v == null) return fallback
  const s = typeof v === 'string' ? v.trim() : String(v)
  return s || fallback
}

export function getClient(runtime: IAgentRuntime): PipRailClient {
  const id = String(runtime.agentId)
  let client = clients.get(id)
  if (!client) {
    const key = runtime.getSetting('PIPRAIL_PRIVATE_KEY')
    if (!key) throw new Error('PIPRAIL_PRIVATE_KEY is not set in the character settings.')
    client = new PipRailClient({
      chain: setting(runtime, 'PIPRAIL_CHAIN', 'base') as ChainSelector,
      wallet: { key: String(key) },
      schemes: ['onchain-proof', 'exact'], // 'exact' also pays standard x402 servers, gasless for the buyer
      policy: {
        maxAmount: setting(runtime, 'PIPRAIL_MAX_AMOUNT', '0.10'),
        maxTotal: setting(runtime, 'PIPRAIL_MAX_TOTAL', '5.00'),
      },
    })
    clients.set(id, client)
  }
  return client
}

export function hasWallet(runtime: IAgentRuntime): boolean {
  return !!runtime.getSetting('PIPRAIL_PRIVATE_KEY')
}
