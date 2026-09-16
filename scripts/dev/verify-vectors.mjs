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
  frame2,
  makeCodecV2,
  hsClientInit,
  hsExitRespond,
  hsClientFinish,
  FRAME,
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
  const build = (name) => {
    const out = path.join(binDir, `${name}.exe`)
    execFileSync(go, ['build', '-o', out, `./cmd/${name}`], { cwd: coreDir })
    return out
  }
  return { seal: build('seal'), unseal: build('unseal'), frame: build('frame'), hs: build('hs') }
}

function runBin(bin, { psk, slot, domain, input, args = [], extraEnv = {} }) {
  try {
    const out = execFileSync(bin, args, {
      cwd: coreDir,
      input,
      env: {
        ...process.env,
        MG_PSK: psk,
        MG_SLOT: String(slot ?? 0),
        MG_DOMAIN: domain ?? '',
        ...extraEnv
      },
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      // rejections are expected in several checks: keep their stderr out of the report
      stdio: ['pipe', 'pipe', 'ignore']
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

    console.log('=== 4. кадры: длины совпадают с векторами ===')
    for (const c of vectors.frameLengths) {
      const payload = Buffer.alloc(c.plainLen, 7)
      const data = frame2(boxKey, FRAME.DATA, 1, payload, 0n)
      const open = frame2(boxKey, FRAME.OPEN, 1, payload, 0n)
      check(data.length === c.data, `DATA ${c.plainLen} Б → ${c.data} Б (Node)`)
      check(open.length === c.open, `OPEN ${c.plainLen} Б → ${c.open} Б (Node)`)
    }
    for (const plainLen of [0, 63, 4095]) {
      const payload = Buffer.alloc(plainLen, 7)
      const goData = runBin(cli.frame, {
        psk: PSK,
        input: payload.toString(),
        args: ['-mode=encode', `-type=${FRAME.DATA}`, '-id=1', '-seq=0']
      })
      const want = vectors.frameLengths.find((c) => c.plainLen === plainLen).data
      check(goData.code === 0 && goData.out.trim().length === want * 2, `Go собирает DATA ${plainLen} Б той же длины`)
    }

    console.log('=== 5. кадры: Node ⇄ Go (обе стороны) ===')
    const payload = Buffer.alloc(517, 9) // the TLS ClientHello size that once broke framing
    const nodeFrame = frame2(boxKey, FRAME.DATA, 1, payload, 0n)
    const goDecoded = runBin(cli.frame, { psk: PSK, input: nodeFrame.toString('hex'), args: ['-mode=decode'] })
    check(
      goDecoded.code === 0 && goDecoded.out.trim() === `${FRAME.DATA} 1 ${payload.toString('hex')}`,
      'Go декодирует кадр Node (DATA 517 Б, включая паддинг)',
      goDecoded.out
    )

    const goFrame = runBin(cli.frame, {
      psk: PSK,
      input: payload.toString(),
      args: ['-mode=encode', `-type=${FRAME.DATA}`, '-id=1', '-seq=0']
    })
    check(goFrame.code === 0, 'Go собрал кадр', goFrame.out)
    const decoded = []
    let killed = false
    const codec = makeCodecV2(boxKey, (type, id, body) => decoded.push({ type, id, body }), () => {
      killed = true
    })
    codec.push(Buffer.from(goFrame.out.trim(), 'hex'))
    check(
      !killed && decoded.length === 1 && decoded[0].type === FRAME.DATA && decoded[0].id === 1 &&
        decoded[0].body.toString('hex') === payload.toString('hex'),
      'Node декодирует кадр Go (кодек v4 с проверкой счётчика)'
    )

    console.log('=== 6. кадры: отказы ===')
    const replayed = frame2(boxKey, FRAME.OPEN, 1, payload, 5n) // sequence 5 where 0 is expected
    check(
      runBin(cli.frame, { psk: PSK, input: replayed.toString('hex'), args: ['-mode=decode'] }).code === 1,
      'Go отвергает кадр с чужим счётчиком'
    )
    const oneFrame = frame2(boxKey, FRAME.OPEN, 1, payload, 0n)
    const killed2 = []
    let killedNode = false
    const codec2 = makeCodecV2(boxKey, (t, i, b) => killed2.push(b), () => {
      killedNode = true
    })
    codec2.push(oneFrame)
    codec2.push(oneFrame) // the same frame twice
    check(killedNode && killed2.length === 1, 'Node отвергает повтор кадра')
    const badType = runBin(cli.frame, {
      psk: PSK,
      input: payload.toString(),
      args: ['-mode=encode', '-type=99', '-id=1', '-seq=0']
    })
    check(badType.code === 1, 'Go отказывается собирать кадр неизвестного типа')
    const badStream = runBin(cli.frame, {
      psk: PSK,
      input: '',
      args: [`-mode=encode`, `-type=${FRAME.PING}`, '-id=3', '-seq=0']
    })
    check(badStream.code === 1, 'Go отказывается собирать ping со streamId != 0')

    console.log('=== 7. хендшейк: Node ⇄ Go (обе стороны) ===')
    // (a) Node is the client, Go is the exit
    const nodeInit = hsClientInit(boxKey)
    const goRespond = runBin(cli.hs, {
      psk: PSK,
      input: nodeInit.msg1.toString('hex'),
      args: ['-mode=respond']
    })
    check(goRespond.code === 0, 'Go отвечает на msg1 клиента Node', goRespond.out)
    const goKeys = goRespond.code === 0 ? JSON.parse(goRespond.out) : null
    const nodeFinish = goKeys && hsClientFinish(boxKey, Buffer.from(goKeys.msg2, 'hex'), nodeInit.ceSk, nodeInit.cePk)
    check(
      !!nodeFinish && nodeFinish.keys.c2e.toString('hex') === goKeys.c2e && nodeFinish.keys.e2c.toString('hex') === goKeys.e2c,
      'Node-клиент и Go-exit выводят одни и те же ключи сессии',
      JSON.stringify({ node: nodeFinish && nodeFinish.keys.c2e.toString('hex'), go: goKeys && goKeys.c2e })
    )

    // (b) Go is the client, Node is the exit
    const goInit = runBin(cli.hs, { psk: PSK, input: '', args: ['-mode=init'] })
    check(goInit.code === 0, 'Go начинает хендшейк', goInit.out)
    const goEph = goInit.code === 0 ? JSON.parse(goInit.out) : null
    const nodeReply = goEph && hsExitRespond(boxKey, Buffer.from(goEph.msg1, 'hex'))
    check(!!nodeReply, 'Node-exit отвечает на msg1 клиента Go')
    let mismatched = false
    if (nodeReply) {
      const goDone = runBin(cli.hs, {
        psk: PSK,
        input: nodeReply.msg2.toString('hex'),
        args: ['-mode=finish'],
        extraEnv: { MG_CE_SK: goEph.ceSk, MG_CE_PK: goEph.cePk }
      })
      mismatched = goDone.code !== 0
      check(!mismatched, 'Go завершает хендшейк с Node-exit', goDone.out)
      if (!mismatched) {
        const done = JSON.parse(goDone.out)
        check(
          done.c2e === nodeReply.keys.c2e.toString('hex') && done.e2c === nodeReply.keys.e2c.toString('hex'),
          'Go-клиент и Node-exit выводят одни и те же ключи сессии'
        )
      }
    }

    console.log('=== 8. хендшейк: отказы ===')
    check(
      runBin(cli.hs, { psk: PSK, input: 'deadbeef', args: ['-mode=respond'] }).code === 1,
      'Go отвергает мусорный msg1'
    )
    check(
      runBin(cli.hs, { psk: 'a-different-psk', input: nodeInit.msg1.toString('hex'), args: ['-mode=respond'] }).code === 1,
      'Go отвергает msg1, зашифрованный другим PSK'
    )
    check(
      !!nodeReply &&
        runBin(cli.hs, {
          psk: PSK,
          input: nodeReply.msg2.toString('hex'),
          args: ['-mode=finish'],
          extraEnv: { MG_CE_SK: 'ff'.repeat(32), MG_CE_PK: 'ee'.repeat(32) }
        }).code === 1,
      'Go отвергает ответ exit\'а, если эфемерный ключ не тот (привязка ответа)'
    )
    // stale timestamps are covered by the Go unit test (TestHandshakeRejections/stale_timestamp):
    // they need a hand-built msg1, which is a unit concern rather than an interop one
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
