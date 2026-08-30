// Blog post registry — the single source of truth for /blog.
//
// Each post's PROSE lives in its own .astro file under src/pages/blog/ (so the
// bespoke figures stay first-class), while everything an index card, the JSON-LD,
// the sitemap, and the "more writing" rail need lives here. One list, no drift.

export interface Author {
  name: string
  role: string
  /** Canonical URL for the author entity (used in author structured data). */
  url: string
}

export interface Post {
  /** URL slug — the page lives at /blog/<slug>. */
  slug: string
  /** Card + <h1> title. */
  title: string
  /** <title> tag override when a longer, keyword-front-loaded form reads better in SERPs. */
  seoTitle?: string
  /** Meta description + card excerpt + OG description. ~150–160 chars. */
  description: string
  /** One-line hook shown on the index card (can be richer than the meta description). */
  excerpt: string
  author: Author
  /** ISO-8601 dates. `updated` defaults to `published` when unset. */
  published: string
  updated?: string
  /** Reading time in minutes (whole number). */
  readingTime: number
  /** Topic/category — drives the eyebrow + article:section. */
  category: string
  /** Keyword tags — article:tag + the post's `keywords` meta. */
  tags: string[]
  /** Per-post social card under /public. */
  ogImage: string
}

export const authors = {
  john: {
    name: 'John Weeks',
    role: 'Founder, PipRail',
    // The author's real, crawlable personal presence — a stronger E-E-A-T / author-entity
    // signal than the brand account or the /blog list page (a weak self-referential one).
    url: 'https://x.com/johnweeksdev',
  },
  tim: {
    name: 'Tim Roelofs',
    role: 'Cofounder, PipRail',
    // Tim's preferred public contact / author presence is his Telegram.
    url: 'https://t.me/tmroel90',
  },
} satisfies Record<string, Author>

// The published feed. Newest entries go first in the file; `postsByDate` sorts by date.
export const posts: Post[] = [
  {
    slug: 'give-your-agent-a-wallet',
    title: 'Give Your AI Agent a Wallet It Can’t Overspend',
    seoTitle:
      'Add x402 payments to an AI agent — the PipRail SDK, MCP server, and spend policy',
    description:
      'Give an AI agent a budget-bound wallet that pays x402 URLs by itself, capped per call and for life. The SDK, the MCP server, and the spend policy.',
    excerpt:
      'An agent can read any API until one asks for money. PipRail hands it a wallet with a hard spend cap it can’t cross — pay an x402 URL, or charge for your own, in a few lines of TypeScript.',
    author: authors.john,
    published: '2026-06-22',
    readingTime: 8,
    category: 'Guide',
    tags: [
      'x402',
      'AI agents',
      'agent payments',
      'MCP',
      'spend policy',
      'elizaOS',
      'TypeScript SDK',
      'self-custody',
      'crypto payments',
    ],
    ogImage: '/blog/give-your-agent-a-wallet.png',
  },
  {
    slug: 'x402-chains',
    title: 'Every Chain PipRail Supports for x402 Payments',
    seoTitle:
      'x402 supported chains: every network PipRail pays on — 29 chains, one parameter',
    description:
      'One chain: parameter, 29 chains — every major EVM network plus Solana, TON, Tron, NEAR, Sui, Aptos, Algorand, Stellar and XRPL, and the tokens on each.',
    excerpt:
      'Name a chain, get paid. PipRail covers 29 chains across ten families from a single parameter — here’s every network it supports, the tokens on each, and how it pays without an allowlist.',
    author: authors.john,
    published: '2026-06-22',
    readingTime: 7,
    category: 'Guide',
    tags: [
      'x402',
      'multi-chain',
      'USDC',
      'stablecoins',
      'Solana',
      'EVM',
      'agent payments',
      'crypto payments',
      'self-custody',
    ],
    ogImage: '/blog/x402-chains.png',
  },
  {
    slug: 'backendless-x402',
    title: 'No Facilitator, No Custody, No Fee: How Backendless x402 Works',
    seoTitle: 'Backendless x402: merchant-local verification, no facilitator, no fee',
    description:
      'Most x402 setups route through a facilitator that takes custody and a cut. PipRail verifies locally against your own RPC — no backend, no middleman.',
    excerpt:
      'Most x402 implementations put a facilitator in the middle — a custodian, a toll booth, a single point of failure. PipRail removes it: the merchant verifies the payment itself, locally. Here’s the architecture that makes backendless possible.',
    author: authors.tim,
    published: '2026-06-22',
    readingTime: 8,
    category: 'Architecture',
    tags: [
      'x402',
      'self-custody',
      'agent payments',
      'decentralization',
      'open-source',
      'payment verification',
      'AI agents',
      'crypto payments',
    ],
    ogImage: '/blog/backendless-x402.png',
  },
  {
    slug: 'the-agent-economy-needs-an-open-rail',
    title: 'The Agent Economy Needs an Open Rail',
    seoTitle: 'The Agent Economy Needs an Open Rail — why agent payments must be open',
    description:
      'Every network that scaled ran on open protocols, not private ones. The agent economy is no different — and its payment rail just got opened up.',
    excerpt:
      'Every network that became an economy ran on open protocols — HTTP, SMTP, TCP/IP — never one company’s walled garden. The agent economy is at the same fork, and its payment rail just got opened up.',
    author: authors.tim,
    published: '2026-06-18',
    readingTime: 6,
    category: 'Perspective',
    tags: [
      'x402',
      'agent economy',
      'open protocols',
      'agent payments',
      'self-custody',
      'multi-chain',
      'AI agents',
      'crypto payments',
      'trust layer',
    ],
    ogImage: '/blog/the-agent-economy-needs-an-open-rail.png',
  },
  {
    slug: 'mpp-vs-x402',
    title: 'MPP vs. x402: Two Ways to Pay an Agent',
    // SERP title is the BUYER's question, not our framing. Measured 2026-08-30: for the
    // query "x402 vs MPP" this page ranked ~75 while Alchemy, WorkOS, Crossmint, Openfort
    // and Zinc took the answer — every one of them titled as a choose-between decision.
    // The old title named the two protocols and asked nothing.
    seoTitle: 'x402 vs MPP: Which Agent Payment Protocol Should You Use?',
    description:
      "Stripe's MPP or the open x402 rail? Both revive HTTP 402 so agents pay per call, and they split on one thing: who holds the money. Fees, custody, chains, and when to pick each.",
    excerpt:
      'Stripe’s MPP and the open x402 rail both answer “Payment Required” for AI agents. They agree on the mechanism and disagree on everything that follows from custody. A fair, side-by-side look.',
    author: authors.john,
    published: '2026-06-18',
    readingTime: 11,
    category: 'Comparison',
    tags: [
      'x402',
      'Machine Payments Protocol',
      'MPP',
      'Stripe',
      'Tempo',
      'agentic commerce',
      'agent payments',
      'stablecoins',
      'self-custody',
      'AI agents',
    ],
    ogImage: '/blog/mpp-vs-x402.png',
  },
]

/** Drafts held back from /blog — kept so the metadata isn't lost. Not rendered anywhere. */
export const parkedPosts: Post[] = []

/** Newest first — the order the index renders in. */
export const postsByDate = [...posts].sort((a, b) => b.published.localeCompare(a.published))

export const getPost = (slug: string): Post | undefined => posts.find((p) => p.slug === slug)

/** Up to `n` other posts, newest first — for the "more writing" rail on a post. */
export const relatedPosts = (slug: string, n = 2): Post[] =>
  postsByDate.filter((p) => p.slug !== slug).slice(0, n)

/** Human date, e.g. "June 17, 2026". Built from the ISO string with no Date math. */
export function formatDate(iso: string): string {
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ]
  const [y, m, d] = iso.split('-').map(Number)
  return `${months[m - 1]} ${d}, ${y}`
}
