// The read-only forwarder that lets the SDK lab on /demo run `client.discover()` in a
// browser, exactly as it runs in Node.
//
// It is one line, because the handler ships IN @piprail/sdk. That is the point: the open
// indexes send no usable CORS header, CORS is enforced by the browser, and rather than make
// every caller solve that, the SDK carries its own forwarder and the browser client finds it
// on its own at INDEX_PROXY_PATH. Nothing here is PipRail-hosted infrastructure the SDK
// depends on: this site mounts the handler the same way any other app would.
//
// Server-side callers need none of this. Node, an MCP server or a worker reads the indexes
// directly with zero configuration, and always has.

import { indexProxyHandler } from '@piprail/sdk'

export default indexProxyHandler()

// 🔴 The path MUST be a literal. Netlify parses `export const config` STATICALLY at deploy
// time, so an imported constant is not resolved and the route silently never registers: the
// path 404s, the SDK concludes no forwarder exists, and discovery degrades to empty with
// nothing anywhere saying why. It has to match the SDK's INDEX_PROXY_PATH, which
// `x402-index-path` in sdk/test/discovery-pagination.test.ts pins by reading this file.
export const config = { path: '/api/x402-index' }
