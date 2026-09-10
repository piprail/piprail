import { defineConfig } from 'astro/config'
import tailwindcss from '@tailwindcss/vite'
import sitemap from '@astrojs/sitemap'

/**
 * Serve the x402 index forwarder during `astro dev`.
 *
 * In production this route is a Netlify Function (site/netlify/functions/x402-index.mjs),
 * and the dev server does not run those. Without this, `npm run dev` answers 404 on
 * INDEX_PROXY_PATH, the SDK on /demo concludes no forwarder exists, and the lab's discovery
 * test degrades to empty. Everything looks broken while being deployed correctly, which is
 * the worst kind of difference between dev and prod.
 *
 * The handler is the SAME one the function mounts, imported from the SDK, so dev and prod
 * cannot drift. Dev only: `apply: 'serve'` keeps it out of every build.
 */
function x402IndexDevRoute() {
  // Imported LAZILY, inside configureServer, and never at config load time. The handler lives
  // in the SDK's BUILT dist, and the site build does not build the SDK first: a top-level
  // import here fails CI with "Unable to load your Astro config" on a clean checkout, while
  // passing locally for the only reason that a dist happens to be lying around.
  let handlePromise
  const getHandler = () => {
    handlePromise ??= import('@piprail/sdk')
      .then((m) => ({ handle: m.indexProxyHandler(), path: m.INDEX_PROXY_PATH }))
      .catch(() => null)
    return handlePromise
  }
  return {
    name: 'piprail:x402-index-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith('/api/x402-index')) return next()
        const mod = await getHandler()
        if (!mod) {
          res.statusCode = 503
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({
            error: 'sdk_not_built',
            detail: 'Run `npm run build:sdk` so the dev server can serve the x402 index forwarder.',
          }))
          return
        }
        try {
          const response = await mod.handle(
            new Request(`http://localhost${req.url}`, { method: req.method ?? 'GET' })
          )
          res.statusCode = response.status
          response.headers.forEach((value, key) => res.setHeader(key, value))
          res.end(Buffer.from(await response.arrayBuffer()))
        } catch (err) {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: 'dev_proxy_failed', detail: String(err?.message ?? err) }))
        }
      })
    },
  }
}

// https://astro.build/config
export default defineConfig({
  site: 'https://piprail.com',
  integrations: [
    sitemap({
      // Add lastmod (build time) + per-page priority/changefreq. Bare <loc>
      // entries become richer signals; /sdk + /mcp rank alongside / as top pages.
      serialize(item) {
        const meta = {
          'https://piprail.com/': { priority: 1.0, changefreq: 'weekly' },
          'https://piprail.com/sdk/': { priority: 0.9, changefreq: 'weekly' },
          'https://piprail.com/mcp/': { priority: 0.9, changefreq: 'weekly' },
          'https://piprail.com/chains/': { priority: 0.8, changefreq: 'weekly' },
          'https://piprail.com/blog/': { priority: 0.7, changefreq: 'weekly' },
          'https://piprail.com/discovery/': { priority: 0.7, changefreq: 'weekly' },
          'https://piprail.com/demo/': { priority: 0.7, changefreq: 'monthly' },
          'https://piprail.com/partners/': { priority: 0.5, changefreq: 'monthly' },
        }
        item.lastmod = new Date().toISOString()
        const o = meta[item.url]
        if (o) {
          item.priority = o.priority
          item.changefreq = o.changefreq
        }
        return item
      },
    }),
  ],
  vite: {
    plugins: [tailwindcss(), x402IndexDevRoute()],
  },
})
