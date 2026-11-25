import { expect, test } from 'vitest'
import { elasticityFixture } from './multigridFixture'

test('cold displacement solves including preconditioner refresh', { timeout: 90_000 }, async ({ bench }) => {
  for (const nelx of [180, 240, 300]) {
    const nely = nelx / 3
    const { solve } = elasticityFixture({ nelx, nely })
    const jacobi = solve(false)
    const multigrid = solve(true)
    expect(jacobi.converged && multigrid.converged).toBe(true)
    const mg = bench(`${nelx}×${nely} MGCG (${multigrid.iterations} iterations)`, () => { solve(true) })
    const pcg = bench(`${nelx}×${nely} Jacobi PCG (${jacobi.iterations} iterations)`, () => { solve(false) })
    const results = await bench.compare(mg, pcg, { iterations: 3, time: 100, warmupIterations: 1, warmupTime: 100 })
    const mgMs = results.get(mg.name).latency.mean
    const pcgMs = results.get(pcg.name).latency.mean
    console.info(`${mg.name} ${mgMs.toFixed(1)} ms · ${pcg.name} ${pcgMs.toFixed(1)} ms · ${(pcgMs / mgMs).toFixed(2)}×`)
  }
})
