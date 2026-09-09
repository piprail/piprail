// Real mainnet demo. One payment, capped at 0.01 USDC. Never prints signing material.
import { readFileSync } from 'node:fs';
import { PipRailClient, parseReceipt } from '../../../../../sdk/dist/index.js';
const url = 'https://piprail.com/x402/demo';
const walletFile = process.env.PIPRAIL_DEMO_WALLET || new URL('../../../../../.secrets/wallets/evm-wallet.json', import.meta.url);
const { privateKey } = JSON.parse(readFileSync(walletFile, 'utf8'));
const client = new PipRailClient({ chain: 'base', wallet: { key: privateKey }, schemes: ['exact'], policy: { maxAmount: '0.01', maxTotal: '0.01', maxPayments: 1 } });
const started = Date.now();
const log = (...s) => console.log(`[${((Date.now()-started)/1000).toFixed(1)}s]`, ...s);
log('GET', url);
const challenge = await fetch(url);
log('HTTP', challenge.status, challenge.status === 402 ? 'PAYMENT REQUIRED' : '');
await challenge.arrayBuffer();
if(challenge.status !== 402) throw Error('Expected a payment challenge');
log('Policy: maxAmount 0.01 USDC | maxPayments 1');
log('client.planPayment(url)');
const plan = await client.planPayment(url);
log('Rails:', plan?.options?.map(o=>`${o.state} (${o.blockers.join(',') || o.method})`).join(' | ') || JSON.stringify(plan));
log('client.fetch(url): sign; merchant settles on Base');
try {
 const response = await client.fetch(url);
 log('HTTP', response.status, response.status === 200 ? 'OK' : '');
 const receipt = parseReceipt(response);
 log('Response:', await response.text());
 if(response.status !== 200 || !receipt?.transaction) throw Error('No settled receipt');
 log('Transaction:', receipt.transaction);
 log('Explorer: https://basescan.org/tx/' + receipt.transaction);
 log('Done. One live payment. No cuts.');
} catch(error) { log('Payment did not complete:', error.name); process.exitCode = 1; }

// The receipt and response have been consumed; do not wait for RPC keep-alive timers.
process.stdout.write('', () => process.exit(process.exitCode || 0));
