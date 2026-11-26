import { describe, expect, it } from 'vitest'
import { elementStiffness } from '../elementQ4'
import { pcg } from '../pcg'

function operator(E: number, nu: number) {
  const K = elementStiffness(E, nu)
  return {
    diagonal: Float64Array.from({ length: 8 }, (_, i) => K[9 * i]),
    multiply: (u: Float64Array, result: Float64Array) => {
      for (let i = 0; i < 8; i++) {
        result[i] = u.reduce((sum, value, j) => sum + K[8 * i + j] * value, 0)
      }
    },
  }
}

describe('Jacobi PCG', () => {
  it('recovers exact uniaxial displacement and Poisson contraction, including a clamped warm start', () => {
    const E = 200
    const nu = 0.3
    const { multiply, diagonal } = operator(E, nu)
    const force = Float64Array.of(99, 99, 5, 0, 5, 0, 99, 0)
    const fixed = Uint8Array.of(1, 1, 0, 0, 0, 0, 1, 0)
    const cold = pcg(multiply, diagonal, force, fixed)
    expect(cold.converged).toBe(true)
    const extension = 10 / E
    const expected = [0, 0, extension, 0, extension, -nu * extension, 0, -nu * extension]
    expected.forEach((value, i) => expect(cold.u[i]).toBeCloseTo(value, 12))
    const initial = cold.u.slice()
    initial[0] = initial[1] = initial[6] = 42
    const warm = pcg(multiply, diagonal, force, fixed, { initial })
    expect(warm.iterations).toBe(0)
    expect([warm.u[0], warm.u[1], warm.u[6]]).toEqual([0, 0, 0])
  })

  it.each([1e-158, 1e-200])('solves and warm-starts a tiny %s RHS in PCG', magnitude => {
    const multiply = (u: Float64Array, result: Float64Array) => { result[0] = 2 * u[0] }
    const force = Float64Array.of(magnitude)
    const diagonal = Float64Array.of(2)
    const fixed = Uint8Array.of(0)
    const result = pcg(multiply, diagonal, force, fixed)
    expect(result.converged).toBe(true)
    expect(result.u[0]).toBe(magnitude / 2)
    const warm = pcg(multiply, diagonal, force, fixed, { initial: result.u, output: result.u })
    expect(warm.iterations).toBe(0)
    expect(warm.u[0]).toBe(magnitude / 2)
  })

  it('solves the exact discrete bending response of a one-cell clamped cantilever', () => {
    const E = 200
    const force = 10
    const { multiply, diagonal } = operator(E, 0)
    const loads = Float64Array.of(0, 0, 0, -force / 2, 0, -force / 2, 0, 0)
    const fixed = Uint8Array.of(1, 1, 0, 0, 0, 0, 1, 1)
    const result = pcg(multiply, diagonal, loads, fixed)
    expect(result.converged).toBe(true)
    expect(result.u[2]).toBeCloseTo(-2 * force / E, 12)
    expect(result.u[4]).toBeCloseTo(2 * force / E, 12)
    expect(result.u[3]).toBeCloseTo(-4 * force / E, 12)
    expect(result.u[5]).toBeCloseTo(-4 * force / E, 12)
    expect(pcg(multiply, diagonal, loads, fixed, { maxIterations: 0 }).converged).toBe(false)
  })
})
