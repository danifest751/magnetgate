import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  deriveKeys,
  saltOf,
  slotSalt,
  slotBoxKey,
  targetOf,
  seal,
  unseal,
  OFFER_SCHEMA,
  MAX_SLOTS
} from '../../src/common.mjs'
import { genVectorsIfStale } from './gen-vectors.mjs'

// Cross-implementation check between the Node client and the Android Go core, in BOTH directions.
//
//   node scripts/dev/verify-vectors.mjs
//
// Part 1: the tracked deterministic vectors must still match what the Node code computes (so a KDF
//         change on one side cannot silently pass).
// Part 2: Node seals → Go unseals, and Go seals → Node unseals. Nonces are random by design, so this
//         part cannot live in a tracked file.
// Part 3: the rejections that matter — tampered envelope, wrong slot, wrong domain.
//
// Needs Go on PATH (override with MG_GO).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const coreDir = path.join(root, 'app-android', 'core')
const vectorsFile = path.join(coreDir, 'proto', 'testdata', 'v1.json')
const go = process.env.MG_GO || 'go'

const checks = []
const check = (ok, what, detail = '') => {
  checks.push({ ok, what })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${what}${detail && !ok ? ` — ${detail}` : ''}`)
}

function goRun(args, { psk, slot, domain, input } = {}) {
  return execFileSync(go, args, {
    cwd: coreDir,
    input,
    env: { ...process.env, MG_PSK: psk, MG_SLOT: String(slot ?? 0), MG_DOMAIN: domain ?? '' },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  })
}

function buildClis(binDir) {
  // built once instead of `go run` per case: same result, a fifth of the time
  execFileSync(go, ['build', '-o', path.join(binDir, 'seal.exe'), './cmd/seal'], { cwd: coreDir })
  execFileSync(go, ['build', '-o', path.join(binDir, 'unseal.exe'), './cmd/unseal'], { cwd: coreDir })
  return {
    seal: path.join(binDir, 'seal.exe'),
    unseal: path.join(binDir, 'unseal.exe')
  }
}

function runBin(bin, { psk, slot, domain, input }) {
  try {
    const out = execFileSync(bin, [], {
      cwd: coreDir,
      input,
      env: { ...process.env, MG_PSK: psk, MG_SLOT: String(slot ?? 0), MG_DOMAIN: domain ?? '' },
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024
    })
    return { code: 0, out }
  } catch (err) {
    return { code: err.status ?? -1, out: String(err.stdout ?? '') + String(err.stderr ?? '') }
  }
}

function main() {
  console.log('=== 1. детерминированные векторы (Node → файл → обе стороны) ===')
  genVectorsIfStale()
  const vectors = JSON.parse(fs.readFileSync(vectorsFile, 'utf8'))
  const PSK = vectors.psk
  const { pk, boxKey } = deriveKeys(PSK)

  check(vectors.keys.pk === pk.toString('hex'), 'vectors.pk совпадает с Node')
  check(vectors.keys.boxKey === boxKey.toString('hex'), 'vectors.boxKey совпадает с Node')
  check(vectors.keys.salt0 === saltOf(PSK).toString('hex'), 'vectors.salt0 совпадает с Node')
  check(vectors.constants.offerSchema === OFFER_SCHEMA, 'схема оффера в векторах')
  check(vectors.constants.maxSlots === MAX_SLOTS, 'диапазон слотов в векторах')
  for (const slot of vectors.slots) {
    const salt = slotSalt(PSK, slot.slot)
    check(salt.toString('hex') === slot.salt, `слот ${slot.slot}: salt`)
    check(targetOf(pk, salt).toString('hex') === slot.target, `слот ${slot.slot}: target`)
    check(slotBoxKey(PSK, slot.slot).toString('hex') === slot.boxKey, `слот ${slot.slot}: boxKey`)
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-vectors-'))
  try {
    const cli = buildClis(tmp)
    const plain = Buffer.from(JSON.stringify({ v: 3, ts: 1789000000000, slot: 1, node: 'fi-1', dp: [] }))

    console.log('=== 2. конверт: Node ⇄ Go (обе стороны) ===')
    for (const domain of ['1789000000000', 'n1789000000000', '1:1789000000000']) {
      const nodeSealed = seal(boxKey, plain, domain).toString('hex')
      const opened = runBin(cli.unseal, { psk: PSK, slot: 0, domain, input: nodeSealed })
      check(opened.code === 0 && opened.out === plain.toString(), `Go открывает конверт Node (домен ${domain})`, opened.out)

      const goSealed = runBin(cli.seal, { psk: PSK, slot: 0, domain, input: plain.toString() })
      check(goSealed.code === 0 && /^[0-9a-f]+$/.test(goSealed.out.trim()), `Go запечатал (домен ${domain})`, goSealed.out)
      const nodeOpened = unseal(boxKey, Buffer.from(goSealed.out.trim(), 'hex'), domain)
      check(
        nodeOpened !== null && nodeOpened.toString() === plain.toString(),
        `Node открывает конверт Go (домен ${domain})`,
        String(nodeOpened)
      )
    }

    console.log('=== 3. отказы, которые обязаны работать ===')
    const env = seal(boxKey, plain, '42')
    const tampered = Buffer.from(env)
    tampered[tampered.length - 1] ^= 0x01
    check(
      runBin(cli.unseal, { psk: PSK, slot: 0, domain: '42', input: tampered.toString('hex') }).code === 1,
      'Go отвергает подделанный конверт'
    )
    check(
      runBin(cli.unseal, { psk: PSK, slot: 0, domain: '43', input: env.toString('hex') }).code === 1,
      'Go отвергает чужой домен'
    )
    check(
      runBin(cli.unseal, { psk: PSK, slot: 1, domain: '42', input: env.toString('hex') }).code === 1,
      'Go отвергает чужой слот'
    )
    check(
      runBin(cli.unseal, { psk: 'another-psk', slot: 0, domain: '42', input: env.toString('hex') }).code === 1,
      'Go отвергает чужой PSK'
    )
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  const failed = checks.filter((c) => !c.ok)
  console.log(
    failed.length ? `\nFAILED: ${failed.length} из ${checks.length}` : `\nALL CHECKS PASSED (${checks.length})`
  )
  process.exit(failed.length ? 1 : 0)
}

main()
