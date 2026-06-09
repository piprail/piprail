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
  /** `onchain-proof` (PipRail's default) or the standard `exact` rail (dual-advertise). */
  scheme: 'onchain-proof' | 'exact'
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
}

/** One discoverable resource: its URL, how to call it, and how to pay it. */
export interface ResourceDescription {
  /** The full URL of the gated resource. */
  url: string
  /** HTTP method the resource answers on. Default 'GET'. */
  method?: string
  /** Human description (shown to agents browsing an index). */
  description?: string
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
   * be listed. Produce one with the driver's `signMessage(wallet, origin)`.
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
    /** Bazaar-style input schema marker so a strict index doesn't "skip" the op. */
    bazaar: { discoverable: true }
  }
}

/** x402scan's legacy origin file (`/.well-known/x402`). */
export interface WellKnownX402 {
  version: 1
  resources: string[]
  ownershipProofs?: string[]
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
        bazaar: { discoverable: true },
      },
    }
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
