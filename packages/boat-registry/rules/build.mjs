// Compiles rules/*.wat to rules/*.wasm (committed, so nodes need no wabt):
// node rules/build.mjs
import fs from 'fs'
import wabt from 'wabt'
const w = await wabt()
for (const f of fs.readdirSync(new URL('.', import.meta.url)).filter((f) => f.endsWith('.wat'))) {
  const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8')
  const mod = w.parseWat(f, src)
  const { buffer } = mod.toBinary({})
  fs.writeFileSync(new URL(f.replace('.wat', '.wasm'), import.meta.url), Buffer.from(buffer))
  console.log(f, '->', buffer.length, 'bytes')
}
