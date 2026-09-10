/**
 * THE LAB BENCH: what /demo runs, and what each test proves it can do.
 *
 * This file is the source of truth for three things that used to disagree:
 *   1. the bench rendered on /demo (the page reads this list, it hardcodes nothing),
 *   2. the runners in `site/public/lab/runners.js` (ids must match, both ways),
 *   3. `npm run lab:coverage`, which fails when a public SDK symbol is in neither
 *      a test's `uses` nor {@link OFF_THE_BENCH}.
 *
 * `uses` is the load-bearing field. A lab that says "test the SDK" and exercises a tenth
 * of it is a brochure, and nothing catches the drift: symbols get added, the page keeps
 * its twelve buttons, and the claim rots silently. Naming the symbols makes the claim
 * checkable, so the page can only ever overstate itself for as long as CI takes to run.
 *
 * Members are written `Type#member`, as in `PipRailClient#quote`. Bare names are exports.
 */

export type LabStage = 'Setup' | 'Merchant' | 'Buyer' | 'Agent' | 'Interop'

export interface LabTest {
  id: string
  stage: LabStage
  name: string
  /** One line, in the sidebar: what the reader is about to see. */
  note: string
  /** `pure` runs offline and deterministically; `live` touches a public RPC, this site's
   *  own 402, or an open index. It is a promise to the reader, not decoration. */
  kind: 'pure' | 'live'
  /** What this test actually calls. Checked against the built SDK by `npm run lab:coverage`. */
  uses: readonly string[]
  /**
   * A REQUIREMENT the reader would otherwise have to discover by being confused: a key, a
   * funded wallet, a package that has no browser build, a server-side runtime. Rendered in
   * the output panel, not buried in prose, because the whole point of a lab is that nothing
   * fails mysteriously.
   */
  needs?: string
}

export const LAB_TESTS: readonly LabTest[] = [
  // ── Setup ─────────────────────────────────────────────────────────────────────────
  {
    id: 'chains',
    stage: 'Setup',
    name: 'Chains and drivers',
    note: 'Every mainnet preset, its gas coin, and the driver behind it.',
    kind: 'pure',
    uses: ['CHAINS', 'resolveChain', 'registerDriver'],
  },
  {
    id: 'client',
    stage: 'Setup',
    name: 'Build a client',
    note: 'Bind a chain and a wallet, and read back what it can do.',
    kind: 'pure',
    uses: [
      'PipRailClient', 'PipRailClient#chain', 'PipRailClient#address', 'PipRailClient#mode',
      'PipRailClient#policy', 'PipRailClient#swapPolicy', 'PipRailClient#canAgentSell',
      'PipRailClient#canAgentSwap', 'AGENT_MODES', 'DEFAULT_AGENT_MODE',
    ],
  },
  {
    id: 'errors',
    stage: 'Setup',
    name: 'Every typed error',
    note: 'The stable codes a caller branches on, all twenty of them.',
    kind: 'pure',
    uses: [
      'PipRailError', 'InsufficientFundsError', 'RecipientNotReadyError', 'WrongChainError',
      'PaymentTimeoutError', 'MaxRetriesExceededError', 'PaymentDeclinedError',
      'ConfirmationTimeoutError', 'SettlementError', 'InvalidEnvelopeError', 'InvalidConfigError',
      'NoCompatibleAcceptError', 'UnsupportedSchemeError', 'NonReplayableBodyError',
      'WalletRequiredError', 'WrongFamilyError', 'UnknownTokenError', 'MissingDriverError',
      'UnsupportedNetworkError', 'toInsufficientFundsError', 'explainDecline',
    ],
  },

  // ── Merchant ──────────────────────────────────────────────────────────────────────
  {
    id: 'gate',
    stage: 'Merchant',
    name: 'Mint a 402',
    note: 'Build a gate and read the challenge it serves.',
    kind: 'pure',
    uses: ['createPaymentGate', 'PaymentGate#challenge'],
  },
  {
    id: 'wire',
    stage: 'Merchant',
    name: 'The bytes on the wire',
    note: 'Encode, decode, and the v1 shape older clients still send.',
    kind: 'pure',
    uses: [
      'buildChallengeHeader', 'parseChallenge', 'decodeBase64Json', 'describeChallenge',
      'HEADER_REQUIRED', 'HEADER_RESPONSE', 'HEADER_SIGNATURE', 'HEADER_SIGNATURE_V1',
      'HEADER_RESPONSE_V1', 'buildV1PaymentHeader', 'normalizeV1Challenge',
    ],
  },
  {
    id: 'verify',
    stage: 'Merchant',
    name: 'Refuse a forged proof',
    note: 'Submit a lie to the gate and watch it get caught.',
    kind: 'live',
    uses: [
      'PaymentGate#verify', 'PaymentGate#verifyObject', 'toInvalidBody',
      'buildSignatureHeader', 'parseSignatureHeader', 'parseSignatureObject',
    ],
  },
  {
    id: 'selftest',
    stage: 'Merchant',
    name: 'Gate self-test',
    note: 'Check the config before a buyer ever sees it.',
    kind: 'pure',
    uses: ['PaymentGate#selfTest'],
  },
  {
    id: 'presets',
    stage: 'Merchant',
    name: 'Paywall, tip jar, adapters',
    note: 'The one-liners, and the runtimes they mount on.',
    kind: 'pure',
    uses: ['createPaywall', 'createTipJar', 'requirePayment', 'toFetchHandler', 'toWorker', 'proxyTo'],
  },
  {
    id: 'describe',
    stage: 'Merchant',
    name: 'Be discoverable',
    note: 'The manifest, OpenAPI and DNS record that get you indexed.',
    kind: 'pure',
    uses: [
      'buildWellKnownX402', 'buildWellKnownX402Manifest', 'buildOpenApi', 'buildX402DnsTxt',
      'buildBazaarExtension', 'discoveryHeaders', 'GENERATOR', 'POWERED_BY', 'PaymentGate#describe',
    ],
  },
  {
    id: 'landing',
    stage: 'Merchant',
    name: 'The page a human lands on',
    note: 'Render the 402 landing page, live, in a frame.',
    kind: 'pure',
    uses: [
      'buildSelfDescription', 'buildEndpointInfo', 'renderLandingPage', 'BRAND',
      'PaymentGate#landingPage',
    ],
  },
  {
    id: 'receipts',
    stage: 'Merchant',
    name: 'Verify a real settlement',
    note: 'Re-derive a live Base transfer from chain, then tamper with it.',
    kind: 'live',
    uses: [
      'PipRailClient#verifyReceipt', 'PipRailClient#verifyAttestation', 'buildReceiptHeader',
      'parseReceipt', 'buildReceiptExtension', 'parseReceiptExtension', 'EXT_OFFER_RECEIPT',
      'deliverReceipt', 'buildPaymentIdentifierAdvertisement', 'readPaymentIdentifier',
      'EXT_PAYMENT_IDENTIFIER',
    ],
    needs: 'A public Base RPC. It reads the most recent USDC transfer on Base and verifies that, so there is nothing to fund and nothing to pin.',
  },

  // ── Buyer ─────────────────────────────────────────────────────────────────────────
  {
    id: 'quote',
    stage: 'Buyer',
    name: 'Quote a live 402',
    note: 'The real price of piprail.com/x402/demo.',
    kind: 'live',
    uses: ['PipRailClient#quote', 'pickAccept'],
  },
  {
    id: 'cost',
    stage: 'Buyer',
    name: 'Estimate gas',
    note: 'The network fee, in the chain’s own gas coin.',
    kind: 'live',
    uses: ['PipRailClient#estimateCost'],
  },
  {
    id: 'plan',
    stage: 'Buyer',
    name: 'Plan the payment',
    note: 'Affordability and blockers, from a burner wallet.',
    kind: 'live',
    uses: [
      'PipRailClient#planPayment', 'PipRailClient#canAfford', 'PipRailClient#balanceOf',
      'summarizePlan',
    ],
  },
  {
    id: 'classify',
    stage: 'Buyer',
    name: 'Can I pay this at all?',
    note: 'Triage a challenge before spending a request on it.',
    kind: 'pure',
    uses: ['classifyChallenge', 'normalizeNetwork'],
  },
  {
    id: 'policy',
    stage: 'Buyer',
    name: 'The spend leash',
    note: 'Watch the policy engine allow one and refuse one.',
    kind: 'pure',
    uses: ['evaluatePolicy', 'denomOf', 'BUILTIN_DENOMS', 'DENOM_PRECISION'],
  },
  {
    id: 'budget',
    stage: 'Buyer',
    name: 'The running total',
    note: 'The ledger an agent cannot spend past.',
    kind: 'pure',
    uses: [
      'SpendLedger', 'SpendLedger#record', 'SpendLedger#reserve', 'SpendLedger#release',
      'SpendLedger#totalFor', 'SpendLedger#totalForDenom', 'SpendLedger#totalSince',
      'SpendLedger#count', 'SpendLedger#countSince', 'SpendLedger#summary',
      'SpendLedger#assetBuckets', 'SpendLedger#denomBuckets', 'SpendLedger#markWarned',
      'SpendLedger#sessionStart', 'memorySpendStore', 'formatSpendReport',
      'PipRailClient#spent', 'PipRailClient#remaining', 'PipRailClient#denomRemaining',
      'PipRailClient#countStatus', 'PipRailClient#budget',
    ],
  },
  {
    id: 'pay',
    stage: 'Buyer',
    name: 'Try to pay it',
    note: 'A real payment attempt from an empty wallet.',
    kind: 'live',
    uses: ['PipRailClient#fetch', 'PipRailClient#get', 'PipRailClient#post', 'PipRailClient#lastReceipt'],
    needs: 'A funded wallet to SUCCEED. The lab uses a burner holding nothing, so you see the refusal an unfunded agent gets, before anything is signed or broadcast.',
  },
  {
    id: 'exact',
    stage: 'Buyer',
    name: 'Sign a gasless payment',
    note: 'A real EIP-3009 authorization, signed in this tab.',
    kind: 'live',
    uses: [
      'buildExactAuthorization', 'encodeXPaymentHeader', 'parseExactPaymentHeader',
      'parseExactObject', 'parseExactRequirements', 'buildExactSignatureHeader',
      'EIP3009_TYPES', 'eip3009Abi', 'readExactDomain', 'exactTransferMethod',
      'isSettleableExactMethod', 'KNOWN_EXACT_TRANSFER_METHODS', 'DEFAULT_EXACT_TRANSFER_METHOD',
      'chainIdForExactNetwork', 'EXACT_NETWORK_SLUGS', 'PERMIT2_ADDRESS',
      'X402_EXACT_PERMIT2_PROXY', 'PERMIT2_PROXY_CHAIN_IDS', 'isPermit2ProxyChain',
      'PERMIT2_WITNESS_TYPES',
    ],
    needs: 'Nothing. The signature is free and gasless by design, which is the point: an empty wallet can authorize a transfer that somebody else pays the gas to submit.',
  },
  {
    id: 'upto',
    stage: 'Buyer',
    name: 'Metered payments',
    note: 'The upto rail, where you authorize a ceiling.',
    kind: 'pure',
    uses: [
      'parseUptoObject', 'parseUptoPaymentHeader', 'buildUptoSignatureHeader',
      'X402_UPTO_PERMIT2_PROXY', 'UPTO_PROXY_CHAIN_IDS', 'isUptoProxyChain',
      'PERMIT2_UPTO_WITNESS_TYPES',
    ],
  },
  {
    id: 'multichain',
    stage: 'Buyer',
    name: 'Pay across chains',
    note: 'Several clients, one wallet, the cheapest rail wins.',
    kind: 'live',
    uses: [
      'MultiChainPayer', 'MultiChainPayer#clients', 'MultiChainPayer#fromWallets',
      'MultiChainPayer#quote', 'MultiChainPayer#planPayment', 'MultiChainPayer#canAfford',
      'MultiChainPayer#balanceOf', 'MultiChainPayer#fetch', 'MultiChainPayer#get',
      'MultiChainPayer#post', 'MultiChainPayer#address', 'MultiChainPayer#chain',
      'MultiChainPayer#mode', 'MultiChainPayer#policy', 'MultiChainPayer#budget',
      'MultiChainPayer#spent', 'MultiChainPayer#discover', 'MultiChainPayer#register',
      'MultiChainPayer#quoteSwap', 'MultiChainPayer#swap', 'MultiChainPayer#canAgentSell',
      'MultiChainPayer#canAgentSwap', 'planAcross', 'fetchAcross',
    ],
  },

  // ── Agent ─────────────────────────────────────────────────────────────────────────
  {
    id: 'discover',
    stage: 'Agent',
    name: 'Search the market',
    note: 'Read the open x402 indexes for something to buy.',
    kind: 'live',
    uses: ['PipRailClient#discover', 'searchOpenIndexes', 'INDEX_PROXY_PATH', 'rankResources', 'scoreResource'],
    needs: 'In a BROWSER, a same-origin forwarder, because the open indexes send no usable CORS header. This site mounts one in a line; the SDK finds it by itself. Server-side there is nothing to do.',
  },
  {
    id: 'tools',
    stage: 'Agent',
    name: 'Agent tools',
    note: 'The tool descriptors and the contract a model is handed.',
    kind: 'pure',
    uses: ['paymentTools', 'agentGuide', 'PIPRAIL_AGENT_GUIDE'],
  },
  {
    id: 'swaps',
    stage: 'Agent',
    name: 'Swap its own funds',
    note: 'Quote a real route, then watch an empty wallet be refused.',
    kind: 'live',
    uses: [
      'SWAP_PROVIDERS', 'swapProvidersFor', 'canSwapOn', 'swappableNetworks', 'applySlippage',
      'resolveSlippageBps', 'DEFAULT_SLIPPAGE_BPS', 'MAX_SLIPPAGE_BPS', 'summarizeSwap',
      'PipRailClient#quoteSwap', 'PipRailClient#swap',
    ],
    needs: 'A funded wallet to actually swap, and a swap policy, because swapping is off by default. The quote is a real live route; the swap itself stops at the empty balance.',
  },
  {
    id: 'listing',
    stage: 'Agent',
    name: 'List your endpoint',
    note: 'The exact payload each directory would receive.',
    kind: 'pure',
    uses: [
      'DIRECTORY_INFO', 'getDirectoryInfo', 'appendAttribution', 'appendKeywords',
      'decorateOutcome', 'REGISTER_ATTRIBUTION',
    ],
    needs: 'This is the one test the lab will not fire. Sending it would write a junk listing into a public directory other people search. The payload shown is exactly what would be posted.',
  },
  {
    id: 'domain',
    stage: 'Agent',
    name: 'Prove you own the domain',
    note: 'A live DNS-backed ownership check for piprail.com.',
    kind: 'live',
    uses: ['verify402IndexDomain', 'PipRailClient#verifyDomain', 'PipRailClient#discoverySigner'],
    needs: 'Claiming a domain needs a TXT record you can publish. Verifying one needs nothing, so that is the half that runs here.',
  },

  // ── Interop ───────────────────────────────────────────────────────────────────────
  {
    id: 'mcp',
    stage: 'Interop',
    name: 'x402 over MCP',
    note: 'A 402 as a tool result, and the payment back.',
    kind: 'pure',
    uses: [
      'toMcpPaymentRequired', 'fromMcpPaymentRequired', 'isMcpPaymentRequired',
      'toMcpPaymentResponse', 'fromMcpPaymentResponse', 'fromMcpPayment', 'buildMcpPaymentMeta',
      'createMcpPaymentTool', 'MCP_PAYMENT_META_KEY', 'MCP_PAYMENT_RESPONSE_META_KEY',
    ],
  },
  {
    id: 'a2a',
    stage: 'Interop',
    name: 'x402 over A2A',
    note: 'Google’s agent-to-agent extension, both versions.',
    kind: 'pure',
    uses: [
      'toA2APaymentRequired', 'fromA2APaymentRequired', 'fromA2APaymentPayload',
      'toA2APaymentReceipts', 'toA2APaymentFailed', 'toA2AErrorCode', 'createA2APaymentHandler',
      'VERIFY_CODE_TO_A2A_ERROR', 'A2A_X402_EXTENSION_URI_V01', 'A2A_X402_EXTENSION_URI_V02',
      'A2A_STATUS_KEY', 'A2A_REQUIRED_KEY', 'A2A_PAYLOAD_KEY', 'A2A_RECEIPTS_KEY',
      'A2A_ERROR_KEY', 'A2A_EXTENSIONS_HEADER',
    ],
  },
  {
    id: 'facilitators',
    stage: 'Interop',
    name: 'Facilitators',
    note: 'Who will sponsor your gas, and what they support.',
    kind: 'live',
    uses: [
      'KNOWN_FACILITATORS', 'knownFacilitatorsFor', 'firstKeylessFacilitator',
      'parseFacilitatorSupported', 'facilitatorCoverage', 'parseSettleResponse',
    ],
    needs: 'Reading a facilitator’s capabilities is keyless. Settling THROUGH one submits a real payment, so that call is not wired to a button here.',
  },
  {
    id: 'proxy',
    stage: 'Interop',
    name: 'The forwarder itself',
    note: 'Run the SDK’s own server code, here, in your browser.',
    kind: 'pure',
    uses: ['indexProxyHandler', 'INDEX_PROXY_ALLOWED_HOSTS'],
  },
]

/**
 * Calls that will not be wired to a button, and the reason.
 *
 * The bar is deliberately high: "needs a wallet" is NOT a reason, because an empty wallet
 * still exercises the whole path up to the money and the refusal is worth seeing. The only
 * things here would write into somebody else's system if a stranger clicked them.
 *
 * The page renders these, so the gap is visible on /demo rather than only in this file.
 */
export const OFF_THE_BENCH: readonly { symbol: string; reason: string; where: string }[] = [
  {
    symbol: 'register402Index',
    reason: 'Posts a listing into a public directory people search. A demo button would fill it with junk.',
    where: 'listing',
  },
  {
    symbol: 'registerX402Scan',
    reason: 'Posts a listing into a public directory people search. A demo button would fill it with junk.',
    where: 'listing',
  },
  {
    symbol: 'PipRailClient#register',
    reason: 'Registers a live endpoint across every directory at once. Same reason, one call higher up.',
    where: 'listing',
  },
  {
    symbol: 'claim402IndexDomain',
    reason: 'Writes a domain-ownership claim you then have to prove with a DNS TXT record you control.',
    where: 'domain',
  },
  {
    symbol: 'PipRailClient#claimDomain',
    reason: 'Writes a domain-ownership claim you then have to prove with a DNS TXT record you control.',
    where: 'domain',
  },
  {
    symbol: 'settleViaFacilitator',
    reason: 'Submits a payment to a third party for settlement. Their endpoint, their gas, real money.',
    where: 'facilitators',
  },
]
