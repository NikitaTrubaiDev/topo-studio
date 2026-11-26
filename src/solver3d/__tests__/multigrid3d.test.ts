import { expect, it } from 'vitest'
import { Multigrid3D } from '../multigrid3d'
import { cantileverFixture3D } from './multigridFixture3d'

it.each(['hex8', 'tet4'] as const)('matches Jacobi PCG with far fewer multigrid iterations for %s', elementType => {
  const { create, fixed } = cantileverFixture3D([24, 12, 8], elementType)
  const jacobi = create(false), mgcg = create(true)
  const plain = jacobi.solve(1e-7), accelerated = mgcg.solve(1e-7)
  expect(plain.converged && accelerated.converged).toBe(true)
  expect(accelerated.relativeResidual).toBeLessThan(1e-7)
  expect(accelerated.iterations).toBeLessThan(plain.iterations / 3)
  let squaredError = 0, norm = 0
  for (let i = 0; i < fixed.length; i++) {
    squaredError += (jacobi.u[i] - mgcg.u[i]) ** 2
    norm += jacobi.u[i] ** 2
    if (fixed[i]) expect(mgcg.u[i]).toBe(0)
  }
  expect(Math.sqrt(squaredError / norm)).toBeLessThan(1e-5)
})

it.each(['hex8', 'tet4'] as const)('applies a symmetric positive V-cycle on odd-sized %s grids', elementType => {
  const { create, fixed, nu } = cantileverFixture3D([13, 7, 5], elementType)
  const { pcg, solve } = create(false)
  expect(solve().converged).toBe(true)
  const mg = new Multigrid3D(pcg.stiffness, nu, elementType)
  mg.prepare(pcg.modulus)
  const a = Float64Array.from(fixed, (f, i) => f ? 0 : Math.sin(i * 0.31))
  const b = Float64Array.from(fixed, (f, i) => f ? 0 : Math.cos(i * 0.127))
  const Ma = new Float64Array(a.length), Mb = new Float64Array(b.length)
  mg.apply(a, Ma)
  mg.apply(b, Mb)
  const dot = (x: Float64Array, y: Float64Array) => x.reduce((sum, v, i) => sum + v * y[i], 0)
  expect(dot(a, Ma)).toBeGreaterThan(0)
  expect(dot(b, Mb)).toBeGreaterThan(0)
  expect(Math.abs(dot(a, Mb) - dot(b, Ma))).toBeLessThan(1e-12)
})
