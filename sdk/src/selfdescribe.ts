/**
 * Self-description — make a PipRail 402 announce WHAT it is and HOW to pay it, to
 * humans, AI agents, and crawlers alike, on BOTH schemes. PURE: a builder that turns
 * the `accepts[]` a gate already resolved into an inert, additive metadata block; it
 * does NO I/O and imports NO chain library (protocol layer — STANDARDS §1, viem-free).
 *
 * The block rides at `challenge.extensions.piprail`, ALONGSIDE the rejection
 * `{ code, detail }` (the gate deep-merges so neither clobbers the other). x402 v2
 * treats `extensions` as an opaque bag a standard client ignores, so this is
 * purely-additive: the pay path, `accepts[]`, headers, and status stay byte-identical.
 *
 * Its whole point: even an `onchain-proof`-only endpoint that a stock x402 client
 * CANNOT pay is no longer invisible — a stranger reads `sdk.install`, runs
 * `npm i @piprail/sdk`, pastes the snippet, and pays. For the non-EVM families that
 * have NO standard `exact` rail, this block is the ENTIRE interop story, so the
 * `onchain-proof` instruction is deliberately chain-agnostic.
 *
 * NOT WIRED here — this is the pure builder (discoverability plan, Phase 1). The gate
 * wires it into every challenge in Phase 5 (default-on, with a `selfDescribe:false`
 * opt-out that restores the byte-identical default).
 */
import type { X402AnyAccept } from './x402.js'

/**
 * The canonical PipRail brand strings — the SINGLE source of truth for the install
 * command, the paste-ready snippet, and the docs links, read by the self-describe
 * block here, and (later phases) the landing page, the `llms.txt` entry, and the
 * agent guide. `<your-chain>` / `<this-url>` are deliberate placeholders — never guess
 * the reader's chain or URL.
 */
export const BRAND = {
  name: 'PipRail',
  home: 'https://piprail.com',
  docs: 'https://docs.piprail.com',
  payDocs: 'https://docs.piprail.com/paying',
  sdkInstall: 'npm i @piprail/sdk',
  sdkSnippet:
    "import { PipRailClient } from '@piprail/sdk'\n" +
    "const client = new PipRailClient({ chain: '<your-chain>', wallet })\n" +
    "await client.fetch('<this-url>')",
  mcpRun: 'npx -y @piprail/mcp',
} as const

/**
 * One payable rail as the self-describe block presents it — the static, agent- and
 * human-readable view of an `accepts[]` entry (no nonce; this is long-lived metadata).
 */
export interface SelfDescribeRail {
  scheme: 'onchain-proof' | 'exact'
  network: string
  asset: string
  payTo: string
  /** Amount in the token's base units (already scaled by decimals). */
  amount: string
  /** Human-readable amount, e.g. "0.01", when the gate resolved one. */
  amountFormatted?: string
  symbol?: string
  /** A one-line instruction for paying THIS rail — chain-agnostic for `onchain-proof`. */
  how: string
}

/**
 * What the endpoint DOES — the agent-readability payload. Present only when the merchant
 * described their resource (a `description`/`mimeType` on the gate, or a `discovery`
 * descriptor with a `summary`/`queryParams`/`output`); absent on a zero-config gate, so
 * the default 402 stays byte-identical. Lets an AI agent understand the endpoint's purpose,
 * inputs, and output shape from the 402 alone — no paid call to find out what it returns.
 */
export interface SelfDescribeEndpoint {
  /** One human sentence: what this endpoint does. */
  summary?: string
  /** HTTP method it answers on. */
  method?: string
  /** The response content-type, e.g. 'application/json'. */
  mimeType?: string
  /** Query params it reads, as a JSON-Schema `properties` object (name → schema). */
  input?: Record<string, unknown>
  /** Output hint — shape/type and a concrete example (examples ground an LLM far better
   *  than a schema alone). */
  output?: { type?: string; example?: unknown }
}

/** The `extensions.piprail` self-description block. Inert, purely-additive metadata. */
export interface SelfDescription {
  name: 'PipRail'
  protocol: 'x402'
  version: '2'
  /** One sentence: what this endpoint is. */
  what: string
  /** What the endpoint DOES (purpose · inputs · output) — see {@link SelfDescribeEndpoint}.
   *  Only present when the merchant described the resource; absent on a zero-config gate. */
  endpoint?: SelfDescribeEndpoint
  /** Every rail the 402 offers, in the same order as `accepts[]`. */
  pay: SelfDescribeRail[]
  /** How to pay programmatically with the SDK. */
  sdk: { install: string; snippet: string }
  /** How to pay via the MCP server (for AI agents). */
  mcp: { run: string; tool: string }
  docs: { home: string; agents: string; pay: string }
  /** Where the open discovery artifacts live on this origin. */
  discovery: { openapi: string; wellKnown: string }
  /** A one-line human summary (the gate sets it from `describeChallenge`). */
  instruction?: string
}

const WHAT =
  'This is an x402 "402 Payment Required" endpoint. Pay one of the offered rails to access it.'

/**
 * How to pay a given rail. `exact` is the ratified, stock-client-payable rail; the
 * `onchain-proof` string is deliberately CHAIN-AGNOSTIC (no EVM/EIP-3009 assumption)
 * and points at the SDK, because on the non-EVM families that have no standard `exact`
 * rail it is the only on-ramp a stranger has.
 */
function howFor(scheme: 'onchain-proof' | 'exact'): string {
  return scheme === 'exact'
    ? 'Standard x402 exact rail — sign an EIP-3009 / Permit2 / SVM authorization; any stock x402 client (e.g. @x402/fetch) can pay this.'
    : 'Pay this amount on-chain to payTo, then resubmit with a payment-signature header carrying the proof ref + nonce. Easiest with @piprail/sdk (see sdk.install).'
}

function railOf(a: X402AnyAccept): SelfDescribeRail {
  // `extra` is required by the type, but guard anyway — this builder is exported and may
  // be handed a foreign/odd accept; missing fields degrade, they never throw.
  const extra: { amountFormatted?: string; symbol?: string } = a.extra ?? {}
  return {
    scheme: a.scheme,
    network: a.network,
    asset: a.asset,
    payTo: a.payTo,
    amount: a.amount,
    ...(extra.amountFormatted ? { amountFormatted: extra.amountFormatted } : {}),
    ...(extra.symbol ? { symbol: extra.symbol } : {}),
    how: howFor(a.scheme),
  }
}

/**
 * Build the `extensions.piprail` self-describe block from a challenge's resolved
 * `accepts[]`. PURE — every rail is derived from data the gate already has (no new
 * data, no I/O). `instruction` is the optional one-line human summary the gate computes
 * via `describeChallenge` (in `render.ts`) and passes in.
 */
export function buildSelfDescription(input: {
  accepts: X402AnyAccept[]
  instruction?: string
  /** What the endpoint DOES — included only when non-empty (keeps the zero-config 402
   *  byte-identical). Built from the gate's `description`/`mimeType`/`discovery` descriptor
   *  via {@link buildEndpointInfo}. */
  endpoint?: SelfDescribeEndpoint
}): SelfDescription {
  return {
    name: 'PipRail',
    protocol: 'x402',
    version: '2',
    what: WHAT,
    ...(input.endpoint && Object.keys(input.endpoint).length > 0 ? { endpoint: input.endpoint } : {}),
    pay: input.accepts.map(railOf),
    sdk: { install: BRAND.sdkInstall, snippet: BRAND.sdkSnippet },
    mcp: { run: BRAND.mcpRun, tool: 'piprail_pay_request' },
    docs: { home: BRAND.home, agents: BRAND.docs, pay: BRAND.payDocs },
    discovery: { openapi: '/openapi.json', wellKnown: '/.well-known/x402' },
    ...(input.instruction ? { instruction: input.instruction } : {}),
  }
}

/**
 * Assemble a {@link SelfDescribeEndpoint} from the pieces a gate knows — its
 * `description`/`mimeType` and an optional `discovery` descriptor. Pure. Returns
 * `undefined` when nothing was described, so the self-describe block (and thus the 402)
 * stays byte-identical on a zero-config gate. The descriptor's `summary` wins over the
 * gate `description` for the one-line "what it does".
 */
export function buildEndpointInfo(input: {
  description?: string
  mimeType?: string
  descriptor?: { summary?: string; method?: string; queryParams?: Record<string, unknown>; output?: { type?: string; example?: unknown } }
}): SelfDescribeEndpoint | undefined {
  const d = input.descriptor
  const summary = d?.summary ?? input.description
  const hasInput = d?.queryParams && Object.keys(d.queryParams).length > 0
  const endpoint: SelfDescribeEndpoint = {
    ...(summary ? { summary } : {}),
    ...(d?.method ? { method: d.method.toUpperCase() } : {}),
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    ...(hasInput ? { input: d!.queryParams } : {}),
    ...(d?.output ? { output: d.output } : {}),
  }
  return Object.keys(endpoint).length > 0 ? endpoint : undefined
}
