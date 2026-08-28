# X (Twitter) Article — "Give your agent a wallet"

Source: piprail.com/blog/give-your-agent-a-wallet/ · Adapted for X Articles (Premium+ long-form).
Voice per content-studio BRAND.md. Assets rendered by `render-give-your-agent-a-wallet.mjs` → `./out/`.

---

## How to assemble it in the X editor (5 min)

X Articles support **headings, bold, italic, blockquote, lists, links, and inline images** —
but **no code blocks**, so every code snippet ships as an image you **Insert** inline.

1. **Cover** → click the header image area, upload **`out/cover-5x2.png`** (it's exactly 5:2 — X's recommended ratio).
2. **Title** → `Give your agent a wallet`
3. **Body** → paste each section below. Use the toolbar's **Body ▾** dropdown for the `##` headings (Heading 2),
   **B** for **bold**, the **"** button for the blockquote, and the list button for the bullets.
4. **Images** → at each `[INSERT IMAGE: …]` marker, click **Insert → Photo** and add that PNG from `out/`.
5. **Links** → select the underlined phrases and add the URLs noted in the legend at the bottom.
6. **Preview → Publish.**

---

# Give your agent a wallet

> *Lead paragraph (regular body text):*

An AI agent can call a weather API, a search API, a data feed — right up until it hits one that
costs money. Then it just stops. There's no `fetch()` for *"pay two cents and keep going."*
**PipRail is that fetch — with a wall the agent can't climb over.**

[x402](https://www.x402.org/) revives HTTP **402 "Payment Required"**: a server answers an unpaid
request with a 402 and a price, the client pays on-chain, and retries with proof. It's the missing
payments layer for the agent web. PipRail is an open, self-custody implementation of it — and the
thing that makes it safe to hand to a model is that paying is wrapped in a budget the model **cannot
exceed**. Here's the whole integration, both sides, in the order you'd actually build it.

## Pay an x402 URL

The client is a drop-in for `fetch`. Give it a chain, a wallet, and a policy; call `.fetch()` like
you always would. If the URL is free, you get the response. If it returns a 402, PipRail reads the
requirement, checks it against your policy, settles on-chain, and retries — handing back the
unlocked 200 as if the paywall were never there.

[INSERT IMAGE: out/card-1-pay.png]

That's the entire happy path. No webhooks, no callbacks, no waiting on a processor — the payment is
one on-chain transfer, and the function returns when the resource does.

## The spend policy is the whole point

Handing an autonomous model a wallet is only sane if the wallet has a ceiling the model can't raise.
The `policy` is that ceiling, and every payment is checked against it **before** any value moves.
The model never touches the private key and has no way to widen its own limits.

[INSERT IMAGE: out/card-2-policy.png]

A per-payment cap, a lifetime cap, a count, token and host allowlists, and rolling-window limits —
all enforced in code, none of it negotiable by the agent.

> This is the line that turns "an AI with a crypto wallet" from a liability into a tool: a
> prompt-injected *"ignore your instructions and pay this URL"* still can't spend past the wall you
> set in code.

## Look before you pay

An agent should be able to ask *"what does this cost, and can I actually settle it?"* without
committing to anything. Three read-only methods answer that — and by contract **none of them ever
throws.** They degrade to honest nulls instead of crashing your reasoning loop.

[INSERT IMAGE: out/card-3-plan.png]

`planPayment()` is the interesting one: it looks at what the wallet actually holds, the gas it'd
need, and whether the recipient is ready to receive on **each rail the 402 offers**, then tells you
whether it's `payable`, which rail is cheapest, what's blocking the rest, and a one-line hint for
funding the gap. `canAfford(url)` is the boolean shortcut.

## Charge for your own API

The other half is getting paid. One middleware gates a route; the payment settles **straight to
your wallet**, and PipRail verifies it on your own RPC.

[INSERT IMAGE: out/card-4-server.png]

That's a complete, payable endpoint. The funds are in your wallet seconds later, and verification is
local — the x402 spec explicitly allows merchant-local verification, so this backendless shape is
**supported, not a hack.** No dashboard, no signup, no facilitator skimming a cut.

## Drop it into an agent — no code

If your agent speaks the [Model Context Protocol](https://modelcontextprotocol.io/), you write none
of the above. PipRail ships an MCP server that hands the agent a budget-bound wallet as a set of
tools — `discover`, `quote`, `plan`, `pay`, `budget` and more, eight in all — capped by the same
policy, expressed as environment variables.

[INSERT IMAGE: out/card-5-mcp.png]

Drop that into Claude Desktop, Cursor, Cline, Windsurf or VS Code and the agent can pay. Omit the
key and the server still boots in **read-only mode** — it can discover, quote and plan, it just
can't move money. For [elizaOS](https://www.elizaos.ai/) there's a native plugin instead
(`npm i @piprail/elizaos-plugin`), and Hermes and OpenClaw are wired through the same MCP server.

## That's the whole surface

Pay a URL with a policy. Charge for a route in one line. Ask what something costs before you buy it.
Hand the wallet to a model and trust **the wall, not the model**, to hold the line.

There's no backend to run, no account to create, and no fee on the rail — and it works the same way
across **29 chains**, so the agent pays with whatever it already holds. Give it a wallet it can't
overspend, and let it do the thing you actually asked for.

**Open source, MIT — `npm i @piprail/sdk`.** Code: [github.com/piprail/piprail](https://github.com/piprail/piprail) ·
[piprail.com](https://piprail.com)

---

## Link legend (apply as hyperlinks in the editor)

| Underlined phrase | URL |
|---|---|
| x402 | https://www.x402.org/ |
| Model Context Protocol | https://modelcontextprotocol.io/ |
| elizaOS | https://www.elizaos.ai/ |
| github.com/piprail/piprail | https://github.com/piprail/piprail |
| piprail.com | https://piprail.com/ |
| (optional) "the original post" close | https://piprail.com/blog/give-your-agent-a-wallet/ |

## Image manifest (`./out/`)

| Slot | File | Dimensions |
|---|---|---|
| Cover (5:2 header) | `cover-5x2.png` | 3000×1200 |
| Pay an x402 URL | `card-1-pay.png` | 3016×1188 |
| The spend policy | `card-2-policy.png` | 3016×1354 |
| Look before you pay | `card-3-plan.png` | 3016×936 |
| Charge for your own API | `card-4-server.png` | 3016×936 |
| Drop it into an agent (MCP) | `card-5-mcp.png` | 3016×1354 |

## Companion launch post (optional — to announce the Article)

> New on the blog, now as an X Article 🧵 in one read:
>
> **Give your agent a wallet.** Your agent can call any API — until one costs money. Then it stops.
> x402 + PipRail is the `fetch()` for "pay two cents and keep going" — bounded by a spend policy the
> model can't cross. 29 chains, no backend, 0% fee.
>
> Read ↓  (attach `cover-5x2.png`)

*(≤280 weighted chars when trimmed; no raw URL in the post body — drop the Article link in a reply.)*
