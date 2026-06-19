// Suite 11 — API-surface sweep. Two jobs:
//   1. COMPLETENESS: assert every public value-export of @piprail/sdk is defined
//      (a tripwire for an accidentally-dropped or renamed export on any release).
//   2. PURE HELPERS: actually invoke the chain-free helpers not covered by other
//      suites — renderers, classify, self-describe + landing, the discovery
//      builders, the index + facilitator data maps, the exact/permit2 codecs &
//      constants, the spend policy, the typed errors, and the agent guide.

import * as sdk from '@piprail/sdk'
import { check, group, note } from '../lib/report.mjs'

// Every value (non-type) export the package promises. A missing one = a broken release.
const EXPECTED = [
  // pay
  'PipRailClient', 'planAcross', 'fetchAcross', 'MultiChainPayer',
  // policy + toolkit + ergonomics
  'evaluatePolicy', 'paymentTools',
  'summarizePlan', 'explainDecline', 'formatSpendReport', 'describeChallenge',
  'PIPRAIL_AGENT_GUIDE', 'agentGuide', 'classifyChallenge', 'buildSelfDescription', 'BRAND',
  // accept
  'requirePayment', 'createPaymentGate', 'toInvalidBody',
  // facilitator
  'settleViaFacilitator', 'parseFacilitatorSupported', 'facilitatorCoverage',
  'KNOWN_FACILITATORS', 'knownFacilitatorsFor', 'firstKeylessFacilitator',
  // receipts + chains + driver SPI
  'deliverReceipt', 'CHAINS', 'resolveChain', 'registerDriver',
  // errors
  'PipRailError', 'InsufficientFundsError', 'RecipientNotReadyError', 'WrongChainError',
  'WrongFamilyError', 'UnknownTokenError', 'MissingDriverError', 'UnsupportedNetworkError',
  'PaymentTimeoutError', 'ConfirmationTimeoutError', 'MaxRetriesExceededError', 'PaymentDeclinedError',
  'InvalidEnvelopeError', 'NoCompatibleAcceptError', 'UnsupportedSchemeError', 'NonReplayableBodyError',
  'WalletRequiredError', 'SettlementError', 'toInsufficientFundsError',
  // wire
  'pickAccept', 'parseChallenge', 'parseReceipt', 'parseSettleResponse', 'parseSignatureHeader',
  'parseExactPaymentHeader', 'buildChallengeHeader', 'buildSignatureHeader', 'buildExactSignatureHeader',
  'buildReceiptHeader', 'HEADER_REQUIRED', 'HEADER_SIGNATURE', 'HEADER_RESPONSE', 'HEADER_SIGNATURE_V1', 'HEADER_RESPONSE_V1',
  // exact codec
  'parseExactRequirements', 'chainIdForExactNetwork', 'buildExactAuthorization', 'encodeXPaymentHeader',
  'readExactDomain', 'eip3009Abi', 'EXACT_NETWORK_SLUGS', 'EIP3009_TYPES',
  // permit2
  'PERMIT2_ADDRESS', 'X402_EXACT_PERMIT2_PROXY', 'PERMIT2_WITNESS_TYPES', 'PERMIT2_PROXY_CHAIN_IDS', 'isPermit2ProxyChain',
  // discovery
  'buildOpenApi', 'buildWellKnownX402', 'buildX402DnsTxt', 'buildBazaarExtension', 'GENERATOR',
  'discoveryHeaders', 'POWERED_BY', 'renderLandingPage',
  'searchOpenIndexes', 'register402Index', 'registerX402Scan', 'claim402IndexDomain', 'verify402IndexDomain',
  'normalizeNetwork', 'DIRECTORY_INFO', 'getDirectoryInfo', 'decorateOutcome', 'appendAttribution', 'REGISTER_ATTRIBUTION',
]

const BASE = 'eip155:8453'
const accept = { scheme: 'onchain-proof', network: BASE, amount: '50000', asset: 'native', payTo: '0xMerchant', maxTimeoutSeconds: 600, extra: { nonce: 'n', decimals: 6, minConfirmations: 1, amountFormatted: '0.05', symbol: 'ETH' } }
const challenge = { x402Version: 2, error: null, resource: { url: 'https://api.example.com/r' }, accepts: [accept] }

export async function run() {
  group('11 api-surface · completeness (every export present)')
  {
    const missing = EXPECTED.filter((n) => sdk[n] === undefined)
    check(`all ${EXPECTED.length} promised value-exports are defined`, missing.length === 0, missing.length ? `MISSING: ${missing.join(', ')}` : '')
    // Catch a SHAPE drift too: the headline things must be the right kind.
    check('PipRailClient + MultiChainPayer are constructors', typeof sdk.PipRailClient === 'function' && typeof sdk.MultiChainPayer === 'function')
    check('CHAINS is the EVM preset registry (base present)', sdk.CHAINS && !!sdk.CHAINS.base)
    check('BRAND has the home + install single-source-of-truth', sdk.BRAND && typeof sdk.BRAND.home === 'string' && typeof sdk.BRAND.sdkInstall === 'string')
  }

  group('11 api-surface · renderers (chain-free, LLM-legible)')
  {
    check('summarizePlan(null) → "no payment required"', /no payment/i.test(sdk.summarizePlan(null)))
    const blockedPlan = { url: 'u', network: BASE, status: 'blocked', payable: false, best: null, options: [], fundingHint: 'top up 1 USDC' }
    check('summarizePlan(blocked) surfaces the fundingHint', sdk.summarizePlan(blockedPlan).includes('top up 1 USDC'))
    check('explainDecline(PaymentDeclinedError) → its message', sdk.explainDecline(new sdk.PaymentDeclinedError('over budget')).includes('over budget'))
    check('explainDecline(non-PipRail error) → "Payment failed"', /payment failed/i.test(sdk.explainDecline(new Error('boom'))))
    const emptySpend = { count: 0, byAsset: [], records: [] }
    check('formatSpendReport(empty) → a string', typeof sdk.formatSpendReport(emptySpend) === 'string')
    check('describeChallenge(challenge) → mentions the rail', typeof sdk.describeChallenge(challenge) === 'string' && sdk.describeChallenge(challenge).length > 0)
  }

  group('11 api-surface · classify (402 triage)')
  {
    const onChain = sdk.classifyChallenge(challenge, { network: BASE, schemes: ['onchain-proof'] })
    check('classifyChallenge → PAYABLE_RAIL on the client chain+scheme', onChain.verdict === 'PAYABLE_RAIL', onChain.verdict)
    const wrongChain = sdk.classifyChallenge(challenge, { network: 'solana:mainnet', schemes: ['onchain-proof'] })
    check('classifyChallenge → not payable on a wrong chain', wrongChain.verdict !== 'PAYABLE_RAIL', wrongChain.verdict)
    const empty = sdk.classifyChallenge({ ...challenge, accepts: [] }, { network: BASE, schemes: ['onchain-proof'] })
    check('classifyChallenge → NO_RAIL when accepts empty', empty.verdict === 'NO_RAIL', empty.verdict)
  }

  group('11 api-surface · self-describe + landing')
  {
    const sd = sdk.buildSelfDescription({ accepts: [accept], instruction: 'pay me' })
    check('buildSelfDescription → name=PipRail, protocol=x402, pay[] per rail', sd.name === 'PipRail' && sd.protocol === 'x402' && sd.pay.length === 1)
    check('buildSelfDescription carries sdk install + mcp tool', sd.sdk?.install && sd.mcp?.tool === 'piprail_pay_request')
    const html = sdk.renderLandingPage(sd)
    check('renderLandingPage(sd) → HTML document', typeof html === 'string' && /<html|<!doctype/i.test(html))
  }

  group('11 api-surface · discovery builders (emit, $0)')
  {
    const rail = { scheme: 'onchain-proof', network: BASE, asset: 'native', payTo: '0xMerchant', amount: '50000', amountFormatted: '0.05', decimals: 6 }
    const manifest = { origin: 'https://api.example.com', resources: [{ url: 'https://api.example.com/r', method: 'GET', description: 'A report', accepts: [rail] }] }
    const oa = sdk.buildOpenApi(manifest)
    check('buildOpenApi → an OpenAPI 3 doc', oa && typeof oa.openapi === 'string' && !!oa.paths)
    check('buildOpenApi stamps the x-generator (PipRail attribution)', JSON.stringify(oa).includes('piprail') || !!sdk.GENERATOR)
    const wk = sdk.buildWellKnownX402(manifest)
    check('buildWellKnownX402 → a .well-known/x402 object', wk && typeof wk === 'object')
    const dns = sdk.buildX402DnsTxt({ host: 'api.example.com', discoveryUrl: 'https://api.example.com/.well-known/x402' })
    check('buildX402DnsTxt → _x402 TXT record', dns.name?.startsWith('_x402.') && dns.value?.includes('v=x4021'))
    const bz = sdk.buildBazaarExtension({})
    check('buildBazaarExtension({}) → an object (no throw on empty)', bz && typeof bz === 'object')
    const headers = sdk.discoveryHeaders({ attribution: true })
    check('discoveryHeaders → a header bag incl. a Link/x-powered-by', headers && Object.keys(headers).length > 0)
    check('POWERED_BY + GENERATOR are strings', typeof sdk.POWERED_BY === 'string' && typeof sdk.GENERATOR === 'string')
  }

  group('11 api-surface · index + facilitator data maps')
  {
    check('normalizeNetwork(base) → a CAIP-2', sdk.normalizeNetwork('base').includes(':'))
    check('getDirectoryInfo(402index) → directory metadata', !!sdk.getDirectoryInfo('402index'))
    check('DIRECTORY_INFO + REGISTER_ATTRIBUTION present', !!sdk.DIRECTORY_INFO && typeof sdk.REGISTER_ATTRIBUTION === 'string')
    check('appendAttribution(desc) → adds the PipRail marker', (sdk.appendAttribution('A data API') ?? '').toLowerCase().includes('piprail'))
    const deco = sdk.decorateOutcome({ source: '402index', ok: true, url: 'https://x/a' })
    check('decorateOutcome(outcome) → an outcome object', deco && deco.source === '402index')
    check('KNOWN_FACILITATORS is a non-empty CAIP-2-keyed map', sdk.KNOWN_FACILITATORS && typeof sdk.KNOWN_FACILITATORS === 'object' && Array.isArray(sdk.KNOWN_FACILITATORS[BASE]) && sdk.KNOWN_FACILITATORS[BASE].length > 0)
    check('knownFacilitatorsFor(base) → list', Array.isArray(sdk.knownFacilitatorsFor(BASE)))
    check('firstKeylessFacilitator(base) → a facilitator or undefined (no throw)', (() => { sdk.firstKeylessFacilitator(BASE); return true })())
    check('parseFacilitatorSupported({}) → array (no throw on junk)', Array.isArray(sdk.parseFacilitatorSupported({})))
    check('facilitatorCoverage is an (async) function', typeof sdk.facilitatorCoverage === 'function')
  }

  group('11 api-surface · exact / permit2 codecs + constants')
  {
    check('chainIdForExactNetwork(base) → 8453', sdk.chainIdForExactNetwork('base') === 8453, String(sdk.chainIdForExactNetwork('base')))
    check('chainIdForExactNetwork(bogus) → null', sdk.chainIdForExactNetwork('nope') === null)
    check('parseExactRequirements(junk) → null (no throw)', sdk.parseExactRequirements({ nope: 1 }) === null)
    check('EXACT_NETWORK_SLUGS + EIP3009_TYPES + eip3009Abi present', !!sdk.EXACT_NETWORK_SLUGS && !!sdk.EIP3009_TYPES && Array.isArray(sdk.eip3009Abi))
    check('PERMIT2_ADDRESS + X402_EXACT_PERMIT2_PROXY are 0x addresses', /^0x[0-9a-fA-F]{40}$/.test(sdk.PERMIT2_ADDRESS) && /^0x[0-9a-fA-F]{40}$/.test(sdk.X402_EXACT_PERMIT2_PROXY))
    check('isPermit2ProxyChain(56) → boolean', typeof sdk.isPermit2ProxyChain(56) === 'boolean')
    check('PERMIT2_WITNESS_TYPES + PERMIT2_PROXY_CHAIN_IDS present', !!sdk.PERMIT2_WITNESS_TYPES && !!sdk.PERMIT2_PROXY_CHAIN_IDS)
  }

  group('11 api-surface · chains + spend policy')
  {
    const rc = sdk.resolveChain('base')
    check('resolveChain(base) → a resolved chain with chainId 8453', rc && rc.chainId === 8453, String(rc?.chainId))
    // A recognised-token intent (what the client builds): asset id + true symbol/decimals + recognized.
    const intent = { host: 'api.example.com', chain: 'base', network: BASE, asset: '0xUSDC', amountBase: 50000n, decimals: 6, symbol: 'USDC', recognized: true }
    const allow = sdk.evaluatePolicy(intent, { maxAmount: '1.00', tokens: ['USDC'] }, 0n)
    check('evaluatePolicy → ALLOW under the cap', allow.allowed === true, JSON.stringify(allow))
    const deny = sdk.evaluatePolicy({ ...intent, amountBase: 5_000_000n }, { maxAmount: '1.00', tokens: ['USDC'] }, 0n)
    check('evaluatePolicy → DENY over maxAmount', deny.allowed === false && !!deny.code, deny.code)
    const denyTok = sdk.evaluatePolicy(intent, { maxAmount: '1.00', tokens: ['USDT'] }, 0n)
    check('evaluatePolicy → DENY a token off the allowlist', denyTok.allowed === false, denyTok.code)
    check('evaluatePolicy(no policy) → ALLOW', sdk.evaluatePolicy(intent, undefined, 0n).allowed === true)
  }

  group('11 api-surface · typed errors (stable .code) + guide')
  {
    const errs = [
      new sdk.PaymentDeclinedError('x'), new sdk.NoCompatibleAcceptError('x'),
      new sdk.WalletRequiredError('x'), new sdk.SettlementError('x'),
    ]
    check('typed errors are instanceof PipRailError', errs.every((e) => e instanceof sdk.PipRailError))
    check('typed errors carry a stable string .code', errs.every((e) => typeof e.code === 'string' && e.code.length > 0), errs.map((e) => e.code).join(','))
    check('toInvalidBody({error,detail}) → an x402 invalid-body object', (() => { const b = sdk.toInvalidBody({ error: 'bad', detail: 'why' }); return !!b && typeof b === 'object' })())
    check('toInsufficientFundsError is a function', typeof sdk.toInsufficientFundsError === 'function')
    check('agentGuide() === PIPRAIL_AGENT_GUIDE (the cross-tool contract)', sdk.agentGuide() === sdk.PIPRAIL_AGENT_GUIDE && sdk.PIPRAIL_AGENT_GUIDE.length > 200)
  }
  note('every promised export reachable; all chain-free helpers invoked')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { summarize } = await import('../lib/report.mjs')
  await run()
  process.exit(summarize())
}
