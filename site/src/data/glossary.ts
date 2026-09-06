// Glossary: the entities PipRail sits on. Rendered as a visible definition list
// on /sdk AND emitted as schema.org DefinedTermSet JSON-LD: entity clarity is a
// top GEO signal (answer engines cite clean, self-contained definitions). Keep
// each definition factual, self-contained, and one set of numbers with the rest
// of the site (no hardcoded chain count here, so speak qualitatively).

export interface Term {
  term: string
  abbr?: string
  def: string
}

export const glossary: Term[] = [
  {
    term: 'x402',
    def: 'An open payment protocol that revives the HTTP 402 "Payment Required" status code. A server answers a request with 402 plus a machine-readable challenge (price, token, chain, pay-to address); the caller pays on-chain and retries with proof, and the request goes through. It lets an HTTP endpoint charge for itself with no API keys, accounts, or invoices.',
  },
  {
    term: 'HTTP 402 Payment Required',
    abbr: '402',
    def: 'A status code reserved in the original HTTP specification for payment, long left unused. x402 turns it into a working protocol: a 402 response carries a payment challenge a client can satisfy programmatically.',
  },
  {
    term: 'Facilitator',
    def: 'A third-party service that, in many x402 stacks, settles or verifies the payment in the middle of the flow. PipRail is backendless: there is no facilitator. The payer broadcasts their own transfer and the merchant verifies it locally against their own RPC. The x402 v2 spec (§7) explicitly permits this merchant-local model.',
  },
  {
    term: 'Model Context Protocol',
    abbr: 'MCP',
    def: 'An open standard for connecting AI agents (Claude Desktop, Cursor, Claude Code, Windsurf, VS Code, Cline) to external tools. @piprail/mcp is an MCP server that hands any MCP client a budget-bound wallet so it can pay x402 URLs autonomously, capped by a local spend policy.',
  },
  {
    term: 'Agentic commerce',
    def: 'Economic activity in which autonomous AI agents, not humans clicking checkout, discover, price, and pay for data, compute, and services. x402 is the HTTP-native payment rail for it; PipRail is the drop-in SDK that makes it one line.',
  },
  {
    term: 'onchain-proof scheme',
    def: 'PipRail’s default x402 settlement scheme: the payer sends a real on-chain transfer and the proof is the transaction itself, which the merchant verifies on its own RPC (the right amount of the right token to the right address, recent, and not already used). Self-custodial end-to-end, with no facilitator.',
  },
  {
    term: 'Stablecoin (USDC / USDT)',
    def: 'A token pegged to a fiat currency, used for predictable pricing. PipRail ships canonical stablecoins per chain (USDC almost everywhere, USDT on most, plus EURC and RLUSD where they are native) and the chain’s native coin is always a valid payment asset too. Any other token works by address.',
  },
  {
    term: 'Self-custody',
    def: 'You hold your own keys and funds; no service ever takes possession. PipRail never custodies money: payments settle wallet-to-wallet, keys never leave your process, and there is no PipRail backend in the path.',
  },
]
