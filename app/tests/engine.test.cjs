const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { EngineController } = require('../engine.cjs')

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magnetgate-engine-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const children = [],
    stopped = [],
    exits = []
  const engine = new EngineController({
    exe: 'fixture',
    cwd: dir,
    configPath: path.join(dir, 'config.json'),
    log: () => {},
    onExit: (err) => exits.push(err),
    execute: async () => {},
    waitReady: async () => {},
    spawnChild: () => {
      const c = new EventEmitter()
      c.stdout = new EventEmitter()
      c.stderr = new EventEmitter()
      children.push(c)
      return c
    },
    terminate: async (child) => {
      stopped.push(child)
      child.emit('exit', 0)
    }
  })
  return { engine, children, stopped, exits, dir }
}
test('invalid replacement keeps the working process and config', async (t) => {
  const { engine, children, stopped, dir } = await fixture(t)
  await engine.start({ generation: 1 })
  engine.execute = async () => {
    throw new Error('bad config')
  }
  await assert.rejects(engine.start({ generation: 2 }), /bad config/)
  assert.equal(engine.child, children[0])
  assert.equal(stopped.length, 0)
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'config.json'))).generation, 1)
})
test('cancellation during the guard hook does not stop the working engine', async (t) => {
  const { engine, children, stopped } = await fixture(t)
  await engine.start({ generation: 1 })
  let entered, release
  const waiting = new Promise((r) => {
      entered = r
    }),
    hold = new Promise((r) => {
      release = r
    })
  const replaced = engine.start({ generation: 2 }, async () => {
    entered()
    await hold
  })
  await waiting
  engine.execute = async () => {
    throw new Error('bad newer config')
  }
  const newer = engine.start({ generation: 3 })
  release()
  assert.equal(await replaced, false)
  await assert.rejects(newer, /bad newer/)
  assert.equal(engine.child, children[0])
  assert.equal(stopped.length, 0)
})
test('failed termination retains ownership so disconnect can retry', async (t) => {
  const { engine, children } = await fixture(t)
  await engine.start({})
  engine.terminate = async () => {
    throw new Error('access denied')
  }
  await assert.rejects(engine.stop(), /access denied/)
  assert.equal(engine.child, children[0])
  engine.terminate = async (child) => child.emit('exit', 0)
  await engine.stop()
  assert.equal(engine.running, false)
})
test('old process exit cannot clear a newer process', async (t) => {
  const { engine, children, exits } = await fixture(t)
  await engine.start({ generation: 1 })
  await engine.start({ generation: 2 })
  children[0].emit('exit', 1)
  assert.equal(engine.child, children[1])
  assert.equal(exits.length, 0)
  await engine.stop()
  assert.equal(engine.running, false)
  assert.equal(exits.length, 0)
})

test('spawn alone does not mark the engine ready', async (t) => {
  const { engine } = await fixture(t)
  let release, entered
  const waiting = new Promise((r) => (entered = r))
  engine.waitReady = async () => {
    entered()
    await new Promise((r) => (release = r))
  }
  const started = engine.start({})
  await waiting
  assert.equal(engine.running, true)
  assert.equal(engine.ready, false)
  release()
  assert.equal(await started, true)
  assert.equal(engine.ready, true)
  await engine.stop()
  assert.equal(engine.ready, false)
})
test('Disconnect cancels readiness and stops only the just-started child', async (t) => {
  const { engine, stopped } = await fixture(t)
  let entered
  const waiting = new Promise((r) => (entered = r))
  engine.waitReady = async (_child, _cfg, signal) => {
    entered()
    await new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    )
  }
  const started = engine.start({})
  await waiting
  const stoppedPromise = engine.stop()
  assert.equal(await started, false)
  await stoppedPromise
  assert.equal(engine.running, false)
  assert.equal(stopped.length, 1)
})
