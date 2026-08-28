// Reads the real shipped brand assets (chain logos, token logos, the PipRail mark)
// and emits assets.js — a self-contained data-URI bundle the scene HTML embeds, so
// the captured page has zero external file deps and renders identically every frame.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '/Users/john/Sites/piprail/site/public';

const b64 = (buf) => buf.toString('base64');
const svgURI = (p) => 'data:image/svg+xml;base64,' + b64(readFileSync(p));
const pngURI = (p) => 'data:image/png;base64,' + b64(readFileSync(p));

// Ordered exactly like site/src/data/chains.ts (by prominence).
const CHAINS = [
  { name: 'Ethereum', slug: 'ethereum', tokens: ['usdc', 'usdt'], family: 'EVM' },
  { name: 'Solana', slug: 'solana', tokens: ['usdc', 'usdt'], family: 'Solana' },
  { name: 'TON', slug: 'ton', tokens: ['usdt'], family: 'TON' },
  { name: 'Tron', slug: 'tron', tokens: ['usdt'], family: 'Tron' },
  { name: 'NEAR', slug: 'near', tokens: ['usdc', 'usdt'], family: 'NEAR' },
  { name: 'Sui', slug: 'sui', tokens: ['usdc'], family: 'Sui' },
  { name: 'Aptos', slug: 'aptos', tokens: ['usdc', 'usdt'], family: 'Aptos' },
  { name: 'Algorand', slug: 'algorand', tokens: ['usdc'], family: 'Algorand' },
  { name: 'Stellar', slug: 'stellar', tokens: ['usdc', 'eurc'], family: 'Stellar' },
  { name: 'XRP Ledger', slug: 'xrpl', tokens: ['usdc', 'rlusd'], family: 'XRPL' },
  { name: 'Base', slug: 'base', tokens: ['usdc'], family: 'EVM' },
  { name: 'BNB Chain', slug: 'bnb', tokens: ['usdc', 'usdt'], family: 'EVM' },
  { name: 'Arbitrum', slug: 'arbitrum', tokens: ['usdc', 'usdt'], family: 'EVM' },
  { name: 'Polygon', slug: 'polygon', tokens: ['usdc', 'usdt'], family: 'EVM' },
  { name: 'Optimism', slug: 'optimism', tokens: ['usdc', 'usdt'], family: 'EVM' },
  { name: 'Avalanche', slug: 'avalanche', tokens: ['usdc', 'usdt'], family: 'EVM' },
  { name: 'HyperEVM', slug: 'hyperevm', tokens: ['usdc'], family: 'EVM' },
  { name: 'Monad', slug: 'monad', tokens: ['usdc'], family: 'EVM' },
  { name: 'Mantle', slug: 'mantle', tokens: ['usdc', 'usdt'], family: 'EVM' },
  { name: 'Linea', slug: 'linea', tokens: ['usdc', 'usdt'], family: 'EVM' },
  { name: 'Scroll', slug: 'scroll', tokens: ['usdc', 'usdt'], family: 'EVM' },
  { name: 'zkSync Era', slug: 'zksync', tokens: ['usdc', 'usdt'], family: 'EVM' },
  { name: 'Celo', slug: 'celo', tokens: ['usdc', 'usdt'], family: 'EVM' },
  { name: 'Sonic', slug: 'sonic', tokens: ['usdc', 'usdt'], family: 'EVM' },
  { name: 'Unichain', slug: 'unichain', tokens: ['usdc', 'usdt'], family: 'EVM' },
  { name: 'World Chain', slug: 'worldchain', tokens: ['usdc'], family: 'EVM' },
  { name: 'Sei', slug: 'sei', tokens: ['usdc'], family: 'EVM' },
  { name: 'Injective', slug: 'injective', tokens: ['usdc', 'usdt'], family: 'EVM' },
  { name: 'Kaia', slug: 'kaia', tokens: ['usdt'], family: 'EVM' },
];

const chains = {};
for (const c of CHAINS) chains[c.slug] = svgURI(join(ROOT, 'chains', c.slug + '.svg'));

const tokens = {};
for (const t of ['usdc', 'usdt', 'eurc', 'rlusd']) tokens[t] = svgURI(join(ROOT, 'tokens', t + '.svg'));

const logo = pngURI(join(ROOT, 'logo.png'));
const logoNoBg = pngURI(join(ROOT, 'logo-no-background.png')); // transparent mark — for the hero finale

const out =
  'window.CHAINS = ' + JSON.stringify(CHAINS) + ';\n' +
  'window.ASSETS = ' + JSON.stringify({ chains, tokens, logo, logoNoBg }) + ';\n';

writeFileSync('/Users/john/Sites/piprail/.claude/skills/branding/design/video/assets.js', out);
const kb = (out.length / 1024).toFixed(0);
console.log(`assets.js written: ${CHAINS.length} chains, ${Object.keys(tokens).length} tokens, logo — ${kb} KB`);
