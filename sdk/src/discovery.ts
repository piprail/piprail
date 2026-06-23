/**
 * Discovery — make a gated resource FINDABLE, by emitting the open-standard
 * artifacts a crawler/index reads. PURE: this file turns the config a gate
 * already has into static metadata; it does NO network I/O and imports NO chain
 * library (protocol layer — STANDARDS §1). The runtime side (registering with /
 * searching the open indexes) lives in `indexes.ts` + the client.
 *
 * Three artifacts, three open conventions (see `.claude/research/x402-discovery.md`):
 *   - OpenAPI-first `/openapi.json` (`x-payment-info` per op) — the live convention
 *     the open indexes parse today (x402scan via `@agentcash/discovery`).
 *   - `/.well-known/x402` origin file — x402scan's legacy bulk-register format.
 *   - `_x402` DNS TXT line — the (experimental) DNS pointer draft.
 *
 * A merchant serves the emitted file on THEIR OWN origin (a static asset — no
 * backend). Nothing is PipRail-hosted. All opt-in; the pay path is untouched.
 *
 * Honesty note (held everywhere): there is no single ratified discovery
 * standard — OpenAPI-first is an emerging multi-vendor convention. Emit it, but
 * treat it as a moving target. And PipRail's own rails use `scheme:
 * 'onchain-proof'`; a merchant who also wants to be USEFULLY listed on the open
 * indexes should additionally offer a standard `exact` USDC rail on Base/Solana.
 */
import type { Caip2, AssetId, AddressId } from './x402.js'

/**
 * The static (nonce-free) shape of one payment option — the discoverable part of
 * an `X402AcceptEntry`. A live challenge adds a single-use `nonce`; discovery
 * metadata is long-lived, so it carries none. Produced by `gate.describe()`,
 * consumed by every emitter below.
 */
export interface PaymentRail {
  /** `onchain-proof` (PipRail's default), the standard `exact` rail, or the standard `upto`
   *  (metered) rail (dual-advertise). */
  scheme: 'onchain-proof' | 'exact' | 'upto'
  network: Caip2
  asset: AssetId
  payTo: AddressId
  /** Amount in the token's base units (already scaled by decimals). */
  amount: string
  /** Human-readable amount, e.g. "0.05". */
  amountFormatted: string
  decimals: number
  symbol?: string
  maxTimeoutSeconds: number
  /** Rail-IDENTITY extra a discoverer needs to reconstruct/route the rail, mirrored from the
   *  live 402's `accept.extra` — the `upto` rail's MANDATORY `facilitatorAddress`, the `exact`
   *  rail's EIP-712 domain (`name`/`version`), and the `assetTransferMethod`. Omitted for the
   *  `onchain-proof` rail (it needs none). The base pricing fields stay top-level on the rail. */
  extra?: Record<string, unknown>
}

/** One discoverable resource: its URL, how to call it, and how to pay it. */
export interface ResourceDescription {
  /** The full URL of the gated resource. */
  url: string
  /** HTTP method the resource answers on. Default 'GET'. */
  method?: string
  /** Human description (shown to agents browsing an index). */
  description?: string
  /** Response content-type, e.g. 'application/json' (v2 ResourceInfo `mimeType`). */
  mimeType?: string
  /** The payment options the gate offers (its resolved `accepts`, nonce-free). */
  accepts: PaymentRail[]
}

/** Shared input for the emitters that describe a whole origin. */
export interface ManifestInput {
  /** The origin the merchant controls, e.g. 'https://api.example.com' (no path). */
  origin: string
  /** The discoverable resources at that origin. */
  resources: ResourceDescription[]
  /**
   * Optional ownership proofs — each a signature of the BARE ORIGIN STRING by a
   * `payTo` key (EVM: eip191 hex). A trust badge on indexes that verify it
   * (x402scan: `recoverMessageAddress(origin, sig) === payTo`); never required to
   * be listed. Produce one via `client.discoverySigner()`, then `signer.signMessage(origin)`
   * (single-arg — it signs the bare origin string).
   */
  ownershipProofs?: string[]
  /** OpenAPI `info.title`. Default 'PipRail x402 resources'. */
  title?: string
  /** OpenAPI `info.version`. Default '1.0.0'. */
  version?: string
  /**
   * Stamp the doc with a `x-generator: "@piprail/sdk"` attribution — a standard,
   * unobtrusive "built with" marker (à la Swagger/Hugo) that rides along wherever
   * an index crawls your `/openapi.json`, so the tech spreads as you get found.
   * Default **true**; set `false` to omit it entirely. It's metadata only — it
   * changes nothing about how the resource is paid or listed.
   */
  attribution?: boolean
}

/** What `x-generator` stamps when attribution is on — see {@link ManifestInput.attribution}. */
export const GENERATOR = '@piprail/sdk · https://piprail.com'

/**
 * The "powered by" marker for the `x-powered-by` HTTP header — the response-side twin of the
 * `/openapi.json` {@link GENERATOR} stamp. Inert metadata; opt out with `attribution:false`.
 * **ASCII-only on purpose:** this is an HTTP header value, and Node's `setHeader` writes header
 * values as latin1 — a non-ASCII separator (e.g. `·` U+00B7) would arrive mangled (`Â·`) and is
 * RFC-7230-discouraged. {@link GENERATOR} keeps its `·` because it only lands in UTF-8 JSON bodies.
 */
export const POWERED_BY = 'PipRail x402 | https://piprail.com'

/**
 * Machine-readable discovery pointers for a gated endpoint's HTTP responses — a `Link` header
 * (RFC 8288) pointing crawlers/agents at the discovery docs, plus a tasteful `x-powered-by`
 * marker. Spread the result into BOTH the 402 challenge response AND the 200 settlement
 * response, so a payer / agent / crawler learns what served them on every hit (this is also
 * how the 200 "receipt" self-advertises — no change to the `X402Receipt` body needed). PURE —
 * returns a header bag the merchant sets; the SDK serves nothing. `attribution:false` omits
 * `x-powered-by` (parity with the `x-generator` opt-out on the OpenAPI doc). If you already set
 * a `Link` header, comma-merge it with this one rather than blindly spreading (object spread
 * would replace it).
 */
export function discoveryHeaders(opts: { attribution?: boolean } = {}): Record<string, string> {
  return {
    link: '</openapi.json>; rel="service-desc", </.well-known/x402>; rel="x402-discovery"',
    ...(opts.attribution === false ? {} : { 'x-powered-by': POWERED_BY }),
  }
}

/** A minimal, valid OpenAPI 3.1 document carrying `x-payment-info` per paid op. */
export interface OpenApiDocument {
  openapi: '3.1.0'
  info: { title: string; version: string }
  servers: { url: string }[]
  paths: Record<string, Record<string, OpenApiOperation>>
  /** "Built with @piprail/sdk" attribution (unless `attribution: false`). */
  'x-generator'?: string
  /** Provenance block the open indexes read (x402scan / agentcash). */
  'x-agentcash-provenance'?: { ownershipProofs: string[] }
}

export interface OpenApiOperation {
  summary?: string
  responses: Record<string, { description: string }>
  /** The discovery payload an x402 index reads: the rails for this operation. */
  'x-payment-info': {
    x402Version: 2
    accepts: PaymentRail[]
  }
}

/** x402scan's legacy origin file (`/.well-known/x402`). */
export interface WellKnownX402 {
  version: 1
  resources: string[]
  ownershipProofs?: string[]
}

/**
 * The official `/.well-known/x402.json` discovery manifest (x402-foundation PR #2646,
 * "Well known x402 discovery" — **DO NOT MERGE YET / for discussion**). A RICHER origin
 * file than the legacy {@link WellKnownX402}: per-item resource metadata + the resolved
 * `accepts` + a lifted input/output contract. PipRail emits this as a SECOND,
 * forward-compatible artifact — {@link buildWellKnownX402} (the x402scan legacy file) is
 * left untouched, so nothing is pinned to an unstable spec. The merchant hosts the result
 * at `<origin>/.well-known/x402.json`.
 */
export interface WellKnownX402Manifest {
  x402Version: 2
  /** Unix timestamp (seconds) the manifest was generated. */
  lastUpdated: number
  items: WellKnownX402Item[]
}

/** One resource in a {@link WellKnownX402Manifest}. The live 402 stays authoritative —
 *  `accepts` here is advisory, nonce-free discovery metadata. */
export interface WellKnownX402Item {
  resource: { url: string; description?: string; mimeType?: string; serviceName?: string; tags?: string[] }
  /** The transport the resource is paid over. PipRail emits `'http'` today. */
  type: 'http' | 'mcp'
  /** The payment options the gate offers (its resolved rails, nonce-free). */
  accepts: PaymentRail[]
  /** How to call the resource (lifted from the route config). */
  input?: { method: string; routeTemplate?: string; pathParams?: Record<string, unknown>; queryParams?: Record<string, unknown> }
  /** Output hint for a richer listing. */
  output?: { mimeType?: string; example?: unknown }
  /** Capability hints (extension keys) the resource requires, when any. */
  requires?: string[]
}

/**
 * Describes a resource's INPUT for discovery. The open indexes that REQUIRE an
 * input schema (x402scan rejects a listing without one) read this from a
 * `extensions.bazaar` block. Pass it to a gate's `discovery` option (emits the
 * block in the 402 challenge) or build it directly with {@link buildBazaarExtension}.
 */
export interface DiscoveryDescriptor {
  /** One human sentence: WHAT this endpoint does (e.g. "Current USD price for any
   *  crypto ticker"). Surfaced in the `extensions.piprail` self-describe block so an
   *  agent understands the endpoint at a glance, without a paid call. */
  summary?: string
  /** HTTP method the resource answers. Default `'GET'`. */
  method?: string
  /** Query params the resource reads, as a JSON-Schema `properties` object
   *  (name → schema). Default `{}` — a no-input GET. */
  queryParams?: Record<string, unknown>
  /** Optional output hint (shape/example) for a richer listing. */
  output?: { type?: string; example?: unknown }
}

/** The `extensions.bazaar` discovery block (the x402 "bazaar" convention the open
 *  indexes parse: `info.input` describes the request, `schema` is its JSON Schema). */
export interface BazaarExtension {
  info: { input: { type: 'http'; method: string; queryParams: Record<string, unknown> }; output?: { type?: string; example?: unknown } }
  schema: Record<string, unknown>
}

/**
 * Build the `extensions.bazaar` block that satisfies x402scan's mandatory input-schema
 * check, from a {@link DiscoveryDescriptor}. Pure. Defaults to a no-input GET — the
 * minimal shape a live x402scan listing accepts.
 */
export function buildBazaarExtension(descriptor: DiscoveryDescriptor = {}): BazaarExtension {
  const method = (descriptor.method ?? 'GET').toUpperCase()
  const queryParams = descriptor.queryParams ?? {}
  return {
    info: {
      input: { type: 'http', method, queryParams },
      output: descriptor.output ?? { type: 'json' },
    },
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        input: {
          type: 'object',
          properties: {
            type: { type: 'string', const: 'http' },
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] },
            queryParams: { type: 'object', properties: queryParams, additionalProperties: false },
          },
          required: ['type', 'method'],
          additionalProperties: false,
        },
      },
      required: ['input'],
    },
  }
}

/** The `_x402` DNS TXT pointer record (experimental draft). */
export interface X402DnsRecord {
  name: string
  type: 'TXT'
  value: string
}

/* ----------------------------- helpers ----------------------------- */

/** Path key for an OpenAPI document — the URL's pathname (defaults to '/'). */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname || '/'
  } catch {
    // Tolerate a bare path string (not a full URL) — use it verbatim.
    return url.startsWith('/') ? url : `/${url}`
  }
}

/* ----------------------------- emitters ----------------------------- */

/**
 * Build a `/openapi.json` document — the OpenAPI-first discovery doc the live
 * open indexes parse. One path per resource (grouped by pathname, keyed by
 * method), each paid operation carrying `x-payment-info` with the resource's
 * rails. Ownership proofs (if any) ride at `x-agentcash-provenance`.
 *
 * The merchant serves the result at `https://<origin>/openapi.json`. Pure — no
 * network, no chain library, fully deterministic.
 */
export function buildOpenApi(input: ManifestInput): OpenApiDocument {
  const paths: OpenApiDocument['paths'] = {}
  for (const r of input.resources) {
    const path = pathOf(r.url)
    const method = (r.method ?? 'GET').toLowerCase()
    const op: OpenApiOperation = {
      ...(r.description ? { summary: r.description } : {}),
      responses: {
        '200': { description: 'Paid — the resource.' },
        '402': { description: 'Payment required (x402).' },
      },
      'x-payment-info': {
        x402Version: 2,
        accepts: r.accepts,
      },
    }
    // OpenAPI keys an operation by (path, method): if two resources resolve to the same pathname
    // AND method (e.g. two query-string variants of `GET /search`), the later one's `x-payment-info`
    // overwrites the earlier — give same-path resources distinct methods or paths to list both.
    paths[path] = { ...(paths[path] ?? {}), [method]: op }
  }
  return {
    openapi: '3.1.0',
    info: { title: input.title ?? 'PipRail x402 resources', version: input.version ?? '1.0.0' },
    servers: [{ url: input.origin }],
    paths,
    // "Built with @piprail/sdk" — default on (opt out with attribution:false). At the
    // document ROOT so `info` stays exactly { title, version }.
    ...(input.attribution === false ? {} : { 'x-generator': GENERATOR }),
    ...(input.ownershipProofs && input.ownershipProofs.length > 0
      ? { 'x-agentcash-provenance': { ownershipProofs: input.ownershipProofs } }
      : {}),
  }
}

/**
 * Build the `/.well-known/x402` origin file (x402scan's legacy bulk-register
 * format): the list of discoverable resource URLs + optional ownership proofs.
 * `/openapi.json` is the primary doc; this is a compatibility breadcrumb.
 */
export function buildWellKnownX402(input: ManifestInput): WellKnownX402 {
  return {
    version: 1,
    resources: input.resources.map((r) => r.url),
    ...(input.ownershipProofs && input.ownershipProofs.length > 0
      ? { ownershipProofs: input.ownershipProofs }
      : {}),
  }
}

/**
 * Build the official `/.well-known/x402.json` manifest (x402-foundation PR #2646 shape) — a
 * SECOND, richer discovery file beside the legacy {@link buildWellKnownX402}. Forward-compatible
 * by design: it emits only the fields the proposal defines, tolerates the spec adding more, and
 * pins nothing (the PR is explicitly pre-merge), so when #2646 stabilises only this one emitter
 * (and the docs recommendation) move — no default ever changed. `lastUpdated` defaults to now
 * (Unix seconds); pass it explicitly for a deterministic file. PURE — no network, no chain
 * library, fully deterministic given its args. The merchant hosts the result; PipRail serves nothing.
 */
export function buildWellKnownX402Manifest(
  input: ManifestInput & { lastUpdated?: number }
): WellKnownX402Manifest {
  return {
    x402Version: 2,
    lastUpdated: input.lastUpdated ?? Math.floor(Date.now() / 1000),
    items: input.resources.map((r) => ({
      resource: {
        url: r.url,
        ...(r.description ? { description: r.description } : {}),
        ...(r.mimeType ? { mimeType: r.mimeType } : {}),
      },
      type: 'http' as const,
      accepts: r.accepts,
      input: { method: (r.method ?? 'GET').toUpperCase() },
      ...(r.mimeType ? { output: { mimeType: r.mimeType } } : {}),
    })),
  }
}

/**
 * Build the `_x402` DNS TXT record (experimental draft) that POINTS at a
 * discovery doc. `host` is the exact host the agent talks to (no inheritance);
 * `discoveryUrl` is the HTTPS manifest (typically `https://<origin>/openapi.json`).
 * Returns the record name + value to paste into the zone — PipRail never touches DNS.
 */
export function buildX402DnsTxt(input: {
  host: string
  discoveryUrl: string
  descriptor?: string
}): X402DnsRecord {
  const descriptor = input.descriptor ? `descriptor=${input.descriptor};` : ''
  return {
    name: `_x402.${input.host}`,
    type: 'TXT',
    value: `v=x4021;${descriptor}url=${input.discoveryUrl}`,
  }
}
