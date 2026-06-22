// Single source of truth for the first-party framework integrations shown on the
// home page (/) and the MCP page (/mcp). Rendered by components/IntegrationCard.astro —
// edit here once and both pages update.

export interface Integration {
  name: string
  /** A 400×400 brand logo at site/public/integrations/<x>.webp */
  logo: string
  /** Small uppercase badge, e.g. "ClawHub skill", "Native MCP". */
  tag: string
  blurb: string
  /** One-line install command — rendered copyable (click-to-copy). */
  cmd?: string
  /** Docs setup guide the "Set it up" button links to. */
  href?: string
}

/** Live today — rendered as full cards (logo + badge + copyable install + CTA). */
export const liveIntegrations: Integration[] = [
  {
    name: 'OpenClaw',
    logo: '/integrations/openclaw.webp',
    tag: 'ClawHub skill',
    blurb:
      'Hand an OpenClaw agent a budget-bound wallet across every major chain. Install the ClawHub skill or add one mcp.servers entry — the eight piprail_* tools appear, capped by a spend policy.',
    cmd: 'clawhub install piprail',
    href: 'https://docs.piprail.com/integrations/openclaw/',
  },
  {
    name: 'Hermes',
    logo: '/integrations/hermes.webp',
    tag: 'Native MCP',
    blurb:
      'Hand a Hermes agent a budget-bound wallet across every major chain. One command and the eight piprail_* tools appear — no facilitator, no fee, capped by a spend policy.',
    cmd: 'hermes mcp add piprail --command npx --args -y @piprail/mcp',
    href: 'https://docs.piprail.com/integrations/hermes/',
  },
  {
    name: 'elizaOS',
    logo: '/integrations/elizaos.webp',
    tag: 'Native plugin',
    blurb:
      'Hand an elizaOS agent a budget-bound wallet across every major chain. Add one plugin and it gets six native payment actions — pay, quote, plan, discover, budget, guide — no facilitator, no fee, capped by a spend policy.',
    cmd: 'npm i @piprail/elizaos-plugin',
    href: 'https://docs.piprail.com/integrations/elizaos/',
  },
]

/** On the roadmap — rendered as compact chips on both pages. */
export const comingSoon: string[] = ['Vercel AI SDK', 'Mastra']
