# Dockerfile — build, run, and introspect the PipRail MCP server in a container.
#
# Purpose: let Glama (and any container-based MCP host / inspector) start the
# server and enumerate its tools for automated quality scoring. Without this,
# Glama reports "this server cannot be installed" and the quality badge stays "?"
# (unevaluated), because it has no way to build and run the server to inspect it.
#
# PipRail ships as the npm package @piprail/mcp — the very same `npx -y @piprail/mcp`
# users run — so this image simply installs that published package and runs its
# stdio bin. Nothing here changes the product's shape: it's a local stdio server,
# no backend, no custody.
#
# With no PIPRAIL_PRIVATE_KEY the server boots in READ-ONLY mode: all eight tools
# (discover · quote · plan · pay · register · budget · guide · verify-receipt) are
# fully discoverable, so an inspector can introspect it WITHOUT a wallet. Provide
# PIPRAIL_PRIVATE_KEY (and optional PIPRAIL_* config — see mcp/README.md) at
# runtime to actually pay.
FROM node:20-slim

# The published MCP (pulls @piprail/sdk as a dependency). Unpinned = always the
# current release — matching smithery.yaml's `npx -y @piprail/mcp` convention, so
# there is no version to keep in sync here.
RUN npm install -g @piprail/mcp

# stdio MCP server; read-only unless PIPRAIL_PRIVATE_KEY is supplied at runtime.
ENTRYPOINT ["piprail-mcp"]
