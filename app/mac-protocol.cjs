const { timingSafeEqual } = require('node:crypto')
const LIMIT = 1024 * 1024

// Private Unix socket plus a per-launch capability. Never log protocol frames: they contain PSKs.
function peer(socket, token, handle = async () => {}, notify = () => {}) {
  let buffer = '', next = 0
  const pending = new Map()
  const send = msg => {
    const frame = JSON.stringify({ ...msg, token }) + '\n'
    if (Buffer.byteLength(frame) > LIMIT || socket.writableLength > LIMIT || socket.destroyed)
      throw new Error('macOS helper channel unavailable')
    socket.write(frame)
  }
  socket.on('data', chunk => {
    buffer += chunk
    if (Buffer.byteLength(buffer) > LIMIT) return socket.destroy()
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      let msg
      try {
        msg = JSON.parse(line)
        const supplied = Buffer.from(String(msg.token || ''))
        const expected = Buffer.from(token)
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
          throw new Error('Invalid helper capability')
      } catch { socket.destroy(); return }
      if (msg.reply) {
        const item = pending.get(msg.reply)
        if (item) {
          pending.delete(msg.reply); clearTimeout(item.timer)
          msg.error ? item.reject(new Error(msg.error)) : item.resolve(msg.value)
        }
      } else if (msg.id) {
        Promise.resolve().then(() => handle(msg.op, msg.value)).then(
          value => send({ reply: msg.id, value }),
          err => send({ reply: msg.id, error: String(err.message).slice(0, 500) })
        ).catch(() => socket.destroy())
      } else notify(msg.op, msg.value)
    }
  })
  socket.on('error', () => {})
  socket.on('close', () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer); item.reject(new Error('macOS helper disconnected'))
    }
    pending.clear()
  })
  return {
    send: (op, value) => send({ op, value }),
    request(op, value) {
      return new Promise((resolve, reject) => {
        const id = ++next
        const timer = setTimeout(() => {
          pending.delete(id); reject(new Error('macOS helper request timed out'))
          socket.destroy()
        }, 30000)
        pending.set(id, { resolve, reject, timer })
        try { send({ id, op, value }) } catch (err) {
          clearTimeout(timer); pending.delete(id); reject(err)
        }
      })
    }
  }
}
module.exports = { peer }
