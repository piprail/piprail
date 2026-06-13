#!/usr/bin/env node
// Export the deck to a shareable PDF (LibreOffice headless). Honors embedded fonts.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SOFFICE = '/Applications/LibreOffice.app/Contents/MacOS/soffice'
const PPTX = join(__dirname, 'PipRail-deck.pptx')

if (!existsSync(SOFFICE)) {
  console.error('LibreOffice not found. Install: brew install --cask libreoffice')
  process.exit(1)
}
execFileSync(SOFFICE, ['--headless', '--convert-to', 'pdf', '--outdir', __dirname, PPTX], { stdio: 'ignore' })
console.log('wrote', join(__dirname, 'PipRail-deck.pdf'))
