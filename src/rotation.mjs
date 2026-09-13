import fs from 'node:fs'
import { atomicWrite } from './state-file.mjs'

// Before publication, recover by rollback. Once the final advertised file is visible,
// recover forward: a publisher may already have sent those credentials to clients.
export function recoverRotation({ journal, restart, write = atomicWrite }) {
  if (!fs.existsSync(journal)) return false
  const saved = JSON.parse(fs.readFileSync(journal, 'utf8'))
  const published =
    !Array.isArray(saved) &&
    saved.publication &&
    fs.existsSync(saved.publication.file) &&
    fs.readFileSync(saved.publication.file, 'utf8') === saved.publication.data
  const restore = Array.isArray(saved) ? saved : published ? saved.after : saved.before
  for (const { file, data } of restore) {
    if (data === null) {
      try {
        fs.unlinkSync(file)
      } catch (e) {
        if (e.code !== 'ENOENT') throw e
      }
    } else write(file, data, 0o640)
  }
  restart()
  fs.unlinkSync(journal)
  return true
}
export function rotateTransaction({
  configFile,
  config,
  metadata,
  journal,
  validate,
  restart,
  write = atomicWrite
}) {
  recoverRotation({ journal, restart, write })
  const candidate = configFile + '.candidate'
  try {
    write(candidate, config, 0o640)
    validate(candidate)
    const files = [configFile, ...metadata.map((m) => m.file)]
    const before = files.map((file) => ({
      file,
      data: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
    }))
    const after = [{ file: configFile, data: config }, ...metadata]
    write(journal, JSON.stringify({ before, after, publication: metadata.at(-1) }), 0o600)
    try {
      write(configFile, config, 0o640)
      restart() // must include health validation, before advertising new credentials
      for (const { file, data } of metadata) write(file, data, 0o640)
      fs.unlinkSync(journal)
    } catch (err) {
      recoverRotation({ journal, restart, write })
      throw err
    }
  } finally {
    try {
      fs.unlinkSync(candidate)
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
  }
}
