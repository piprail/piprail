Below is a **minimal, self‑contained example** that demonstrates how an AI agent (or any script) can:

1. **Pay the x402 endpoint** (`https://wazir-x402.duckdns.org/api/bug-intel`) with 5 USDC on Base.  
2. **Trigger the MCP scanner** (`https://bug-bounty-intelligence-mcp.vercel.app/api/scan`) to get the vulnerability report.  

The snippet is written in **Node.js** (ES‑module style) and uses `ethers.js` for signing the payment transaction and `node-fetch` for the HTTP calls.  
All the hard‑coded values (URLs, token, amount, chain) are kept in a single place so you can tweak them for your own environment.

> **Why this fixes the issue**  
> The original example in the repo was missing:  
> * the correct MCP endpoint URL,  
> * the `payment` payload