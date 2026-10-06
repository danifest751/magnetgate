import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withRealityResolver } from '../src/reality-resolver.cjs'

test('Reality resolver survives rotations without changing credentials or other DNS paths', () => {
  const config = {
    dns: { servers: [{ type: 'local', tag: 'existing' }], final: 'existing' },
    inbounds: [
      { tls: { reality: { enabled: true, private_key: 'unchanged', short_id: ['current', 'previous'],
        handshake: { server: 'www.microsoft.com', server_port: 443 } } } },
      { type: 'hysteria2', users: [{ password: 'unchanged' }] }
    ]
  }
  withRealityResolver(config)
  withRealityResolver(config)
  const reality = config.inbounds[0].tls.reality
  assert.equal(reality.private_key, 'unchanged')
  assert.deepEqual(reality.short_id, ['current', 'previous'])
  assert.equal(reality.handshake.server, 'www.microsoft.com')
  assert.deepEqual(reality.handshake.domain_resolver,
    { server: 'reality-resolver', strategy: 'ipv4_only', timeout: '4s' })
  assert.equal(reality.handshake.connect_timeout, '5s')
  assert.equal(config.inbounds[0].tls.handshake_timeout, '8s')
  assert.equal(config.dns.servers.length, 2)
  assert.equal(config.dns.final, 'existing')
  assert.deepEqual(config.inbounds[1], { type: 'hysteria2', users: [{ password: 'unchanged' }] })
})
