/**
 * Landing page — a tiny, self-contained HTML representation of a 402, for the HUMAN
 * who opens a gated URL in a browser (agents/crawlers still get the unchanged JSON 402).
 * PURE string templating; imports only the `SelfDescription` type — zero I/O, zero chain
 * libraries (protocol layer, STANDARDS §1).
 *
 * The SDK NEVER serves this itself (it's headless by charter). The merchant opts in by
 * branching on the request's `Accept` header in their own handler and returning this
 * string with `content-type: text/html`. See `gate.landingPage(challenge)`.
 *
 * SECURITY: every interpolated field is HTML-escaped (a `payTo` / instruction can be
 * merchant- or rail-influenced) — global rule: escape all user-/data-influenced content.
 */
import type { SelfDescription } from './selfdescribe.js'

/** Escape the five HTML-significant characters. Applied to EVERY interpolated value. */
function esc(s: unknown): string {
  // Coerce first — never throw on a missing/foreign field (the module's never-throw contract;
  // a rail's `amount`/`asset` are typed-required but only the type system guards them).
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  )
}

const STYLE = `:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0a0e0f;color:#e6edf0;font:16px/1.6 ui-sans-serif,system-ui,-apple-system,Inter,sans-serif}
main{max-width:680px;margin:0 auto;padding:48px 24px}
h1{font-size:1.6rem;margin:0 0 .25rem}
.lede{color:#9fb0b5;margin:.25rem 0 2rem}
h2{font-size:1rem;text-transform:uppercase;letter-spacing:.05em;color:#34d399;margin:2rem 0 .75rem}
table{width:100%;border-collapse:collapse;font-size:.92rem}
th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid #1c2426;vertical-align:top}
th{color:#9fb0b5;font-weight:600}
code,pre{font-family:ui-monospace,JetBrains Mono,monospace;font-size:.85rem}
pre{background:#11181a;border:1px solid #1c2426;border-radius:8px;padding:14px;overflow-x:auto;color:#cfe9df}
a{color:#34d399}
.mono{font-family:ui-monospace,monospace;word-break:break-all}
.warn{margin:0 0 2rem;padding:14px 16px;border:1px solid #5a4a1f;background:#17130a;border-radius:8px;color:#e8d9a8;font-size:.92rem;line-height:1.55}
.warn strong{color:#f5d77a}
.muted{color:#5b6b6f;font-weight:400;text-transform:none;letter-spacing:0;font-size:.8rem}
footer{margin-top:2.5rem;color:#5b6b6f;font-size:.8rem}`

/**
 * Render a self-describing HTML 402 landing page from a {@link SelfDescription}. Leads with the
 * one-line instruction and a prominent CAUTION — payment must go through an x402 client; a manual
 * send to the address won't unlock the resource and isn't matched to the request (it lands in the
 * merchant's wallet uncredited). Then the primary "How to pay" (the `npm i @piprail/sdk` install +
 * paste-ready snippet + MCP command), and finally the per-rail "Payment details" table (scheme ·
 * chain · amount · settles-to) for transparency. Fully static — no script, no external asset.
 */
export function renderLandingPage(sd: SelfDescription): string {
  const lede = esc(sd.instruction ?? sd.what)
  const rows = sd.pay
    .map(
      (r) =>
        `<tr><td><code>${esc(r.scheme)}</code></td><td>${esc(r.network)}</td>` +
        `<td>${esc(r.amountFormatted ?? r.amount)} ${esc(r.symbol ?? r.asset)}</td>` +
        `<td class="mono">${esc(r.payTo)}</td></tr>`
    )
    .join('')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(sd.name)} · x402 payment required</title>
<style>${STYLE}</style>
</head><body><main>
<h1>402 — Payment Required</h1>
<p class="lede">${lede}</p>
<div class="warn"><strong>Pay with an x402 client — not by hand.</strong> This endpoint is paid programmatically: an x402 client (the ${esc(sd.name)} SDK or MCP below, or any x402-compatible wallet) makes the payment <em>and proves it</em>, which is what unlocks the resource. Sending funds straight to the address below from an ordinary wallet will reach the merchant but <strong>will NOT unlock this resource and won't be matched to your request</strong> — there is no custody and no manual-payment desk. Use one of the methods below.</div>
<h2>How to pay</h2>
<pre>${esc(sd.sdk.install)}</pre>
<pre>${esc(sd.sdk.snippet)}</pre>
<p>For AI agents (MCP): <code>${esc(sd.mcp.run)}</code> &rarr; tool <code>${esc(sd.mcp.tool)}</code></p>
<h2>Payment details <span class="muted">— what the client pays, NOT a manual-send address</span></h2>
<table><thead><tr><th>Scheme</th><th>Chain</th><th>Amount</th><th>Settles to</th></tr></thead>
<tbody>${rows}</tbody></table>
<p>Docs: <a href="${esc(sd.docs.pay)}">paying</a> &middot; <a href="${esc(sd.docs.home)}">${esc(sd.docs.home)}</a> &middot; <a href="${esc(sd.discovery.openapi)}">${esc(sd.discovery.openapi)}</a></p>
<footer>Powered by ${esc(sd.name)} &middot; x402 &middot; no backend, no fee, settled straight to the merchant's wallet (no custody).</footer>
</main></body></html>`
}
