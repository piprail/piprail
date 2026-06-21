import { PipRailClient, type ChainSelector } from '@piprail/sdk'
import type { IAgentRuntime } from '@elizaos/core'

// One PipRailClient per agent, built lazily from the character's settings. The wallet field is
// `key` (PipRail v2 unified the secret to one field — the old `{ privateKey }` throws a migration
// error). The policy is the hard cap the model cannot exceed.
const clients = new Map<string, PipRailClient>()

export function getClient(runtime: IAgentRuntime): PipRailClient {
  const id = String(runtime.agentId)
  let client = clients.get(id)
  if (!client) {
    const key = runtime.getSetting('PIPRAIL_PRIVATE_KEY')
    if (!key) throw new Error('PIPRAIL_PRIVATE_KEY is not set in the character settings.')
    client = new PipRailClient({
      chain: ((runtime.getSetting('PIPRAIL_CHAIN') as string) || 'base') as ChainSelector,
      wallet: { key: String(key) },
      schemes: ['onchain-proof', 'exact'], // 'exact' also pays standard x402 servers, gasless for the buyer
      policy: {
        maxAmount: (runtime.getSetting('PIPRAIL_MAX_AMOUNT') as string) || '0.10',
        maxTotal: (runtime.getSetting('PIPRAIL_MAX_TOTAL') as string) || '5.00',
      },
    })
    clients.set(id, client)
  }
  return client
}

export function hasWallet(runtime: IAgentRuntime): boolean {
  return !!runtime.getSetting('PIPRAIL_PRIVATE_KEY')
}
