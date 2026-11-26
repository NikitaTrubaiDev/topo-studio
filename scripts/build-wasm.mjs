import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const target = join(root, 'wasm-solver', 'target')
const result = spawnSync('cargo', ['build', '--locked', '--manifest-path', 'wasm-solver/Cargo.toml',
  '--release', '--target', 'wasm32-unknown-unknown', '--target-dir', target], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, RUSTFLAGS: [process.env.RUSTFLAGS, '-C target-feature=+simd128'].filter(Boolean).join(' ') },
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
const output = join(root, 'src', 'wasm')
mkdirSync(output, { recursive: true })
copyFileSync(join(target, 'wasm32-unknown-unknown', 'release', 'topo_solver.wasm'), join(output, 'topo_solver.wasm'))
