import { MCPClient } from '@mastra/mcp'

/**
 * PipRail plugs into Mastra as a standard MCP server — the published
 * [`@piprail/mcp`](https://www.npmjs.com/package/@piprail/mcp), run via `npx -y @piprail/mcp`.
 *
 * Because it runs as a separate stdio process, neither `@piprail/sdk` nor its `viem` peer ever
 * enter Mastra's dependency tree. The agent gets all 8 PipRail tools (`piprail_*`), capped by a
 * spend policy it cannot exceed — funds settle straight to the provider's wallet, verified locally
 * against your own RPC. No facilitator, no fee, self-custodial.
 *
 * Read-only by default: omit `PIPRAIL_PRIVATE_KEY` and discover/quote/plan/budget/guide still work;
 * only paying needs a (funded) wallet key. Never commit the key — it's not an API key.
 */
export const piprailMcp = new MCPClient({
  id: 'piprail',
  servers: {
    piprail: {
      command: 'npx',
      args: ['-y', '@piprail/mcp'],
      env: {
        // Self-custodial wallet key/seed (EVM `0x…`, Solana base58, or a mnemonic). Omit for read-only.
        PIPRAIL_PRIVATE_KEY: process.env.PIPRAIL_PRIVATE_KEY ?? '',
        // Chain to pay on — any EVM, or solana/ton/tron/near/sui/aptos/algorand/stellar/xrpl.
        PIPRAIL_CHAIN: process.env.PIPRAIL_CHAIN ?? 'base',
        // The spend wall the model cannot exceed.
        PIPRAIL_MAX_AMOUNT: process.env.PIPRAIL_MAX_AMOUNT ?? '0.10', // max per payment (token units)
        PIPRAIL_MAX_TOTAL: process.env.PIPRAIL_MAX_TOTAL ?? '5.00', // lifetime budget per token
        PIPRAIL_TOKENS: process.env.PIPRAIL_TOKENS ?? 'USDC', // allowed tokens
      },
    },
  },
})
