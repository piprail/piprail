/**
 * L4 · PAYMENTS — real money, on mainnet, across both proof templates.
 *
 * The only layer that proves a chain actually works. Tiny amounts, from the gitignored test
 * wallets. For each family: a fresh 402, a real settlement, a 200 with a receipt, and a REPLAY
 * of that same proof which must be refused.
 *
 * Template A families additionally get the check that cannot be run offline at all: a genuine,
 * already-settled transaction re-presented against a DIFFERENT challenge must be refused,
 * because the nonce is committed inside the signed transaction.
 */
export const meta = {
  id: 'payments',
  layer: 'L4',
  what: 'pay → 200 → receipt → replay refused, per family, on mainnet',
  why: 'unit tests are the contract; this is the proof against the actual network',
  network: true,
  wallets: true,
  spends: true,
}

// family, chain, token, amount, proof template. Keep amounts at the dust level.
export const MATRIX = [
  // ── Template A (memo/nonce-bound): the nonce is committed INSIDE the signed tx ──────
  { fam: 'algorand', chain: 'algorand', token: 'USDC', amount: '0.01', template: 'A' },
  { fam: 'algorand', chain: 'algorand', token: 'native', amount: '0.01', template: 'A' },
  { fam: 'near', chain: 'near', token: 'USDC', amount: '0.01', template: 'A' },
  { fam: 'near', chain: 'near', token: 'USDT', amount: '0.01', template: 'A' },
  { fam: 'stellar', chain: 'stellar', token: 'native', amount: '0.1', template: 'A' },
  { fam: 'xrpl', chain: 'xrpl', token: 'native', amount: '0.1', template: 'A' },
  { fam: 'ton', chain: 'ton', token: 'native', amount: '0.01', template: 'A' },

  // ── Template B (digest-bound): the proof IS the tx hash ─────────────────────────────
  { fam: 'solana', chain: 'solana', token: 'USDC', amount: '0.01', template: 'B' },
  { fam: 'solana', chain: 'solana', token: 'native', amount: '0.0005', template: 'B' },
  { fam: 'sui', chain: 'sui', token: 'USDC', amount: '0.01', template: 'B' },
  { fam: 'aptos', chain: 'aptos', token: 'USDC', amount: '0.01', template: 'B' },
  { fam: 'aptos', chain: 'aptos', token: 'USDT', amount: '0.01', template: 'B' },
  { fam: 'tron', chain: 'tron', token: 'native', amount: '0.5', template: 'B' },

  // ── EVM, across several chains and a token that is NOT USDC ─────────────────────────
  { fam: 'evm', chain: 'bnb', token: 'USDC', amount: '0.01', template: 'B' },
  { fam: 'evm', chain: 'bnb', token: 'USD1', amount: '0.01', template: 'B' },
  { fam: 'evm', chain: 'monad', token: 'USDC', amount: '0.01', template: 'B' },
  { fam: 'evm', chain: 'hyperevm', token: 'USDC', amount: '0.01', template: 'B' },
  // Robinhood ships USDG and no native USDC at all — the chain that catches a hardcoded 'USDC'.
  { fam: 'evm', chain: 'robinhood', token: 'USDG', amount: '0.01', template: 'B' },
]

const PAYER = {
  evm: (w) => ({ key: w.privateKey }),
  solana: (w) => ({ key: w.secretKey }),
  near: (w) => ({ accountId: w.accountId, key: w.privateKey }),
  sui: (w) => ({ key: w.privateKey }),
  aptos: (w) => ({ key: w.privateKey }),
  algorand: (w) => ({ key: w.mnemonic }),
  stellar: (w) => ({ key: w.secret }),
  xrpl: (w) => ({ key: w.seed }),
  ton: (w) => ({ key: w.mnemonic }),
  tron: (w) => ({ key: w.privateKey }),
}
const MERCHANT = {
  evm: (w) => w.merchantAddress,
  aptos: (w) => w.merchantAddress,
  algorand: (w) => w.merchantAddress,
  near: (w) => w.merchant.accountId,
  solana: (w) => w.merchant.address,
  sui: (w) => w.merchant.address,
  stellar: (w) => w.merchant.address,
  xrpl: (w) => w.merchant.address,
  ton: (w) => w.merchant.address,
  tron: (w) => w.merchant.address,
}

export async function run({ sdk, section, check, warn, serve, wallet, REPO, env, only }) {
  const { createPaymentGate, PipRailClient, buildSignatureHeader, decodeBase64Json } = sdk

  for (const spec of MATRIX) {
    if (only.length && !only.includes(spec.fam) && !only.includes(spec.chain)) continue
    // Several rows share a family now, so label by chain AND token.
    const label = `${spec.chain}/${spec.token}`
    section(`payments · ${label}`, `Template ${spec.template} · real mainnet payment of ${spec.amount}`)

    let w, payTo
    try {
      w = wallet(spec.fam, REPO)
      payTo = MERCHANT[spec.fam](w)
    } catch (e) {
      await check(`${label}: load wallet`, () => ({ fail: e.message }))
      continue
    }

    const rpcUrl = env[`RPC_${spec.chain.toUpperCase()}`] || undefined
    const gateOpts = { chain: spec.chain, token: spec.token, amount: spec.amount, payTo, ...(rpcUrl ? { rpcUrl } : {}) }

    let gate, srv, client, lastProof = null
    try {
      gate = createPaymentGate(gateOpts)
      srv = await serve(async (req) => {
        const sig = req.headers.get('payment-signature')
        if (sig) lastProof = sig
        const r = await gate.verify(sig ?? undefined)
        if (r.kind === 'paid') {
          return new Response(JSON.stringify({ ok: true, receipt: r.receipt }), {
            status: 200, headers: { 'content-type': 'application/json', 'payment-response': r.receiptHeader },
          })
        }
        return new Response(JSON.stringify(r.challenge), {
          status: 402, headers: { 'content-type': 'application/json', 'payment-required': r.requiredHeader },
        })
      })
      client = new PipRailClient({ chain: spec.chain, wallet: PAYER[spec.fam](w), ...(rpcUrl ? { rpcUrl } : {}) })
    } catch (e) {
      await check(`${label}: set up`, () => ({ fail: `${e.constructor.name}: ${e.message}` }))
      if (srv) await srv.close()
      continue
    }

    try {
      /*
       * 🔴 UNFUNDED IS NOT BROKEN.
       *
       * planPayment is the read-only guardrail that answers "can I settle this?" before a
       * signature exists. When it says no because the wallet is empty, attempting the payment
       * anyway proves nothing and burns gas failing. A red L4 is far more often an empty
       * wallet than a broken chain, and reporting the two identically is how a real outage
       * gets lost in the noise. So: an empty wallet SKIPS the row, loudly; anything else the
       * plan objects to is a genuine failure.
       */
      let plan = null
      await check('planPayment answers before any spend', async () => {
        plan = await client.planPayment(srv.url)
        if (!plan) return { fail: 'planPayment returned null' }
        return plan.payable ? `payable (${plan.status})` : `NOT payable: ${plan.fundingHint ?? 'no hint'}`
      })

      if (plan && !plan.payable) {
        const blockers = (plan.options ?? []).flatMap((o) => o.blockers ?? []).join(', ')
        const funding = /INSUFFICIENT|top up|fund/i.test(`${blockers} ${plan.fundingHint ?? ''}`)
        if (funding) {
          warn(`${label}: SKIPPED, wallet needs funding`, plan.fundingHint ?? blockers)
          continue
        }
        await check(`${label}: not payable for a NON-funding reason`, () => ({ fail: `${blockers} — ${plan.fundingHint ?? ''}` }))
        continue
      }

      await check('estimateCost returns a gas figure in the native coin', async () => {
        const c = await client.estimateCost(srv.url)
        return c ? `${c.cost?.feeFormatted} ${c.cost?.feeSymbol} (${c.cost?.basis})` : { fail: 'null' }
      })

      await check('💸 REAL PAYMENT → 200 with a receipt', async () => {
        const res = await client.fetch(srv.url)
        if (res.status !== 200) return { fail: `status ${res.status}: ${(await res.text()).slice(0, 180)}` }
        const body = await res.json()
        const tx = body?.receipt?.transaction
        if (!tx) return { fail: 'no receipt.transaction' }
        if (body.receipt.payTo !== payTo) return { fail: `receipt payTo ${body.receipt.payTo} !== ${payTo}` }
        return `settled ${String(tx).slice(0, 24)}…`
      })

      await check('the same proof is REFUSED on replay', async () => {
        if (!lastProof) return { fail: 'no proof captured' }
        const r = await gate.verify(lastProof)
        return r.kind !== 'paid' ? `refused: ${r.error ?? r.kind}` : { fail: 'REPLAY ACCEPTED' }
      })

      if (spec.template === 'A') {
        await check('🔑 Template A: a settled tx cannot answer a DIFFERENT challenge', async () => {
          const ref = decodeBase64Json(lastProof)?.payload?.txHash
          // A FRESH gate has a fresh replay set, so only the memo binding can refuse this.
          const g2 = createPaymentGate(gateOpts)
          const { challenge } = await g2.challenge(srv.url)
          const accept = challenge.accepts.find((a) => a.scheme === 'onchain-proof')
          const forged = buildSignatureHeader({
            x402Version: 2, accepted: accept, payload: { nonce: accept.extra.nonce, txHash: ref },
          })
          const r = await g2.verify(forged)
          return r.kind !== 'paid'
            ? `refused: ${r.error} (the nonce is committed on-chain)`
            : { fail: 'a tx that paid another challenge satisfied this one' }
        })
      }
    } finally {
      if (srv) await srv.close()
    }
  }
}
