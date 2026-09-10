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

import { indexProxyHandler, INDEX_PROXY_PATH } from '@piprail/sdk'

export default indexProxyHandler()

export const config = { path: INDEX_PROXY_PATH }
