# PipRail discovery — the complete reference

How a PipRail user — a human merchant **or** an AI agent — becomes **discoverable**, and how an
agent **finds** payable resources. This is the single source of truth for the discovery feature.
Companion docs: [README.md](./README.md) (the full API), [STANDARDS.md](./STANDARDS.md) (how it's
built), [ERRORS.md](./ERRORS.md) (the error model). Background research lives in
`.claude/research/x402-discovery.md` (the "what is this") and `x402-discovery-integration.md` (the
"exactly how").

> **One line:** PipRail makes you discoverable by building on the **open** x402 indexes that already
> exist (402 Index, the CDP Bazaar read API, x402scan) — **it hosts nothing of its own**: no
> registry, no database, no backend, no fee. Every piece is opt-in; the pay path is untouched.

> **⚠️ Status: EXPERIMENTAL.** Discovery integrates with **third-party** open indexes whose wire
> shapes are a moving, unratified convention — treat this whole layer as experimental and expect to
> re-verify the integration over time. The **read** path + the **402 Index register** flow are
> live-verified (see the log in §10); **x402scan SIWX is not yet live-tested** — exercise it against
> x402scan before relying on it. The pay path and the rest of the SDK are stable; only this layer
> carries the experimental flag.

---

## 1. The problem (discovery is NOT part of x402)

The x402 protocol answers exactly one question: *"how do I pay for THIS url?"* You hit a URL, get a
`402` with a machine-readable challenge, pay on-chain, retry with proof, get `200`. It does **not**
answer *"what payable URLs exist?"*

So a fresh PipRail merchant is in a bind:

- A **seller** adds `requirePayment()` to `https://api.acme.com/report`. It's now payable — but
  nobody knows the URL exists. A shop with no sign, on a street with no name.
- A **buyer** (an AI agent with a budget-bound wallet) wants to *buy a weather feed under $0.01 on
  Base*. It has no phone book — it can only pay URLs a human already handed it.

That missing phone book is **discovery**. It's a separate, optional layer built *around* x402.

**Why PipRail doesn't host its own directory.** A registry/database is a backend we'd run forever —
a bill that never reaches $0, uptime, an open write endpoint that invites spam + a moderation queue.
That would turn PipRail from *"a tool you `npm install`"* into *"a platform you sign up for"* — the
exact thing the project is defined against. So instead we **consume and contribute to the open
indexes that already exist**, and host nothing.

---

## 2. The open infrastructure we build on

All three are external, open, and already running. PipRail reads from and writes to them; it operates
none of them.

| Index | Read (find) | Write (be listed) | Chains | PipRail role |
|---|---|---|---|---|
| **402 Index** (402index.io) | ✅ free, no auth | ✅ **`POST /register` — no auth, no signature, no payment** | any | **Primary register target** + a free read source. A superset (it also re-ingests the CDP Bazaar). |
| **CDP Bazaar** (api.cdp.coinbase.com) | ✅ free, no key | ❌ listed only when the CDP **facilitator settles** your payment | any | **Read-only source.** PipRail uses no facilitator, so PipRail merchants don't auto-list here — discoverability comes from 402 Index / x402scan. |
| **x402scan** (x402scan.com) | 💲 paid ($0.01–0.02, off by default) | ✅ **SIWX** (one wallet signature; facilitator-free) | **Base + Solana only** | **Secondary register target** (the strongest ownership model); a paid, opt-in read. |

> The honest framing: the most prominent directory, the CDP Bazaar, is a *facilitator network
> effect* — it lists you only when Coinbase's facilitator settles your payment, which PipRail never
> uses. That's why discoverability for a backendless merchant flows through 402 Index (and x402scan),
> not the Bazaar. PipRail can still freely **read** the Bazaar to help an agent find *other* people's
> endpoints.

---

## 2.5 Works on EVERY chain (the guarantee)

**No matter the chain — a built-in preset, a non-EVM family, or a custom `{ id, rpcUrl }` chain we
don't ship — a PipRail user can be indexed and found, and an agent can discover them.** This is a
hard guarantee, proven by the test suite (`test/discovery-e2e.test.ts` parametrizes every family +
a custom chain) and by running it for real:

- **Emit** is pure serialization — it works for any chain's rails, full stop.
- **Register** defaults to **402 Index**, which needs no signature and has no chain allowlist, so it
  lists **every** chain. `payment_network` is optional metadata: it's the chain slug when you
  configured the client with one (`'base'`, `'tron'`, …), and omitted for a custom `{ id, rpcUrl }`
  chain (pass `network` explicitly if you want it). No chain is ever turned away.
- **Discover** filters by delegating to the bound driver's own `supports()`, and — critically — a
  rail whose network it can't resolve to CAIP-2 is **kept, never silently hidden**. So discovery is
  never empty on a custom or unmapped chain; at worst it returns a re-checkable extra the agent
  confirms at quote time.

The **one** chain-limited piece is the *optional* x402scan register target (Base/Solana only, its
own limit). It's a bonus, never the path — 402 Index already covers everyone. So: **402 Index +
emit + discover = universal discovery on every chain.**

**Future chains.** A chain we add later inherits all of this for free — register and emit need no
discovery change at all, and `discover()` already never hides an unmapped chain. The only
discovery touch in the add-a-chain procedure is a one-line entry in `indexes.ts`'s `SLUG_TO_CAIP2`
(slug → the family's exact `caip2`), which sharpens `'self'` filtering precision; it's on the
`add-chain-integration` checklist. Omitting it degrades nothing that matters — the resource is
still found.

---

## 3. The three moves

Discovery is three opt-in capabilities. A merchant uses Emit + Register to **be found**; an agent
uses Discover to **find**. Defaults are byte-identical to before — omit all three and nothing changes.

### 3.1 EMIT — turn a gate's config into a discovery file (pure, no I/O)

A gate already knows its price/asset/chain/`payTo`. `gate.describe()` exposes that as static,
**nonce-free** metadata (discovery metadata is long-lived; a live challenge mints a nonce, this does
not). The three pure emitters turn it into the file formats crawlers read. The merchant serves the
result as a **static file on their own origin** — the one wiring step, no backend.

```ts
import { createPaymentGate, buildOpenApi, buildWellKnownX402, buildX402DnsTxt } from '@piprail/sdk'

const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.05', payTo })
const resource = await gate.describe('https://api.example.com/report')
//  → { url, description?, accepts: PaymentRail[] }   (PaymentRail = scheme/network/asset/payTo/
//                                                       amount/amountFormatted/decimals/symbol?/maxTimeoutSeconds)

// (a) OpenAPI-first — the convention the live indexes parse. Serve at /openapi.json.
const openapi = buildOpenApi({ origin: 'https://api.example.com', resources: [resource] })

// (b) Legacy x402scan origin file. Serve at /.well-known/x402.
const wellKnown = buildWellKnownX402({ origin: 'https://api.example.com', resources: [resource] })

// (c) The experimental _x402 DNS pointer — paste into your zone.
const dns = buildX402DnsTxt({ host: 'api.example.com', discoveryUrl: 'https://api.example.com/openapi.json' })
//  → { name: '_x402.api.example.com', type: 'TXT', value: 'v=x4021;url=https://api.example.com/openapi.json' }
```

| Function | Output | Serve at |
|---|---|---|
| `buildOpenApi(input)` | a minimal valid **OpenAPI 3.1** doc — one path per resource pathname (resources sharing a pathname merge, keyed by HTTP method), `x-payment-info` per paid op, optional `x-agentcash-provenance.ownershipProofs` | `https://<origin>/openapi.json` (primary) |
| `buildWellKnownX402(input)` | `{ version: 1, resources: [urls], ownershipProofs? }` | `https://<origin>/.well-known/x402` (legacy) |
| `buildX402DnsTxt({ host, discoveryUrl, descriptor? })` | `{ name: '_x402.<host>', type: 'TXT', value: 'v=x4021;[descriptor=…;]url=…' }` | a DNS TXT record (experimental) |

`ManifestInput` = `{ origin, resources, ownershipProofs?, title?, version?, attribution? }`. All three
emitters are **pure** — no network, no chain library — so they're deterministic and trivially testable.
They emit exactly the rails you pass; to be *usefully* listed on the open indexes, also offer a standard
`exact` rail (see §6).

**Spreading the word — three tasteful, honest channels (no spam, no rule-breaking).**

1. **`x-generator` stamp (default on, opt-out).** `buildOpenApi` marks the document root with
   `x-generator: "@piprail/sdk · https://piprail.com"` — a standard, unobtrusive "built with" mark
   (like Swagger/Hugo emit). It lives in the `/openapi.json` the merchant serves on their *own*
   origin — the very file the open indexes **crawl** — so the attribution rides along wherever a
   PipRail merchant is found. Metadata only; opt out with `attribution: false`.
2. **`User-Agent` on every index request (always on).** All reads/registers send
   `User-Agent: @piprail/sdk (+https://piprail.com)` — the standard bot-UA-with-contact-URL
   convention, so index operators see PipRail-driven traffic in their logs. It's a request *header*,
   so it can never affect an index's body validation (zero risk of breaking a register), and the
   browser keeps its own UA where it must. *(Live-verified: the server echoes it back.)*
3. **Opt-in `via` listing tag (default OFF).** `register(url, { attribution: true })` adds
   `via: '@piprail/sdk'` to the listing payload. **Off by default** — it's the *merchant's* listing
   on a third party, so we never tag it without being asked — and **best-effort** (an index may
   ignore an unknown field). *(Live-verified safe: 402 Index tolerates the field — a tagged register
   gets the exact same URL-probe response as an untagged one, never a field rejection.)*

We do **not** hijack the listing's `provider` (that's the merchant's), and the always-on channels (1
+ 2) are the reliable ones; (3) is purely opt-in. Honest attribution through the channels that
already exist — never spam.

**Ownership proof (optional trust badge).** Sign the **bare origin string** with the `payTo` key and
pass it as `ownershipProofs`. x402scan verifies `recoverMessageAddress(origin, sig) === payTo`.

```ts
const signer = await client.discoverySigner() // EVM today; null on families without it
const proof = signer ? [await signer.signMessage('https://api.example.com')] : undefined
const openapi = buildOpenApi({ origin: 'https://api.example.com', resources: [resource], ownershipProofs: proof })
```

### 3.2 REGISTER — list yourself on the open registries

```ts
const client = new PipRailClient({ wallet: { privateKey: KEY }, chain: 'base' })

const outcomes = await client.register('https://api.example.com/report', {
  name: 'Market Report',
  priceUsd: 0.05,
  // targets: ['402index']            // default — no auth, no signature
  // targets: ['402index', 'x402scan'] // also x402scan via SIWX (EVM + Base/Solana)
})
//  → [{ source: '402index', ok: true, status: 200, detail: 'Listed on 402 Index (searchable at 402index.io).' }]
```

`RegisterOptions` = `{ name?, description?, priceUsd?, asset?, network?, method?, targets? }`. The
`network` slug defaults to the client's `chain` when it's a slug (e.g. `'base'`). Returns one
`RegisterOutcome` (`{ source, ok, status?, detail?, listingUrl? }`) **per target** — a target the
chain can't satisfy is reported `{ ok: false, detail }`, **never thrown**:

| target | what happens |
|---|---|
| `'402index'` (default) | one `POST` — no auth/signature/payment. The reliable path on every chain. |
| `'x402scan'` | **SIWX**: `POST` → `402` challenge → sign EIP-4361 with the wallet key → resend with the `SIGN-IN-WITH-X` header. The SDK checks **only** for an EVM `discoverySigner` locally (returns `{ ok:false }` on a non-EVM family); the **Base/Solana-only** limit is enforced by x402scan itself, so any other chain comes back `{ ok:false }` with the HTTP status it returns. **Experimental** — the SIWX handshake is a moving convention; validate against x402scan before relying on it. |
| `'bazaar'` | honestly refused (`{ ok:false }`) — the Bazaar has no write endpoint (facilitator-settle only). |

Standalone equivalents (no client): `register402Index(input)` and `registerX402Scan({ url }, signer)`.

### 3.3 DISCOVER — find payable resources (read-only, free)

```ts
const hits = await client.discover({ query: 'weather', maxPrice: 0.01 })
//  → DiscoveredResource[]  ({ resource, source, name?, description?, priceUsd?, rails: DiscoveredRail[] })
const res = await client.fetch(hits[0].resource) // then the usual quote → plan → pay
```

`DiscoverOptions` = `{ query?, network?, maxPrice?, sources?, limit? }`:

| option | default | meaning |
|---|---|---|
| `query` | — | free-text; matched against name/description/resource (Bazaar is filtered client-side, 402 Index server-side via `?q=`). |
| `network` | `'self'` | `'self'` = only resources payable on the client's bound chain · a **CAIP-2** id = that chain · `'any'` = every chain. |
| `maxPrice` | — | coarse pre-filter: drop results whose *advertised* USD price exceeds it (results with no price pass through — `quote()` gives the exact figure). |
| `sources` | `['bazaar','402index']` | which open indexes to read (both free). |
| `limit` | `20` | max results per source before merge. |

Results from all sources are **merged and deduped by resource URL** (first source wins). Standalone:
`searchOpenIndexes({ query?, sources?, limit?, signal? })`.

**Network filtering is forgiving by design.** An index reports networks as slugs (`'base'`) or CAIP-2
(`'eip155:8453'`). `normalizeNetwork()` maps known slugs to the exact CAIP-2 each driver binds (every
family is covered; Solana's reference is the 32-char-truncated form). For `network: 'self'` the filter
delegates to the driver's own `net.supports()`, and — crucially — a rail whose network it **cannot
resolve** is **kept, not silently hidden** (a re-checkable false positive beats an invisible
resource; the agent's next `quote()`/`planPayment()` rejects a wrong chain anyway).

---

## 4. The signing primitive — `discoverySigner`

One **optional** addition to the `PaymentDriver` contract:

```ts
// drivers/types.ts — ResolvedNetwork
discoverySigner?(wallet: WalletHandle): DiscoverySigner | null
// DiscoverySigner = { address: string; signMessage(message: string): Promise<string> }
```

- **Discovery only** — ownership proofs + SIWX registration. It **never signs a payment**.
- **EVM today** (eip191 via the wallet client; works for `{ privateKey }` and `{ walletClient }`).
  Recoverable with viem's `recoverMessageAddress` — exactly how x402scan verifies origin ownership.
- **Optional by design** — a family omits it until an open index verifies its signatures. The
  primary register path (402 Index) needs no signature, so families without it lose nothing there;
  `register(..., { targets: ['x402scan'] })` returns a clear `{ ok:false }` for them.
- It is the SDK's **first optional contract method**, so it does *not* trigger the "implement in all
  families" rule that applies to required methods.

`client.discoverySigner()` surfaces it (or `null`) so a merchant can generate an ownership proof.

---

## 5. Agent / MCP tools

`paymentTools(client)` ships five descriptors; the MCP server is a pass-through, so they appear in
`@piprail/mcp` automatically:

| tool | does |
|---|---|
| **`piprail_discover`** `{ query?, network?, maxPrice?, limit? }` | find payable resources on the open indexes — the phone book. |
| `piprail_quote_payment` `{ url }` | price a gated URL without paying. |
| `piprail_plan_payment` `{ url }` | check you *can* pay (balance/gas/recipient) across every rail. |
| `piprail_pay_request` `{ url, method?, body? }` | pay the 402 and return the result. |
| **`piprail_register`** `{ url, name?, description?, priceUsd? }` | list a resource you run (402 Index, no signature). |

The discover tool returns a compact list (`resource, name, source, priceUsd, networks`) for the model
to pick from, then quote → pay. Because index results are cross-scheme, the model should always
`quote()` a chosen resource (re-hitting the live URL) before paying.

---

## 6. The honest caveats (never glossed)

1. **Scheme.** PipRail 402s use `scheme: 'onchain-proof'`; the open indexes assume the mainstream
   **`exact`** scheme. A naive PipRail 402 risks being marked "skipped." **To be *usefully* indexed,
   also advertise a standard `exact` USDC rail on Base/Solana.** `discover()` results are
   cross-scheme: `client.fetch()` pays only `onchain-proof` rails directly; paying a discovered
   `exact` resource uses the already-exported experimental `drivers/evm/exact.ts` interop.
2. **x402scan is Base/Solana only** (enforced server-side by x402scan — the SDK does no local chain
   check before calling `registerX402Scan`). 402 Index has no such
   limit, so it's the default register target and covers every family.
3. **There is no single ratified discovery standard.** The ratified x402 v2 spec defines discovery
   only as the read-only facilitator Bazaar. OpenAPI-first (`x-payment-info`) is an **emerging
   multi-vendor convention** (an early IETF draft, Merit Systems + Tempo Labs) — emit it, but treat
   it as a moving target, never "the standard." The `_x402` DNS draft is expired; emit it as a
   nice-to-have only.

---

## 7. Step-by-step walkthrough (and exactly what you need)

Two roles. **A merchant lists their own endpoint so agents can find it; an agent finds and pays.**
There is **no PipRail account and no x402 sign-up anywhere** — you never "register your SDK" with us
or with x402. The only thing that's ever "registered" is a *merchant's own URL* on a public index,
and they do it themselves with one call.

### 7a. Merchant — be found (each step says what it needs)

1. **Gate the route.** `requirePayment({ chain, token, amount, payTo })`.
   *You need:* your **receiving wallet address** (`payTo`) — a public address, **not** a private key.
   *No signing, no sign-up.* The route now returns `402` (payable) but is invisible.
2. **(Optional) Emit a discovery file.** `const r = await gate.describe(url)` →
   `buildOpenApi({ origin, resources: [r] })` → serve the JSON at `https://<origin>/openapi.json`.
   *You need:* nothing — it's pure, no keys, no network. It's a static file on your own server.
3. **Register so agents can find you.** `await client.register(url, { name, priceUsd })`.
   - **402 Index — the default.** **No sign-up, no API key, no signature, no wallet.** One HTTPS POST;
     402 Index probes your URL (it must return a real `402`) and lists it. Searchable in seconds.
   - **x402scan — optional.** Add `targets: ['402index', 'x402scan']`. This one signs a **SIWX**
     challenge with **your own wallet's key** (one signature — *no funds move*). Base/Solana only.
     This is the **only** signing on the be-found side, and it's optional.
4. **(Optional) Ownership badge.** Sign your bare origin string with your `payTo` key
   (`const s = await client.discoverySigner(); await s.signMessage(origin)`) and pass it as
   `buildOpenApi({ ownershipProofs: [...] })`. A trust badge on indexes that verify it; never required.
5. **Found.** Agents discover you through the open indexes. Nothing is hosted by PipRail.

### 7b. Agent — find & pay

1. **Discover.** `await client.discover({ query })` — reads the open indexes (free). *No key, no sign-up.*
2. **Quote.** `await client.quote(resource)` — the exact live price. *No funds move.*
3. **Plan.** `await client.planPayment(resource)` — can this wallet actually settle it? *No funds move.*
4. **Pay.** `await client.fetch(resource)` — *you need:* a **funded wallet** (it signs + broadcasts the
   payment, then verifies locally). The payment goes **merchant-direct** — no facilitator, and the
   index never touches the money.

### 7c. What you need at each step (the whole truth, one table)

| Step | Wallet? | Private key / signing? | Sign-up / account? | Cost |
|---|---|---|---|---|
| Gate an endpoint | a receiving **address** only | **no** | **no** | free |
| Emit `/openapi.json` | — | **no** | **no** | free |
| **Register · 402 Index** (default) | — | **no** | **no** | free |
| Register · x402scan (optional) | your own | yes — **1 SIWX signature, no funds move** | **no** | free |
| Ownership badge (optional) | your own | yes — sign the origin string | **no** | free |
| Discover | — | **no** | **no** | free |
| Quote / plan | — | **no** | **no** | free |
| **Pay** a discovered API | a **funded** wallet | yes — the on-chain payment tx | **no** | the price + gas |

**The fastest path to discoverable** is the bold row pair: gate it, then `client.register(url)` —
**no wallet, no signature, no account, free.** Everything else is optional polish.

---

## 8. Constraint compliance

- **No backend / DB / registry of our own.** Emit = a static file the *merchant* hosts; discover /
  register = runtime calls to *third-party* open indexes; payment is merchant-direct + local verify.
- **Protocol layer stays chain-agnostic** (STANDARDS §1): `discovery.ts` + `indexes.ts` import only
  `x402.ts`/`drivers/types.ts` + pure utils — zero chain libraries (verified by the lazy-chunk grep).
- **Opt-in, defaults unchanged.** `discover`/`register`/`discoverySigner`/the emitters/`gate.describe`
  are all new optional surface; the zero-config pay path is byte-identical.
- **Read-style, never throws.** Search returns `[]` on a dead/garbage index; register returns
  `{ ok:false, detail }` on any failure; the pure emitters can't fail at runtime. (See ERRORS.md.)

---

## 9. Full API surface

```ts
// Emit (pure)
buildOpenApi(input: ManifestInput): OpenApiDocument
buildWellKnownX402(input: ManifestInput): WellKnownX402
buildX402DnsTxt(input: { host; discoveryUrl; descriptor? }): X402DnsRecord
gate.describe(resourceUrl?): Promise<ResourceDescription>

// Register (developer-invoked I/O; never throws)
client.register(url, opts?: RegisterOptions): Promise<RegisterOutcome[]>
register402Index(input: RegisterInput): Promise<RegisterOutcome>
registerX402Scan({ url }, signer: DiscoverySigner): Promise<RegisterOutcome>

// Discover (read-only I/O; never throws)
client.discover(opts?: DiscoverOptions): Promise<DiscoveredResource[]>
searchOpenIndexes(opts?: SearchOpenIndexesOptions): Promise<DiscoveredResource[]>
normalizeNetwork(network: string): string

// Sign (discovery only)
client.discoverySigner(): Promise<DiscoverySigner | null>

// Types
PaymentRail · ResourceDescription · ManifestInput · OpenApiDocument · OpenApiOperation ·
WellKnownX402 · X402DnsRecord · DiscoverySource · DiscoveredResource · DiscoveredRail ·
RegisterOutcome · RegisterInput · SearchOpenIndexesOptions · DiscoverOptions · RegisterOptions ·
DiscoverySigner
```

---

## 10. Experimental status & live-integration log

Discovery is **experimental** because it depends on third-party open indexes (402 Index, CDP Bazaar,
x402scan) whose APIs and conventions are young and moving. The SDK code is stable and tested; what's
experimental is the *integration contract* with those external services. Keep this log current.

**Live integration test — 2026-06-06** (the SDK's own functions, run against the real services):

| What | Result |
|---|---|
| `searchOpenIndexes({ sources: ['bazaar'] })` — CDP Bazaar, free | ✅ 20 resources normalized; all `exact`-scheme on `eip155:8453` (confirms the cross-scheme caveat). |
| `searchOpenIndexes({ sources: ['402index'], query })` | ✅ real `{services:[…]}` parsed; the **x402 protocol filter dropped L402/MPP** on live data. |
| `client.discover({ network: 'any' })` | ✅ both indexes merged + deduped (sources: `bazaar` + `402index`). |
| `client.discover()` (default `self`) | ✅ filtered to the client's chain; the never-hide invariant held on real data. |
| `register402Index(...)` (write, no auth) | ✅ POST succeeded end-to-end; **402 Index PROBES the URL** and returned **HTTP 422** for a non-402 URL: *"Your endpoint returned HTTP 200 instead of 402."* Our code reported `{ ok:false, status:422, detail }` **without throwing**, and surfaces the index's own reason. |
| `registerX402Scan(...)` (SIWX write) | ⏳ **NOT yet live-tested.** EVM signing is correct in isolation, but the SIWX handshake against x402scan is unverified — still experimental. |
| **`User-Agent` attribution** | ✅ confirmed sent over the wire (`@piprail/sdk (+https://piprail.com)` echoed back by an external header service). |
| **Opt-in `via` listing tag** | ✅ confirmed **safe**: a `register(..., { attribution: true })` to 402 Index returns the *identical* URL-probe response as an untagged one — the field is tolerated, never causes a rejection. |

**Key facts learned live:**
- **402 Index validates by probing** — it will only list a URL that actually returns a `402`. So a
  successful registration requires a **real, deployed, public** x402 endpoint (PipRail has none to
  test with — a marketing site returns 200 and is correctly rejected). This also means our test
  created **no junk listing**. The error reason is now surfaced in `RegisterOutcome.detail`.
- **Read is free and works today** on both CDP Bazaar and 402 Index with no key.
- **402 Index totals (2026-06-06):** ~63k endpoints (x402: ~61k), ~1.6k services — a real, populated index.

**Before relying on it in production:** (1) register a real deployed x402 endpoint and confirm a
`200`/listed outcome end-to-end; (2) live-test the x402scan SIWX path; (3) re-verify the index wire
shapes (they drift — this doc's parser is defensive but the conventions are unratified).

---

## 11. Sources & further reading

- `.claude/research/x402-discovery.md` — the from-scratch explainer (concepts, formats, glossary).
- `.claude/research/x402-discovery-integration.md` — the source-level integration plan + verification log.
- 402 Index — https://402index.io · CDP Bazaar — https://docs.cdp.coinbase.com/x402/bazaar ·
  x402scan — https://github.com/Merit-Systems/x402scan · x402 spec — https://github.com/coinbase/x402
