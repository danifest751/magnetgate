const { spawn, execFile } = require('node:child_process')

const DNS_ADDRESS = '172.19.0.2'
const KEY = `State:/Network/Service/org.magnetgate.tun-${process.pid}/DNS`
const ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }

// A temporary Dynamic Store key belongs to this scutil connection. Keeping its stdin
// open leases DNS only for the VPN lifetime; EOF (even after helper SIGKILL) removes
// the key automatically. Never rewrite the user's Wi-Fi/Ethernet DNS preferences.
class MacDnsLease {
  constructor({ launch = spawn, flush = () => new Promise(resolve =>
    execFile('/usr/bin/dscacheutil', ['-flushcache'], { env: ENV, timeout: 2000 }, resolve)),
    onLost = () => {}, timeoutMs = 4000 } = {}) {
    Object.assign(this, { launch, flush, onLost, timeoutMs })
    this.child = null
    this.closed = false
    this.stopping = null
  }
  async start() {
    if (this.closed || this.child) throw new Error('DNS lease already used')
    const child = this.child = this.launch('/usr/sbin/scutil', [], {
      env: ENV, stdio: ['pipe', 'pipe', 'pipe']
    })
    child.stdin.on('error', () => {})
    child.on('error', () => {})
    child.once('exit', () => { if (!this.closed) this.onLost() })
    try {
      await new Promise((resolve, reject) => {
        let output = ''
        const timer = setTimeout(() => finish(new Error('macOS VPN DNS setup timed out')), this.timeoutMs)
        const finish = error => {
          clearTimeout(timer)
          child.stdout.removeListener('data', data)
          child.stderr.removeListener('data', failed)
          child.removeListener('error', failed)
          child.removeListener('exit', exited)
          error ? reject(error) : resolve()
        }
        const failed = () => finish(new Error('macOS VPN DNS setup failed'))
        const exited = () => finish(new Error('macOS DNS helper exited during setup'))
        const data = chunk => {
          output += chunk.toString()
          if (/failed|error|not found|denied/i.test(output) || output.length > 8192) failed()
          else if (output.includes('ServerAddresses') && output.includes(DNS_ADDRESS) && output.includes('SupplementalMatchDomainsNoSearch')) finish()
        }
        child.stdout.on('data', data)
        child.stderr.on('data', failed)
        child.once('error', failed)
        child.once('exit', exited)
        child.stdin.write([
          'd.init', `d.add ServerAddresses * ${DNS_ADDRESS}`,
          'd.add SupplementalMatchDomains * ""', 'd.add SupplementalMatchOrders * # 1',
          'd.add SupplementalMatchDomainsNoSearch # 1',
          `add ${KEY} temporary`, `show ${KEY}`, ''
        ].join('\n'))
      })
      if (this.closed || child.exitCode !== null || child.signalCode !== null)
        throw new Error('macOS VPN DNS lease was interrupted')
      await this.flush()
    } catch (error) {
      await this.stop()
      throw error
    }
  }
  stop() {
    if (this.stopping) return this.stopping
    this.closed = true
    this.stopping = (async () => {
      const child = this.child
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        await new Promise(resolve => {
          const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
          child.once('exit', () => { clearTimeout(timer); resolve() })
          // Closing this session also removes its temporary resolver.
          child.stdin.end('quit\n')
        })
      }
      this.child = null
      await this.flush()
    })()
    return this.stopping
  }
}
module.exports = { MacDnsLease, DNS_ADDRESS }
