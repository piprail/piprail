/**
 * L2 · RECEIPTS — the buyer's proof that it paid.
 *
 * A receipt is what an agent keeps, shows, and reconciles against. Two failures matter and
 * they point in opposite directions:
 *
 *   · a FORGED receipt convinces a buyer it was paid when nothing settled — the merchant's
 *     word taken as fact, which is the exact thing on-chain verification exists to avoid;
 *   · a receipt that cannot be RE-VERIFIED later is worthless as a record.
 *
 * The merchant supplies the receipt header, so it is untrusted input by construction. Every
 * field a buyer acts on must be re-derived from the chain, never believed.
 */
export const meta = {
  id: 'receipts',
  layer: 'L2',
  what: 'receipt parsing, forgery, re-verification against the chain, extensions',
  why: 'a receipt a buyer trusts without checking is the merchant\'s word, not a proof',
}

const PAY_TO = '0x' + '3'.repeat(40)
const ATTACKER = '0x' + '9'.repeat(40)
const REF = (n) => '0x' + String(n).repeat(64).slice(0, 64)

export async function run({ sdk, section, check, serve }) {
  const {
    createPaymentGate, registerDriver, buildSignatureHeader, buildReceiptHeader,
    parseReceipt, parseReceiptExtension, PipRailClient,
  } = sdk

  // The pretend chain: what each ref ACTUALLY moved. Re-verification must consult THIS,
  // not whatever the merchant wrote in the header.
  const USDC = '0x' + 'a'.repeat(40)
  const LEDGER = new Map()
  const settled = (ref, payTo, amount, asset = USDC) => { LEDGER.set(ref, { payTo, amount, asset }); return ref }

  registerDriver({
    family: 'evm',
    resolve(opts) {
      const chain = opts.chain
      const id = typeof chain === 'object' ? chain.id : { base: 8453 }[chain]
      if (typeof id !== 'number') return null
      const network = `eip155:${id}`
      return {
        family: 'evm', network, supports: (n) => n === network,
        resolveToken: () => ({ asset: '0x' + 'a'.repeat(40), decimals: 6, symbol: 'USDC' }),
        describeAsset: () => ({ symbol: 'USDC', decimals: 6 }),
        assertValidPayTo: (a) => { if (!/^0x[0-9a-fA-F]{40}$/.test(String(a))) throw new sdk.WrongFamilyError('not an EVM address') },
        bindWallet: (w) => ({ _native: w }),
        send: async () => settled(REF(1), PAY_TO, '50000', USDC),
        confirm: async () => ({ height: '1' }),
        estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'heuristic' }),
        addressOf: async () => '0xself',
        balanceOf: async () => ({ token: 10n ** 12n, native: 10n ** 18n }),
        recipientReady: async () => ({ ready: 'n/a' }),
        verify: async (ref, accept) => {
          /*
           * A FAITHFUL fake checks every field a real driver checks. One that ignores `asset`
           * reports a receipt with a forged asset as perfectly valid, so an asset-forgery
           * regression would pass this section unnoticed — which it did, once.
           */
          const moved = LEDGER.get(ref)
          if (!moved) return { ok: false, error: 'tx_not_found', detail: 'no such transfer' }
          if (moved.asset !== accept.asset) return { ok: false, error: 'transfer_not_found', detail: 'no transfer of that asset' }
          if (moved.payTo !== accept.payTo) return { ok: false, error: 'wrong_recipient', detail: 'paid elsewhere' }
          if (BigInt(moved.amount) < BigInt(accept.amount)) return { ok: false, error: 'amount_too_low', detail: 'underpaid' }
          return {
            ok: true,
            receipt: { scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref,
              asset: accept.asset, amount: accept.amount, payer: '0xpayer', payTo: accept.payTo, verifiedAt: new Date().toISOString() },
          }
        },
      }
    },
  })

  const CHAIN = { id: 8453, rpcUrl: 'x' }
  const mk = (over = {}) => createPaymentGate({ chain: CHAIN, token: 'USDC', amount: '0.05', payTo: PAY_TO, ...over })
  const chal = async (g) => {
    const { challenge } = await g.challenge('https://x.test/r')
    const accept = challenge.accepts.find((a) => a.scheme === 'onchain-proof')
    return { accept, nonce: accept.extra.nonce }
  }
  const hdr = (accepted, nonce, txHash) =>
    buildSignatureHeader({ x402Version: 2, accepted, payload: { nonce, txHash } })

  // ── the gate emits one ──────────────────────────────────────────────────────
  section('receipts · a settled payment produces a readable receipt')

  let realHeader
  await check('a paid gate emits a PAYMENT-RESPONSE header', async () => {
    const g = mk(); const c = await chal(g)
    settled(REF(2), PAY_TO, '50000')
    const r = await g.verify(hdr(c.accept, c.nonce, REF(2)))
    if (r.kind !== 'paid') return { fail: `not paid: ${r.error ?? r.kind}` }
    realHeader = r.receiptHeader
    return realHeader ? `${realHeader.length} bytes` : { fail: 'no receiptHeader' }
  })

  await check('the receipt round-trips through parseReceipt', () => {
    const res = new Response('{}', { status: 200, headers: { 'payment-response': realHeader } })
    const parsed = parseReceipt(res)
    if (!parsed) return { fail: 'parseReceipt returned null on our OWN header' }
    return parsed.success === true && parsed.transaction === REF(2)
      ? `tx ${String(parsed.transaction).slice(0, 12)}…`
      : { fail: JSON.stringify(parsed).slice(0, 180) }
  })

  await check('the receipt states the SERVER-trusted payTo and amount', () => {
    const parsed = parseReceipt(new Response('{}', { status: 200, headers: { 'payment-response': realHeader } }))
    return parsed.payTo === PAY_TO && parsed.amount === '50000'
      ? 'matches the gate, not the client'
      : { fail: `payTo=${parsed.payTo} amount=${parsed.amount}` }
  })

  // ── parsing is hostile-input safe ───────────────────────────────────────────
  section('receipts · a merchant header is UNTRUSTED input')

  for (const [label, value] of [
    ['garbage', '!!!!'],
    ['empty', ''],
    ['base64 of null', Buffer.from('null').toString('base64')],
    ['base64 of an array', Buffer.from('[1,2]').toString('base64')],
    ['base64 of a number', Buffer.from('42').toString('base64')],
    ['__proto__ pollution', Buffer.from(JSON.stringify({ success: true, __proto__: { polluted: true } })).toString('base64')],
    ['a 512KB blob', Buffer.from(JSON.stringify({ success: true, transaction: 'x'.repeat(512_000) })).toString('base64')],
  ]) {
    await check(`parseReceipt survives ${label}`, () => {
      const t0 = Date.now()
      const parsed = parseReceipt(new Response('{}', { status: 200, headers: { 'payment-response': value } }))
      const ms = Date.now() - t0
      if (ms > 2000) return { fail: `${ms}ms — possible DoS` }
      // null OR a parsed object is fine; a THROW or a crash is not.
      return parsed === null ? 'null' : `parsed defensively (${typeof parsed})`
    })
  }

  await check('Object.prototype was not polluted by a hostile receipt', () =>
    ({}).polluted === undefined ? 'clean' : { fail: 'PROTOTYPE POLLUTED' })

  await check('a missing header is null, not a throw', () =>
    parseReceipt(new Response('{}', { status: 200 })) === null ? 'null' : { fail: 'invented a receipt' })

  // ── re-verification against the chain ───────────────────────────────────────
  section('receipts · a receipt is re-verified against the CHAIN, never believed',
    'PipRailClient.verifyReceipt is STATIC and wallet-free: anyone with an RPC can run it')

  const resWith = (header) => new Response('{}', { status: 200, headers: { 'payment-response': header } })

  /** A gate with `receipts: true` emits the richer PipRailReceipt the verifier consumes. */
  async function paidReceipt(ref, payToOnChain = PAY_TO, amountOnChain = '50000') {
    const g = mk({ receipts: true })
    const c = await chal(g)
    settled(ref, payToOnChain, amountOnChain)
    const r = await g.verify(hdr(c.accept, c.nonce, ref))
    if (r.kind !== 'paid') return null
    return parseReceiptExtension(resWith(r.receiptHeader))
  }

  /*
   * A PipRailReceipt is a WRAPPER: { piprail, receipt, resource, decimals }, with the X402
   * receipt nested at `.receipt`. Forging a TOP-LEVEL `transaction` changes nothing the
   * verifier reads — it cost a false "a forged tx verified" finding once, so forge the field
   * the verifier actually consults.
   */
  const forge = (rec, patch) => ({ ...rec, receipt: { ...rec.receipt, ...patch } })

  let genuine
  await check('a GENUINE receipt re-verifies as ok', async () => {
    genuine = await paidReceipt(REF(7))
    if (!genuine) return { fail: 'no PipRailReceipt from a receipts:true gate' }
    const v = await PipRailClient.verifyReceipt(genuine, { rpcUrl: 'x' })
    return v?.ok ? `ok, matchesClaims=${v.matchesClaims}` : { fail: JSON.stringify(v).slice(0, 200) }
  })

  await check('a receipt naming a tx that NEVER happened is refused', async () => {
    const v = await PipRailClient.verifyReceipt(forge(genuine, { transaction: REF('c') }), { rpcUrl: 'x' })
    return v && v.ok === false ? `refused: ${v.error}` : { fail: '🔴 a receipt for a NONEXISTENT tx verified' }
  })

  await check('a receipt claiming a payment that went ELSEWHERE is refused', async () => {
    // The money really moved — to an attacker. The receipt claims it was ours.
    const real = await paidReceipt(REF(8))
    settled(REF(8), ATTACKER, '50000')
    const v = await PipRailClient.verifyReceipt(real, { rpcUrl: 'x' })
    return v && (v.ok === false || v.matchesClaims === false)
      ? `caught: ok=${v.ok} matchesClaims=${v.matchesClaims}`
      : { fail: '🔴 a receipt claiming OUR payTo verified against a payment to an ATTACKER' }
  })

  await check('an INFLATED amount claim is refused against the chain', async () => {
    const real = await paidReceipt(REF(9))
    settled(REF(9), PAY_TO, '1') // only 1 base unit really moved
    const v = await PipRailClient.verifyReceipt(real, { rpcUrl: 'x' })
    return v && (v.ok === false || v.matchesClaims === false)
      ? `caught: ok=${v.ok} (chain says ${v.onChain?.amount})`
      : { fail: '🔴 an inflated amount verified' }
  })

  await check('a forged PAYER surfaces as matchesClaims:false', async () => {
    const real = await paidReceipt(REF('a'))
    const v = await PipRailClient.verifyReceipt(forge(real, { payer: ATTACKER }), { rpcUrl: 'x' })
    return v && v.matchesClaims === false
      ? 'matchesClaims=false, as documented'
      : { fail: `payer forgery not surfaced: ${JSON.stringify(v).slice(0, 160)}` }
  })

  await check('a forged payTo is refused (the chain says it went elsewhere)', async () => {
    const real = await paidReceipt(REF('b'))
    const v = await PipRailClient.verifyReceipt(forge(real, { payTo: ATTACKER }), { rpcUrl: 'x' })
    return v && v.ok === false
      ? `refused: ${v.error}`
      : { fail: `🔴 a receipt claiming payment to an ATTACKER verified: ${JSON.stringify(v).slice(0, 140)}` }
  })

  await check('a forged ASSET is refused', async () => {
    const real = await paidReceipt(REF('d'))
    const v = await PipRailClient.verifyReceipt(forge(real, { asset: '0x' + 'f'.repeat(40) }), { rpcUrl: 'x' })
    return v && v.ok === false ? `refused: ${v.error}` : { fail: '🔴 a forged asset verified' }
  })

  await check('verifyReceipt NEVER throws on a malformed receipt', async () => {
    for (const bad of [null, undefined, {}, { transaction: 123 }, { success: 'yes' }, [], 'nope']) {
      const v = await PipRailClient.verifyReceipt(bad, { rpcUrl: 'x' })
      if (v && v.ok === true) return { fail: `a malformed receipt verified: ${JSON.stringify(bad)}` }
    }
    return 'every malformed receipt refused, none threw'
  })

  // ── the opt-in extension ────────────────────────────────────────────────────
  section('receipts · the verifiable-receipt extension is opt-in and additive')

  await check('WITHOUT `receipts`, the header carries no extension', async () => {
    const ext = parseReceiptExtension(resWith(realHeader))
    return ext === null ? 'no extension, byte-identical to before the feature' : { fail: `ext present without opting in` }
  })

  await check('WITH `receipts`, the extension reconstructs a richer receipt', async () => {
    const g = mk({ receipts: true }); const c = await chal(g)
    settled(REF(5), PAY_TO, '50000')
    const r = await g.verify(hdr(c.accept, c.nonce, REF(5)))
    if (r.kind !== 'paid') return { fail: `not paid: ${r.error}` }
    const ext = parseReceiptExtension(resWith(r.receiptHeader))
    return ext ? `extension present: ${Object.keys(ext).slice(0, 6).join(', ')}` : { fail: 'receipts:true produced no extension' }
  })

  await check('a standard x402 reader still sees a valid SettlementResponse', async () => {
    const g = mk({ receipts: true }); const c = await chal(g)
    settled(REF(6), PAY_TO, '50000')
    const r = await g.verify(hdr(c.accept, c.nonce, REF(6)))
    const parsed = parseReceipt(new Response('{}', { status: 200, headers: { 'payment-response': r.receiptHeader } }))
    return parsed?.success === true && typeof parsed.transaction === 'string'
      ? 'the extension is additive, the base shape is intact'
      : { fail: JSON.stringify(parsed).slice(0, 160) }
  })
}
