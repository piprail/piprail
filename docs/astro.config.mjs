// @ts-check
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import starlightLlmsTxt from 'starlight-llms-txt'

// docs.piprail.com — the single source of truth for all PipRail documentation.
// Astro Starlight, same Astro + Tailwind v4 toolchain as the marketing site, so it
// shares the brand (emerald accent, dark-first). Deploys to GitHub Pages — served
// from the domain root, so set `site` and leave `base` unset. See
// .claude/plans/docs-site/ for the full plan.
export default defineConfig({
  site: 'https://docs.piprail.com',

  // The chain-specific "Permit2 & BNB Chain" page was consolidated into the broader
  // "Gasless payments" page — keep the old URL alive.
  redirects: {
    '/making-payments/permit2-and-bnb/': '/making-payments/gasless-payments/',
  },

  integrations: [
    starlight({
      title: 'PipRail',
      description:
        'The complete documentation for @piprail/sdk and @piprail/mcp — x402 crypto payments for AI agents on any chain. No backend, no fee, settled straight to your wallet.',
      logo: { src: './src/assets/logo.png', alt: 'PipRail' },
      favicon: '/favicon-32.png',

      // The PipRail brand applied on top of Starlight (emerald accent, dark-first,
      // Inter + JetBrains Mono, the signature glow). See src/styles/global.css.
      customCss: ['./src/styles/global.css'],

      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/piprail/piprail' },
        { icon: 'x.com', label: 'X', href: 'https://x.com/piprailhq' },
      ],

      // Default to dark — PipRail is a dark-first brand.
      // (Readers can still toggle to light; we theme both.)
      head: [
        // Brand fonts — match the marketing site exactly.
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
        {
          tag: 'link',
          attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap',
          },
        },
        // Default social card for pages that don't set their own.
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://docs.piprail.com/og.png' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: 'https://docs.piprail.com/og.png' } },
      ],

      editLink: {
        baseUrl: 'https://github.com/piprail/piprail/edit/main/docs/',
      },

      lastUpdated: true,

      // The agent-payable docs: emit /llms.txt + /llms-full.txt at build time so any
      // LLM can read the whole manual in one fetch. On-brand for an agent-payments SDK.
      plugins: [
        starlightLlmsTxt({
          projectName: 'PipRail',
          description:
            'TypeScript SDK + MCP server for x402 crypto payments across every major chain. No backend, no fee — payments settle straight to your wallet, verified locally against your own RPC.',
        }),
      ],

      // Laravel-style IA — a learning gradient, one level of nesting. Groups grow as
      // pages land; ordering inside a group is controlled by each page's
      // `sidebar.order` frontmatter. See .claude/plans/docs-site/03-information-architecture.md.
      sidebar: [
        { label: 'Getting Started', items: [{ autogenerate: { directory: 'getting-started' } }] },
        { label: 'Core Concepts', items: [{ autogenerate: { directory: 'concepts' } }] },
        { label: 'Accepting Payments', items: [{ autogenerate: { directory: 'accepting-payments' } }] },
        { label: 'Making Payments', items: [{ autogenerate: { directory: 'making-payments' } }] },
        { label: 'Spend Controls', items: [{ autogenerate: { directory: 'spend-controls' } }] },
        { label: 'Agent Toolkit', items: [{ autogenerate: { directory: 'agent-toolkit' } }] },
        { label: 'Discovery', items: [{ autogenerate: { directory: 'discovery' } }] },
        { label: 'Chains', collapsed: true, items: [{ autogenerate: { directory: 'chains' } }] },
        { label: 'Errors', items: [{ autogenerate: { directory: 'errors' } }] },
        { label: 'MCP Server', items: [{ autogenerate: { directory: 'mcp' } }] },
        { label: 'Integrations', items: [{ autogenerate: { directory: 'integrations' } }] },
        { label: 'Testing', items: [{ autogenerate: { directory: 'testing' } }] },
        { label: 'Reference', collapsed: true, items: [{ autogenerate: { directory: 'reference' } }] },
      ],
    }),
  ],
})
