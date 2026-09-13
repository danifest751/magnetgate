import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { sequenceStore, atomicWrite } from '../src/state-file.mjs'
import { rotateTransaction, recoverRotation } from '../src/rotation.mjs'
import { nostrPublisher } from '../src/nostr.mjs'

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magnetgate-recovery-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
test('publication sequence is durable before return and reread after restart', (t) => {
  const file = path.join(directory(t), 'seq'),
    reserve = sequenceStore(file)
  const first = reserve()
  assert.equal(Number(fs.readFileSync(file)), first)
  const next = sequenceStore(file)()
  assert.equal(next, first + 1)
  assert.equal(reserve(), next + 1)
  fs.writeFileSync(file, 'corrupt')
  assert.throws(() => reserve(), /invalid sequence/)
})
test('rotation validates before publication and rolls back engine or metadata failure', (t) => {
  for (const failure of ['validation', 'restart', 'metadata']) {
    const dir = directory(t),
      configFile = path.join(dir, 'config'),
      dp = path.join(dir, 'dp'),
      journal = path.join(dir, 'journal')
    fs.writeFileSync(configFile, 'old')
    fs.writeFileSync(dp, 'old offer')
    let restarts = 0
    assert.throws(
      () =>
        rotateTransaction({
          configFile,
          config: 'new',
          metadata: [{ file: dp, data: 'new offer' }],
          journal,
          validate: () => {
            assert.equal(fs.readFileSync(configFile, 'utf8'), 'old')
            if (failure === 'validation') throw new Error('validation')
          },
          restart: () => {
            if (++restarts === 1 && failure === 'restart') throw new Error('restart')
          },
          write: (file, data, mode) => {
            if (file === dp && data === 'new offer' && failure === 'metadata')
              throw new Error('metadata')
            atomicWrite(file, data, mode)
          }
        }),
      new RegExp(failure)
    )
    assert.equal(fs.readFileSync(configFile, 'utf8'), 'old')
    assert.equal(fs.readFileSync(dp, 'utf8'), 'old offer')
    assert.equal(fs.existsSync(journal), false)
  }
})
test('interrupted rotation recovers the previous generation before a new rotation', (t) => {
  const dir = directory(t),
    file = path.join(dir, 'config'),
    journal = path.join(dir, 'journal')
  let restarted = 0
  fs.writeFileSync(file, 'partial')
  fs.writeFileSync(journal, JSON.stringify([{ file, data: 'old' }]))
  assert.equal(recoverRotation({ journal, restart: () => restarted++ }), true)
  assert.equal(fs.readFileSync(file, 'utf8'), 'old')
  assert.equal(restarted, 1)
  assert.equal(fs.existsSync(journal), false)
})
test(
  'Nostr sends publication queued before opening and replays it on reconnect',
  { timeout: 6000 },
  async (t) => {
    const relay = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await once(relay, 'listening')
    const messages = []
    let complete
    const done = new Promise((r) => {
      complete = r
    })
    relay.on('connection', (socket) =>
      socket.on('message', (data) => {
        messages.push(JSON.parse(data))
        if (messages.length === 1) socket.close()
        else complete()
      })
    )
    const publisher = nostrPublisher('test fixture PSK', [`ws://127.0.0.1:${relay.address().port}`])
    t.after(() => {
      publisher.close()
      for (const c of relay.clients) c.terminate()
      relay.close()
    })
    publisher.publish(Buffer.from('sealed fixture'), 'n123')
    await done
    assert.equal(messages[0][0], 'EVENT')
    assert.deepEqual(messages[0], messages[1])
  }
)

test('recovery keeps a generation that was already advertised before the crash', (t) => {
  const dir = directory(t),
    file = path.join(dir, 'config'),
    dp = path.join(dir, 'dp'),
    journal = path.join(dir, 'journal')
  fs.writeFileSync(file, 'new config')
  fs.writeFileSync(dp, 'new offer')
  const after = [
    { file, data: 'new config' },
    { file: dp, data: 'new offer' }
  ]
  fs.writeFileSync(
    journal,
    JSON.stringify({
      before: [
        { file, data: 'old config' },
        { file: dp, data: 'old offer' }
      ],
      after,
      publication: after[1]
    })
  )
  assert.throws(
    () =>
      recoverRotation({
        journal,
        restart: () => {
          throw new Error('transient restart failure')
        }
      }),
    /restart failure/
  )
  assert.equal(fs.existsSync(journal), true)
  assert.equal(fs.readFileSync(file, 'utf8'), 'new config')
  recoverRotation({ journal, restart: () => {} })
  assert.equal(fs.readFileSync(dp, 'utf8'), 'new offer')
  assert.equal(fs.existsSync(journal), false)
})
