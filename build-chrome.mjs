// Chrome build: extension/ with a manifest stripped of the Firefox-only keys Chrome warns about.
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

process.chdir(import.meta.dirname)
const out = 'dist/chrome'
rmSync('dist', { recursive: true, force: true })
cpSync('extension', out, { recursive: true, filter: (src) => !src.endsWith('.svg') })

const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'))
delete manifest.browser_specific_settings
delete manifest.background.scripts
delete manifest.action.default_area
manifest.permissions = manifest.permissions.filter((p) => p !== 'menus')
writeFileSync(`${out}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)

execFileSync('zip', ['-qr', `../visual-history-chrome-${manifest.version}.zip`, '.'], { cwd: out })
