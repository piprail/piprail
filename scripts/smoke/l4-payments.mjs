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
  { fam: 'algorand', chain: 'algorand', token: 'USDC', amount: '0.01', template: 'A' },
  { fam: 'near', chain: 'near', token: 'USDC', amount: '0.01', template: 'A' },
  { fam: 'stellar', chain: 'stellar', token: 'native', amount: '0.1', template: 'A' },
  { fam: 'solana', chain: 'solana', token: 'USDC', amount: '0.01', template: 'B' },
  { fam: 'sui', chain: 'sui', token: 'USDC', amount: '0.01', template: 'B' },
  { fam: 'evm', chain: 'bnb', token: 'USDC', amount: '0.01', template: 'B' },
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

export async function run({ sdk, section, check, serve, wallet, REPO, env, only }) {
  const { createPaymentGate, PipRailClient, buildSignatureHeader, decodeBase64Json } = sdk

  for (const spec of MATRIX) {
    if (only.length && !only.includes(spec.fam) && !only.includes(spec.chain)) continue
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
      await check('planPayment says payable BEFORE any spend', async () => {
        const p = await client.planPayment(srv.url)
        if (!p) return { fail: 'planPayment returned null' }
        return p.payable ? `payable (${p.status})` : { fail: `NOT payable: ${p.fundingHint ?? 'no hint'}` }
      })

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
