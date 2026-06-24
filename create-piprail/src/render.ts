/**
 * The pure scaffolder render: a {@link ScaffoldConfig} → a Map of (relative path → file content).
 * No filesystem, no prompts — so it's unit-testable and the mainnet-default guard is assertable.
 * The CLI ({@link run}) collects the config, calls this, and writes the map to disk.
 *
 * The emitted app depends ONLY on `@piprail/sdk` (+ `express` for the node host). The merchant's
 * config — chain, token, amount, the PUBLIC `payTo` address, and (for a proxy) the origin URL — is
 * baked into `src/gate.mjs` / the entry as literals (no env, no key), so it works at module scope on
 * every runtime, including Workers. Every app self-describes (`/.well-known/x402` for agents) and
 * shows a human a friendly landing page when opened in a browser.
 */

export type Sell = 'api' | 'tip' | 'proxy'
export type Host = 'node' | 'cloudflare' | 'vercel'

export interface ScaffoldConfig {
  /** The generated package name. */
  name: string
  /** What you're selling — a paywalled endpoint, an open tip jar, or a gate in front of an existing API. */
  sell: Sell
  /** Mainnet chain to be paid on, e.g. `'base'`. NEVER a testnet (the scaffolder refuses testnets). */
  chain: string
  /** Token to charge in, e.g. `'USDC'` or `'native'`. */
  token: string
  /** Your receiving PUBLIC wallet address — no private key. */
  payTo: string
  /** The fixed price (api/proxy) or the minimum (tip), human-readable, e.g. `'0.05'`. */
  amount: string
  /** Where it will run. (`proxy` is edge-only: cloudflare or vercel.) */
  host: Host
  /** REQUIRED for `sell: 'proxy'` — the existing backend the proxy gates (e.g. `https://api.me.com`). */
  origin?: string
}

const SDK = '@piprail/sdk'

/** The gated resource path + the unlocked JSON payload, per sell type. (Proxy gates every path.) */
function resourceOf(sell: Sell): { path: string; payload: string } {
  if (sell === 'tip') return { path: '/tip', payload: "{ thanks: true, message: 'Thank you for the tip!' }" }
  if (sell === 'proxy') return { path: '/', payload: '' } // proxy forwards to the origin; no canned payload
  return { path: '/report', payload: "{ unlocked: true, report: 'your premium content here' }" }
}

/** The `serve` expression for the fetch hosts: forward to the origin (proxy) or return the canned payload. */
function serveExpr(cfg: ScaffoldConfig): string {
  if (cfg.sell === 'proxy') return 'proxyTo(ORIGIN)'
  return `() => Response.json(${resourceOf(cfg.sell).payload})`
}

/** The browser-detector both fetch templates use to show a human a landing page (vs JSON for agents). */
const IS_BROWSER_GET = [
  `function isBrowserGet(request) {`,
  `  return request.method === 'GET' &&`,
  `    !request.headers.get('payment-signature') && !request.headers.get('x-payment') &&`,
  `    (request.headers.get('accept') || '').includes('text/html')`,
  `}`,
].join('\n')

/** Render the whole project as (relative path → file content). */
export function render(cfg: ScaffoldConfig): Map<string, string> {
  const files = new Map<string, string>()
  files.set('package.json', packageJson(cfg))
  files.set('.gitignore', 'node_modules\ndist\n.env\n.dev.vars\n.vercel\n')
  files.set('.env.example', envExample())
  files.set('README.md', readme(cfg))
  files.set('src/gate.mjs', gateFile(cfg))
  files.set('src/verify.mjs', verifyFile())
  if (cfg.host === 'node') {
    files.set('src/server.mjs', nodeServer(cfg))
  } else if (cfg.host === 'cloudflare') {
    files.set('src/worker.mjs', cloudflareWorker(cfg))
    files.set('wrangler.toml', wranglerToml(cfg))
  } else {
    files.set('api/x402.js', vercelFunction(cfg))
    files.set('vercel.json', vercelJson())
  }
  return files
}

function gateFile(cfg: ScaffoldConfig): string {
  const preset = cfg.sell === 'tip' ? 'createTipJar' : 'createPaywall'
  const amountKey = cfg.sell === 'tip' ? 'min' : 'amount'
  return [
    `import { ${preset} } from '${SDK}'`,
    ``,
    `// Your x402 payment gate. Receiving needs only this PUBLIC wallet address — no private key, ever.`,
    `// Edit these values; the server and the 'verify' check both read this one gate.`,
    `export const gate = ${preset}({`,
    `  chain: ${JSON.stringify(cfg.chain)},`,
    `  token: ${JSON.stringify(cfg.token)},`,
    `  ${amountKey}: ${JSON.stringify(cfg.amount)},`,
    `  payTo: ${JSON.stringify(cfg.payTo)},`,
    `  onPaid: (receipt) =>`,
    `    console.log('💰 paid ' + receipt.amountFormatted + ' ' + (receipt.symbol || '') + ' — ' + receipt.idempotencyKey),`,
    `})`,
    ``,
  ].join('\n')
}

function verifyFile(): string {
  return [
    `import { gate } from './gate.mjs'`,
    ``,
    `// A read-only config check — never signs, never sends. Run it before you deploy.`,
    `const r = await gate.selfTest()`,
    `if (!r.ok) {`,
    `  console.error('❌ Gate misconfigured: ' + r.error)`,
    `  process.exit(1)`,
    `}`,
    `console.log('✅ Configured to accept:')`,
    `for (const rail of r.rails) {`,
    `  console.log('   ' + rail.amount + ' ' + (rail.symbol || rail.asset) + ' on ' + rail.network + ' -> ' + rail.payTo + '  [' + rail.schemes.join(', ') + ']')`,
    `}`,
    `for (const w of r.warnings) console.warn('warning: ' + w)`,
    ``,
  ].join('\n')
}

function nodeServer(cfg: ScaffoldConfig): string {
  const { path, payload } = resourceOf(cfg.sell)
  return [
    `import express from 'express'`,
    `import { gate } from './gate.mjs'`,
    ``,
    `const RESOURCE = ${JSON.stringify(path)}`,
    `const app = express()`,
    ``,
    `// Machine-readable discovery — so AI agents can find + price this endpoint.`,
    `app.get('/.well-known/x402', async (_req, res) => res.json(await gate.describe(RESOURCE)))`,
    ``,
    `app.get(RESOURCE, async (req, res) => {`,
    `  const proof = req.headers['payment-signature'] ?? req.headers['x-payment']`,
    `  // A human opening the link in a browser (no proof yet)? Show a friendly page, not raw JSON.`,
    `  if (!proof && (req.headers['accept'] || '').includes('text/html')) {`,
    `    const { challenge } = await gate.challenge(RESOURCE)`,
    `    res.setHeader('content-type', 'text/html; charset=utf-8')`,
    `    return res.status(402).send(gate.landingPage(challenge))`,
    `  }`,
    `  const result = await gate.verify(proof)`,
    `  if (result.kind === 'paid') {`,
    `    res.setHeader('payment-response', result.receiptHeader)`,
    `    return res.json(${payload})`,
    `  }`,
    `  res.setHeader('payment-required', result.requiredHeader)`,
    `  res.status(402).json(result.challenge)`,
    `})`,
    ``,
    `const port = process.env.PORT || 8080`,
    `app.listen(port, () => console.log('serving http://localhost:' + port + RESOURCE + '  (pay to unlock)'))`,
    ``,
  ].join('\n')
}

/** The shared entry body for the fetch hosts (worker + vercel): discovery route, human landing, paid handler. */
function fetchEntry(cfg: ScaffoldConfig, importPath: string): { imports: string; body: string } {
  const { path } = resourceOf(cfg.sell)
  const named = cfg.sell === 'proxy' ? 'toFetchHandler, proxyTo' : 'toFetchHandler'
  const imports = [
    `import { ${named} } from '${SDK}'`,
    `import { gate } from '${importPath}'`,
  ].join('\n')
  const originLine = cfg.sell === 'proxy' ? `\nconst ORIGIN = ${JSON.stringify(cfg.origin ?? '')}` : ''
  const body = [
    `const RESOURCE = ${JSON.stringify(path)}${originLine}`,
    `const paid = toFetchHandler(gate, ${serveExpr(cfg)})`,
    ``,
    `async function route(request, ...rest) {`,
    `  const url = new URL(request.url)`,
    `  if (url.pathname === '/.well-known/x402') return Response.json(await gate.describe(RESOURCE))`,
    `  // A human opening the link in a browser (no proof yet)? Show a friendly page, not raw JSON.`,
    `  if (isBrowserGet(request)) {`,
    `    const { challenge } = await gate.challenge(RESOURCE)`,
    `    return new Response(gate.landingPage(challenge), { status: 402, headers: { 'content-type': 'text/html; charset=utf-8' } })`,
    `  }`,
    `  return paid(request, ...rest)`,
    `}`,
    ``,
    IS_BROWSER_GET,
  ].join('\n')
  return { imports, body }
}

function cloudflareWorker(cfg: ScaffoldConfig): string {
  const { imports, body } = fetchEntry(cfg, './gate.mjs')
  return [
    imports,
    ``,
    body,
    ``,
    `export default {`,
    `  fetch(request, env, ctx) {`,
    `    return route(request, env, ctx)`,
    `  },`,
    `}`,
    ``,
  ].join('\n')
}

function vercelFunction(cfg: ScaffoldConfig): string {
  const { imports, body } = fetchEntry(cfg, '../src/gate.mjs')
  return [
    imports,
    ``,
    `export const config = { runtime: 'edge' }`,
    ``,
    body,
    ``,
    `// A single Edge Function gates everything; vercel.json rewrites all paths here.`,
    `export default function handler(request) {`,
    `  return route(request)`,
    `}`,
    ``,
  ].join('\n')
}

function wranglerToml(cfg: ScaffoldConfig): string {
  return [
    `name = ${JSON.stringify(cfg.name)}`,
    `main = "src/worker.mjs"`,
    `compatibility_date = "2024-09-23"`,
    ``,
    `# Receiving needs only your PUBLIC address (baked into src/gate.mjs) — no secret here.`,
    ``,
  ].join('\n')
}

function vercelJson(): string {
  return JSON.stringify({ rewrites: [{ source: '/(.*)', destination: '/api/x402' }] }, null, 2) + '\n'
}

function envExample(): string {
  return [
    `# Receiving x402 payments needs only your PUBLIC wallet address — and it's already in`,
    `# src/gate.mjs (no private key, ever). These are optional overrides:`,
    `# PORT=8080`,
    `# RPC_URL=          # a custom RPC for your chain (recommended in production)`,
    ``,
  ].join('\n')
}

function packageJson(cfg: ScaffoldConfig): string {
  let scripts: Record<string, string>
  if (cfg.host === 'node') {
    scripts = { verify: 'node src/verify.mjs', start: 'node src/server.mjs' }
  } else if (cfg.host === 'cloudflare') {
    scripts = { verify: 'node src/verify.mjs', dev: 'npx wrangler dev', deploy: 'npx wrangler deploy' }
  } else {
    scripts = { verify: 'node src/verify.mjs', dev: 'npx vercel dev', deploy: 'npx vercel deploy' }
  }
  const dependencies: Record<string, string> = { [SDK]: 'latest' }
  if (cfg.host === 'node') dependencies['express'] = '^4.21.0'
  const pkg = {
    name: cfg.name,
    private: true,
    type: 'module',
    scripts,
    dependencies,
  }
  return JSON.stringify(pkg, null, 2) + '\n'
}

/** A one-click "Deploy" button + push-then-click steps, for the cloudflare / vercel hosts. */
function deployButton(cfg: ScaffoldConfig): string {
  if (cfg.host === 'node') return ''
  const repo = 'https://github.com/YOUR_GITHUB_USERNAME/' + cfg.name
  const [provider, badge, url] =
    cfg.host === 'cloudflare'
      ? [
          'Cloudflare',
          'https://deploy.workers.cloudflare.com/button',
          `https://deploy.workers.cloudflare.com/?url=${repo}`,
        ]
      : ['Vercel', 'https://vercel.com/button', `https://vercel.com/new/clone?repository-url=${repo}`]
  return [
    ``,
    `## Deploy in one click (your own ${provider} account)`,
    ``,
    `1. Push this folder to a **public** GitHub repo.`,
    `2. Replace \`YOUR_GITHUB_USERNAME\` in the link below with yours, then click:`,
    ``,
    `[![Deploy to ${provider}](${badge})](${url})`,
    ``,
    `Your **public** wallet address is already baked into \`src/gate.mjs\` — there's nothing else to`,
    `configure, and no secret to set. It deploys to **your** ${provider} account, not PipRail's.`,
  ].join('\n')
}

/** A copy-paste "Pay" button for a web page — the shareable embed (api/tip only; a proxy is an API). */
function embedSnippet(cfg: ScaffoldConfig): string {
  if (cfg.sell === 'proxy') return ''
  const { path } = resourceOf(cfg.sell)
  return [
    ``,
    `## Share it — a payable link + an embed`,
    ``,
    `Your deployed URL **is** the shareable link: anyone who hits \`${path}\` (a person *or* an AI agent)`,
    `is asked to pay, and unlocks it on payment. Drop this button on any web page to let a visitor pay`,
    `with their browser wallet (e.g. MetaMask) — pure client-side, no backend:`,
    ``,
    '```html',
    `<button id="pay">Pay ${cfg.amount} ${cfg.token}</button>`,
    `<script type="module">`,
    `  import { PipRailClient } from 'https://esm.sh/@piprail/sdk'`,
    `  document.getElementById('pay').onclick = async () => {`,
    `    // Sign with the visitor's injected wallet — never a raw key in a web page.`,
    `    const client = new PipRailClient({ chain: ${JSON.stringify(cfg.chain)}, wallet: { walletClient } })`,
    `    const res = await client.fetch('https://YOUR-DEPLOYED-URL${path}')`,
    `    alert(JSON.stringify(await res.json()))`,
    `  }`,
    `</script>`,
    '```',
  ].join('\n')
}

function readme(cfg: ScaffoldConfig): string {
  const { path } = resourceOf(cfg.sell)
  let run: string
  if (cfg.host === 'node') {
    run =
      '```sh\nnpm install\nnpm run verify   # checks your config (no signing, no sending)\nnpm start        # serves the paid endpoint on http://localhost:8080\n```'
  } else if (cfg.host === 'cloudflare') {
    run =
      '```sh\nnpm install\nnpm run verify   # checks your config\nnpm run dev      # npx wrangler dev (local)\nnpm run deploy   # npx wrangler deploy (your Cloudflare account)\n```'
  } else {
    run =
      '```sh\nnpm install\nnpm run verify   # checks your config\nnpm run dev      # npx vercel dev (local)\nnpm run deploy   # npx vercel deploy (your Vercel account)\n```'
  }
  const what =
    cfg.sell === 'tip'
      ? 'an open tip jar'
      : cfg.sell === 'proxy'
        ? `a payment gate in front of your existing API (\`${cfg.origin ?? ''}\`)`
        : 'a paywalled endpoint'
  const endpointLine =
    cfg.sell === 'proxy'
      ? `- **Gates:** every path → forwards **paid** requests to \`${cfg.origin ?? ''}\` (the origin never sees an unpaid one)`
      : `- **Endpoint:** \`${path}\` (plus \`/.well-known/x402\` for agent discovery)`
  return [
    `# ${cfg.name}`,
    ``,
    `${what} that accepts **x402 stablecoin payments** — from humans *and* AI agents — straight to your`,
    `own wallet. Built with [\`@piprail/sdk\`](https://piprail.com): no backend, no account, no fee, and`,
    `receiving needs only your **public address** (no private key).`,
    ``,
    `- **Chain / token:** ${cfg.chain} · ${cfg.token}`,
    `- **Pays to:** \`${cfg.payTo}\``,
    endpointLine,
    ``,
    `## Run it`,
    ``,
    run,
    deployButton(cfg),
    embedSnippet(cfg),
    ``,
    `## The whole integration`,
    ``,
    `The gate is the only PipRail code — \`src/gate.mjs\`:`,
    ``,
    '```js',
    gateFile(cfg).trim(),
    '```',
    ``,
    `Open the URL in a browser and you'll see a friendly **landing page**; an AI agent or \`curl\` gets`,
    `the machine-readable \`402\`. Change the price or wallet in the gate and re-run \`npm run verify\`.`,
    `Full docs: [docs.piprail.com](https://docs.piprail.com).`,
    ``,
  ].join('\n')
}
