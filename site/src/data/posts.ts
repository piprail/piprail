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
  tim: {
    name: 'Tim Roelofs',
    role: 'Cofounder, PipRail',
    // A real, crawlable author presence (the project's public account the cofounder
    // posts from) — not the /blog list page, which is a weak self-referential author signal.
    url: 'https://x.com/piprailhq',
  },
} satisfies Record<string, Author>

export const posts: Post[] = [
  {
    slug: 'an-agents-receipts-are-its-credit-score',
    title: "An Agent's Receipts Are Its Credit Score",
    seoTitle: "An Agent's Receipts Are Its Credit Score — the trust layer for the agent economy",
    description:
      'Identity tells you who an agent is; a track record tells you whether to trust it. A settled x402 payment is the one trust signal as costly to fake as to earn.',
    excerpt:
      'Intelligence is no longer the bottleneck in the agent economy — trust is. And the one signal that can’t be gamed is hiding in plain sight: a settled payment.',
    author: authors.tim,
    published: '2026-06-17',
    updated: '2026-06-17',
    readingTime: 6,
    category: 'Research',
    tags: [
      'agent economy',
      'x402',
      'agent reputation',
      'Know Your Agent',
      'ERC-8004',
      'agentic commerce',
      'trust layer',
      'AI agents',
      'crypto payments',
    ],
    ogImage: '/blog/an-agents-receipts-are-its-credit-score.png',
  },
]

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
