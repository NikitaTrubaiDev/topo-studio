import { expect, test } from 'vitest'
import { makePreset3D, presetGrid3D, presets3D, resolutions3D } from '../presets3d'
import { Simp3D } from '../simp3d'
import { cantileverFixture3D } from './multigridFixture3d'

for (const elementType of ['hex8', 'tet4'] as const) {
  test(`cold Jacobi and MGCG solves with ${elementType}`, { timeout: 120_000 }, async ({ bench }) => {
    for (const resolution of resolutions3D.slice(1, 3)) {
      const { create } = cantileverFixture3D(resolution, elementType)
      const jacobi = create(false), mgcg = create(true)
      const plain = jacobi.solve(), accelerated = mgcg.solve()
      expect(plain.converged && accelerated.converged).toBe(true)
      const grid = resolution.join('×')
      const mg = bench(`${grid} MGCG (${accelerated.iterations} iterations)`, () => { mgcg.solve() })
      const pcg = bench(`${grid} Jacobi PCG (${plain.iterations} iterations)`, () => { jacobi.solve() })
      const results = await bench.compare(mg, pcg, { iterations: 3, time: 100, warmupIterations: 1, warmupTime: 100 })
      const mgMs = results.get(mg.name).latency.mean
      const pcgMs = results.get(pcg.name).latency.mean
      console.info(`${elementType} ${grid}: Jacobi ${plain.iterations} iter / ${pcgMs.toFixed(1)} ms, MGCG ${accelerated.iterations} iter / ${mgMs.toFixed(1)} ms (${(pcgMs / mgMs).toFixed(2)}×)`)
    }
  })
}

test.each(['hex8', 'tet4'] as const)('warm 64×32×20 SIMP iterations with %s', { timeout: 120_000 }, elementType => {
  const solver = new Simp3D(makePreset3D('cantilever3d', presetGrid3D(resolutions3D[3]), undefined, undefined, elementType))
  solver.step()
  const times: number[] = []
  for (let i = 0; i < 5; i++) {
    const start = performance.now()
    expect(solver.step().compliance).toBeGreaterThan(0)
    times.push(performance.now() - start)
  }
  const mean = times.reduce((sum, time) => sum + time) / times.length
  console.info(`${elementType} 64×32×20: ${mean.toFixed(1)} ms/iteration (mean of iterations 2–6)`)
})

test('solves the other 64×32×20 presets in both element modes', { timeout: 120_000 }, () => {
  const grid = presetGrid3D(resolutions3D[3])
  for (const elementType of ['hex8', 'tet4'] as const) {
    for (const preset of presets3D.filter(id => id !== 'cantilever3d')) {
      const solver = new Simp3D(makePreset3D(preset, grid, undefined, undefined, elementType))
      const frame = solver.step()
      expect(frame.compliance, preset).toBeGreaterThan(0)
      expect(frame.volFrac, preset).toBeCloseTo(solver.problem.params.volFrac, 7)
    }
  }
})
