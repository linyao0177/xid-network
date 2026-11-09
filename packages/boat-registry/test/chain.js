// A fresh anvil chain for tests, on its own port.
import { spawn, execFileSync } from 'child_process'
import { JsonRpcProvider } from 'ethers'

export const MNEMONIC = 'test test test test test test test test test test test junk' // anvil's own test accounts

export async function startChain (port = 8552) {
  try {
    execFileSync('anvil', ['--version'], { stdio: 'ignore' })
  } catch {
    return null
  }
  const anvil = spawn('anvil', ['--port', String(port), '--silent', '--mnemonic', MNEMONIC, '--accounts', '20'], { stdio: 'ignore' })
  const url = `http://127.0.0.1:${port}`
  const provider = new JsonRpcProvider(url, undefined, { pollingInterval: 100, cacheTimeout: -1 })
  for (let i = 0; i < 50; i++) {
    try {
      if (anvil.exitCode !== null) throw new Error(`port ${port} is taken`)
      if ((await provider.getNetwork()).chainId === 31337n) return { anvil, url, provider }
    } catch (err) {
      if (/taken/.test(err.message)) throw err
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  anvil.kill()
  throw new Error('anvil did not start')
}
