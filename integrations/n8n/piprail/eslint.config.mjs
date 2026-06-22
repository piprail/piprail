// n8n community-node lint config (eslint-plugin-n8n-nodes-base + @n8n/eslint-plugin-community-nodes),
// shipped by @n8n/node-cli. Run: `npm run lint`.
//
// We use the WITHOUT-cloud-support config on purpose: this node BUNDLES @piprail/sdk (so the
// published package has zero runtime dependencies), but n8n Cloud's verification forbids ANY
// third-party import in source — incompatible with wrapping a real SDK. This is the self-hosted
// community-node tier, installed via Settings -> Community Nodes (what the README documents).
import { configWithoutCloudSupport } from '@n8n/node-cli/eslint'

export default [
  ...configWithoutCloudSupport,
  {
    // PipRail's credential is a self-custody wallet private key — there is no HTTP endpoint to
    // validate it against (n8n's credential `test` is an HTTP request; a private key can't be
    // checked that way). Disable the API-credential-only rule for this non-API credential.
    files: ['credentials/**/*.ts'],
    rules: { '@n8n/community-nodes/credential-test-required': 'off' },
  },
]
