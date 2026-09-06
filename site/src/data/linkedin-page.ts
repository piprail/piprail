// LinkedIn company-page post registry: the single source of truth for /linkedin-page.xml.
//
// 🔴 WHY A FEED. Posting AS the PipRail page has no self-serve API: the scope
// (w_organization_social) ships only with the Community Management product, and
// LinkedIn's own review page says that product is "only available to registered
// legal organizations for commercial use cases". PipRail is not a legal entity, on
// purpose. So the page is fed through a partner LinkedIn has already vetted: a
// two-step Zapier Zap (RSS trigger -> "Create Company Update") reads this feed and
// posts each new item to the page. No password, no partnership application, and a
// post is a git commit that has passed the prose gate and the sync guard first.
//
// Each entry becomes exactly one page post. Zapier de-duplicates on <guid>, so `id`
// is permanent: changing it re-posts. Editing `text` after publish does nothing on
// LinkedIn, because the item already fired.
//
// 🔴 The company page has no "I". Every `text` is "we" or the plain third person.
// The `linkedin-page-feed` sync rule fails the build on first-person singular, on a
// missing image file, on a duplicate id, and on text over LinkedIn's 3,000 chars.
//
// The Zap cannot add a first comment (free plan is one trigger, one action), so a
// link a post needs goes in `text`, at the end. Newest entries first.

export interface PagePost {
  /** Permanent id. Zapier de-dupes on it: never reuse, never rename. */
  id: string
  /** ISO-8601 date. Becomes <pubDate>. */
  date: string
  /** Short internal title. Becomes <title> and the Zap's preview title. Not shown as the post body. */
  title: string
  /** The post itself, verbatim. Line breaks are kept. No first person singular. */
  text: string
  /** Path under site/public, so Zapier can fetch it by URL. Optional. */
  image?: string
}

export const pagePosts: PagePost[] = [
  {
    id: 'facilitator-receipts-2026-09-06',
    date: '2026-09-06',
    title: 'Every facilitator receipt, re-verified on-chain',
    image: '/linkedin/2026-09-06-facilitator-receipts.png',
    text: `Every x402 facilitator PipRail lists has been paid through on mainnet. Every one of those receipts has now been re-verified on-chain.

30 verified. 0 refuted. 0 unverifiable.

An x402 facilitator settles a payment on your behalf and sponsors the gas, so the buyer pays nothing to transact. Which ones actually work, and on which chains, is a question worth answering from evidence rather than from documentation.

PipRail's list is different in one specific way: nothing goes on it until a real payment has settled through it.

Four entries were falling short of that standard. Three recorded only a truncated transaction prefix and one recorded no hash at all. A prefix is not a proof. It cannot be opened on a block explorer and it cannot be re-checked by a machine. Rather than reconstruct them from history, each was re-proved with a fresh mainnet payment.

Every test asserts the same four things:

- A real 402, pay, verify, 200 round trip
- The merchant received exactly the amount
- The buyer paid zero gas, the facilitator sponsored it
- Replaying the same proof was rejected

The audit also found a bug of our own making. Solana receipts had never rendered as explorer links, because the page generator recognised only EVM and Algorand hash formats and base58 signatures fell through it. The hash still displayed, so nothing looked broken. It was simply dead text on an entire chain.

Nine keyless facilitators, thirteen chains, and no API key for any of them: PayAI, Dexter, xpay, Cascade, GoPlausible, Pieverse, Polygon Labs, OpenFacilitator and Ultravioleta DAO.

On all thirteen chains PipRail can also settle with no facilitator at all, verifying against your own RPC. The list exists to tell you what your options are, not to sell you one.

Every entry, and every receipt linked to its block explorer:
https://piprail.com/facilitators`,
  },
]

/** Newest first, by date then by file order. */
export const pagePostsByDate = [...pagePosts].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
