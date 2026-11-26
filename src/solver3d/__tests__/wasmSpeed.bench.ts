import { expect, test } from 'vitest'
import { generateAdaptiveMesh3D } from '../adaptiveMesh3d'
import { defaultParams3D, makePreset3D, presetGrid3D } from '../presets3d'
import { Simp3D } from '../simp3d'
import { loadWasmBackend3D } from '../wasmBackend'

test('compare warm 3D SIMP steps on the same problems', { timeout: 240_000 }, async () => {
  const backend = await loadWasmBackend3D()
  if (!backend) throw new Error('Run npm run build:wasm before benchmarking')
  const cases = [
    ['hex8', [48, 24, 16]], ['hex8', [64, 32, 20]],
    ['tet4', [36, 18, 12]], ['tet4', [48, 24, 16]],
    ['adaptiveTet4', [24, 12, 8]],
  ] as const
  for (const [elementType, resolution] of cases) {
    const adaptive = elementType === 'adaptiveTet4'
    const problem = makePreset3D(adaptive ? 'boltBracket3d' : 'cantilever3d', presetGrid3D(resolution),
      { ...defaultParams3D, changeTol: 0 }, undefined, elementType)
    if (adaptive) problem.mesh = generateAdaptiveMesh3D(problem)
    const js = new Simp3D(problem)
    const wasm = new Simp3D(problem, undefined, undefined, backend)
    const jsTimes: number[] = [], wasmTimes: number[] = []
    function sample(solver: Simp3D, times: number[], i: number) {
      const start = performance.now()
      const frame = solver.step()
      const elapsed = performance.now() - start
      if (i > 0) times.push(elapsed)
      return frame.compliance
    }
    try {
      for (let i = 0; i < 4; i++) {
        let expected: number, actual: number
        if (i % 2 === 0) {
          expected = sample(js, jsTimes, i)
          actual = sample(wasm, wasmTimes, i)
        } else {
          actual = sample(wasm, wasmTimes, i)
          expected = sample(js, jsTimes, i)
        }
        expect(wasm.engine).toBe('wasm')
        expect(Math.abs(actual / expected - 1)).toBeLessThan(1e-5)
      }
      const median = (times: number[]) => times.sort((a, b) => a - b)[1]
      const a = median(jsTimes), b = median(wasmTimes)
      console.info(`${elementType} ${resolution.join('×')}${adaptive ? ` 4-bolt (${problem.mesh?.stats.elements} tets)` : ''}: `
        + `JS ${a.toFixed(1)} ms, WASM SIMD ${b.toFixed(1)} ms, ${(a / b).toFixed(2)}×`)
    } finally {
      wasm.setBackend()
    }
  }
})
