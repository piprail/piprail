/**
 * THE LAB RUNNERS: every test on /demo, calling the real SDK.
 *
 * Served as a plain ES module out of `public/`, on purpose. The lab loads @piprail/sdk from
 * a CDN at runtime and hands it in here, so nothing about this file is bundled, transformed
 * or pinned at build time. That matters more than it sounds: the page's whole claim is that
 * it runs the PUBLISHED package, and a build step between the two is exactly how a page ends
 * up demonstrating a version nobody can install.
 *
 * Contract with the page:
 *   RUNNERS[id](ctx) -> { data, view }   `data` feeds the json tab, `view` is drawn HTML.
 *   ctx = { sdk, config(), burnerKey(), logos, LIVE_402, ORIGIN }
 *
 * Ids must match `site/src/lib/lab/manifest.ts` in both directions; `npm run lab:coverage`
 * fails otherwise, and it also fails when a public SDK symbol is exercised by nothing here.
 *
 * House rule for a runner: call the real thing, show what came back, and when a call cannot
 * work in a browser say WHY in the output rather than letting it read as broken.
 */

/* ------------------------------- the view kit ------------------------------- */

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export const dump = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2)

export const short = (s, n = 10) =>
  String(s ?? '').length > n * 2 ? `${String(s).slice(0, n)}…${String(s).slice(-4)}` : String(s ?? '')

export const card = (title, body, tone = '') => `<div class="lab-card ${tone}"><p class="lab-card-t">${esc(title)}</p>${body}</div>`
export const kv = (rows) =>
  `<dl class="lab-kv">${rows.filter(Boolean).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`
export const big = (value, unit, label) =>
  `<div class="lab-big"><span class="lab-big-v">${esc(value)}<em>${esc(unit ?? '')}</em></span><span class="lab-big-l">${esc(label)}</span></div>`
export const pill = (text, tone = 'n') => `<span class="lab-pill lab-${tone}">${esc(text)}</span>`
export const bar = (pct, tone = 'ok') =>
  `<div class="lab-bar"><i class="lab-${tone}" style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>`
export const note = (text) => `<p class="lab-note">${esc(text)}</p>`
export const row = (cells) => `<div class="lab-row">${cells.join('')}</div>`
export const grid2 = (cards) => `<div class="lab-grid2">${cards.join('')}</div>`
export const pre = (text, wrap = true) => `<pre class="lab-pre${wrap ? ' lab-wrap' : ''}">${esc(text)}</pre>`
export const chips = (items) => `<div class="lab-chips">${items.join('')}</div>`

export const verdict = (tone, title, sub) =>
  `<div class="lab-verdict is-${tone}"><span class="lab-verdict-i">${tone === 'ok' ? '✓' : tone === 'bad' ? '✕' : '!'}</span>` +
  `<div><p class="lab-verdict-t">${esc(title)}</p><p class="lab-verdict-s">${esc(sub)}</p></div></div>`

/** A requirement the reader would otherwise hit as confusion. Drawn at the TOP of the panel. */
export const needs = (text) =>
  `<div class="lab-needs"><span class="lab-needs-k">needs</span><span>${esc(text)}</span></div>`

/**
 * Show one call and its result, side by side.
 *
 * The lab's job is not to look busy, it is to make the reader believe the SDK does what the
 * docs say. A row that names the exact call next to the exact value it returned is the whole
 * mechanism: nothing is paraphrased, so nothing can quietly be wrong.
 */
export const call = (signature, result, tone = 'ok') =>
  `<div class="lab-call is-${tone}"><code class="lab-call-c">${esc(signature)}</code><span class="lab-call-r">${result}</span></div>`

export const calls = (rows) => `<div class="lab-calls">${rows.join('')}</div>`

/** Never let one optional call take the whole panel down. Returns a rendered `call` row. */
function tryCall(signature, fn, render) {
  try {
    const value = fn()
    return { ok: true, value, html: call(signature, (render ?? ((v) => `<code>${esc(shortVal(v))}</code>`))(value)) }
  } catch (err) {
    return { ok: false, value: undefined, html: call(signature, pill(String(err?.message ?? err).slice(0, 80), 'bad'), 'bad') }
  }
}

const shortVal = (v) => {
  if (v === undefined) return 'undefined'
  if (v === null) return 'null'
  if (typeof v === 'string') return v.length > 70 ? `${v.slice(0, 70)}…` : v
  if (typeof v === 'bigint') return `${v}n`
  if (typeof v === 'function') return `ƒ ${v.name || 'anonymous'}()`
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? '' : 's'}]`
  if (typeof v === 'object') {
    const s = dump(v)
    return s.length > 90 ? `{${Object.keys(v).slice(0, 4).join(', ')}${Object.keys(v).length > 4 ? ', …' : ''}}` : s.replace(/\s+/g, ' ')
  }
  return String(v)
}

/* --------------------------------- fixtures --------------------------------- */

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const BASE_NET = 'eip155:8453'

/** A throwaway key, made here, never stored or sent. It holds nothing, which is the point:
 *  every shortfall the lab shows is the real one a fresh agent sees before anyone funds it. */
const randomKey = () => {
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  return '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

/** A synthetic settled receipt, for the pure wire tests that must not invent a real payment. */
const fixtureReceipt = (over = {}) => ({
  scheme: 'onchain-proof',
  success: true,
  network: BASE_NET,
  transaction: '0x' + 'ab'.repeat(32),
  asset: USDC_BASE,
  amount: '10000',
  payer: '0x1111111111111111111111111111111111111111',
  payTo: '0x2222222222222222222222222222222222222222',
  verifiedAt: new Date().toISOString(),
  ...over,
})

const gateFor = (sdk, c) =>
  sdk.createPaymentGate({
    chain: c.chain,
    token: c.token,
    amount: c.amount,
    payTo: c.payTo,
    description: 'Real-time market intelligence',
    mimeType: 'application/json',
  })

/* --------------------------------- runners --------------------------------- */

export const RUNNERS = {
  /* ═══════════════════════════════ Setup ═══════════════════════════════ */

  chains: ({ sdk, logos }) => {
    const rows = Object.entries(sdk.CHAINS).map(([slug, p]) => ({
      slug,
      chainId: p.chain.id,
      name: p.chain.name,
      gasCoin: p.chain.nativeCurrency.symbol,
      presetTokens: Object.keys(p.tokens),
    }))
    const logo = (slug, name) =>
      logos.has(slug)
        ? `<img src="/chains/${esc(slug)}.svg" alt="" width="18" height="18" loading="lazy" class="lab-chain-i" />`
        : `<span class="lab-chip-fallback">${esc((name || slug || '?').slice(0, 2))}</span>`

    const grid = rows
      .map(
        (r) =>
          `<div class="lab-chain">${logo(r.slug, r.name)}<span class="lab-chain-n">${esc(r.name)}</span><span class="lab-chain-g">${esc(r.gasCoin)}</span></div>`
      )
      .join('')

    // The preset is a convenience, not a gate. Bind a chain the SDK has never heard of and it
    // still resolves: that is the difference between a chain LIST and a chain PARAMETER.
    const preset = tryCall("resolveChain('base')", () => sdk.resolveChain('base'), (v) =>
      `<code>${esc(v.chain.name)} · id ${v.chain.id} · gas ${v.chain.nativeCurrency.symbol}</code>`
    )
    const adhoc = tryCall(
      "resolveChain({ id: 5000, rpcUrl: '…' })",
      () => sdk.resolveChain({ id: 5000, rpcUrl: 'https://rpc.mantle.xyz' }),
      (v) => `<code>id ${esc(v.chain.id)} · gas ${esc(v.chain.nativeCurrency.symbol)}</code>`
    )

    // registerDriver is the plug-in seam the whole multi-chain design rests on. Registering
    // under a family name no real chain uses is inert, and proves the seam is open code.
    const stub = {
      family: 'lab-demo',
      resolve: () => ({ network: 'lab:0', asset: 'LAB', decimals: 0 }),
    }
    const registered = tryCall('registerDriver({ family: "lab-demo", … })', () => {
      sdk.registerDriver(stub)
      return 'registered'
    })

    const noTokens = rows.filter((r) => r.presetTokens.length === 0).length
    return {
      data: { evmPresets: rows.length, nativeCoinOnly: noTokens, chains: rows },
      view:
        row([big(String(rows.length), '', 'EVM presets'), big('9', '', 'non-EVM families'), big(String(noTokens), '', 'native-coin only')]) +
        card('every preset, with its gas coin', `<div class="lab-chain-grid">${grid}</div>`) +
        card('a chain is a parameter, not an allowlist', calls([preset.html, adhoc.html, registered.html])) +
        note(
          'The gas coin is the point of a preset: bind an unpreseted chain as { id, rpcUrl } and it reports ETH, which denominates every gas estimate in the wrong unit. Chains showing no token ship no stablecoin preset on purpose, because the ones deployed there are bridged rather than issuer-native.'
        ) +
        note(
          'registerDriver is how a family gets added at all. The nine non-EVM families register themselves through the same call, lazily, the first time you name one of their chains.'
        ),
    }
  },

  client: async ({ sdk, config }) => {
    const c = config()
    const policy = { maxAmount: '0.10', maxTotal: '1.00', maxPayments: 25 }
    const client = new sdk.PipRailClient({ chain: c.chain, wallet: { key: randomKey() }, policy })

    const address = await client.address().catch((e) => `unavailable (${e?.code ?? 'error'})`)
    const rows = [
      call('client.chain()', `<code>${esc(String(client.chain()))}</code>`),
      call('await client.address()', `<code>${esc(short(address, 14))}</code>`),
      call('client.mode()', pill(String(client.mode()), 'accent')),
      call('client.policy()', `<code>${esc(dump(client.policy()).replace(/\s+/g, ' '))}</code>`),
      call('client.swapPolicy()', client.swapPolicy() ? `<code>${esc(dump(client.swapPolicy()).replace(/\s+/g, ' '))}</code>` : pill('undefined · swapping is off', 'warn')),
      call('client.canAgentSell?.()', client.canAgentSell ? pill(String(client.canAgentSell()), client.canAgentSell() ? 'ok' : 'bad') : pill('not in this mode', 'n')),
      call('client.canAgentSwap?.()', client.canAgentSwap ? pill(String(client.canAgentSwap()), client.canAgentSwap() ? 'ok' : 'bad') : pill('not in this mode', 'n')),
    ]

    const modes = sdk.AGENT_MODES.map((m) =>
      pill(m + (m === sdk.DEFAULT_AGENT_MODE ? ' · default' : ''), m === sdk.DEFAULT_AGENT_MODE ? 'ok' : 'n')
    )

    return {
      data: {
        chain: client.chain(),
        address,
        mode: client.mode(),
        policy: client.policy(),
        swapPolicy: client.swapPolicy() ?? null,
        modes: sdk.AGENT_MODES,
        defaultMode: sdk.DEFAULT_AGENT_MODE,
      },
      view:
        row([big(String(client.chain()), '', 'bound chain'), big(String(client.mode()), '', 'agent mode'), big(String(sdk.AGENT_MODES.length), '', 'modes available')]) +
        card('what this client will and will not do', calls(rows)) +
        card('the modes', chips(modes)) +
        note(
          'One constructor, one chain, one wallet. Everything the client is allowed to do is readable off it before you call anything, which is what lets a supervising process decide whether to hand a model this client at all.'
        ) +
        note(
          'Selling and swapping are absent by default rather than merely discouraged. Raising the mode is a deliberate act, and the client still refuses anything the policy has not sized.'
        ),
    }
  },

  errors: ({ sdk }) => {
    // Every typed error, instantiated for real. The `.code` is the contract: it survives
    // minification, which is precisely why the panel leads with it rather than a class name.
    const names = [
      'InsufficientFundsError', 'RecipientNotReadyError', 'WrongChainError', 'PaymentTimeoutError',
      'MaxRetriesExceededError', 'PaymentDeclinedError', 'ConfirmationTimeoutError', 'SettlementError',
      'InvalidEnvelopeError', 'InvalidConfigError', 'NoCompatibleAcceptError', 'UnsupportedSchemeError',
      'NonReplayableBodyError', 'WalletRequiredError', 'WrongFamilyError', 'UnknownTokenError',
      'MissingDriverError', 'UnsupportedNetworkError',
    ]
    const made = names.map((n) => {
      const e = new sdk[n]('example')
      return { name: n, code: e.code, isPipRailError: e instanceof sdk.PipRailError, isError: e instanceof Error }
    })

    const table = made
      .map((m) => `<div class="lab-tool"><code>${esc(m.code)}</code><span class="lab-tool-d">${esc(m.name)}</span>${pill(m.isPipRailError ? 'PipRailError' : 'plain', m.isPipRailError ? 'ok' : 'bad')}</div>`)
      .join('')

    // The two helpers a caller actually reaches for: normalise a raw chain error, and turn
    // any decline into one sentence a human or a model can act on.
    const raw = new Error('insufficient funds for gas * price + value')
    const normalised = sdk.toInsufficientFundsError(raw)
    const notFunds = sdk.toInsufficientFundsError(new Error('nonce too low'))

    const helpers = calls([
      call('toInsufficientFundsError(new Error("insufficient funds for gas…"))', normalised ? pill(normalised.code, 'ok') : pill('null', 'bad')),
      call('toInsufficientFundsError(new Error("nonce too low"))', notFunds ? pill(notFunds.code, 'bad') : pill('null · correctly not funds', 'ok')),
      call('explainDecline(new InsufficientFundsError("…"))', `<code>${esc(sdk.explainDecline(new sdk.InsufficientFundsError('needs 0.05 USDC, holds 0')))}</code>`),
      call('explainDecline(new WrongChainError("…"))', `<code>${esc(sdk.explainDecline(new sdk.WrongChainError('challenge is on Solana, client is on Base')))}</code>`),
    ])

    return {
      data: { count: made.length, errors: made },
      view:
        row([big(String(made.length), '', 'typed errors'), big(String(made.filter((m) => m.isPipRailError).length), '', 'extend PipRailError'), big('1', '', 'stable field: .code')]) +
        card('every code a caller can branch on', `<div class="lab-tools">${table}</div>`) +
        card('turning any failure into something actionable', helpers) +
        note(
          'Branch on .code, never on the class name or the message. A bundler renames the class and a copy-edit changes the wording, but the code is part of the contract and is pinned by tests.'
        ) +
        note(
          'The distinction the list is built around: INSUFFICIENT_FUNDS means fund the payer, RECIPIENT_NOT_READY means the recipient has not set up to receive. Different fix, different party, so they are different codes.'
        ),
    }
  },

  /* ═══════════════════════════════ Merchant ═══════════════════════════════ */

  gate: async ({ sdk, config }) => {
    const c = config()
    const { challenge, requiredHeader } = await gateFor(sdk, c).challenge()
    const rails = (challenge.accepts || [])
      .map((a) =>
        card(
          a.scheme,
          kv([
            ['network', `<code>${esc(a.network)}</code>`],
            ['amount', `<code>${esc(a.amount ?? a.maxAmountRequired)}</code> base units`],
            ['asset', `<code>${esc(short(a.asset, 14))}</code>`],
            ['payTo', `<code>${esc(short(a.payTo, 12))}</code>`],
            ['expires in', `${esc(a.maxTimeoutSeconds)}s`],
          ]),
          'lab-accent'
        )
      )
      .join('')

    return {
      data: { challenge, requiredHeader },
      view:
        row([
          big(c.amount, c.token === 'native' ? '' : ` ${c.token}`, `priced on ${c.chainName}`),
          big(String((challenge.accepts || []).length), '', 'rails offered'),
          big('v' + challenge.x402Version, '', 'x402 envelope'),
        ]) +
        `<div class="lab-grid2">${rails}</div>` +
        note(
          'A real challenge object, built offline. A buyer reads accepts[], picks a rail it can pay, and retries with proof. Change the chain above and watch the asset and address change with it.'
        ) +
        note('No key was involved. A gate holds no secret, because verifying a payment needs only public chain data and the address you already published.'),
    }
  },

  wire: async ({ sdk, config }) => {
    const { challenge } = await gateFor(sdk, config()).challenge()
    const header = sdk.buildChallengeHeader(challenge)
    const decoded = sdk.decodeBase64Json(header)

    // A challenge does not only travel as a header. Round-trip it through a real Response
    // the way a client would receive it, so the parse path is the one that ships.
    const res402 = new Response(JSON.stringify(challenge), {
      status: 402,
      headers: { [sdk.HEADER_REQUIRED]: header, 'content-type': 'application/json' },
    })
    const reparsed = await sdk.parseChallenge(res402)

    // The v1 shape a five-year-old client still emits, normalised into the v2 envelope.
    const v1Body = {
      x402Version: 1,
      error: 'X-PAYMENT header is required',
      accepts: [
        {
          scheme: 'exact',
          network: 'base',
          maxAmountRequired: '10000',
          resource: 'https://example.test/report',
          description: 'A report',
          mimeType: 'application/json',
          payTo: '0x2222222222222222222222222222222222222222',
          maxTimeoutSeconds: 60,
          asset: USDC_BASE,
          extra: { name: 'USD Coin', version: '2' },
        },
      ],
    }
    const normalised = sdk.normalizeV1Challenge(v1Body)
    const v1Header = sdk.buildV1PaymentHeader({
      scheme: 'exact',
      network: 'base',
      payload: { authorization: { from: '0x11', to: '0x22', value: '10000' }, signature: '0xdead' },
    })

    const headers = calls([
      call('HEADER_REQUIRED', `<code>${esc(sdk.HEADER_REQUIRED)}</code>`),
      call('HEADER_SIGNATURE', `<code>${esc(sdk.HEADER_SIGNATURE)}</code>`),
      call('HEADER_RESPONSE', `<code>${esc(sdk.HEADER_RESPONSE)}</code>`),
      call('HEADER_SIGNATURE_V1', `<code>${esc(sdk.HEADER_SIGNATURE_V1)}</code>`),
      call('HEADER_RESPONSE_V1', `<code>${esc(sdk.HEADER_RESPONSE_V1)}</code>`),
    ])

    const roundTrip = calls([
      call('buildChallengeHeader(challenge)', `<code>${esc(header.length)} bytes of base64</code>`),
      call('decodeBase64Json(header).x402Version', `<code>${esc(String(decoded?.x402Version))}</code>`),
      call('await parseChallenge(response402)', reparsed ? pill(`${reparsed.accepts.length} rail(s) recovered`, 'ok') : pill('null', 'bad')),
      call('normalizeV1Challenge(v1Body)', normalised ? pill(`v1 → v${normalised.x402Version}`, 'ok') : pill('null', 'bad')),
      call('buildV1PaymentHeader({ scheme, network, payload })', `<code>${esc(v1Header.length)} bytes</code>`),
    ])

    return {
      data: { header, bytes: header.length, decoded, reparsed, normalisedFromV1: normalised, v1Header },
      view:
        row([big(String(header.length), 'B', 'header size'), big('base64', '', 'encoding'), big('v1 + v2', '', 'shapes read')]) +
        card('payment-required', pre(header)) +
        card('the round trip', roundTrip) +
        card('every header name in the protocol', headers) +
        card('what a human reads', pre(sdk.describeChallenge(challenge))) +
        note(
          'One header carries the whole challenge, so any HTTP client can read it without a PipRail dependency. The wire is the contract, which is why it is pinned by tests rather than described in prose.'
        ) +
        note(
          'The v1 shape still exists in the wild, and a client that rejects it simply cannot buy from those servers. Reading both costs one function and is the difference between working against the x402 web and working against part of it.'
        ),
    }
  },

  verify: async ({ sdk, config }) => {
    const c = config()
    const gate = gateFor(sdk, c)
    const { challenge } = await gate.challenge()
    const accepted = challenge.accepts[0]

    // A proof that is well formed and completely false: the right nonce, a transaction that
    // does not exist. This is the shape an attacker sends, so it is the shape worth showing.
    const forged = {
      x402Version: 2,
      accepted,
      payload: { nonce: accepted.nonce ?? challenge.nonce ?? 'lab-nonce', txHash: '0x' + 'de'.repeat(32) },
    }
    const header = sdk.buildSignatureHeader(forged)
    const reparsed = sdk.parseSignatureHeader(header)
    const fromObject = sdk.parseSignatureObject(forged)

    const viaHeader = await gate.verify(header)
    const viaObject = await gate.verifyObject(forged)
    const body = sdk.toInvalidBody(viaHeader)

    const outcome = (label, r) =>
      card(
        label,
        kv([
          ['valid', r.ok ? pill('yes', 'bad') : pill('no', 'ok')],
          ['code', r.code ? pill(r.code, 'bad') : pill('none', 'n')],
          ['detail', esc(r.detail ?? r.reason ?? 'no detail')],
        ]),
        r.ok ? 'lab-rose' : 'lab-accent'
      )

    return {
      data: { forged, header, reparsed, fromObject, viaHeader, viaObject, invalidBody: body },
      view:
        verdict(
          viaHeader.ok ? 'bad' : 'ok',
          viaHeader.ok ? 'A forged proof was ACCEPTED' : 'The forged proof was refused',
          viaHeader.ok
            ? 'This should never happen. Please open an issue.'
            : `Rejected with ${viaHeader.code ?? 'an error code'}, before anything was served.`
        ) +
        grid2([outcome('gate.verify(header)', viaHeader), outcome('gate.verifyObject(payload)', viaObject)]) +
        card(
          'the signature round trip',
          calls([
            call('buildSignatureHeader(proof)', `<code>${esc(header.length)} bytes</code>`),
            call('parseSignatureHeader(header)', reparsed ? pill('recovered', 'ok') : pill('null', 'bad')),
            call('parseSignatureObject(proof)', fromObject ? pill('recovered', 'ok') : pill('null', 'bad')),
            call('toInvalidBody(result)', `<code>${esc(dump(body).replace(/\s+/g, ' ').slice(0, 90))}</code>`),
          ])
        ) +
        note(
          'Verification re-derives every checked field from the challenge the gate itself issued, never from the proof the client sent. That is what stops a forged echo redirecting the check at a transaction the attacker chose.'
        ) +
        note(
          'The refusal is a value, not an exception. A gate answers a bad proof with a fresh 402 carrying the reason, so a buyer that made an honest mistake can correct it and retry.'
        ),
    }
  },

  selftest: async ({ sdk, config }) => {
    const r = await gateFor(sdk, config()).selfTest()
    const rails = (r.rails || [])
      .map((rail) =>
        card(
          `${rail.symbol || 'asset'} on ${rail.network}`,
          kv([
            ['amount', `<code>${esc(rail.amount)}</code>`],
            ['decimals', String(rail.decimals)],
            ['asset', `<code>${esc(short(rail.asset, 14))}</code>`],
            ['schemes', (rail.schemes || []).map((s) => pill(s, 'ok')).join('')],
          ])
        )
      )
      .join('')
    const warnings = r.warnings || []
    const warnCard = warnings.length ? card('warnings', warnings.map((w) => `<p class="lab-warn-t">${esc(w)}</p>`).join(''), 'lab-amber') : ''

    return {
      data: r,
      view:
        verdict(
          r.ok ? 'ok' : 'bad',
          r.ok ? 'This gate is payable' : 'This gate would refuse buyers',
          warnings.length ? `${warnings.length} warning(s) to read below.` : 'No warnings. Every rail it advertises resolves.'
        ) +
        `<div class="lab-grid2">${rails}</div>${warnCard}` +
        note('Run this in CI. It catches a wrong address, an unpriceable token or a dead RPC before a buyer ever sees a 402.'),
    }
  },

  presets: async ({ sdk, config }) => {
    const c = config()
    const paywall = sdk.createPaywall({ chain: c.chain, token: c.token, amount: c.amount, payTo: c.payTo })
    const tipJar = sdk.createTipJar({ chain: c.chain, token: c.token, min: c.amount, payTo: c.payTo })
    const [pw, tj] = await Promise.all([paywall.challenge(), tipJar.challenge()])

    // The adapters are not descriptions of how to mount a gate, they mount it. Run the fetch
    // handler here, in the tab, and read the 402 it produces.
    const serve = () => new Response(JSON.stringify({ secret: 42 }), { headers: { 'content-type': 'application/json' } })
    const handler = sdk.toFetchHandler(paywall, serve)
    const unpaid = await handler(new Request('https://example.test/report'))
    const worker = sdk.toWorker(paywall, serve)
    const middleware = sdk.requirePayment({ chain: c.chain, token: c.token, amount: c.amount, payTo: c.payTo })
    const proxy = sdk.proxyTo('https://api.example.test')

    return {
      data: {
        paywall: pw.challenge,
        tipJar: tj.challenge,
        fetchHandler: { status: unpaid.status, header: unpaid.headers.get(sdk.HEADER_REQUIRED)?.slice(0, 48) + '…' },
        worker: Object.keys(worker),
        middlewareArity: middleware.length,
      },
      view:
        row([big(String(unpaid.status), '', 'status from the handler'), big('4', '', 'ways to mount'), big('1', '', 'gate behind them all')]) +
        card(
          'the adapters, actually running',
          calls([
            call('toFetchHandler(gate, serve)(new Request(…))', pill(`HTTP ${unpaid.status}`, unpaid.status === 402 ? 'ok' : 'bad')),
            call('  → payment-required header', unpaid.headers.get(sdk.HEADER_REQUIRED) ? pill('present', 'ok') : pill('missing', 'bad')),
            call('toWorker(gate, serve)', `<code>{ ${esc(Object.keys(worker).join(', '))} }</code>`),
            call('requirePayment({ … })', `<code>ƒ (req, res, next) · arity ${esc(middleware.length)}</code>`),
            call("proxyTo('https://api.example.test')", `<code>ƒ ${esc(typeof proxy)}</code>`),
          ])
        ) +
        grid2([
          card('createPaywall · a fixed price', kv([
            ['scheme', pill(pw.challenge.accepts[0].scheme, 'ok')],
            ['amount', `<code>${esc(pw.challenge.accepts[0].amount ?? pw.challenge.accepts[0].maxAmountRequired)}</code>`],
          ]), 'lab-accent'),
          card('createTipJar · a floor, pay more if you like', kv([
            ['scheme', pill(tj.challenge.accepts[0].scheme, 'ok')],
            ['minimum', `<code>${esc(tj.challenge.accepts[0].amount ?? tj.challenge.accepts[0].maxAmountRequired)}</code>`],
          ]), 'lab-accent'),
        ]) +
        note(
          'The same gate object mounts on Express, on any Request-to-Response runtime, on a Cloudflare Worker, or in front of an origin you do not control. Nothing about the payment logic changes with the runtime.'
        ) +
        note('The 402 above came out of the SDK in this browser tab. There is no server in this test at all.'),
    }
  },

  describe: async ({ sdk, config, LIVE_402 }) => {
    const c = config()
    const input = {
      origin: 'https://piprail.com',
      resources: [
        {
          url: LIVE_402,
          method: 'GET',
          description: 'Real-time market intelligence',
          mimeType: 'application/json',
          accepts: [{ scheme: 'onchain-proof', network: BASE_NET, asset: 'USDC', amount: c.amount, payTo: c.payTo }],
        },
      ],
    }
    const wellKnown = sdk.buildWellKnownX402(input)
    const manifest = sdk.buildWellKnownX402Manifest(input)
    const openApi = sdk.buildOpenApi(input)
    const dns = sdk.buildX402DnsTxt({ host: 'piprail.com', discoveryUrl: 'https://piprail.com/.well-known/x402' })
    const bazaar = sdk.buildBazaarExtension({ summary: 'Real-time market intelligence', method: 'GET' })
    const headers = sdk.discoveryHeaders({ attribution: true })
    const described = await gateFor(sdk, c).describe(LIVE_402)

    return {
      data: { wellKnown, manifest, openApi, dnsTxt: dns, bazaarExtension: bazaar, headers, described },
      view:
        row([big(String(Object.keys(headers).length), '', 'response headers'), big(String(manifest.items.length), '', 'manifest items'), big('4', '', 'discovery formats')]) +
        grid2([
          card('/.well-known/x402', pre(dump(wellKnown), false)),
          card('/.well-known/x402 · manifest form', pre(dump(manifest), false)),
        ]) +
        grid2([
          card('/openapi.json', pre(dump(openApi).slice(0, 700) + '…', false)),
          card('DNS TXT', pre(`${dns.name}\n${dns.value}`)),
        ]) +
        card(
          'the small stuff that makes an index find you',
          calls([
            call('discoveryHeaders({ attribution: true })', `<code>${esc(dump(headers).replace(/\s+/g, ' '))}</code>`),
            call('buildBazaarExtension(descriptor)', `<code>${esc(dump(bazaar).replace(/\s+/g, ' ').slice(0, 90))}…</code>`),
            call('GENERATOR', `<code>${esc(sdk.GENERATOR)}</code>`),
            call('POWERED_BY', `<code>${esc(sdk.POWERED_BY)}</code>`),
            call('await gate.describe(url)', `<code>${esc(dump(described).replace(/\s+/g, ' ').slice(0, 90))}…</code>`),
          ])
        ) +
        note(
          'Serve these and the open indexes can find you. PipRail hosts no directory of its own: it reads and writes the ones that already exist, so being discoverable costs you nothing and locks you into nobody.'
        ),
    }
  },

  landing: async ({ sdk, config }) => {
    const c = config()
    const gate = gateFor(sdk, c)
    const { challenge } = await gate.challenge()
    const html = gate.landingPage(challenge)

    const sd = sdk.buildSelfDescription({
      accepts: challenge.accepts,
      instruction: 'Pay any listed rail, then retry with the proof header.',
      endpoint: sdk.buildEndpointInfo({ description: 'Real-time market intelligence', mimeType: 'application/json' }),
    })
    const standalone = sdk.renderLandingPage(sd)

    return {
      data: { selfDescription: sd, brand: sdk.BRAND, landingBytes: html.length, standaloneBytes: standalone.length },
      view:
        row([big(String(Math.round(html.length / 1024)), 'KB', 'landing page'), big(String(sd.accepts?.length ?? challenge.accepts.length), '', 'rails explained'), big('0', '', 'external requests')]) +
        card(
          'what a human sees when they open a paid URL',
          `<iframe class="lab-frame" title="The 402 landing page this gate serves" sandbox="" srcdoc="${esc(html)}"></iframe>`
        ) +
        card(
          'and what a machine reads from the same 402',
          calls([
            call('buildEndpointInfo({ description, mimeType })', `<code>${esc(dump(sd.endpoint ?? {}).replace(/\s+/g, ' ').slice(0, 80))}…</code>`),
            call('buildSelfDescription({ accepts, … })', `<code>${esc(Object.keys(sd).join(', '))}</code>`),
            call('renderLandingPage(selfDescription)', `<code>${esc(standalone.length)} bytes, self-contained</code>`),
            call('BRAND.name', `<code>${esc(sdk.BRAND.name ?? 'PipRail')}</code>`),
          ])
        ) +
        note(
          'A 402 is a dead end for a person unless something explains it. This page is generated from the same accepts[] the machine reads, so the human explanation and the machine contract cannot drift apart.'
        ) +
        note('It is inert HTML with no scripts and no external requests, which is why it can be framed here safely.'),
    }
  },

  receipts: async ({ sdk, ORIGIN }) => {
    const viem = await import('viem')
    const rpcUrl = sdk.CHAINS.base.chain.rpcUrls.default.http[0]
    const pub = viem.createPublicClient({ transport: viem.http(rpcUrl) })

    // Find a REAL settled USDC transfer on Base, right now. Nothing is pinned, nothing is
    // fabricated, and the verifier is pointed at a payment neither we nor you control, which
    // is the only kind of proof worth showing for a verifier.
    const head = await pub.getBlockNumber()
    const transferEvent = viem.parseAbiItem(
      'event Transfer(address indexed from, address indexed to, uint256 value)'
    )
    const transferEvent0 = viem.keccak256(viem.toHex('Transfer(address,address,uint256)'))
    // Public RPCs rate-limit, so ask for a small window and widen it only if empty. A 429
    // here is somebody else's throttle, not a fault in the SDK, and it must not read as one.
    let logs = []
    let readError = null
    for (let back = 0n; back < 300n && logs.length === 0; back += 25n) {
      try {
        logs = await pub.getLogs({ address: USDC_BASE, event: transferEvent, fromBlock: head - back - 24n, toBlock: head - back })
      } catch (err) {
        readError = String(err?.shortMessage ?? err?.message ?? err)
        break
      }
    }
    const candidates = logs.filter((l) => (l.args?.value ?? 0n) > 0n).reverse()
    let log = null
    for (const c of candidates.slice(0, 6)) {
      try {
        const rcpt = await pub.getTransactionReceipt({ hash: c.transactionHash })
        const transfers = rcpt.logs.filter(
          (l) => l.address.toLowerCase() === USDC_BASE.toLowerCase() && l.topics[0] === transferEvent0
        )
        if (transfers.length === 1) { log = c; break }
      } catch { /* try the next one */ }
    }
    log ??= candidates[0] ?? null
    if (!log) {
      return {
        data: { found: 0, head: head.toString(), readError },
        view:
          verdict('warn', readError ? 'The public RPC would not answer just now' : 'No USDC transfer in the last few hundred blocks', readError ? 'Public endpoints throttle. Point the SDK at your own RPC and this reads instantly.' : 'Unusual but not an error. Run it again in a moment.') +
          (readError ? card('what the RPC said', pre(readError)) : '') +
          note('This test verifies a real settlement rather than a fixture, so it needs one to read. Nothing about the verifier changed: it simply had nothing to verify.'),
      }
    }

    const real = {
      piprail: '1',
      receipt: {
        scheme: 'onchain-proof',
        success: true,
        network: BASE_NET,
        transaction: log.transactionHash,
        asset: USDC_BASE,
        amount: log.args.value.toString(),
        payer: log.args.from,
        payTo: log.args.to,
        verifiedAt: new Date().toISOString(),
      },
      resource: { url: 'https://example.test/report' },
      decimals: 6,
    }

    const good = await sdk.PipRailClient.verifyReceipt(real, { rpcUrl })
    // The same receipt, claiming ten times the money. A verifier that passes this is decoration.
    const tampered = { ...real, receipt: { ...real.receipt, amount: (log.args.value * 10n).toString() } }
    const bad = await sdk.PipRailClient.verifyReceipt(tampered, { rpcUrl })

    // Tier 2: the merchant's signature that the resource was SERVED, which no chain can attest.
    const forgedAttestation = {
      ...real,
      attestation: { signature: '0x' + '11'.repeat(65), signer: real.receipt.payTo },
    }
    const attested = await sdk.PipRailClient.verifyAttestation(forgedAttestation)

    // The wire round trip for a settled response.
    const ext = sdk.buildReceiptExtension({ receipt: real.receipt, resource: real.resource, decimals: 6 })
    const header = sdk.buildReceiptHeader(real.receipt, ext)
    const settled = new Response(null, { headers: { [sdk.HEADER_RESPONSE]: header } })
    const parsedReceipt = sdk.parseReceipt(settled)
    const parsedExt = sdk.parseReceiptExtension(settled)

    // Optional payment identifier, the three answers it can give.
    const advert = sdk.buildPaymentIdentifierAdvertisement()
    const idOk = sdk.readPaymentIdentifier({ extensions: { [sdk.EXT_PAYMENT_IDENTIFIER]: { info: { id: 'order-000000000001' } } } })
    const idBad = sdk.readPaymentIdentifier({ extensions: { [sdk.EXT_PAYMENT_IDENTIFIER]: { info: { id: 'too short' } } } })
    const idNone = sdk.readPaymentIdentifier({ extensions: {} })

    // Deliver it somewhere. This origin answers POST with 405, which is a real, honest
    // delivery attempt against a real server without POSTing a stranger's receipt anywhere.
    const delivered = await sdk.deliverReceipt(real.receipt, {
      url: `${ORIGIN}/api/x402-index`,
      retries: 0,
      timeoutMs: 8000,
    })

    const amt = (v) => (Number(v) / 1e6).toFixed(6)

    return {
      data: { real, verified: good, tampered: bad, attestation: attested, header, parsedReceipt, parsedExt, advert, ids: { idOk, idBad, idNone }, delivered },
      view:
        verdict(
          good.ok ? 'ok' : 'bad',
          good.ok ? 'A real Base payment, re-derived from the chain' : 'The live transfer did not verify',
          good.ok
            ? `${amt(real.receipt.amount)} USDC confirmed moving to ${short(real.receipt.payTo, 8)}, read back out of block data a moment ago.`
            : 'Read the onChain block below for what the chain actually says.'
        ) +
        grid2([
          card('the honest receipt', kv([
            ['tx', `<code>${esc(short(real.receipt.transaction, 12))}</code>`],
            ['amount', `<code>${esc(amt(real.receipt.amount))} USDC</code>`],
            ['payTo', `<code>${esc(short(real.receipt.payTo, 10))}</code>`],
            ['verdict', good.ok ? pill('ok', 'ok') : pill('rejected', 'bad')],
            ['re-derived payer', `<code>${esc(short(good.onChain?.payer ?? 'n/a', 10))}</code>`],
            ['matches the claim', good.matchesClaims ? pill('yes', 'ok') : pill('no', 'bad')],
          ]), 'lab-accent'),
          card('the same receipt, claiming 10x', kv([
            ['claimed', `<code>${esc(amt(tampered.receipt.amount))} USDC</code>`],
            ['chain moved', `<code>${esc(amt(real.receipt.amount))} USDC</code>`],
            ['code', bad.error ? pill(bad.error, 'bad') : pill('none', 'n')],
            ['verdict', bad.ok ? pill('ACCEPTED · bug', 'bad') : pill('caught', 'ok')],
          ]), bad.ok ? 'lab-rose' : 'lab-accent'),
        ]) +
        card(
          'the receipt on the wire, and where it goes next',
          calls([
            call('buildReceiptExtension({ receipt, resource, decimals })', `<code>extensions["${esc(sdk.EXT_OFFER_RECEIPT)}"]</code>`),
            call('buildReceiptHeader(receipt, extensions)', `<code>${esc(header.length)} bytes</code>`),
            call('parseReceipt(settledResponse)', parsedReceipt ? pill('recovered', 'ok') : pill('null', 'bad')),
            call('parseReceiptExtension(settledResponse)', parsedExt ? pill('recovered with resource + decimals', 'ok') : pill('null', 'bad')),
            call('verifyAttestation(forgedSignature)', attested.ok ? pill('ACCEPTED · bug', 'bad') : pill('caught, signer mismatch', 'ok')),
            call('await deliverReceipt(receipt, { url })', pill(`${delivered.delivered ? 'delivered' : 'not delivered'} · ${delivered.attempts} POST(s) · HTTP ${delivered.status ?? 'n/a'}`, delivered.delivered ? 'ok' : 'warn')),
          ])
        ) +
        card(
          'the optional payment identifier',
          calls([
            call('buildPaymentIdentifierAdvertisement()', `<code>${esc(Object.keys(advert)[0])}</code>`),
            call('readPaymentIdentifier(validId)', `<code>${esc(String(idOk))}</code>`),
            call('readPaymentIdentifier(shortId)', pill(idBad?.invalid ?? String(idBad), 'warn')),
            call('readPaymentIdentifier(absent)', pill('null · the feature is optional', 'ok')),
          ])
        ) +
        note(
          'Verification re-reads the transaction and compares what actually moved against what the receipt claims. That is why the tampered copy fails: nothing in the receipt is trusted, it is all re-derived from the chain.'
        ) +
        note(
          'The attestation is the second tier, and it answers the one question the chain cannot: was the thing actually served. It is the merchant signing with the same payTo key they already have, so it needs no new infrastructure and no third party.'
        ) +
        note(
          'The delivery attempt above posted to this site so you can watch the retry machinery run against a real server. Point it at your own endpoint and it signs the body with your shared secret.'
        ),
    }
  },

  /* ═══════════════════════════════ Buyer ═══════════════════════════════ */

  quote: async ({ sdk, LIVE_402 }) => {
    const client = new sdk.PipRailClient({ chain: 'base' })
    const q = await client.quote(LIVE_402)
    if (!q) {
      return {
        data: { quote: null },
        view: verdict('warn', 'That endpoint did not answer with a 402', 'It may be temporarily down. Discovery reads and quotes both degrade rather than throw.'),
      }
    }
    // The same rail selection the client just did, run by hand, so the mechanism is visible.
    const res = await fetch(LIVE_402)
    const challenge = await sdk.parseChallenge(res)
    const picked = challenge ? sdk.pickAccept(challenge, (n) => n === BASE_NET) : null

    return {
      data: { quote: q, picked },
      view:
        row([big(q.amountFormatted, ` ${q.symbol}`, 'price'), big(String(q.decimals), 'dp', 'decimals'), big(q.recognized ? 'known' : 'unknown', '', 'token')]) +
        card(
          'what the merchant asked for',
          kv([
            ['resource', `<code>${esc(q.url)}</code>`],
            ['network', `<code>${esc(q.network)}</code>`],
            ['asset', `<code>${esc(short(q.asset, 14))}</code>`],
            ['payTo', `<code>${esc(short(q.payTo, 12))}</code>`],
            ['base units', `<code>${esc(q.amount)}</code>`],
            ['within policy', q.withinPolicy ? pill('yes', 'ok') : pill('no', 'bad')],
            ['symbol mismatch', q.symbolMismatch ? pill('yes', 'bad') : pill('no', 'ok')],
          ]),
          'lab-accent'
        ) +
        card(
          'picking a rail out of the challenge',
          calls([
            call('await parseChallenge(response)', challenge ? pill(`${challenge.accepts.length} rail(s)`, 'ok') : pill('null', 'bad')),
            call("pickAccept(challenge, n => n === 'eip155:8453')", picked ? `<code>${esc(picked.scheme)} on ${esc(picked.network)}</code>` : pill('no match', 'warn')),
          ])
        ) +
        note(
          'A live read of this site’s own 402, over the network, from your browser. The SDK re-derives decimals and symbol from its own registry rather than trusting what the server claimed, which is what makes a spend cap mean anything.'
        ),
    }
  },

  cost: async ({ sdk, LIVE_402 }) => {
    const r = await new sdk.PipRailClient({ chain: 'base' }).estimateCost(LIVE_402)
    if (!r) return { data: null, view: verdict('warn', 'No estimate came back', 'The endpoint did not answer with a 402 just now.') }
    const c = r.cost
    return {
      data: r,
      view:
        row([big(r.quote.amountFormatted, ` ${r.quote.symbol}`, 'you pay'), big(c.feeFormatted, ` ${c.feeSymbol}`, 'gas costs'), big(c.basis, '', 'basis')]) +
        card(
          'gas is a different token from the payment',
          kv([
            ['fee coin', pill(c.feeSymbol, 'ok')],
            ['fee decimals', String(c.feeDecimals)],
            ['base units', `<code>${esc(c.fee)}</code>`],
            ['detail', esc(c.detail || 'n/a')],
          ])
        ) +
        note(
          'You pay in USDC but burn ETH for gas. An agent budgeting only the price runs out of gas mid-task, so this never throws: when RPC is unavailable it degrades to a typical-cost constant and says so in basis.'
        ),
    }
  },

  plan: async ({ sdk, LIVE_402 }) => {
    const client = new sdk.PipRailClient({ chain: 'base', wallet: { key: randomKey() } })
    const plan = await client.planPayment(LIVE_402)
    if (!plan) return { data: null, view: verdict('warn', 'No plan came back', 'The endpoint did not answer with a 402 just now.') }

    const affordable = await client.canAfford(LIVE_402)
    const balances = await client.balanceOf().catch(() => [])
    const options = plan.options || []

    const cards = options
      .map((o) => {
        const q = o.quote || {}
        const cst = o.cost || {}
        const blockers = o.blockers || []
        const has = (code) => blockers.includes(code)
        const need = (label, body, blocked) =>
          `<div class="lab-need ${blocked ? 'is-bad' : 'is-ok'}"><span class="lab-need-l">${esc(label)}</span><span class="lab-need-v">${body}</span>${blocked ? pill('short', 'bad') : pill('ok', 'ok')}</div>`
        const held = (h, n, sym) => `<b>${esc(h)}</b> held of <b>${esc(n)}</b> needed<em> ${esc(sym)}</em>`
        const ready = o.recipient && o.recipient.ready
        return card(
          `${q.symbol || 'rail'} · ${o.accept ? o.accept.scheme : 'rail'}`,
          need('token', held((o.balance && o.balance.token) ?? '0', (o.need && o.need.token) ?? q.amountFormatted, q.symbol || ''), has('INSUFFICIENT_TOKEN')) +
            need('gas', held((o.balance && o.balance.native) ?? '0', (o.need && o.need.native) ?? cst.feeFormatted, cst.feeSymbol || ''), has('INSUFFICIENT_GAS')) +
            need('recipient', ready === 'n/a' ? 'this chain needs no receive setup' : `<b>${esc(String(ready ?? '?'))}</b>`, has('RECIPIENT_NOT_READY')) +
            `<div class="lab-blockers">${blockers.length ? blockers.map((b) => pill(b, 'bad')).join('') : pill('no blockers', 'ok')}${(o.warnings || []).map((w) => pill(w, 'warn')).join('')}</div>`,
          o.state === 'payable' ? 'lab-accent' : 'lab-rose'
        )
      })
      .join('')

    return {
      data: { plan, canAfford: affordable, balances },
      view:
        verdict(plan.payable ? 'ok' : 'bad', plan.payable ? 'This wallet can pay' : 'This wallet cannot pay yet', plan.fundingHint || 'No funding needed.') +
        row([big(plan.status, '', 'status'), big(String(options.length), '', 'rails offered'), big(String(options.filter((o) => o.state === 'payable').length), '', 'rails payable')]) +
        `<div class="lab-grid2">${cards}</div>` +
        card(
          'the same answer, three ways',
          calls([
            call('await client.canAfford(url)', pill(String(affordable), affordable ? 'ok' : 'bad')),
            call('await client.balanceOf()', `<code>${esc(balances.map((b) => `${b.formatted ?? b.balance ?? '0'} ${b.symbol ?? ''}`).join(', ') || 'nothing held')}</code>`),
            call('summarizePlan(plan)', `<code>${esc(sdk.summarizePlan(plan))}</code>`),
          ])
        ) +
        note(
          'Planned from a wallet generated in this tab a moment ago, holding nothing. Every shortfall above is real, and it is exactly what a freshly created agent sees before anyone funds it. Nothing was signed and nothing was broadcast.'
        ) +
        note('summarizePlan is the one-line version, and it exists because a model reasons better over a sentence than over a nested object.'),
    }
  },

  classify: async ({ sdk, config }) => {
    const c = config()
    const { challenge } = await gateFor(sdk, c).challenge()
    const schemes = ['onchain-proof', 'exact']

    // The three answers that matter, from the buyer's point of view.
    const onChain = sdk.classifyChallenge(challenge, { network: challenge.accepts[0].network, schemes })
    const wrongChain = sdk.classifyChallenge(challenge, { network: 'eip155:1', schemes })
    const wrongScheme = sdk.classifyChallenge(challenge, { network: challenge.accepts[0].network, schemes: ['upto'] })

    const verdictCard = (label, t) =>
      card(
        label,
        kv([
          ['verdict', pill(t.verdict, t.verdict === 'payable' ? 'ok' : 'bad')],
          ['on your chain', t.onClientChain ? pill('yes', 'ok') : pill('no', 'bad')],
          ['scheme enabled', t.payableScheme ? pill('yes', 'ok') : pill('no', 'bad')],
          ['offers', t.offeredSchemes.map((s) => pill(s, 'n')).join('')],
        ]),
        t.verdict === 'payable' ? 'lab-accent' : 'lab-rose'
      )

    const norm = ['base', 'eip155:8453', 'Base', 'solana'].map((n) =>
      call(`normalizeNetwork('${n}')`, `<code>${esc(sdk.normalizeNetwork(n))}</code>`)
    )

    return {
      data: { onChain, wrongChain, wrongScheme },
      view:
        row([big(onChain.verdict, '', 'this client'), big(String(onChain.offeredNetworks.length), '', 'networks offered'), big(String(onChain.offeredSchemes.length), '', 'schemes offered')]) +
        grid2([verdictCard('your chain, your schemes', onChain), verdictCard('same challenge, wrong chain', wrongChain)]) +
        grid2([verdictCard('same challenge, scheme you do not run', wrongScheme), card('network names are normalised first', calls(norm))]) +
        note(
          'Triage before you spend a request. A challenge you cannot pay is not an error to retry, it is a fact to route around, and the verdict tells the caller which of the two it is looking at.'
        ),
    }
  },

  policy: ({ sdk }) => {
    const policy = { maxAmount: '0.10', maxTotal: '1.00' }
    const now = Date.now()
    const ctx = { now, sessionStart: now, spentInWindowBase: 0n, paymentCount: 0 }
    const intent = (usd) => ({
      host: 'piprail.com',
      chain: 'base',
      network: BASE_NET,
      asset: USDC_BASE,
      amountBase: BigInt(Math.round(usd * 1e6)),
      decimals: 6,
      symbol: 'USDC',
      recognized: true,
    })
    const attempts = [0.05, 0.5].map((usd) => ({ usd, verdict: sdk.evaluatePolicy(intent(usd), policy, 0n, ctx) }))
    const cap = Number(policy.maxAmount)
    const cards = attempts
      .map(({ usd, verdict: v }) =>
        card(
          `attempt ${usd.toFixed(2)} USDC`,
          `${bar((usd / cap) * 100, v.allowed ? 'ok' : 'bad')}<p class="lab-cap">${usd.toFixed(2)} against a ${cap.toFixed(2)} cap</p>${
            v.allowed ? pill('allowed', 'ok') : `${pill(v.code || 'refused', 'bad')}<p class="lab-warn-t">${esc(v.reason || '')}</p>`
          }`,
          v.allowed ? 'lab-accent' : 'lab-rose'
        )
      )
      .join('')

    const denoms = calls([
      call("denomOf('USDC', asset, policy)", `<code>${esc(String(sdk.denomOf('USDC', USDC_BASE, policy)))}</code>`),
      call("denomOf('WETH', asset, policy)", `<code>${esc(String(sdk.denomOf('WETH', '0x4200000000000000000000000000000000000006', policy)))}</code>`),
      call('DENOM_PRECISION', `<code>${esc(String(sdk.DENOM_PRECISION))}</code>`),
      call('BUILTIN_DENOMS', `<code>${esc(Object.keys(sdk.BUILTIN_DENOMS).slice(0, 8).join(', '))}…</code>`),
    ])

    return {
      data: { policy, attempts, builtinDenoms: sdk.BUILTIN_DENOMS },
      view:
        row([big(policy.maxAmount, ' USDC', 'per payment'), big(policy.maxTotal, ' USDC', 'session total'), big('0', ' USDC', 'spent so far')]) +
        `<div class="lab-grid2">${cards}</div>` +
        card('one cap across many tokens', denoms) +
        note(
          'The engine is pure: it takes the intent, the policy, what has already been spent, and an injected clock. A refusal happens before anything is signed, so an agent cannot exceed its leash even if it tries.'
        ) +
        note(
          'Denominations are why a cap survives contact with reality. Five different dollar stablecoins on four chains are one budget, because they map to one denom rather than to five separate allowances.'
        ),
    }
  },

  budget: ({ sdk }) => {
    const store = sdk.memorySpendStore()
    const ledger = new sdk.SpendLedger(store)
    const mk = (usd, ref) => ({
      url: 'https://piprail.com/x402/demo',
      host: 'piprail.com',
      network: BASE_NET,
      asset: USDC_BASE,
      amountBase: String(Math.round(usd * 1e6)),
      amountFormatted: usd.toFixed(2),
      symbol: 'USDC',
      decimals: 6,
      denom: 'usd',
      ref,
      at: new Date().toISOString(),
    })

    ledger.record(mk(0.01, '0xaaa'), 6, 'usd')
    ledger.record(mk(0.02, '0xbbb'), 6, 'usd')
    // A reservation holds budget while a payment is in flight, so two concurrent payments
    // cannot both fit under a cap that only has room for one.
    const held = ledger.reserve(BASE_NET, USDC_BASE, 5000n, 6, 'usd')
    const duringFlight = ledger.totalFor(BASE_NET, USDC_BASE)
    ledger.release(held)
    const afterRelease = ledger.totalFor(BASE_NET, USDC_BASE)

    const client = new sdk.PipRailClient({
      chain: 'base',
      wallet: { key: randomKey() },
      policy: { maxAmount: '0.10', maxTotal: '1.00', maxPayments: 25 },
      ledger,
    })

    const summary = ledger.summary()
    const fmt = (b) => (Number(b) / 1e6).toFixed(6)

    return {
      data: {
        summary,
        assetBuckets: ledger.assetBuckets(),
        denomBuckets: ledger.denomBuckets(),
        budget: client.budget(),
        spent: client.spent(),
        remaining: client.remaining(),
        denomRemaining: client.denomRemaining(),
        counts: client.countStatus(),
      },
      view:
        row([
          big(fmt(ledger.totalFor(BASE_NET, USDC_BASE)), ' USDC', 'spent'),
          big(String(ledger.count()), '', 'payments'),
          big(String(client.remaining()[0]?.remainingFormatted ?? 'n/a'), ' USDC', 'left this session'),
        ]) +
        card(
          'the ledger',
          calls([
            call('ledger.record(payment, 6, "usd") x2', pill(`${ledger.count()} recorded`, 'ok')),
            call('ledger.totalFor(network, asset)', `<code>${esc(fmt(ledger.totalFor(BASE_NET, USDC_BASE)))} USDC</code>`),
            call('ledger.totalForDenom("usd")', `<code>${esc(fmt(ledger.totalForDenom('usd')))}</code>`),
            call('ledger.reserve(…) while a payment is in flight', `<code>${esc(fmt(duringFlight))} USDC counted</code>`),
            call('ledger.release(token) when it settles or fails', `<code>${esc(fmt(afterRelease))} USDC counted</code>`),
            call('ledger.countSince(Date.now() - 60_000)', `<code>${esc(String(ledger.countSince(Date.now() - 60_000)))}</code>`),
            call('ledger.totalSince(network, asset, since)', `<code>${esc(fmt(ledger.totalSince(BASE_NET, USDC_BASE, ledger.sessionStart)))}</code>`),
            call('ledger.markWarned("80pct")', pill(String(ledger.markWarned('80pct')), 'ok')),
            call('ledger.markWarned("80pct") again', pill(String(ledger.markWarned('80pct')) + ' · fires once', 'n')),
            call('ledger.sessionStart', `<code>${esc(new Date(ledger.sessionStart).toISOString())}</code>`),
          ])
        ) +
        grid2([
          card('by asset', ledger.assetBuckets().map((b) => kv([[b.symbol ?? short(b.asset, 8), `<code>${esc(fmt(b.totalBase))}</code> on <code>${esc(b.network)}</code>`]])).join('') || note('nothing yet')),
          card('by denomination', ledger.denomBuckets().map((b) => kv([[b.denom, `<code>${esc(fmt(b.totalBase ?? b.total ?? 0n))}</code>`]])).join('') || note('nothing yet')),
        ]) +
        card('what the client reports back', pre(sdk.formatSpendReport(client.spent()))) +
        card(
          'the same numbers, as the client sees them',
          calls([
            call('client.spent()', `<code>${esc(dump(client.spent()).replace(/\s+/g, ' ').slice(0, 90))}…</code>`),
            call('client.remaining()', `<code>${esc(dump(client.remaining()).replace(/\s+/g, ' ').slice(0, 90))}…</code>`),
            call('client.denomRemaining()', `<code>${esc(dump(client.denomRemaining()).replace(/\s+/g, ' ').slice(0, 90))}…</code>`),
            call('client.countStatus()', `<code>${esc(dump(client.countStatus()).replace(/\s+/g, ' '))}</code>`),
            call('client.budget().session', `<code>${esc(dump(client.budget().session).replace(/\s+/g, ' '))}</code>`),
          ])
        ) +
        note(
          'The reservation is the part that is easy to leave out and expensive to miss. Without it two payments launched at once each see an empty ledger, both pass the cap, and the agent spends twice its budget while every individual check was correct.'
        ) +
        note('Pass a SpendStore and the same ledger survives a restart, so a budget is a real limit rather than a limit per process.'),
    }
  },

  pay: async ({ sdk, LIVE_402 }) => {
    const client = new sdk.PipRailClient({
      chain: 'base',
      wallet: { key: randomKey() },
      policy: { maxAmount: '0.10', maxTotal: '1.00' },
    })
    const address = await client.address()

    let outcome
    try {
      const res = await client.fetch(LIVE_402)
      outcome = { kind: 'served', status: res.status, body: (await res.text()).slice(0, 300) }
    } catch (err) {
      outcome = { kind: 'refused', code: err?.code ?? 'ERROR', message: String(err?.message ?? err) }
    }

    const receipt = client.lastReceipt()
    const refused = outcome.kind === 'refused'

    return {
      data: { address, outcome, lastReceipt: receipt },
      view:
        (refused
          ? verdict('ok', `Refused with ${outcome.code}`, 'The wallet is empty, so the client stopped before signing anything. This is the whole point: it failed at the cheapest possible moment, with a code you can branch on.')
          : verdict('ok', `Paid and served · HTTP ${outcome.status}`, 'A payment settled and the resource came back.')) +
        row([big(short(address, 8), '', 'burner wallet'), big('0', ' USDC', 'balance'), big(refused ? outcome.code : 'PAID', '', 'outcome')]) +
        card('what happened', refused ? pre(outcome.message) : pre(outcome.body)) +
        card(
          'the three ways to spend',
          calls([
            call('await client.fetch(url)', refused ? pill(outcome.code, 'warn') : pill(`HTTP ${outcome.status}`, 'ok')),
            call('await client.get(url)', pill('same path, GET', 'n')),
            call('await client.post(url, body)', pill('same path, POST with a replayable body', 'n')),
            call('client.lastReceipt()', receipt ? pill('a settled receipt', 'ok') : pill('null · nothing was paid', 'n')),
          ])
        ) +
        note(
          'Fund this wallet and the same call pays and returns the resource, with the receipt on lastReceipt(). Nothing else about the code changes, which is the reason the SDK draws the line at the wallet rather than at a mode flag.'
        ) +
        note(
          'It refused before signing, not after broadcasting. An agent that discovers it is broke by losing gas has already paid for the lesson.'
        ),
    }
  },

  exact: async ({ sdk }) => {
    const { privateKeyToAccount } = await import('viem/accounts')
    const viem = await import('viem')
    const account = privateKeyToAccount(randomKey())
    const chainId = sdk.chainIdForExactNetwork('base')

    const accept = {
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: '10000',
      resource: 'https://example.test/report',
      description: 'A report',
      mimeType: 'application/json',
      payTo: '0x2222222222222222222222222222222222222222',
      maxTimeoutSeconds: 60,
      asset: USDC_BASE,
      extra: { name: 'USD Coin', version: '2' },
    }

    // A real EIP-712 signature over a real EIP-3009 authorization. No funds, no gas, no chain
    // contact: this is the whole reason the gasless rail exists.
    const nonce = viem.toHex(crypto.getRandomValues(new Uint8Array(32)))
    const { authorization, signature } = await sdk.buildExactAuthorization({
      account,
      accept,
      chainId,
      now: Math.floor(Date.now() / 1000),
      nonce,
    })

    const header = sdk.encodeXPaymentHeader({ network: 'base', authorization, signature })
    const parsed = sdk.parseExactPaymentHeader(header)
    const fromObject = sdk.parseExactObject(JSON.parse(atob(header)))
    const requirements = sdk.parseExactRequirements({ accepts: [accept] }) ?? sdk.parseExactRequirements([accept])
    const sigHeader = sdk.buildExactSignatureHeader({ accepted: accept, payload: { authorization, signature } })

    // The on-chain domain the signature is bound to, read live from the token itself.
    let domain = null
    try {
      const pub = viem.createPublicClient({ transport: viem.http(sdk.CHAINS.base.chain.rpcUrls.default.http[0]) })
      domain = await sdk.readExactDomain(pub, USDC_BASE)
    } catch (err) {
      domain = { error: String(err?.message ?? err) }
    }

    const proxyRows = calls([
      call('PERMIT2_ADDRESS', `<code>${esc(sdk.PERMIT2_ADDRESS)}</code>`),
      call('X402_EXACT_PERMIT2_PROXY', `<code>${esc(sdk.X402_EXACT_PERMIT2_PROXY)}</code>`),
      call('isPermit2ProxyChain(8453)', pill(String(sdk.isPermit2ProxyChain(8453)), sdk.isPermit2ProxyChain(8453) ? 'ok' : 'n')),
      call('PERMIT2_PROXY_CHAIN_IDS.size', `<code>${esc(String(sdk.PERMIT2_PROXY_CHAIN_IDS.size))} chains</code>`),
      call('PERMIT2_WITNESS_TYPES', `<code>${esc(Object.keys(sdk.PERMIT2_WITNESS_TYPES).join(', '))}</code>`),
    ])

    const methodRows = calls([
      call('exactTransferMethod(accept)', `<code>${esc(sdk.exactTransferMethod(accept))}</code>`),
      call('isSettleableExactMethod(accept)', pill(String(sdk.isSettleableExactMethod(accept)), sdk.isSettleableExactMethod(accept) ? 'ok' : 'bad')),
      call('DEFAULT_EXACT_TRANSFER_METHOD', `<code>${esc(sdk.DEFAULT_EXACT_TRANSFER_METHOD)}</code>`),
      call('KNOWN_EXACT_TRANSFER_METHODS', `<code>${esc(Object.keys(sdk.KNOWN_EXACT_TRANSFER_METHODS).join(', ') || String(sdk.KNOWN_EXACT_TRANSFER_METHODS))}</code>`),
      call("chainIdForExactNetwork('base')", `<code>${esc(String(chainId))}</code>`),
      call('EXACT_NETWORK_SLUGS', `<code>${esc(Object.keys(sdk.EXACT_NETWORK_SLUGS).length)} slugs</code>`),
      call('eip3009Abi', `<code>${esc(String(sdk.eip3009Abi.length))} entries</code>`),
      call('EIP3009_TYPES', `<code>${esc(Object.keys(sdk.EIP3009_TYPES).join(', '))}</code>`),
    ])

    return {
      data: { account: account.address, authorization, signature, header, parsed, fromObject, requirements, sigHeader, domain },
      view:
        verdict('ok', 'A gasless payment authorization, signed in this tab', 'No funds moved, no chain was touched, and no gas was spent. Somebody else can submit this and pay the gas.') +
        row([big(short(account.address, 8), '', 'signer'), big('0.01', ' USDC', 'authorized'), big(String(signature.length), '', 'signature chars')]) +
        card(
          'the authorization',
          kv([
            ['from', `<code>${esc(short(authorization.from, 12))}</code>`],
            ['to', `<code>${esc(short(authorization.to, 12))}</code>`],
            ['value', `<code>${esc(authorization.value)}</code>`],
            ['valid after', `<code>${esc(authorization.validAfter)}</code>`],
            ['valid before', `<code>${esc(authorization.validBefore)}</code>`],
            ['nonce', `<code>${esc(short(authorization.nonce, 12))}</code>`],
          ]),
          'lab-accent'
        ) +
        card('the signature', pre(signature)) +
        card(
          'the EIP-712 domain, read off the token on Base',
          domain?.error ? pre(String(domain.error)) : kv([
            ['name', `<code>${esc(domain?.name ?? 'n/a')}</code>`],
            ['version', `<code>${esc(domain?.version ?? 'n/a')}</code>`],
          ])
        ) +
        card(
          'onto the wire and back',
          calls([
            call('encodeXPaymentHeader({ network, authorization, signature })', `<code>${esc(header.length)} bytes</code>`),
            call('parseExactPaymentHeader(header)', parsed ? pill('recovered', 'ok') : pill('null', 'bad')),
            call('parseExactObject(decoded)', fromObject ? pill('recovered', 'ok') : pill('null', 'bad')),
            call('parseExactRequirements(body)', requirements ? pill(`${requirements.length} rail(s)`, 'ok') : pill('null', 'bad')),
            call('buildExactSignatureHeader({ accepted, payload })', `<code>${esc(sigHeader.length)} bytes</code>`),
          ])
        ) +
        card('the transfer method, and who can settle it', methodRows) +
        card('the Permit2 fallback, for tokens without EIP-3009', proxyRows) +
        note(
          'This is what makes an unfunded agent viable at all. It signs an authorization for a token it holds, and the merchant or a facilitator submits it and pays the gas, so the agent never needs the chain’s native coin.'
        ) +
        note(
          'The signature is bound to the token’s own EIP-712 domain, read from the contract above rather than assumed. Get that wrong and the signature is valid but useless, which is the classic way this rail breaks quietly.'
        ),
    }
  },

  upto: ({ sdk }) => {
    const payload = {
      x402Version: 2,
      scheme: 'upto',
      network: 'base',
      payload: {
        permit: {
          permitted: { token: USDC_BASE, amount: '100000' },
          nonce: '1',
          deadline: String(Math.floor(Date.now() / 1000) + 600),
        },
        witness: { payTo: '0x2222222222222222222222222222222222222222', maxAmount: '100000' },
        signature: '0x' + '11'.repeat(65),
      },
    }
    const accepted = {
      scheme: 'upto',
      network: 'base',
      maxAmountRequired: '100000',
      asset: USDC_BASE,
      payTo: '0x2222222222222222222222222222222222222222',
      resource: 'https://example.test/stream',
      description: 'Metered inference',
      mimeType: 'application/json',
      maxTimeoutSeconds: 600,
    }
    const header = sdk.buildUptoSignatureHeader({ accepted, payload: payload.payload })
    const parsedHeader = sdk.parseUptoPaymentHeader(header)
    const parsedObject = sdk.parseUptoObject(payload)

    return {
      data: { payload, header, parsedHeader, parsedObject, uptoChains: [...sdk.UPTO_PROXY_CHAIN_IDS] },
      view:
        row([big('0.10', ' USDC', 'ceiling authorized'), big(String(sdk.UPTO_PROXY_CHAIN_IDS.size), '', 'chains with the proxy'), big('1', '', 'signature')]) +
        card(
          'authorize a ceiling, get charged the actual use',
          calls([
            call('buildUptoSignatureHeader({ accepted, payload })', `<code>${esc(header.length)} bytes</code>`),
            call('parseUptoPaymentHeader(header)', parsedHeader ? pill('recovered', 'ok') : pill('null', 'bad')),
            call('parseUptoObject(payload)', parsedObject ? pill('recovered', 'ok') : pill('null', 'bad')),
            call('X402_UPTO_PERMIT2_PROXY', `<code>${esc(sdk.X402_UPTO_PERMIT2_PROXY)}</code>`),
            call('isUptoProxyChain(8453)', pill(String(sdk.isUptoProxyChain(8453)), sdk.isUptoProxyChain(8453) ? 'ok' : 'n')),
            call('PERMIT2_UPTO_WITNESS_TYPES', `<code>${esc(Object.keys(sdk.PERMIT2_UPTO_WITNESS_TYPES).join(', '))}</code>`),
          ])
        ) +
        note(
          'A metered rail fits work whose cost is not known until it is done, like tokens of inference. The buyer signs a ceiling once, the seller settles the real amount, and the buyer can never be charged above what they signed.'
        ) +
        note('The witness is what binds the ceiling to one recipient. Without it a signature for a ceiling is a signature anybody could redirect.'),
    }
  },

  multichain: async ({ sdk, LIVE_402 }) => {
    const key = randomKey()
    const payer = sdk.MultiChainPayer.fromWallets({
      wallets: { base: { key }, polygon: { key }, arbitrum: { key } },
      policy: { maxAmount: '0.10', maxTotal: '1.00' },
    })

    const address = await payer.address().catch(() => 'unavailable')
    const quote = await payer.quote(LIVE_402).catch(() => null)
    const plan = await payer.planPayment(LIVE_402).catch(() => null)
    const affordable = await payer.canAfford(LIVE_402).catch(() => false)

    // The same idea without the wrapper: a list of clients, one call across all of them.
    const clients = ['base', 'polygon'].map((chain) => new sdk.PipRailClient({ chain, wallet: { key } }))
    const across = await sdk.planAcross(clients, LIVE_402).catch(() => null)

    return {
      data: {
        address,
        chains: payer.clients?.length ?? 3,
        quote,
        plan,
        canAfford: affordable,
        planAcross: across,
        mode: payer.mode?.(),
      },
      view:
        row([big(String(payer.clients?.length ?? 3), '', 'chains bound'), big(short(address, 8), '', 'one wallet'), big(plan?.status ?? 'n/a', '', 'best rail')]) +
        card(
          'one wallet, several chains, one call',
          calls([
            call('MultiChainPayer.fromWallets({ wallets })', pill(`${payer.clients?.length ?? 3} clients`, 'ok')),
            call('await payer.address()', `<code>${esc(short(address, 12))}</code>`),
            call('payer.chain()', `<code>${esc(String(payer.chain?.() ?? 'multi'))}</code>`),
            call('payer.mode()', pill(String(payer.mode?.() ?? 'budgeted'), 'accent')),
            call('payer.policy()', `<code>${esc(dump(payer.policy?.() ?? {}).replace(/\s+/g, ' '))}</code>`),
            call('await payer.quote(url)', quote ? `<code>${esc(quote.amountFormatted)} ${esc(quote.symbol)}</code>` : pill('no 402 right now', 'warn')),
            call('await payer.planPayment(url)', plan ? pill(plan.status, plan.payable ? 'ok' : 'bad') : pill('none', 'warn')),
            call('await payer.canAfford(url)', pill(String(affordable), affordable ? 'ok' : 'bad')),
            call('await payer.balanceOf()', pill('reads every bound chain', 'n')),
            call('payer.budget() · payer.spent()', pill('one shared ledger', 'n')),
            call('payer.discover() · payer.register()', pill('the agent surface, unchanged', 'n')),
            call('payer.quoteSwap() · payer.swap()', pill('routed to the right chain', 'n')),
            call('payer.canAgentSell?.() · payer.canAgentSwap?.()', pill('same authority questions', 'n')),
            call('payer.fetch() · payer.get() · payer.post()', pill('pays on whichever chain can', 'n')),
          ])
        ) +
        card(
          'or keep your own clients and merge across them',
          calls([
            call('await planAcross([base, polygon], url)', across ? pill(across.status, across.payable ? 'ok' : 'bad') : pill('none', 'warn')),
            call('await fetchAcross([base, polygon], url)', pill('pays the cheapest settleable rail', 'n')),
          ])
        ) +
        note(
          'The merchant decides which chains it accepts and the buyer decides which it holds funds on. Neither has to be right about the other, because the payer resolves the overlap at call time.'
        ) +
        note(
          'One ledger sits behind all of them, so a cap is a cap across chains rather than per chain. Three chains with a one dollar limit each is three dollars, which is not what anybody meant.'
        ),
    }
  },

  /* ═══════════════════════════════ Agent ═══════════════════════════════ */

  discover: async ({ sdk }) => {
    const client = new sdk.PipRailClient({ chain: 'base' })
    const found = await client.discover({ query: 'weather', network: 'any', limit: 12 })

    if (found.length > 0) {
      const bySource = found.reduce((m, r) => ((m[r.source] = (m[r.source] || 0) + 1), m), {})
      const rows = found
        .slice(0, 10)
        .map((r) =>
          card(
            r.name || r.resource,
            kv([
              ['resource', `<code>${esc(short(r.resource, 34))}</code>`],
              r.priceUsd != null ? ['price', `$${esc(r.priceUsd)}`] : null,
              ['source', pill(r.source, 'ok')],
              r.indexMatched ? ['matched by', pill('index search', 'accent')] : null,
              ['rails', (r.rails || []).slice(0, 3).map((x) => pill(x.network, 'n')).join('')],
            ])
          )
        )
        .join('')

      // Ranking is the part that turns three catalogues into one answer.
      const tokens = ['weather']
      const scored = found.slice(0, 5).map((r) => ({ name: r.name || short(r.resource, 20), score: sdk.scoreResource(r, tokens) }))
      const reranked = sdk.rankResources([...found], 'weather')

      return {
        data: { found: found.length, bySource, results: found, scored },
        view:
          row([big(String(found.length), '', 'results'), ...Object.entries(bySource).map(([s, n]) => big(String(n), '', s))]) +
          `<div class="lab-grid2">${rows}</div>` +
          card(
            'how they were ordered',
            calls([
              ...scored.map((s) => call(`scoreResource("${s.name}", ["weather"])`, `<code>${esc(String(s.score))}</code>`)),
              call('rankResources(all, "weather")', `<code>${esc(String(reranked.length))} kept, best first</code>`),
              call('INDEX_PROXY_PATH', `<code>${esc(sdk.INDEX_PROXY_PATH)}</code>`),
            ])
          ) +
          note(
            'Real, payable endpoints other people run, read live from three open indexes and ranked as one set. PipRail hosts no directory: it reads the ones that already exist, pages through them so a search sees the whole catalogue, and can register your endpoint on them too.'
          ) +
          note(
            'No transport was configured to make this work. Browsers cannot read those indexes directly, because none of them sends a usable CORS header, so the SDK looks for its own forwarder on this origin and uses it. Mounting that forwarder is one line, and a Node caller needs none of it.'
          ),
      }
    }

    const reach = async (label, url) => {
      try {
        const res = await fetch(`${sdk.INDEX_PROXY_PATH}?url=${encodeURIComponent(url)}`)
        return { index: label, readable: res.ok, status: res.status }
      } catch (err) {
        return { index: label, readable: false, reason: String(err?.message ?? err) }
      }
    }
    const reachability = await Promise.all([
      reach('CDP Bazaar', 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=1'),
      reach('402 Index', 'https://402index.io/api/v1/services?limit=1'),
      reach('Circle', 'https://api.circle.com/v2/x402/discovery/resources?limit=1'),
    ])
    const why = {
      'CDP Bazaar': 'sends no Access-Control-Allow-Origin header',
      '402 Index': 'sends no Access-Control-Allow-Origin header',
      Circle: "sends Access-Control-Allow-Origin twice ('*, *'), which browsers reject",
    }

    return {
      data: { found: 0, reachability, why },
      view:
        verdict('warn', 'No results came back just now', 'Nothing matched, or an index is having a moment. Discovery reads never throw, so the search degrades to empty rather than failing.') +
        grid2(
          reachability.map((r) =>
            card(
              r.index,
              kv([
                ['reachable', r.readable ? pill('yes', 'ok') : pill('no', 'bad')],
                r.status ? ['status', String(r.status)] : null,
                !r.readable ? ['note', esc(why[r.index] || r.reason || '')] : null,
              ]),
              r.readable ? 'lab-accent' : 'lab-rose'
            )
          )
        ) +
        note('Discovery reads never throw. A dead or unreadable index contributes nothing and the others still answer, so a search degrades instead of failing.'),
    }
  },

  tools: ({ sdk }) => {
    const tools = sdk.paymentTools(new sdk.PipRailClient({ chain: 'base' }))
    const label = (n) => (/pay|swap|sell/.test(n) ? 'money' : /register|collect/.test(n) ? 'write' : 'read')
    const tone = (n) => ({ money: 'bad', write: 'warn', read: 'ok' })[label(n)]
    const rows = tools
      .map(
        (t) =>
          `<div class="lab-tool"><code>${esc(t.name)}</code><span class="lab-tool-d">${esc((t.description || '').split('.')[0])}</span>${pill(label(t.name), tone(t.name))}</div>`
      )
      .join('')
    const guide = sdk.agentGuide()

    return {
      data: { count: tools.length, tools: tools.map((t) => ({ name: t.name, description: t.description })), guideBytes: guide.length },
      view:
        row([
          big(String(tools.length), '', 'tools in this mode'),
          big(String(tools.filter((t) => label(t.name) === 'read').length), '', 'read only'),
          big(String(tools.filter((t) => label(t.name) === 'money').length), '', 'can move money'),
        ]) +
        card('what the model is handed', `<div class="lab-tools">${rows}</div>`) +
        card('and the contract it is given alongside them', pre(guide.slice(0, 1400) + (guide.length > 1400 ? '\n…' : ''))) +
        card(
          'the guide, two ways',
          calls([
            call('agentGuide()', `<code>${esc(guide.length)} chars, rendered for the current build</code>`),
            call('PIPRAIL_AGENT_GUIDE', `<code>${esc(sdk.PIPRAIL_AGENT_GUIDE.length)} chars, the constant</code>`),
          ])
        ) +
        note(
          'This is the budgeted set. Sovereign mode adds swap and seller tools behind a separate policy, so the authority a model holds is a deliberate choice rather than a default.'
        ) +
        note(
          'The guide matters as much as the tools. A model that has not been told the rules of the rail invents them, and the invented version is always more confident and less correct.'
        ),
    }
  },

  swaps: async ({ sdk }) => {
    const nets = sdk.swappableNetworks()
    const providers = sdk.swapProvidersFor(BASE_NET)

    // `from`/`to` are TokenInput: the string 'native', a preset symbol, or a raw address.
    // `wantAmount` is what you want to RECEIVE, so the quote answers with the maximum it
    // would spend to get there, which is the number a budget actually has to survive.
    const client = new sdk.PipRailClient({
      chain: 'base',
      wallet: { key: randomKey() },
      swapPolicy: { maxPerSwap: '5.00', maxSlippageBps: 100, allowTo: ['USDC'] },
    })

    let quote = null
    let quoteError = null
    try {
      quote = await client.quoteSwap({ from: 'native', to: 'USDC', wantAmount: '0.10' })
    } catch (err) {
      quoteError = String(err?.message ?? err)
    }

    let swapOutcome
    if (quote) {
      try {
        const receipt = await client.swap(quote)
        swapOutcome = { kind: 'swapped', receipt }
      } catch (err) {
        swapOutcome = { kind: 'refused', code: err?.code ?? 'ERROR', message: String(err?.message ?? err) }
      }
    } else {
      swapOutcome = { kind: 'no-quote' }
    }

    const slip = calls([
      call('DEFAULT_SLIPPAGE_BPS', `<code>${esc(String(sdk.DEFAULT_SLIPPAGE_BPS))} bps</code>`),
      call('MAX_SLIPPAGE_BPS', `<code>${esc(String(sdk.MAX_SLIPPAGE_BPS))} bps</code>`),
      call('resolveSlippageBps(undefined)', `<code>${esc(String(sdk.resolveSlippageBps(undefined)))} · the default</code>`),
      call('resolveSlippageBps(150)', `<code>${esc(String(sdk.resolveSlippageBps(150)))}</code>`),
      // It REFUSES rather than clamping, and that is the safer of the two. A silently
      // clamped slippage config reads as accepted and trades at a tolerance nobody chose.
      tryCall('resolveSlippageBps(99999)', () => sdk.resolveSlippageBps(99999)).html,
      call('applySlippage(1000000n, 50)', `<code>${esc(String(sdk.applySlippage(1000000n, 50)))}</code>`),
      call("canSwapOn('eip155:8453')", pill(String(sdk.canSwapOn(BASE_NET)), sdk.canSwapOn(BASE_NET) ? 'ok' : 'bad')),
      call("swapProvidersFor('eip155:8453')", `<code>${esc(providers.map((p) => p.name ?? p.id ?? p.provider).join(', ') || 'none')}</code>`),
      call('SWAP_PROVIDERS.length', `<code>${esc(String(sdk.SWAP_PROVIDERS.length))} routes</code>`),
    ])

    return {
      data: { swappableNetworks: nets, providers, quote, swapOutcome },
      view:
        (quote
          ? verdict('ok', 'A real route, priced live', sdk.summarizeSwap(quote))
          : verdict('warn', 'No route priced just now', quoteError ?? 'The provider did not answer. Swap quotes degrade rather than throw.')) +
        row([big(String(nets.length), '', 'networks with a route'), big(String(sdk.SWAP_PROVIDERS.length), '', 'providers'), big(swapOutcome.kind === 'refused' ? swapOutcome.code : swapOutcome.kind, '', 'swap outcome')]) +
        (quote
          ? card(
              'the quote',
              kv([
                ['you spend', `<code>${esc(quote.from.amountFormatted)} ${esc(quote.from.symbol)}</code>`],
                ['you receive', `<code>${esc(quote.to.amountFormatted)} ${esc(quote.to.symbol)}</code>`],
                ['most it can spend', `<code>${esc(quote.maxSpendFormatted)} ${esc(quote.from.symbol)}</code>`],
                ['slippage', `<code>${esc(quote.slippageBps)} bps</code>`],
                ['network', `<code>${esc(quote.network)}</code>`],
                ['routed by', pill(`${quote.source.name} · ${quote.source.kind}`, 'accent')],
              ]),
              'lab-accent'
            )
          : '') +
        (swapOutcome.kind === 'refused'
          ? card(`the swap itself · ${swapOutcome.code}`, pre(swapOutcome.message), 'lab-rose')
          : '') +
        card('where an agent can swap its own funds', chips(nets.map((n) => pill(n, 'n')))) +
        card('slippage, and the caps around it', slip) +
        note(
          'A swap moves the agent’s own funds between denominations on one chain: it never touches a counterparty. It is off unless a separate swap policy turns it on, and the MCP cannot swap at all by default.'
        ) +
        note(
          'The quote is real and the refusal is real. An empty wallet gets exactly this far, which is the honest demonstration: the route exists, the funds do not.'
        ),
    }
  },

  listing: ({ sdk, config, LIVE_402 }) => {
    const c = config()
    const sources = Object.keys(sdk.DIRECTORY_INFO)
    const described = sources.map((s) => ({ source: s, info: sdk.getDirectoryInfo(s) }))

    const description = 'Real-time market intelligence for agents'
    const withAttribution = sdk.appendAttribution(description)
    const withKeywords = sdk.appendKeywords(description, ['weather', 'forecast', 'api'])

    // Exactly what would be sent, built by the SDK, and deliberately not sent.
    const payload = {
      url: LIVE_402,
      name: 'PipRail demo endpoint',
      description: sdk.appendKeywords(sdk.appendAttribution(description), ['x402', 'agents']),
      priceUsd: Number(c.amount),
      asset: c.token,
      network: c.chain,
      method: 'GET',
      category: 'data',
    }

    const outcome = sdk.decorateOutcome({ source: '402index', ok: true, status: 201, detail: 'Listed' })

    const dirCards = described
      .map(({ source, info }) =>
        card(
          source,
          kv([
            ['listing goes', pill(info.visibility ?? 'live', info.visibility === 'live' ? 'ok' : 'warn')],
            ['read by discover()', info.readable === false ? pill('no', 'bad') : pill('yes', 'ok')],
            ['note', esc(info.note ?? info.detail ?? '')],
          ])
        )
      )
      .join('')

    return {
      data: { directories: described, payload, decorated: outcome, withAttribution, withKeywords },
      view:
        verdict('warn', 'This is the one test the lab will not fire', 'Clicking send here would write a junk listing into a public directory that other people search. Everything below is built for real; only the POST is withheld.') +
        row([big(String(sources.length), '', 'directories'), big(String(sources.filter((s) => sdk.getDirectoryInfo(s).visibility === 'live').length), '', 'list immediately'), big('0', '', 'sent from here')]) +
        `<div class="lab-grid2">${dirCards}</div>` +
        card('the exact payload that would be posted', pre(dump(payload), false), 'lab-accent') +
        card(
          'the description helpers, applied above',
          calls([
            call('appendAttribution(description)', `<code>${esc(withAttribution)}</code>`),
            call('appendKeywords(description, tags)', `<code>${esc(withKeywords)}</code>`),
            call('REGISTER_ATTRIBUTION', `<code>${esc(sdk.REGISTER_ATTRIBUTION)}</code>`),
            call('decorateOutcome({ source, ok, status })', `<code>${esc(dump(outcome).replace(/\s+/g, ' '))}</code>`),
          ])
        ) +
        note(
          'Category and keywords are the two fields that decide whether anybody finds you. Most of 402 Index is uncategorized, so filling them in is the cheapest ranking you will ever get.'
        ) +
        note(
          'Run client.register(url) from your own code and it posts to every directory at once, returning one outcome per source with a visibility you can branch on rather than a guess about when the listing appears.'
        ),
    }
  },

  domain: async ({ sdk }) => {
    const client = new sdk.PipRailClient({ chain: 'base', wallet: { key: randomKey() } })
    const direct = await sdk.verify402IndexDomain('piprail.com').catch((e) => ({ error: String(e?.message ?? e) }))
    const viaClient = await client.verifyDomain('https://piprail.com/x402/demo').catch((e) => ({ error: String(e?.message ?? e) }))
    const signer = client.discoverySigner ? client.discoverySigner({ key: randomKey() }) : null

    // 402 Index verifies over a cross-origin POST with a JSON content-type, which a browser
    // preflights and that host does not answer. It is one of exactly two calls in this lab
    // that a page cannot complete, so it says which it is rather than reading as a failure.
    const blocked = (v) => !v?.ok && /failed to fetch|networkerror|load failed|cors/i.test(String(v?.detail ?? v?.error ?? ''))
    const browserBlocked = blocked(direct)

    return {
      data: { direct, viaClient, hasSigner: Boolean(signer), browserBlocked },
      view:
        (browserBlocked
          ? verdict(
              'warn',
              'This one needs a server, and said so instead of throwing',
              'The check is a cross-origin POST and 402 Index sends no CORS header, so a browser cannot make it. The SDK returned ok:false with the reason. Run the identical line in Node and it answers.'
            )
          : verdict(direct?.ok ? 'ok' : 'warn', direct?.ok ? 'piprail.com is a verified owner' : 'Not currently verified', direct?.detail ?? 'The directory answered with the current ownership state.')) +
        card(
          'the two halves of ownership',
          calls([
            call("await verify402IndexDomain('piprail.com')", `<code>${esc(dump(direct).replace(/\s+/g, ' ').slice(0, 110))}</code>`),
            call('await client.verifyDomain(url)', `<code>${esc(dump(viaClient).replace(/\s+/g, ' ').slice(0, 110))}</code>`),
            call('client.discoverySigner?.(wallet)', signer ? pill('a signer for authenticated listings', 'ok') : pill('not configured', 'n')),
          ])
        ) +
        card(
          'the same two lines, in Node',
          pre("import { verify402IndexDomain } from '@piprail/sdk'\n\nconsole.log(await verify402IndexDomain('piprail.com'))\n// { ok: true, domain: 'piprail.com', httpStatus: 200, status: 'verified' }")
        ) +
        note(
          'Worth reading twice: it did not throw. Every discovery call returns a verdict with a reason instead of an exception, so an agent that loses a directory keeps running rather than crashing on somebody else’s outage.'
        ) +
        note(
          'Claiming a domain hands you a TXT record to publish, which is why the claim half is not wired to a button here: it would be a claim on a domain you do not control. Verifying is a read and runs freely.'
        ) +
        note(
          'Ownership is what stops somebody else listing your endpoint and pointing the payment address at themselves. It is worth doing on the day you list.'
        ),
    }
  },

  /* ═══════════════════════════════ Interop ═══════════════════════════════ */

  mcp: async ({ sdk, config }) => {
    const c = config()
    const { challenge } = await gateFor(sdk, c).challenge()

    const required = sdk.toMcpPaymentRequired(challenge)
    const isRequired = sdk.isMcpPaymentRequired(required)
    const recovered = sdk.fromMcpPaymentRequired(required)

    const meta = sdk.buildMcpPaymentMeta({
      accepted: challenge.accepts[0],
      payload: { nonce: 'lab', txHash: '0x' + 'cd'.repeat(32) },
      resource: { url: 'https://example.test/report', mimeType: 'application/json' },
    })
    const readBack = sdk.fromMcpPayment({ name: 'get_report', arguments: {}, _meta: meta })

    const receipt = fixtureReceipt()
    const response = sdk.toMcpPaymentResponse([{ type: 'text', text: '{"ok":true}' }], receipt)
    const settle = sdk.fromMcpPaymentResponse(response)

    const tool = sdk.createMcpPaymentTool({ chain: c.chain, token: c.token, amount: c.amount, payTo: c.payTo })

    return {
      data: { required, meta, readBack, response, settle, tool: Object.keys(tool) },
      view:
        verdict(isRequired && recovered ? 'ok' : 'bad', 'A 402 survives the trip through MCP and back', 'Same envelope, same accepts[], carried as a tool result instead of an HTTP response.') +
        row([big('402', '', 'as a tool error'), big(String(challenge.accepts.length), '', 'rails preserved'), big(settle?.success ? 'settled' : 'none', '', 'response read back')]) +
        card(
          'the round trip',
          calls([
            call('toMcpPaymentRequired(challenge)', pill(required.isError ? 'isError tool result' : 'result', 'ok')),
            call('isMcpPaymentRequired(result)', pill(String(isRequired), isRequired ? 'ok' : 'bad')),
            call('fromMcpPaymentRequired(result)', recovered ? pill(`${recovered.accepts.length} rail(s) recovered`, 'ok') : pill('null', 'bad')),
            call('buildMcpPaymentMeta({ accepted, payload })', `<code>${esc(Object.keys(meta).join(', '))}</code>`),
            call('fromMcpPayment(toolCallParams)', readBack ? pill('payload recovered', 'ok') : pill('null', 'bad')),
            call('toMcpPaymentResponse(content, receipt)', `<code>${esc(Object.keys(response).join(', '))}</code>`),
            call('fromMcpPaymentResponse(result)', settle ? pill(`success: ${settle.success}`, 'ok') : pill('null', 'bad')),
            call('createMcpPaymentTool({ … })', `<code>{ ${esc(Object.keys(tool).join(', '))} }</code>`),
            call('MCP_PAYMENT_META_KEY', `<code>${esc(sdk.MCP_PAYMENT_META_KEY)}</code>`),
            call('MCP_PAYMENT_RESPONSE_META_KEY', `<code>${esc(sdk.MCP_PAYMENT_RESPONSE_META_KEY)}</code>`),
          ])
        ) +
        note(
          'MCP has no status codes, so a 402 travels as a tool result flagged as an error with the challenge in its structured content. A client that knows nothing about payments still sees a readable error rather than a crash.'
        ) +
        note('This is the wire @piprail/mcp speaks. The same envelopes, the same verification, a different transport.'),
    }
  },

  a2a: async ({ sdk, config }) => {
    const c = config()
    const { challenge } = await gateFor(sdk, c).challenge()
    const taskId = 'task-lab-0001'

    const task = sdk.toA2APaymentRequired(taskId, challenge)
    const recovered = sdk.fromA2APaymentRequired(task)
    const payload = sdk.fromA2APaymentPayload({
      role: 'user',
      parts: [],
      metadata: { [sdk.A2A_PAYLOAD_KEY]: { x402Version: 2, accepted: challenge.accepts[0], payload: { nonce: 'lab', txHash: '0x' + 'ef'.repeat(32) } } },
    })
    const receipts = sdk.toA2APaymentReceipts([fixtureReceipt()])
    const failed = sdk.toA2APaymentFailed('PROOF_NOT_FOUND', 'no such transaction', [], BASE_NET)
    const errorCode = sdk.toA2AErrorCode('PROOF_NOT_FOUND')
    const handler = sdk.createA2APaymentHandler({ chain: c.chain, token: c.token, amount: c.amount, payTo: c.payTo })

    const keys = calls(
      [
        ['A2A_X402_EXTENSION_URI_V01', sdk.A2A_X402_EXTENSION_URI_V01],
        ['A2A_X402_EXTENSION_URI_V02', sdk.A2A_X402_EXTENSION_URI_V02],
        ['A2A_EXTENSIONS_HEADER', sdk.A2A_EXTENSIONS_HEADER],
        ['A2A_STATUS_KEY', sdk.A2A_STATUS_KEY],
        ['A2A_REQUIRED_KEY', sdk.A2A_REQUIRED_KEY],
        ['A2A_PAYLOAD_KEY', sdk.A2A_PAYLOAD_KEY],
        ['A2A_RECEIPTS_KEY', sdk.A2A_RECEIPTS_KEY],
        ['A2A_ERROR_KEY', sdk.A2A_ERROR_KEY],
      ].map(([k, v]) => call(k, `<code>${esc(String(v))}</code>`))
    )

    return {
      data: { task, recovered, payload, receipts, failed, errorCode, handler: Object.keys(handler), errorMap: sdk.VERIFY_CODE_TO_A2A_ERROR },
      view:
        verdict(recovered ? 'ok' : 'bad', 'The same 402, as an A2A task', 'Google’s agent-to-agent extension carries the challenge in task metadata. Both published versions are recognised.') +
        row([big(String(task.status?.state ?? 'input-required'), '', 'task state'), big('2', '', 'spec versions read'), big(String(Object.keys(sdk.VERIFY_CODE_TO_A2A_ERROR).length), '', 'error codes mapped')]) +
        card(
          'the round trip',
          calls([
            call('toA2APaymentRequired(taskId, challenge)', `<code>${esc(task.status?.state ?? 'task')}</code>`),
            call('fromA2APaymentRequired(task)', recovered ? pill(`${recovered.accepts.length} rail(s)`, 'ok') : pill('null', 'bad')),
            call('fromA2APaymentPayload(message)', payload ? pill('payload recovered', 'ok') : pill('null', 'bad')),
            call('toA2APaymentReceipts([receipt])', `<code>${esc(Object.keys(receipts).join(', '))}</code>`),
            call('toA2APaymentFailed(code, detail)', `<code>${esc(Object.keys(failed).join(', '))}</code>`),
            call("toA2AErrorCode('PROOF_NOT_FOUND')", `<code>${esc(errorCode)}</code>`),
            call('createA2APaymentHandler({ … })', `<code>{ ${esc(Object.keys(handler).join(', '))} }</code>`),
          ])
        ) +
        card('every key on the wire', keys) +
        note(
          'A2A is how agents from different vendors talk to each other. Carrying x402 inside it means a PipRail-gated service can charge an agent that has never heard of PipRail.'
        ) +
        note(
          'Verification error codes map onto A2A error codes rather than leaking through as free text, so the calling agent can branch on the failure instead of pattern-matching a sentence.'
        ),
    }
  },

  facilitators: async ({ sdk }) => {
    const forBase = sdk.knownFacilitatorsFor(BASE_NET)
    const keyless = sdk.firstKeylessFacilitator(BASE_NET, 'eip3009')
    const networks = Object.keys(sdk.KNOWN_FACILITATORS)

    // A live capability read. Facilitators are third-party hosts and most send no CORS header,
    // so this may come back empty in a browser and never in Node. Say which, rather than
    // letting an empty list read as "nobody supports anything".
    let coverage = []
    let coverageRan = false
    if (keyless?.url) {
      coverage = await sdk.facilitatorCoverage(keyless.url).catch(() => [])
      coverageRan = true
    }

    const parsed = sdk.parseFacilitatorSupported({
      kinds: [
        { x402Version: 2, scheme: 'exact', network: 'base' },
        { x402Version: 2, scheme: 'exact', network: 'polygon' },
      ],
    })
    const settle = sdk.parseSettleResponse(
      new Response(JSON.stringify({ success: true, transaction: '0x' + '99'.repeat(32), network: 'base', payer: '0x11' }), {
        headers: { 'content-type': 'application/json' },
      })
    )

    const cards = forBase
      .slice(0, 6)
      .map((f) =>
        card(
          f.name ?? f.url,
          kv([
            ['url', `<code>${esc(short(f.url, 24))}</code>`],
            ['key needed', f.keyless ? pill('no', 'ok') : pill('yes', 'warn')],
            ['methods', (f.methods ?? []).map((m) => pill(m, 'n')).join('') || pill('unstated', 'n')],
          ]),
          f.keyless ? 'lab-accent' : ''
        )
      )
      .join('')

    return {
      data: { networks: networks.length, forBase, keyless, coverage, parsed, settle },
      view:
        row([big(String(networks.length), '', 'networks with a facilitator'), big(String(forBase.length), '', 'on this chain'), big(keyless ? 'yes' : 'no', '', 'keyless option')]) +
        `<div class="lab-grid2">${cards}</div>` +
        card(
          'reading what one supports',
          calls([
            call(`await facilitatorCoverage('${short(keyless?.url ?? 'none', 16)}')`, coverageRan ? (coverage.length ? pill(`${coverage.length} kind(s)`, 'ok') : pill('empty · browser CORS, works in Node', 'warn')) : pill('no keyless host on this chain', 'n')),
            call('parseFacilitatorSupported(body)', `<code>${esc(parsed.map((k) => `${k.scheme}/${k.network}`).join(', '))}</code>`),
            call('parseSettleResponse(response)', settle ? pill(`success: ${settle.success}`, 'ok') : pill('null', 'bad')),
            call("firstKeylessFacilitator(net, 'eip3009')", keyless ? `<code>${esc(keyless.name ?? keyless.url)}</code>` : pill('none', 'n')),
          ])
        ) +
        note(
          'A facilitator sponsors the gas so a buyer with no native coin can still pay. PipRail never requires one: it is an option a merchant can offer, not a party the rail depends on.'
        ) +
        note(
          'Keyless matters more than it sounds. A facilitator that needs an API key puts an account between an autonomous agent and its ability to pay, which is the dependency this project exists to avoid.'
        ),
    }
  },

  proxy: async ({ sdk }) => {
    const handle = sdk.indexProxyHandler()

    // The forwarder is server code. Running it here, against real Request objects, is the
    // clearest way to show it is ordinary code you own rather than a service we host.
    const probe = await handle(new Request('https://example.test/api/x402-index'))
    const evil = await handle(new Request('https://example.test/api/x402-index?url=' + encodeURIComponent('https://api.circle.com.evil.test/v2')))
    const insecure = await handle(new Request('https://example.test/api/x402-index?url=' + encodeURIComponent('http://402index.io/api/v1/services')))
    const wrongMethod = await handle(new Request('https://example.test/api/x402-index', { method: 'POST' }))
    // The upstream READ is the one part that cannot run here, and for the very reason the
    // forwarder exists: the handler's own fetch is subject to the browser's CORS rules, and
    // the indexes send no header that would satisfy them. So the read goes through the
    // forwarder this site actually mounts, which is the same handler running where it belongs.
    const mounted = await fetch(`${sdk.INDEX_PROXY_PATH}?url=${encodeURIComponent('https://402index.io/api/v1/services?limit=1')}`)
      .catch(() => ({ status: 0, ok: false }))

    const outcome = (label, res, expected, why) =>
      call(
        label,
        `${pill(`HTTP ${res.status}`, res.status === expected ? 'ok' : 'bad')} <span class="lab-call-w">${esc(why)}</span>`,
        res.status === expected ? 'ok' : 'bad'
      )

    return {
      data: {
        allowedHosts: sdk.INDEX_PROXY_ALLOWED_HOSTS,
        path: sdk.INDEX_PROXY_PATH,
        statuses: { probe: probe.status, evil: evil.status, insecure: insecure.status, wrongMethod: wrongMethod.status, mounted: mounted.status },
      },
      view:
        verdict('ok', 'The forwarder, running in your browser', 'This is the same handler the site mounts as a serverless function. It is in the package you install, not on a server we run.') +
        row([big(String(sdk.INDEX_PROXY_ALLOWED_HOSTS.length), '', 'allowed hosts'), big('GET', '', 'only method'), big('0', '', 'credentials forwarded')]) +
        card(
          'what it does with each request',
          calls([
            outcome('handle(GET, no url)', probe, 400, 'how the SDK asks whether a forwarder is here'),
            outcome('handle(GET, api.circle.com.evil.test)', evil, 403, 'exact host match, so a lookalike prefix fails'),
            outcome('handle(GET, http://402index.io)', insecure, 400, 'https only'),
            outcome('handle(POST)', wrongMethod, 405, 'reads only, never writes'),
          ])
        ) +
        card(
          'and the same handler where it is mounted, on this origin',
          calls([
            mounted.status === 200
              ? outcome(`fetch('${sdk.INDEX_PROXY_PATH}?url=402index.io/…')`, mounted, 200, 'a real catalogue read, forwarded for real')
              : call(
                  `fetch('${sdk.INDEX_PROXY_PATH}?url=402index.io/…')`,
                  `${pill(mounted.status ? `HTTP ${mounted.status}` : 'unreachable', 'warn')} <span class="lab-call-w">no forwarder is mounted on this origin, so there is nothing to forward through</span>`,
                  'ok'
                ),
          ])
        ) +
        (mounted.status === 200
          ? ''
          : note(
              'This origin serves no forwarder, which is why the last row did not read a catalogue. That is the one-line fix at the top of this panel, and it is the difference between browser discovery working and returning nothing.'
            )) +
        card('the allowlist', chips(sdk.INDEX_PROXY_ALLOWED_HOSTS.map((h) => pill(h, 'ok')))) +
        note(
          'The four checks above ran the handler here, in the page. The fifth could not: a forwarder running inside a browser is subject to the same CORS rules as the code that called it, which is the entire reason it belongs on a server. So that row went through the mounted route instead.'
        ) +
        note(
          'An open forwarder becomes somebody else’s abuse problem, so this one talks to a fixed list of index hosts, passes no credentials, accepts no body, and forwards the upstream status unchanged so a dead index reads as dead rather than as nothing matched.'
        ) +
        note(
          'Mount it on any route your app already serves and browser discovery works with no client configuration at all. PipRail hosts nothing here, which is the difference between a tool you own and a platform you depend on.'
        ),
    }
  },
}
