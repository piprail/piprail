#!/usr/bin/env node
import { run } from './index.js'

run(process.argv.slice(2)).catch((err: unknown) => {
  console.error('\ncreate-piprail: ' + (err instanceof Error ? err.message : String(err)) + '\n')
  process.exit(1)
})
