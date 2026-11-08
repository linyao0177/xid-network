import fs from 'fs'
import HyperDHT from 'hyperdht'

// A key pair from a JSON file { "seed": hex }, created (mode 0600) when missing.
export function loadKeyPair (file) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify({ seed: HyperDHT.keyPair().secretKey.subarray(0, 32).toString('hex') }) + '\n', { mode: 0o600 })
  }
  const { seed } = JSON.parse(fs.readFileSync(file, 'utf8'))
  return HyperDHT.keyPair(Buffer.from(seed, 'hex'))
}
