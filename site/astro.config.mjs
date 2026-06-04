import { defineConfig } from 'astro/config'
import tailwindcss from '@tailwindcss/vite'
import sitemap from '@astrojs/sitemap'

// https://astro.build/config
export default defineConfig({
  site: 'https://piprail.com',
  integrations: [
    sitemap({
      // Add lastmod (build time) + per-page priority/changefreq. Bare <loc>
      // entries become richer signals; /mcp ranks alongside / as a top page.
      serialize(item) {
        const meta = {
          'https://piprail.com/': { priority: 1.0, changefreq: 'weekly' },
          'https://piprail.com/mcp/': { priority: 0.9, changefreq: 'weekly' },
          'https://piprail.com/demo/': { priority: 0.8, changefreq: 'monthly' },
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
