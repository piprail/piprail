// Minimal local facilitator STUB so the merchant runs keyless and offline.
//
// In production you point FACILITATOR_URL at a real facilitator that verifies
// and settles Nano (e.g. the x402nano/exact facilitator, or your own). This stub
// serves ONLY the /supported handshake needed for a merchant to start and return
// 402 challenges; it does NOT verify or settle real payments. It exists so a
// reviewer can see the multi-rail merchant working without a live Nano network.
//
// Endpoints the x402 generic client/scheme may probe, stubbed:
//   GET  /supported   -> declares exact on nano:mainnet (needed for initialize)
//
// The merchant starts this automatically on an ephemeral port when FACILITATOR_URL
// is unset. Set FACILITATOR_URL to your real facilitator to build actual challenges.

import http from 'node:http'

export function startStubFacilitator({ port = 0, nanoNetwork = 'nano:mainnet', scheme = 'exact' } = {}) {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/supported' && req.method === 'GET') {
      res.end(JSON.stringify({
        kinds: [
          { x402Version: 2, scheme, network: nanoNetwork },
        ],
        extensions: [],
        signers: {},
      }))
      return
    }
    // Anything else: a real facilitator path this example doesn't exercise offline.
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'stub facilitator does not implement this path' }))
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => server.close() })
    })
  })
}
