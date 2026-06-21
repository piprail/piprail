import type { Plugin } from '@elizaos/core'
import { buildActions } from './actions.js'

/**
 * elizaos-plugin-piprail — give an elizaOS agent a budget-bound, self-custody wallet to pay
 * x402 ("402 Payment Required") APIs across many chains. Wraps the published `@piprail/sdk`
 * (`paymentTools`) — no payment logic lives here, and the agent's own key signs against its own
 * RPC, so there is no facilitator and no fee. The spend policy is a hard cap the model cannot cross.
 */
export const piprailPlugin: Plugin = {
  name: 'piprail',
  description:
    'Pay x402 (HTTP 402) APIs autonomously across many chains, capped by a spend policy. Self-custody, no facilitator, no fee.',
  actions: buildActions(),
}

export default piprailPlugin
