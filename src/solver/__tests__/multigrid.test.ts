import { describe, expect, it } from 'vitest'
import { elasticityFixture } from './multigridFixture'

describe('geometric multigrid', () => {
  it.each(['mbb', 'bellcrank'] as const)('matches Jacobi PCG on %s while reducing iterations', preset => {
    const { solve, fixed } = elasticityFixture({ nelx: 120, nely: 40 }, preset)
    const jacobi = solve(false, 1e-9)
    const mgcg = solve(true, 1e-9)
    expect(mgcg.converged && jacobi.converged).toBe(true)
    expect(mgcg.iterations).toBeLessThan(jacobi.iterations * 0.35)
    let norm = 0, error = 0
    for (let i = 0; i < jacobi.u.length; i++) {
      norm += jacobi.u[i] ** 2
      error += (mgcg.u[i] - jacobi.u[i]) ** 2
      if (fixed[i]) expect(mgcg.u[i]).toBe(0)
    }
    expect(Math.sqrt(error / norm)).toBeLessThan(1e-5)
  })

  it('uses Jacobi on grids too small to coarsen', () => {
    const { multigrid, solve } = elasticityFixture({ nelx: 6, nely: 2 })
    expect(multigrid.prepare()).toBeUndefined()
    expect(solve(true)).toEqual(solve(false))
  })
})
