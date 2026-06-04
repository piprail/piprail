// Pre-highlighted code snippets shown on the landing page. The `tok-*` spans are
// styled in global.css; lines are reflowed short so they never overflow on
// mobile. Rendered via <CodeWindow code={…} />.

export const acceptCode = `<span class="tok-kw">import</span> { requirePayment } <span class="tok-kw">from</span> <span class="tok-str">'@piprail/sdk'</span>

app.<span class="tok-fn">get</span>(<span class="tok-str">'/report'</span>,
  <span class="tok-fn">requirePayment</span>({
    chain: <span class="tok-chain">'solana'</span>,
    token: <span class="tok-str">'USDC'</span>,
    amount: <span class="tok-str">'0.05'</span>,
    payTo,
  }),
  (req, res) => res.<span class="tok-fn">json</span>({ data }),
)`

export const payCode = `<span class="tok-kw">import</span> { PipRailClient } <span class="tok-kw">from</span> <span class="tok-str">'@piprail/sdk'</span>

<span class="tok-kw">const</span> client = <span class="tok-kw">new</span> <span class="tok-fn">PipRailClient</span>({
  chain: <span class="tok-chain">'arbitrum'</span>,
  wallet: { privateKey: process.env.KEY },
})

<span class="tok-com">// On a 402: pays, then retries.</span>
<span class="tok-kw">const</span> res = <span class="tok-kw">await</span> client.<span class="tok-fn">fetch</span>(url)`

export const oneParamCode = `<span class="tok-fn">requirePayment</span>({
  chain: <span class="tok-chain">'hyperevm'</span>,  <span class="tok-com">// ← any of 28 chains</span>
  token: <span class="tok-str">'USDC'</span>,
  amount: <span class="tok-str">'0.05'</span>,
  payTo,
})`

export const exoticCode = `<span class="tok-com">// Any chain we don't ship — no allowlist.</span>
<span class="tok-fn">requirePayment</span>({
  chain: { id: <span class="tok-num">1313161554</span>, rpcUrl: <span class="tok-str">'https://…'</span> },
  token: { address: <span class="tok-str">'0x…'</span>, decimals: <span class="tok-num">6</span> },
  amount: <span class="tok-str">'0.05'</span>, payTo,
})`

export const solanaCode = `<span class="tok-com">// Name the chain — pay in its</span>
<span class="tok-com">// stablecoin, or its native coin.</span>
<span class="tok-fn">requirePayment</span>({
  chain: <span class="tok-chain">'solana'</span>, token: <span class="tok-str">'USDC'</span>,
  amount: <span class="tok-str">'0.05'</span>, payTo,
})
<span class="tok-fn">requirePayment</span>({
  chain: <span class="tok-chain">'sui'</span>, token: <span class="tok-str">'native'</span>,
  amount: <span class="tok-str">'0.5'</span>, payTo, <span class="tok-com">// pay in SUI</span>
})`

export const agentSafeCode = `<span class="tok-kw">const</span> client = <span class="tok-kw">new</span> <span class="tok-fn">PipRailClient</span>({
  chain: <span class="tok-chain">'monad'</span>, wallet,
  policy: {
    maxAmount: <span class="tok-str">'0.10'</span>,  <span class="tok-com">// per call</span>
    maxTotal: <span class="tok-str">'5.00'</span>,   <span class="tok-com">// lifetime</span>
    tokens: [<span class="tok-str">'USDC'</span>],  <span class="tok-com">// only USDC</span>
  },
})

<span class="tok-com">// Price it — without paying.</span>
<span class="tok-kw">const</span> q = <span class="tok-kw">await</span> client.<span class="tok-fn">quote</span>(url)

<span class="tok-com">// …and the gas to send it (native coin).</span>
<span class="tok-kw">const</span> { cost } = <span class="tok-kw">await</span> client.<span class="tok-fn">estimateCost</span>(url)

<span class="tok-com">// Over budget? Refused before any send.</span>
<span class="tok-kw">await</span> client.<span class="tok-fn">fetch</span>(url)`

// TON's one-time setup: a free toncenter API key in the rpcUrl. The only TON-specific config.
export const tonCode = `<span class="tok-com">// 1. Free key from @tonapibot on Telegram</span>
<span class="tok-com">// 2. Drop it into rpcUrl — the whole TON setup</span>
<span class="tok-fn">requirePayment</span>({
  chain: <span class="tok-chain">'ton'</span>, token: <span class="tok-str">'USDT'</span>,
  amount: <span class="tok-str">'0.05'</span>, payTo,
  rpcUrl: <span class="tok-str">'…/jsonRPC?api_key=YOUR_KEY'</span>,
})`

// One challenge, several chains — the agent pays with whatever it holds.
export const multiAcceptCode = `<span class="tok-fn">requirePayment</span>({
  accept: [
    { chain: <span class="tok-chain">'arbitrum'</span>, token: <span class="tok-str">'USDC'</span>, amount: <span class="tok-str">'0.05'</span>, payTo: evm },
    { chain: <span class="tok-chain">'solana'</span>, token: <span class="tok-str">'USDC'</span>, amount: <span class="tok-str">'0.05'</span>, payTo: sol },
  ],
})`
