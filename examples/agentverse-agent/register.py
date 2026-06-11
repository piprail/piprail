"""Register PipRail Pay on Agentverse so other agents (and ASI:One) discover it.

This makes the relay (relay.mjs) a verified Agentverse identity: a seed-derived
address + a discovery README, pointing at the relay's PUBLIC webhook URL. That
identity is also what Agent Launch tokenizes in Phase 5 (one AGENTVERSE_KEY links
both platforms).

Prereqs (the human go-live steps):
  1. An Agentverse account → copy your AGENTVERSE_KEY.
  2. Deploy relay.mjs somewhere public (its URL = RELAY_PUBLIC_URL).
  3. pip install -r requirements.txt ; set AGENT_SECRET_KEY (a random seed) + AGENTVERSE_KEY.
  4. python3 register.py

Docs: https://innovationlab.fetch.ai/resources/docs/agent-creation/sdk-creation
"""

import os
from pathlib import Path

from uagents_core.crypto import Identity
from fetchai.registration import register_with_agentverse

# The agent's identity is derived from a secret seed (store in .secrets, never commit).
AGENT_SECRET_KEY = os.environ["AGENT_SECRET_KEY"]
AGENTVERSE_KEY = os.environ["AGENTVERSE_KEY"]

# The PUBLIC URL where relay.mjs is reachable (its /pay endpoint earns; Agentverse
# routes discovery here). Must be https in production.
WEBHOOK_URL = os.environ.get("RELAY_PUBLIC_URL", "https://your-relay.example.com") + "/pay"

NAME = "PipRail Pay"

# The discovery README drives ranking on Agentverse + ASI:One. (Phase 5 tokenizes the
# agent's resulting agent1q… address via POST /api/agents/tokenize; the token's own
# name/symbol/description ≤32/11/500 chars are set there. Keep this README rich for ranking.)
README = (Path(__file__).parent / "agent_readme.md").read_text(encoding="utf-8")


def main() -> None:
    identity = Identity.from_seed(AGENT_SECRET_KEY, 0)
    print(f"• agent address: {identity.address}")
    print(f"• webhook:       {WEBHOOK_URL}")
    register_with_agentverse(
        identity,
        WEBHOOK_URL,
        AGENTVERSE_KEY,
        NAME,
        README,
    )
    print("✓ registered with Agentverse — discoverable on the marketplace + ASI:One")


if __name__ == "__main__":
    main()
