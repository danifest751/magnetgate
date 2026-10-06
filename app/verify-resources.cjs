const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const pins = require('../scripts/pins.json')

function verifyResources(platform, arch, dir = path.resolve(__dirname, '../tools/sing-box')) {
  const check = (name, hash, required = true) => {
    const file = path.join(dir, name)
    if (!required && !fs.existsSync(file)) return
    const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    if (actual !== hash) throw new Error(`Refusing to package unpinned ${name} for ${platform}/${arch}`)
  }
  if (platform === 'darwin') {
    const pin = pins.singBox.darwin[arch === 'x64' ? 'amd64' : arch]
    if (!pin) throw new Error('Unsupported macOS architecture')
    check('sing-box', pin.binarySha256)
    // Native core dependencies must be installed for the build host architecture as well.
    if (process.platform !== 'darwin' || process.arch !== arch)
      throw new Error('Build macOS on a Mac runner of the target architecture')
  } else if (platform === 'win32' && arch === 'x64') {
    check('sing-box.exe', pins.singBox.exeSha256)
    check('wintun.dll', pins.localAssets['wintun.dll'].sha256)
  } else throw new Error('Unsupported desktop target')
  for (const name of ['refilter-domains.srs', 'refilter-ip.srs']) check(name, pins.ruleSets[name].sha256)
  check('tunnel-userlist.srs', pins.localAssets['tunnel-userlist.srs'].sha256, false)
}
module.exports = context => verifyResources(context.electronPlatformName,
  require('builder-util').Arch[context.arch])
module.exports.verifyResources = verifyResources
