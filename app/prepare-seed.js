// Build helper: produce app/seed-config.json that the packaged app seeds its userData config from
// on first run (so testing needs no manual PSK entry). Prefers the real ../magnetgate.config.json;
// falls back to the PSK-less example so the build never fails when no config is present.
//
// NOTE: when seeded from the real config, the built .exe CONTAINS your PSK — keep that .exe private
// and do not distribute it. seed-config.json itself is gitignored.
const fs = require('node:fs')
const path = require('node:path')

const repo = path.join(__dirname, '..')
const out = path.join(__dirname, 'seed-config.json')
const real = path.join(repo, 'magnetgate.config.json')
const example = path.join(repo, 'magnetgate.config.example.json')

const src = fs.existsSync(real) ? real : example
fs.copyFileSync(src, out)
console.log(`[prepare-seed] seed-config.json <- ${path.basename(src)}${src === real ? ' (contains your PSK — keep the .exe private)' : ' (no PSK; you will enter it in the app)'}`)
