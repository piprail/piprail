// /linkedin-page.xml: the RSS feed a Zapier Zap reads to post AS the PipRail company page.
//
// See src/data/linkedin-page.ts for why this exists. Hand-rolled RSS 2.0 rather than
// @astrojs/rss: it is thirty lines, adds no dependency, and the one consumer is a
// single Zap whose field mapping is documented in the linkedin-page skill (ZAPIER.md).
//
// 🔴 <guid isPermaLink="false"> is the de-dupe key on the Zapier side. It is the entry's
// `id`, never a URL, so a site move cannot re-fire every post.
import type { APIRoute } from 'astro'
import { pagePostsByDate } from '../data/linkedin-page'

const SITE = 'https://piprail.com'

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/* Inside CDATA the only thing that must not appear is the terminator itself. */
const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`

const rfc822 = (iso: string) => new Date(`${iso}T09:00:00Z`).toUTCString()

export const GET: APIRoute = () => {
  const items = pagePostsByDate
    .map((p) => {
      const image = p.image ? `${SITE}${p.image}` : null
      return [
        '    <item>',
        `      <title>${esc(p.title)}</title>`,
        `      <link>${SITE}/</link>`,
        `      <guid isPermaLink="false">${esc(p.id)}</guid>`,
        `      <pubDate>${rfc822(p.date)}</pubDate>`,
        `      <description>${cdata(p.text)}</description>`,
        // The image travels two ways so either Zapier field can read it: a standard
        // enclosure, and a media:content element that the "Media URL" mapping sees.
        image ? `      <enclosure url="${esc(image)}" type="image/png" length="0" />` : '',
        image ? `      <media:content url="${esc(image)}" medium="image" type="image/png" />` : '',
        '    </item>',
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>PipRail on LinkedIn</title>
    <link>${SITE}/</link>
    <atom:link href="${SITE}/linkedin-page.xml" rel="self" type="application/rss+xml" />
    <description>Posts published to the PipRail LinkedIn company page. Each item is one post, verbatim.</description>
    <language>en-gb</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`
  return new Response(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  })
}
