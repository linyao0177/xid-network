#!/usr/bin/env node
// Installs what the packages need, in the order they depend on each other.
// The node packages name each other and two packages of the submodule with
// file: paths, which npm links instead of installing: so the linked ones need
// their own install first, or `npm test` fails on a module of theirs.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const sub = path.join(root, 'third_party', 'hyperdht-esp32')
if (!fs.existsSync(path.join(sub, 'packages', 'boat-peer', 'package.json'))) {
  console.error('third_party/hyperdht-esp32 is empty: git submodule update --init')
  process.exit(1)
}

const steps = [
  ['third_party/hyperdht-esp32/packages/boat-peer', ['install', '--omit=dev']],
  ['third_party/hyperdht-esp32/packages/boat-ota', ['install', '--omit=dev']],
  ['packages/boat-mqtt-node', ['ci']],
  ['packages/boat-registry', ['ci']],
  ['packages/xid-depin', ['ci']]
]
for (const [dir, args] of steps) {
  console.log(`\n== npm ${args.join(' ')} in ${dir}`)
  const r = spawnSync('npm', [...args, '--no-audit', '--no-fund'], { cwd: path.join(root, dir), stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) process.exit(r.status || 1)
}
