const http = require('node:http')

function apiRequest({ port, secret }, method, path, body, signal) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        signal,
        agent: false,
        headers: {
          Authorization: 'Bearer ' + secret,
          ...(data
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
            : {})
        }
      },
      (res) => {
        let result = '',
          size = 0
        res.on('error', reject)
        res.on('data', (b) => {
          size += b.length
          if (size > 65536) req.destroy(new Error('VPN control response too large'))
          else result += b
        })
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300)
            reject(new Error(`VPN control ${method} ${path}: HTTP ${res.statusCode}`))
          else resolve(result)
        })
      }
    )
    req.on('error', reject)
    req.end(data)
  })
}

// Call only for the authenticated API of the owned process. No config reload or TUN restart.
async function switchMode(api, mode, signal, timeoutMs = 5000) {
  if (!['full', 'split'].includes(mode)) throw new Error('Invalid VPN mode')
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  const clashMode = mode === 'full' ? 'Global' : 'Rule'
  await apiRequest(api, 'PATCH', '/configs', { mode: clashMode }, bounded)
  const actual = JSON.parse(await apiRequest(api, 'GET', '/configs', undefined, bounded))
  if (String(actual.mode).toLowerCase() !== clashMode.toLowerCase())
    throw new Error('VPN control did not apply requested mode')
  // Existing TCP/UDP flows must reconnect under the new policy, including direct Split flows.
  await apiRequest(api, 'DELETE', '/connections', undefined, bounded)
  bounded.throwIfAborted()
}

function engineSignature(cfg, dp) {
  return JSON.stringify({ dp, cfg: { ...cfg, vpnMode: cfg.killSwitch ? cfg.vpnMode : 'live' } })
}
module.exports = { switchMode, engineSignature }
