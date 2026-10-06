import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

test('hygiene accepts protocol CIDRs but rejects bare hosts and nearby prefixes', () => {
  const gate = fileURLToPath(new URL('../scripts/check-hygiene.mjs', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'magnetgate-hygiene-'))
  const prefixes = ['128.0.0.0/1', '192.0.0.0/24', '224.0.0.0/3', '192.88.99.0/24']
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: dir })
    const check = (file, text, expected) => {
      mkdirSync(dirname(join(dir, file)), { recursive: true })
      writeFileSync(join(dir, file), text)
      execFileSync('git', ['add', '.'], { cwd: dir })
      const result = spawnSync(process.execPath, [gate, '--staged'], { cwd: dir, encoding: 'utf8' })
      assert.equal(result.status, expected, result.stderr)
      execFileSync('git', ['rm', '--cached', '-r', '--quiet', '.'], { cwd: dir })
      rmSync(join(dir, file))
    }
    check('fixture.txt', prefixes.join('\n'), 0)
    for (const prefix of prefixes) {
      check('fixture.txt', prefix.split('/')[0], 1)
      check('fixture.txt', prefix.replace(/\/\d+$/, '/32'), 1)
    }
    const boundary = prefixes[0].split('/')[0]
    const mask = `if mask == "${boundary}" && (dest == "0.0.0.0" || dest == "${boundary}") {`
    check('app-android/core/cmd/peer-node/platform_windows.go', mask, 0)
    check('fixture.txt', mask, 1)
    check('app-android/core/cmd/peer-node/platform_windows.go', `host := "${boundary}"`, 1)
  } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()))
    rmSync(dir, { recursive: true, force: true })
  }
})
