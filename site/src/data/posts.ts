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
    seoTitle:
      "MPP vs. x402: Stripe's Machine Payments Protocol vs. the open agent-payment rail",
    description:
      "Stripe's Machine Payments Protocol and x402 both revive HTTP 402 to let agents pay per call. They split on one thing: who holds the money. An honest comparison.",
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
