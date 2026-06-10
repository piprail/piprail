# PipRail — "29 chains, 29 days" social campaign

One tweet + one image per day, one per chain PipRail ships (the 29 logos in
`site/public/chains/`). Each post says the same thing in the chain's own colors:
**PipRail makes that chain an x402 rail your AI agent can pay — no backend, no fee,
one `npm install`.**

- **Plan + copy:** this file.
- **Image template:** `design/exports/social/template.html` (one HTML, parameterised per chain).
- **Rendered PNGs:** `design/exports/social/<chain>.png` (1600×900, gitignored — local renders).
- **Render command:** see §3.

---

## 1. The image spec (EVERY image follows this — non-negotiable)

Clean, crisp, on-brand. If a render doesn't meet all of these, it's not done.

- **Pure black background** (`#000`) with a single soft **emerald** radial glow — nothing else.
- **The chain logo** (from `site/public/chains/<chain>.svg`), large and centered, softly glowing.
- **The PipRail logo** (`site/public/logo.png`), linked to the chain logo by an **emerald "rail"**
  with a payment dot — the visual = *PipRail pays this chain*.
- **`x402`** present as a small emerald pill/badge.
- **One headline + one sub-line** — AI-agent payment messaging, nothing more.
- Emerald (`#2ee6a6`) is the only accent. Inter / JetBrains Mono. `piprail.com` footer.
- **Straight to the point. No clutter.** White space is the brand.

Aspect: **1600×900** (16:9, X-friendly). Keep each PNG under ~400 KB.

---

## 2. The 29 — daily checklist (Day 1 = the Telegram coin)

| # | Day | Chain | Native coin | Stablecoins | Tweet | Image | Posted |
|--:|-----|-------|-------------|-------------|:-----:|:-----:|:------:|
| 1 | TON (Telegram) | `ton` | Toncoin (TON) | USD₮ | ✅ | ✅ | ☐ |
| 2 | Solana | `solana` | SOL | USDC · USDT | ☐ | ☐ | ☐ |
| 3 | Base | `base` | ETH | USDC | ☐ | ☐ | ☐ |
| 4 | Ethereum | `ethereum` | ETH | USDC · USDT | ☐ | ☐ | ☐ |
| 5 | Tron | `tron` | TRX | USD₮ | ☐ | ☐ | ☐ |
| 6 | BNB Chain | `bnb` | BNB | USDC · USDT | ☐ | ☐ | ☐ |
| 7 | Polygon | `polygon` | POL | USDC · USDT | ☐ | ☐ | ☐ |
| 8 | Arbitrum | `arbitrum` | ETH | USDC · USDT | ☐ | ☐ | ☐ |
| 9 | Avalanche | `avalanche` | AVAX | USDC · USDT | ☐ | ☐ | ☐ |
| 10 | Optimism | `optimism` | ETH | USDC · USDT | ☐ | ☐ | ☐ |
| 11 | Sui | `sui` | SUI | USDC | ☐ | ☐ | ☐ |
| 12 | Aptos | `aptos` | APT | USDC · USDT | ☐ | ☐ | ☐ |
| 13 | NEAR | `near` | NEAR | USDC · USDT | ☐ | ☐ | ☐ |
| 14 | XRP Ledger | `xrpl` | XRP | USDC · RLUSD | ☐ | ☐ | ☐ |
| 15 | Stellar | `stellar` | XLM | USDC · EURC | ☐ | ☐ | ☐ |
| 16 | Algorand | `algorand` | ALGO | USDC | ☐ | ☐ | ☐ |
| 17 | Celo | `celo` | CELO | USDC · USDT | ☐ | ☐ | ☐ |
| 18 | Mantle | `mantle` | MNT | USDC · USDT | ☐ | ☐ | ☐ |
| 19 | Sonic | `sonic` | S | USDC · USDT | ☐ | ☐ | ☐ |
| 20 | Linea | `linea` | ETH | USDC · USDT | ☐ | ☐ | ☐ |
| 21 | Scroll | `scroll` | ETH | USDC · USDT | ☐ | ☐ | ☐ |
| 22 | zkSync | `zksync` | ETH | USDC · USDT | ☐ | ☐ | ☐ |
| 23 | Unichain | `unichain` | ETH | USDC · USDT | ☐ | ☐ | ☐ |
| 24 | World Chain | `worldchain` | ETH | USDC | ☐ | ☐ | ☐ |
| 25 | Sei | `sei` | SEI | USDC | ☐ | ☐ | ☐ |
| 26 | Injective | `injective` | INJ | USDC · USDT | ☐ | ☐ | ☐ |
| 27 | HyperEVM | `hyperevm` | HYPE | USDC | ☐ | ☐ | ☐ |
| 28 | Monad | `monad` | MON | USDC | ☐ | ☐ | ☐ |
| 29 | Kaia | `kaia` | KAIA | USD₮ | ☐ | ☐ | ☐ |

> Token coverage per chain is authoritative in `sdk/CHAINS.md` — re-check before each post.
> Native coin (`token: 'native'`) is a valid payment asset on **every** chain.

---

## 3. How to render an image

The template reads a chain config and composes the spec in §1. To render one chain:

```bash
# from repo root — renders design/exports/social/<chain>.png at 1600×900
node .claude/skills/site-design/design/exports/social/render.mjs ton
```

(Uses the Playwright Chromium already installed for the project — same HTML→screenshot
approach as the promo-video pipeline.)

---

## 4. Daily tweet copy

Day 1 (TON) is written below. Add each day's copy here as it's drafted, then check it off
in §2.

> **Hard rule: every tweet must be ≤ 280 characters** (X weighted count — emoji & some
> symbols like `₮` count as 2). Draft *including* the @handle + hashtag block, then verify.
> No `piprail.com` link in the body (the image carries it; drop a link in a reply for reach).

### Day 1 — TON (the Telegram coin)  — ~238/280 chars ✅

> Your AI agent can now pay on TON — the chain behind Telegram. 🛤️
>
> npm i @piprail/sdk, name the chain, add a wallet. It pays any x402 endpoint in USD₮ or Toncoin. No backend, no fee.
>
> @ton_blockchain #TON #x402 #AIagents #payments #crypto

Image: `design/exports/social/ton.png`

---

## 5. Assets used by the renderer

- **PipRail mark (transparent / no box):** [`site/public/logo-no-background.png`](../../../../../site/public/logo-no-background.png)
  — the white "P" with the emerald bar on a **transparent** background. This is the one the
  campaign images use (it floats cleanly on black; the boxed `site/public/logo.png` is NOT used
  here). The renderer points at it via the `LOGO` const in `render.mjs`.
- **Chain logos:** `site/public/chains/<chain>.svg` (the shipped set — source of truth for the 29).
- **Coin-chip treatment:** every logo is normalised into one circular coin. Logos that ship with
  their own full-bleed background (the `FULL_BLEED` set in `render.mjs`) fill the coin; bare
  glyphs sit centered with padding. The PipRail (payer) coin gets an emerald rim.
- **Center label:** `x402` sits on the emerald rail between the PipRail coin and the chain coin.

---

## 6. Tags & hashtags (per chain)

**Every post ends with this common block** (the PipRail evergreen tags):

> `#x402 #AIagents #payments #crypto`

…plus the **chain's own @handle + #hashtag** from the table below. Keep it to ~5–6 tags total —
more reads as spam on X. Order: `@chainhandle #ChainTag #x402 #AIagents #payments #crypto`.

> ⚠️ = handle I'm not 100% sure of (rebrands/squatters happen) — **verify on X before posting.**
> Handles with no ⚠️ are the well-known official accounts but a quick glance never hurts.

| # | Chain | @handle (tag) | Chain hashtag(s) |
|--:|-------|---------------|------------------|
| 1 | TON | @ton_blockchain | #TON #Toncoin |
| 2 | Solana | @solana | #Solana #SOL |
| 3 | Base | @base | #Base |
| 4 | Ethereum | @ethereum | #Ethereum #ETH |
| 5 | Tron | @trondao | #TRON #TRX #USDT |
| 6 | BNB Chain | @BNBCHAIN | #BNBChain #BNB |
| 7 | Polygon | @0xPolygon ⚠️ (rebrand → also @Polygon) | #Polygon #POL |
| 8 | Arbitrum | @arbitrum | #Arbitrum #ARB |
| 9 | Avalanche | @avax ⚠️ | #Avalanche #AVAX |
| 10 | Optimism | @Optimism | #Optimism #OP |
| 11 | Sui | @SuiNetwork | #Sui |
| 12 | Aptos | @Aptos ⚠️ (also @AptosLabs) | #Aptos #APT |
| 13 | NEAR | @NEARProtocol | #NEAR |
| 14 | XRP Ledger | @XRPLF ⚠️ (or @Ripple) | #XRPL #XRP #RLUSD |
| 15 | Stellar | @StellarOrg | #Stellar #XLM |
| 16 | Algorand | @Algorand ⚠️ (also @AlgoFoundation) | #Algorand #ALGO |
| 17 | Celo | @Celo ⚠️ (also @CeloOrg) | #Celo |
| 18 | Mantle | @Mantle_Official ⚠️ | #Mantle #MNT |
| 19 | Sonic | @SonicLabs ⚠️ | #Sonic |
| 20 | Linea | @LineaBuild ⚠️ | #Linea |
| 21 | Scroll | @Scroll_ZKP ⚠️ | #Scroll |
| 22 | zkSync | @zksync | #zkSync |
| 23 | Unichain | @unichain ⚠️ | #Unichain |
| 24 | World Chain | @worldcoin ⚠️ (also @world_chain_) | #WorldChain |
| 25 | Sei | @SeiNetwork | #Sei |
| 26 | Injective | @injective | #Injective #INJ |
| 27 | HyperEVM | @HyperliquidX ⚠️ | #Hyperliquid #HyperEVM |
| 28 | Monad | @monad_xyz ⚠️ (also @monad) | #Monad |
| 29 | Kaia | @KaiaChain ⚠️ | #Kaia #KAIA |

Stablecoin tags worth adding when relevant: `@circle #USDC` (most chains), `@Tether_to #USDT`
(Tether-native chains), `#RLUSD` (XRPL), `#EURC` (Stellar). Don't stack them — one extra at most.

---

## 7. Replies / engagement (a SECOND image style — keep it separate from posts)

When another project posts about x402 / agent payments on a chain we ship, reply with the
**code-window** image (not the coin-rail post image — reserve that for the scheduled day):

```bash
node .claude/skills/site-design/design/exports/social/render-reply.mjs <chain>
# -> design/exports/social/reply-<chain>.png  (1600×900)
```

It shows the real integration (`chain: '<chain>'`, the asset list, `client.fetch(url)`) in the
site's `tok-*` syntax colors — "we pay x402 on <chain> too." Keep replies **additive, not
combative**: open by acknowledging their launch.

**Logged replies:**
- **Injective** — replying under @injective's "AI Agent payments are now live on Injective"
  post (2026-06-08). Image: `reply-injective.png`. Copy (~260/280):
  > Love seeing this 🙌 Injective is one of 29 chains @piprail/sdk already pays via x402 — your AI agent names the chain, adds a wallet, and pays any 402 endpoint in INJ/USDC/USDT. No backend, no facilitator, no fee.
  >
  > npm i @piprail/sdk
  >
  > @injective #x402 #AIagents
