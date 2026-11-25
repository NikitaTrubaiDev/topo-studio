import { describe, expect, it } from 'vitest'
import { defaultParams, makePreset } from '../presets'
import { Simp2D } from '../simp2d'
import type { Grid, SimpProblem } from '../types'

const params = { ...defaultParams, maxIter: 45, changeTol: 0.001 }

function run(problem: SimpProblem) {
  const solver = new Simp2D(problem)
  const first = solver.step()
  let last = first
  while (!last.done) {
    last = solver.step()
    expect(last.volFrac).toBeCloseTo(problem.params.volFrac, 6)
    expect(Number.isFinite(last.compliance + last.change + last.maxVonMises)).toBe(true)
  }
  return { first, last }
}

function mirrorError(density: Float32Array, { nelx, nely }: Grid) {
  let max = 0
  for (let y = 0; y < nely; y++) {
    for (let x = 0; x < nelx; x++) {
      max = Math.max(max, Math.abs(density[y * nelx + x] - density[(nely - 1 - y) * nelx + x]))
    }
  }
  return max
}

describe('2D SIMP optimization', () => {
  it('reduces MBB compliance substantially at constant volume with finite results', () => {
    const problem = makePreset('mbb', { nelx: 30, nely: 10 }, params)
    const { first, last } = run(problem)
    expect(last.compliance).toBeLessThan(first.compliance * 0.65)
    expect(Math.abs(last.volFrac - params.volFrac)).toBeLessThan(0.01)
    expect(last.density.every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true)
    expect(last.vonMises.every(value => Number.isFinite(value) && value >= 0)).toBe(true)
    expect(last.displacements[0].every(Number.isFinite)).toBe(true)
    for (const support of problem.supports) {
      if (support.fixedX) expect(last.displacements[0][2 * support.node]).toBe(0)
      if (support.fixedY) expect(last.displacements[0][2 * support.node + 1]).toBe(0)
    }
  })

  it('preserves vertical reflection symmetry for a centrically loaded cantilever', () => {
    const grid = { nelx: 30, nely: 14 }
    const { last } = run(makePreset('cantilever', grid, params))
    expect(mirrorError(last.density, grid)).toBeLessThan(2e-6)
  })

  it('holds L-bracket passive solids and voids exactly through every filtered OC update', () => {
    const problem = makePreset('bracket', { nelx: 24, nely: 12 }, { ...params, maxIter: 18 })
    const solver = new Simp2D(problem)
    for (let i = 0; i < problem.params.maxIter; i++) {
      const snapshot = solver.step()
      const { solid, void: voidMask } = problem.passive!
      for (let e = 0; e < snapshot.density.length; e++) {
        if (solid![e]) expect(snapshot.density[e]).toBe(1)
        if (voidMask![e]) {
          expect(snapshot.density[e]).toBe(0)
          expect(snapshot.vonMises[e]).toBe(0)
        }
      }
      expect(snapshot.volFrac).toBeCloseTo(params.volFrac, 6)
      if (snapshot.done) break
    }
  })

  it('sums opposite load cases and retains the symmetric cantilever solution', () => {
    const grid = { nelx: 30, nely: 14 }
    const one = makePreset('cantilever', grid, { ...params, maxIter: 20 })
    const opposite = { name: 'Upward tip load', forces: one.loadCases[0].forces.map(force => ({ ...force, fy: -force.fy })) }
    const { last } = run({ ...one, loadCases: [...one.loadCases, opposite] })
    const reference = run(one).last
    expect(last.displacements).toHaveLength(2)
    expect(last.compliance / reference.compliance).toBeCloseTo(2, 7)
    expect(last.maxVonMises).toBeCloseTo(reference.maxVonMises, 5)
    expect(mirrorError(last.density, grid)).toBeLessThan(2e-6)
  })

  it('runs the bridge preset under distributed deck loading', () => {
    const { first, last } = run(makePreset('bridge', { nelx: 30, nely: 10 }, { ...params, maxIter: 12 }))
    expect(last.compliance).toBeLessThan(first.compliance)
  })
})
