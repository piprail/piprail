#!/usr/bin/env node
// Export the deck to a shareable PDF (LibreOffice headless). Honors embedded fonts.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SOFFICE = '/Applications/LibreOffice.app/Contents/MacOS/soffice'
const PPTX = join(__dirname, 'PipRail-deck.pptx')
const PDF = join(__dirname, 'PipRail-deck.pdf')
// Repo root: deck/ -> design/ -> branding/ -> skills/ -> .claude/ -> root
const ROOT_PDF = join(__dirname, '..', '..', '..', '..', '..', 'PipRail-deck.pdf')

if (!existsSync(SOFFICE)) {
  console.error('LibreOffice not found. Install: brew install --cask libreoffice')
  process.exit(1)
}
execFileSync(SOFFICE, ['--headless', '--convert-to', 'pdf', '--outdir', __dirname, PPTX], { stdio: 'ignore' })
console.log('wrote', PDF)

// Also publish a copy to the repo root so it's clickable from the GitHub repo / org page
// (GitHub renders PDFs inline in the browser). The root copy is the published artifact —
// keep it in sync; that's why it's written here rather than copied by hand.
copyFileSync(PDF, ROOT_PDF)
console.log('wrote', ROOT_PDF)
