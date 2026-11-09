// Builds the contracts with forge and keeps their ABI and bytecode in
// artifacts/, so the JS works without forge: node scripts-build.mjs
import { execFileSync } from 'child_process'
import fs from 'fs'
execFileSync('forge', ['build', '--skip', 'test'], { stdio: 'inherit' })
fs.mkdirSync('artifacts', { recursive: true })
for (const name of ['BoatRegistry', 'BoatReads', 'TestToken']) {
  const a = JSON.parse(fs.readFileSync(`out/${name}.sol/${name}.json`, 'utf8'))
  fs.writeFileSync(`artifacts/${name}.json`, JSON.stringify({ abi: a.abi, bytecode: a.bytecode.object }) + '\n')
}
