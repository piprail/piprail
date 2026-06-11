import { defineConfig } from 'astro/config'
import tailwindcss from '@tailwindcss/vite'
import sitemap from '@astrojs/sitemap'

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
    plugins: [tailwindcss()],
  },
})
