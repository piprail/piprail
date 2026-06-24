/**
 * The pure scaffolder render: a {@link ScaffoldConfig} → a Map of (relative path → file content).
 * No filesystem, no prompts — so it's unit-testable and the mainnet-default guard is assertable.
 * The CLI ({@link run}) collects the config, calls this, and writes the map to disk.
 *
 * The emitted app depends ONLY on `@piprail/sdk` (+ `express` for the node host). The merchant's
 * config — chain, token, amount, and the PUBLIC `payTo` address — is baked into `src/gate.mjs` as
 * literals (no env, no key), so it works at module scope on every runtime, including Workers.
 */

export type Sell = 'api' | 'tip'
export type Host = 'node' | 'cloudflare'

export interface ScaffoldConfig {
  /** The generated package name. */
  name: string
  /** What you're selling — a paywalled API endpoint, or an open tip jar. */
  sell: Sell
  /** Mainnet chain to be paid on, e.g. `'base'`. NEVER a testnet (the scaffolder refuses testnets). */
  chain: string
  /** Token to charge in, e.g. `'USDC'` or `'native'`. */
  token: string
  /** Your receiving PUBLIC wallet address — no private key. */
  payTo: string
  /** The fixed price (api) or the minimum (tip), human-readable, e.g. `'0.05'`. */
  amount: string
  /** Where it will run. */
  host: Host
}

const SDK = '@piprail/sdk'

/** The gated resource path + the unlocked JSON payload, per sell type. */
function resourceOf(sell: Sell): { path: string; serve: string } {
  return sell === 'tip'
    ? { path: '/tip', serve: "{ thanks: true, message: 'Thank you for the tip!' }" }
    : { path: '/report', serve: "{ unlocked: true, report: 'your premium content here' }" }
}

/** Render the whole project as (relative path → file content). */
export function render(cfg: ScaffoldConfig): Map<string, string> {
  const files = new Map<string, string>()
  files.set('package.json', packageJson(cfg))
  files.set('.gitignore', 'node_modules\ndist\n.env\n.dev.vars\n')
  files.set('.env.example', envExample())
  files.set('README.md', readme(cfg))
  files.set('src/gate.mjs', gateFile(cfg))
  files.set('src/verify.mjs', verifyFile())
  if (cfg.host === 'node') {
    files.set('src/server.mjs', nodeServer(cfg))
  } else {
    files.set('src/worker.mjs', cloudflareWorker(cfg))
    files.set('wrangler.toml', wranglerToml(cfg))
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
  const { path, serve } = resourceOf(cfg.sell)
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
    `  const result = await gate.verify(req.headers['payment-signature'] ?? req.headers['x-payment'])`,
    `  if (result.kind === 'paid') {`,
    `    res.setHeader('payment-response', result.receiptHeader)`,
    `    return res.json(${serve})`,
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

function cloudflareWorker(cfg: ScaffoldConfig): string {
  const { path, serve } = resourceOf(cfg.sell)
  return [
    `import { toFetchHandler } from '${SDK}'`,
    `import { gate } from './gate.mjs'`,
    ``,
    `const RESOURCE = ${JSON.stringify(path)}`,
    `// toFetchHandler runs the whole 402 contract; we route /.well-known/x402 for agent discovery.`,
    `const paid = toFetchHandler(gate, () => Response.json(${serve}))`,
    ``,
    `export default {`,
    `  async fetch(request, env, ctx) {`,
    `    const url = new URL(request.url)`,
    `    if (url.pathname === '/.well-known/x402') return Response.json(await gate.describe(RESOURCE))`,
    `    return paid(request, env, ctx)`,
    `  },`,
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
  const scripts: Record<string, string> =
    cfg.host === 'node'
      ? { verify: 'node src/verify.mjs', start: 'node src/server.mjs' }
      : { verify: 'node src/verify.mjs', dev: 'wrangler dev', deploy: 'wrangler deploy' }
  const dependencies: Record<string, string> = { [SDK]: 'latest' }
  if (cfg.host === 'node') dependencies['express'] = '^4.21.0'
  const pkg: Record<string, unknown> = {
    name: cfg.name,
    private: true,
    type: 'module',
    scripts,
    dependencies,
  }
  if (cfg.host === 'cloudflare') pkg['devDependencies'] = { wrangler: '^3.78.0' }
  return JSON.stringify(pkg, null, 2) + '\n'
}

function readme(cfg: ScaffoldConfig): string {
  const { path } = resourceOf(cfg.sell)
  const run =
    cfg.host === 'node'
      ? '```sh\nnpm install\nnpm run verify   # checks your config (no signing, no sending)\nnpm start        # serves the paid endpoint on http://localhost:8080\n```'
      : '```sh\nnpm install\nnpm run verify   # checks your config\nnpm run dev      # wrangler dev (local)\nnpm run deploy   # wrangler deploy (your Cloudflare account)\n```'
  const what = cfg.sell === 'tip' ? 'an open tip jar' : 'a paywalled endpoint'
  return [
    `# ${cfg.name}`,
    ``,
    `${what} that accepts **x402 stablecoin payments** — from humans *and* AI agents — straight to your`,
    `own wallet. Built with [\`@piprail/sdk\`](https://piprail.com): no backend, no account, no fee, and`,
    `receiving needs only your **public address** (no private key).`,
    ``,
    `- **Chain / token:** ${cfg.chain} · ${cfg.token}`,
    `- **Pays to:** \`${cfg.payTo}\``,
    `- **Endpoint:** \`${path}\` (plus \`/.well-known/x402\` for agent discovery)`,
    ``,
    `## Run it`,
    ``,
    run,
    ``,
    `## The whole integration`,
    ``,
    `The gate is the only PipRail code — \`src/gate.mjs\`:`,
    ``,
    '```js',
    gateFile(cfg).trim(),
    '```',
    ``,
    `Change the price or wallet there and re-run \`npm run verify\`. Full docs:`,
    `[docs.piprail.com](https://docs.piprail.com).`,
    ``,
  ].join('\n')
}
