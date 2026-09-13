const http = require('node:http')
const net = require('node:net')
const { setTimeout: delay } = require('node:timers/promises')

function controlReady(port, secret, signal) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/version',
        headers: { Authorization: 'Bearer ' + secret },
        timeout: 1000,
        signal
      },
      (res) => {
        res.destroy()
        resolve(res.statusCode === 200)
      }
    )
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
  })
}
function socksReady(port, signal) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port, signal })
    const reply = Buffer.alloc(2)
    let received = 0,
      done = false
    const finish = (ready) => {
      if (done) return
      done = true
      sock.destroy()
      resolve(ready)
    }
    sock.setTimeout(1000, () => finish(false))
    sock.on('error', () => finish(false))
    sock.on('close', () => finish(false))
    sock.once('connect', () => sock.write(Buffer.from([5, 1, 0])))
    sock.on('data', (b) => {
      received += b.copy(reply, received, 0, 2 - received)
      if (received === 2) finish(reply[0] === 5 && reply[1] === 0)
    })
  })
}

// The SOCKS inbound follows TUN initialization. Both it and our authenticated control
// endpoint must be ready; a child PID by itself does not mean Windows finished creating TUN.
async function waitForEngineReady(child, config, signal, timeoutMs = 30000) {
  const controller = config.experimental?.clash_api
  const socks = config.inbounds?.find((i) => i.tag === 'health-in')
  if (!controller || !socks) throw new Error('Missing engine readiness endpoints')
  const port = Number(controller.external_controller.split(':').at(-1))
  const timeout = AbortSignal.timeout(timeoutMs)
  const bounded = AbortSignal.any([signal, timeout])
  try {
    while (true) {
      bounded.throwIfAborted()
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error('VPN process exited before TUN became ready')
      const [control, inbound] = await Promise.all([
        controlReady(port, controller.secret, bounded),
        socksReady(socks.listen_port, bounded)
      ])
      bounded.throwIfAborted()
      if (control && inbound) return
      await delay(250, undefined, { signal: bounded })
    }
  } catch (err) {
    if (timeout.aborted && !signal.aborted)
      throw new Error(`Windows TUN did not become ready within ${timeoutMs / 1000} seconds`)
    throw err
  }
}
module.exports = { waitForEngineReady }
