/**
 * ── THE TWO ADDRESSES ───────────────────────────────────────────────────────────────
 *
 * PipRail uses two email addresses on purpose, and mixing them up is a real cost in
 * both directions. This module is the ONE place that decides which is which.
 * Everything else imports from here; nothing else hardcodes an address.
 *
 * Rule (John, 2026-08-30):
 *
 *   BUSINESS  john@piprail.com          front-facing. Anything a stranger, partner,
 *                                       grant reviewer, researcher or security
 *                                       reporter is invited to write to.
 *
 *   INFRA     <personal webmail>        the identity that OWNS the technical
 *                                       accounts: GitHub, Netlify, npm, Google
 *                                       (GSC/GA4 OAuth), and git commit authorship.
 *                                       Not written out here — see PERSONAL_MAIL_HOSTS.
 *
 * \U0001f534 WHY THE SPLIT MATTERS BOTH WAYS.
 *
 *   Publishing INFRA on the site leaks a personal address onto a page built to be
 *   crawled, and it makes a project with a domain of its own look like a hobby.
 *   On 2026-08-30 piprail.com/partners/ was still serving one live.
 *
 *   Putting BUSINESS on an account is worse: john@piprail.com is a mailbox that has
 *   existed since 2026-08-29, on a domain registered in 2026. Moving an npm or
 *   GitHub account onto it would tie account recovery to the newest, least-proven
 *   thing we own. Account identity stays on the durable address.
 *
 * So: **an account login is INFRA. An invitation to make contact is BUSINESS.**
 * When something is genuinely both (the GitHub org's public profile email is a
 * contact field on an account), it is INFRA — because that is the answer that is
 * never wrong about account ownership.
 */

/** Front-facing contact. Safe to publish. Use in anything a stranger reads. */
export const BUSINESS_CONTACT = 'john@piprail.com'

/**
 * Account-owner identity. NEVER publish on a site, docs page or marketing surface.
 *
 * 🔴 DELIBERATELY NOT WRITTEN OUT HERE. This file is tracked in a PUBLIC repo, so
 * hardcoding the personal address would republish it — the exact thing this module
 * exists to prevent. It is already discoverable from git commit authorship; that is
 * not a reason to add another copy on a page people read.
 *
 * The guard therefore tests for the CLASS rather than the literal: any free-webmail
 * address on a front-facing surface is wrong, whoever it belongs to. That also
 * catches a different personal address added later, which a literal never would.
 */
export const PERSONAL_MAIL_HOSTS = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com',
  'yahoo.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com',
]

/** Matches any address at a free-webmail host. Used by the sync guard. */
export const personalAddressRe = () =>
  new RegExp(String.raw`[A-Za-z0-9._%+-]+@(?:${PERSONAL_MAIL_HOSTS.map((h) => h.replace('.', String.raw`\.`)).join('|')})\b`, 'i')

/**
 * Surfaces a stranger reads. Each MUST use BUSINESS_CONTACT and MUST NOT contain
 * INFRA_IDENTITY. The `contact-addresses-split` sync rule enforces exactly this.
 *
 * `requires` = the file is expected to publish a contact address at all.
 */
export const FRONT_FACING = [
  { file: 'site/src/pages/partners.astro', requires: true, note: 'the partnership contact CTA' },
  { file: '.github/SECURITY.md', requires: true, note: 'where a vulnerability report is sent' },
  { file: '.github/CODE_OF_CONDUCT.md', requires: true, note: 'where a conduct report is sent' },
  { file: 'CITATION.cff', requires: true, note: 'citation metadata — read by researchers and Zenodo' },
  { file: 'README.md', requires: false, note: 'no address today; must not gain the personal one' },
  { file: 'site/public/llms.txt', requires: false, note: 'served to AI crawlers' },
  { file: 'site/public/llms-full.txt', requires: false, note: 'served to AI crawlers' },
]

/**
 * Places INFRA_IDENTITY is CORRECT and must not be "fixed" to the business address.
 * Listed so the next person does not helpfully break account recovery.
 */
export const INFRA_SURFACES = [
  'git commit authorship (user.email)',
  'the GitHub account John-Weeks-Dev and the piprail org profile email',
  'the Netlify account that owns the piprail site + DNS zone',
  'the npm account that publishes @piprail/sdk and @piprail/mcp',
  'the Google account behind GSC + GA4 OAuth (~/.config/gcp/*-oauth.json)',
  'the outreach mailer\'s OUR_ADDRESSES allowlist — it lists BOTH, on purpose',
  '(that allowlist is in a gitignored skill, so the literal lives there, not here)',
]
