"""PipRail settlement bridge for Fetch's Agent Payment Protocol.

The bridge from Python uAgents to PipRail's payment rail. It speaks MCP (JSON-RPC
over stdio) to ``@piprail/mcp`` — the budget-bound payer wallet — and exposes one
method the APP adapter needs:

    bridge.pay(reference) -> receipt   # settle an x402 URL, return the proof

It's *stdlib only* (subprocess + json) — no ``uagents`` and no ``mcp`` SDK
dependency — so it imports and self-tests anywhere Python runs, and the same code
backs both the demo agents and a production sidecar.

Why the MCP and not the SDK directly? The SDK is TypeScript. ``@piprail/mcp`` wraps
it behind a language-agnostic protocol and adds the spend policy the model cannot
exceed — so the bridge gets a budget-bound wallet for free, in any language.

Run it directly to verify the wiring against the real MCP (no payment, no funds):

    python3 piprail_bridge.py            # initialize + tools/list handshake
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from typing import Any, Optional


class PipRailBridge:
    """A minimal MCP stdio client bound to one ``@piprail/mcp`` process.

    The MCP's spend policy (``PIPRAIL_MAX_AMOUNT`` / ``PIPRAIL_MAX_TOTAL`` / the
    token + chain allowlist) is configured purely via ``env`` — never in code, and
    no key is ever logged. Only ``pay()`` moves money; everything else is read-only.
    """

    def __init__(
        self,
        command: Optional[list[str]] = None,
        env: Optional[dict[str, str]] = None,
        timeout: float = 120.0,
    ) -> None:
        # Default to the published package; override to a local build for dev, e.g.
        # ["node", "../../mcp/dist/bin.js"].
        self.command = command or ["npx", "-y", "@piprail/mcp"]
        # Inherit the ambient env (so PIPRAIL_PRIVATE_KEY / PIPRAIL_CHAIN / budgets
        # flow through) and layer any explicit overrides on top.
        self.env = {**os.environ, **(env or {})}
        self.timeout = timeout
        self._proc: Optional[subprocess.Popen[str]] = None
        self._next_id = 0
        self._lock = threading.Lock()

    # -- process lifecycle ----------------------------------------------------

    def start(self) -> "PipRailBridge":
        """Spawn the MCP and complete the ``initialize`` handshake."""
        self._proc = subprocess.Popen(
            self.command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=sys.stderr,  # the MCP logs its banner to stderr — let it through
            env=self.env,
            text=True,
            bufsize=1,  # line-buffered: MCP frames one JSON object per line on stdio
        )
        self._request(
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "piprail-fetch-app-bridge", "version": "1.0.0"},
            },
        )
        self._notify("notifications/initialized", {})
        return self

    def close(self) -> None:
        if self._proc is not None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
            self._proc = None

    def __enter__(self) -> "PipRailBridge":
        return self.start()

    def __exit__(self, *_exc: Any) -> None:
        self.close()

    # -- the JSON-RPC line transport -----------------------------------------

    def _send(self, message: dict[str, Any]) -> None:
        assert self._proc is not None and self._proc.stdin is not None, "bridge not started"
        self._proc.stdin.write(json.dumps(message) + "\n")
        self._proc.stdin.flush()

    def _notify(self, method: str, params: dict[str, Any]) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def _request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        """Send a request and read until the matching response id comes back."""
        assert self._proc is not None and self._proc.stdout is not None, "bridge not started"
        with self._lock:
            self._next_id += 1
            req_id = self._next_id
            self._send({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
            # stdio MCP is strictly request/response here; skip any notification
            # lines and stop on the response carrying our id.
            for line in self._proc.stdout:
                line = line.strip()
                if not line:
                    continue
                msg = json.loads(line)
                if msg.get("id") != req_id:
                    continue
                if "error" in msg:
                    raise RuntimeError(f"MCP error on {method}: {msg['error']}")
                return msg.get("result", {})
        raise RuntimeError(f"MCP closed before responding to {method}")

    # -- the tools the APP adapter uses --------------------------------------

    def list_tools(self) -> list[dict[str, Any]]:
        """The MCP's tool catalogue (7 tools; only ``piprail_pay_request`` pays)."""
        return self._request("tools/list", {}).get("tools", [])

    def _call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        result = self._request("tools/call", {"name": name, "arguments": arguments})
        # The MCP emits structured JSON as `structuredContent` AND as a text block;
        # prefer the structured form, fall back to parsing the text.
        if "structuredContent" in result:
            payload: Any = result["structuredContent"]
        else:
            blocks = result.get("content", [])
            text = next((b.get("text", "") for b in blocks if b.get("type") == "text"), "")
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                payload = {"text": text}
        if result.get("isError"):
            raise RuntimeError(f"{name} failed: {payload}")
        return payload

    def pay(self, reference: str, method: str = "GET", body: Any = None) -> dict[str, Any]:
        """Settle an x402 ``reference`` URL and return the result.

        Maps APP ``RequestPayment.reference`` → ``piprail_pay_request`` → the proof.
        Returns ``{status, ok, body, receipt}``; ``receipt`` is the x402 receipt
        (``{transaction, network, asset, amount, payer, payTo, verifiedAt}``) you
        forward as APP ``CompletePayment.proof``. A policy refusal or shortfall
        comes back as ``{ok: False, code, reason, ...}`` — never an exception.
        """
        args: dict[str, Any] = {"url": reference, "method": method}
        if body is not None:
            args["body"] = body
        return self._call_tool("piprail_pay_request", args)


def _self_test() -> int:
    """Prove the bridge against the real MCP: initialize + tools/list, no payment.

    Uses a throwaway key (read-only handshake — the key only derives an address
    locally; ``tools/list`` touches no network and moves no money).
    """
    env = {
        # A valid-format but unfunded ephemeral key — handshake only, never used to pay.
        "PIPRAIL_PRIVATE_KEY": os.environ.get(
            "PIPRAIL_PRIVATE_KEY",
            "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
        ),
        "PIPRAIL_CHAIN": os.environ.get("PIPRAIL_CHAIN", "bnb"),
    }
    # Prefer a local build if present, else the published package.
    local = os.path.join(os.path.dirname(__file__), "..", "..", "mcp", "dist", "bin.js")
    command = ["node", local] if os.path.exists(local) else ["npx", "-y", "@piprail/mcp"]
    print(f"• spawning {' '.join(command)} (chain={env['PIPRAIL_CHAIN']})", file=sys.stderr)
    with PipRailBridge(command=command, env=env) as bridge:
        tools = [t["name"] for t in bridge.list_tools()]
        print(f"• tools/list → {tools}", file=sys.stderr)
        if "piprail_pay_request" not in tools:
            print("✗ piprail_pay_request missing — bridge cannot settle", file=sys.stderr)
            return 1
        print("✓ bridge handshake OK — piprail_pay_request is callable", file=sys.stderr)
        return 0


if __name__ == "__main__":
    raise SystemExit(_self_test())
