const fs = require('node:fs/promises')
function rotatingLog(file, maxBytes = 5 * 1024 * 1024) {
  let chain = Promise.resolve(),
    queued = 0
  const append = (line) => {
    const data = line + '\n',
      size = Buffer.byteLength(data)
    if (queued + size > 1024 * 1024) return
    queued += size
    chain = chain
      .then(async () => {
        const stat = await fs.stat(file).catch(() => null)
        if (stat && stat.size + size > maxBytes) {
          await fs.unlink(file + '.1').catch(() => {})
          await fs.rename(file, file + '.1')
        }
        await fs.appendFile(file, data, { mode: 0o600 })
      })
      .catch(() => {})
      .finally(() => {
        queued -= size
      })
  }
  return { append, flush: () => chain }
}
module.exports = { rotatingLog }
