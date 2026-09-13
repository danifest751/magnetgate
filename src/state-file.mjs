import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export function atomicWrite(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  let fd
  try {
    fd = fs.openSync(temp, 'wx', mode)
    fs.writeFileSync(fd, value)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(temp, file)
    if (process.platform !== 'win32') {
      const dir = fs.openSync(path.dirname(file), 'r')
      try {
        fs.fsyncSync(dir)
      } finally {
        fs.closeSync(dir)
      }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try {
      fs.unlinkSync(temp)
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
  }
}

// One publisher owns the state file (systemd holds a lifetime flock). Random offer nonces
// remain safe even if state is restored. No sentinel survives a crash to block recovery.
export function sequenceStore(file) {
  let current = Math.floor(Date.now() / 1000)
  if (file && fs.existsSync(file)) {
    const saved = Number(fs.readFileSync(file, 'utf8').trim())
    if (!Number.isSafeInteger(saved) || saved < 0) throw new Error('invalid sequence state')
    current = Math.max(current, saved)
  }
  return () => {
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      if (fs.existsSync(file)) {
        const saved = Number(fs.readFileSync(file, 'utf8').trim())
        if (!Number.isSafeInteger(saved) || saved < 0) throw new Error('invalid sequence state')
        current = Math.max(current, saved)
      }
    }
    const next = Math.max(current + 1, Math.floor(Date.now() / 1000))
    if (!Number.isSafeInteger(next)) throw new Error('sequence exhausted')
    if (file) atomicWrite(file, String(next))
    current = next
    return next
  }
}
