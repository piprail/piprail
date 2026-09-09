// Exercise the displayed middleware and policy using a local route. No funds move.
import assert from 'node:assert/strict';
import express from 'express';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { PipRailClient, requirePayment } from '../../../../../sdk/dist/index.js';
const key=generatePrivateKey();
const payTo=privateKeyToAccount(generatePrivateKey()).address;
const gate=requirePayment({chain:'base',token:'USDC',amount:'0.01',payTo});
const expensive=requirePayment({chain:'base',token:'USDC',amount:'0.02',payTo});
const app=express();
app.get('/report',gate,(_req,res)=>res.send('paid'));
app.get('/expensive',expensive,(_req,res)=>res.send('paid'));
const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});
try {
 const root=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await fetch(root+'/report')).status,402);
 const wallet={key};const url=root+'/expensive';
 const client=new PipRailClient({chain:'base',wallet,policy:{maxAmount:'0.01'}});
 const plan=await client.planPayment(url);
 assert(plan.options.some(o=>o.blockers.includes('OUTSIDE_POLICY')));
 await assert.rejects(()=>client.fetch(url),e=>{console.log('Actual refusal:',e.name,e.code);return e.name==='PaymentDeclinedError'});
 console.log('Displayed server and agent snippets verified. No payment sent.');
} finally {server.close();server.closeAllConnections();}
