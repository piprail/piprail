// A tiny HTTP 402 server that mounts a PipRail PaymentGate — the same shape every merchant
// uses. `onVerify` lets a suite swap the verification seam (e.g. route a payment THROUGH the
// A2A handler instead of gate.verify) while keeping the standard challenge/response wiring.
import { createServer } from 'node:http'
import { HEADER_SIGNATURE, HEADER_REQUIRED, HEADER_RESPONSE } from '@piprail/sdk'

export function serveGate(gate, { port, path = '/m', body = { ok: true }, onVerify } = {}) {
  let lastSig = null
  let lastResp = null
  const server = createServer(async (req, res) => {
    try {
      const sig = req.headers[HEADER_SIGNATURE] ?? req.headers['payment-signature']
      if (!sig) {
        const c = await gate.challenge(`http://127.0.0.1:${port}${req.url}`)
        res.setHeader(HEADER_REQUIRED, c.requiredHeader)
        res.writeHead(402, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(c.challenge))
      }
      lastSig = sig
      const r = onVerify ? await onVerify(sig) : await gate.verify(sig)
      if (r.kind === 'paid') {
        lastResp = r.receiptHeader
        if (r.receiptHeader) res.setHeader(HEADER_RESPONSE, r.receiptHeader)
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(typeof body === 'function' ? body(r) : body))
      }
      // re-challenge / rejection
      if (r.requiredHeader) res.setHeader(HEADER_REQUIRED, r.requiredHeader)
      res.writeHead(r.statusCode ?? 402, { 'content-type': 'application/json' })
      res.end(JSON.stringify(r.challenge ?? { error: r.error ?? 'rejected' }))
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String(err?.message ?? err) }))
    }
  })
  return {
    server,
    url: `http://127.0.0.1:${port}${path}`,
    listen: () => new Promise((r) => server.listen(port, '127.0.0.1', r)),
    close: () => server.close(),
    lastSig: () => lastSig,
    lastResp: () => lastResp,
  }
}
