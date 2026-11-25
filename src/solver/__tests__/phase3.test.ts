import { describe, expect, it } from 'vitest'
import { dictionaries } from '../../i18n/dictionaries'
import { hasFreeLoad, supportError } from '../design'
import { engineeringMetrics } from '../engineering'
import { ManufacturingDensity } from '../manufacturing'
import { OverhangFilter } from '../overhang'
import { defaultParams, makePreset } from '../presets'
import { loadProject, projectGrid, ProjectError, saveProject, type Settings } from '../project'
import { Simp2D } from '../simp2d'
import type { BuildDirection, Grid, SimpParams } from '../types'

const grid = { nelx: 18, nely: 6 }
const directions: BuildDirection[] = ['+Y', '-Y', '+X', '-X']

function derivativeCheck(params: SimpParams, beta: number) {
  const filter = new ManufacturingDensity({ grid, params })
  const n = grid.nelx * grid.nely
  const input = Float64Array.from({ length: n }, (_, i) => 0.4 + Math.sin(i * 25.2) * 0.13)
  const direction = Float64Array.from({ length: n }, (_, i) => Math.cos(i * 0.53))
  const output = new Float64Array(n)
  const adjoint = new Float64Array(n)
  const epsilon = 2e-7

  // Compliance has a nonuniform density derivative. Volume has unit derivative.
  for (const volume of [false, true]) {
    filter.apply(input, output, beta)
    const dq = output.map((rho, i) => volume ? 1 : -(1 + i / n) / (0.1 + rho) ** 2)
    filter.transpose(dq, adjoint)
    const predicted = adjoint.reduce((sum, value, i) => sum + value * direction[i], 0)
    const evaluate = (sign: number) => {
      filter.apply(input.map((value, i) => value + sign * epsilon * direction[i]), output, beta, false)
      return output.reduce((sum, rho, i) => sum + (volume ? rho : (1 + i / n) / (0.1 + rho)), 0)
    }
    const measured = (evaluate(1) - evaluate(-1)) / (2 * epsilon)
    expect(Math.abs(measured - predicted) / Math.max(1e-8, Math.abs(measured))).toBeLessThan(1e-4)
  }
}

describe('manufacturing constraints', () => {
  it.each([1, 4, 16])('differentiates Heaviside compliance and volume at beta %d', beta => {
    derivativeCheck({ ...defaultParams, heaviside: true }, beta)
  })

  it.each(directions)('differentiates the 45° filter for %s and caps every layer by its support', direction => {
    derivativeCheck({ ...defaultParams, overhang: direction }, 1)
    const overhang = new OverhangFilter(grid, direction)
    const n = grid.nelx * grid.nely
    const input = Float64Array.from({ length: n }, (_, i) => (Math.sin(i * i * 47.35 + 0.3) + 1) / 2)
    const rho = overhang.apply(input, new Float64Array(n))
    expect(overhang.unsupported(input, 0.5)).toBeGreaterThan(0)
    for (const threshold of [0.05, 0.2, 0.5, 0.75, 0.95]) {
      expect(overhang.unsupported(rho, threshold)).toBe(0)
    }
  })

  it('differentiates the complete projection with symmetry, Heaviside and overhang', () => {
    derivativeCheck({ ...defaultParams, heaviside: true, symmetry: 'xy', overhang: '+Y' }, 4)
  })

  it.each(['x', 'y', 'xy'] as const)('produces exact %s symmetry under asymmetric loads', symmetry => {
    const problem = makePreset('mbb', grid, { ...defaultParams, maxIter: 6, symmetry, heaviside: true })
    const solid = new Uint8Array(grid.nelx * grid.nely)
    solid[1] = 1
    const optimizer = new Simp2D({ ...problem, passive: { solid } })
    let result = optimizer.step()
    while (!result.done) result = optimizer.step()
    const { density } = result
    expect(result.volFrac).toBeCloseTo(problem.params.volFrac, 5)
    expect(density[1]).toBe(1)
    for (let y = 0; y < grid.nely; y++) {
      for (let x = 0; x < grid.nelx; x++) {
        const e = y * grid.nelx + x
        if (symmetry.includes('x')) expect(density[e]).toBe(density[y * grid.nelx + grid.nelx - 1 - x])
        if (symmetry.includes('y')) expect(density[e]).toBe(density[(grid.nely - 1 - y) * grid.nelx + x])
      }
    }
  })

  it('preserves projected volume during beta continuation and the overhang update', () => {
    const problem = makePreset('cantilever', grid, {
      ...defaultParams, heaviside: true, overhang: '+Y', maxIter: 8, changeTol: 1,
    })
    const optimizer = new Simp2D(problem)
    const overhang = new OverhangFilter(grid, '+Y')
    for (const expected of [1, 2, 4, 8, 16]) {
      const result = optimizer.step()
      expect(result.beta).toBe(expected)
      expect(result.volFrac).toBeCloseTo(problem.params.volFrac, 5)
      expect(overhang.unsupported(result.density, 0.5)).toBe(0)
    }
  })

  it.each(['none', 'xy'] as const)('anchors passive solids without unsupported cells with %s symmetry', symmetry => {
    const solid = new Uint8Array(grid.nelx * grid.nely)
    const voidMask = new Uint8Array(solid.length)
    solid[grid.nelx * 2 + 3] = 1
    voidMask[grid.nelx + 3] = 1
    const filter = new ManufacturingDensity({
      grid, params: { ...defaultParams, symmetry, overhang: '+Y' }, passive: { solid, void: voidMask },
    })
    const design = filter.setup.design.map((rho, i) => filter.setup.mask[i] ? rho : (Math.sin(i * i) + 1) / 2)
    filter.symmetry?.apply(design)
    const density = filter.apply(design, new Float64Array(solid.length), 1)
    expect(filter.addedAnchors).toBeGreaterThan(0)
    expect(density[grid.nelx * 2 + 3]).toBe(1)
    expect(density[grid.nelx + 3]).toBe(0)
    const forwards = new OverhangFilter(grid, '+Y')
    const backwards = new OverhangFilter(grid, '-Y')
    for (const rho of density) {
      if (rho > 0) expect(forwards.unsupported(density, rho)).toBe(0)
      if (rho > 0 && symmetry === 'xy') expect(backwards.unsupported(density, rho)).toBe(0)
    }
  })

  it('reports a void mask that blocks every path to the build plate', () => {
    const solid = new Uint8Array(grid.nelx * grid.nely)
    const voidMask = solid.slice().fill(1, 0, grid.nelx)
    solid[grid.nelx + 1] = 1
    expect(() => new ManufacturingDensity({
      grid, params: { ...defaultParams, overhang: '+Y' }, passive: { solid, void: voidMask },
    })).toThrow(/no path to the build plate/)
  })

  it('rejects contradictory fixed masks in a mirror orbit', () => {
    const solid = new Uint8Array(grid.nelx * grid.nely)
    const voidMask = solid.slice()
    solid[0] = voidMask[grid.nelx - 1] = 1
    expect(() => new ManufacturingDensity({
      grid, params: { ...defaultParams, symmetry: 'x' }, passive: { solid, void: voidMask },
    })).toThrow(/conflicts/)
  })
})

describe('engineering analysis', () => {
  it('doubles mass and halves deflection and von Mises stress when thickness doubles', () => {
    const thin = makePreset('cantilever', { ...grid, thicknessMm: 5, cellSizeMm: 2 })
    const thick = { ...thin, grid: { ...thin.grid, thicknessMm: 10 } }
    const a = new Simp2D(thin).step()
    const b = new Simp2D(thick).step()
    const metricsA = engineeringMetrics(thin, a.density, a)
    const metricsB = engineeringMetrics(thick, b.density, b)
    expect(metricsB.mass / metricsA.mass).toBeCloseTo(2, 6)
    expect(metricsB.maxDeflection! / metricsA.maxDeflection!).toBeCloseTo(0.5, 6)
    expect(b.maxVonMises / a.maxVonMises).toBeCloseTo(0.5, 6)
    expect(metricsB.safetyFactor! / metricsA.safetyFactor!).toBeCloseTo(2, 6)
  })

  it.each([60, 96, 120, 150, 180, 240, 300])('runs both bellcrank cases at %d columns', nelx => {
    const grid: Grid = { nelx, nely: nelx / 3, cellSizeMm: 120 / nelx, thicknessMm: 10 }
    const problem = makePreset('bellcrank', grid, { ...defaultParams, maxIter: 1 })
    expect(supportError(grid, problem.supports)).toBeUndefined()
    expect(problem.loadCases).toHaveLength(2)
    expect(hasFreeLoad(problem)).toBe(true)
    expect(problem.passive?.solid?.some(Boolean)).toBe(true)
    expect(problem.passive?.void?.some(Boolean)).toBe(true)
    const [bump, rebound] = problem.loadCases.map(load =>
      load.forces.reduce((sum, force) => sum + force.fy, 0))
    expect(bump).toBeCloseTo(350, 8)
    expect(rebound).toBeCloseTo(50, 8)
    const result = new Simp2D(problem).step()
    expect(result.displacements.every(u => u.every(Number.isFinite))).toBe(true)
    expect(result.vonMises.every(Number.isFinite)).toBe(true)
    expect(result.compliance).toBeGreaterThan(0)
    expect(result.volFrac).toBeCloseTo(problem.params.volFrac, 7)
  }, 20_000)
  it('runs 300×100 optimization with projection and manufacturing anchors enabled', () => {
    const grid: Grid = { nelx: 300, nely: 100, cellSizeMm: 0.4, thicknessMm: 10 }
    const params = { ...defaultParams, heaviside: true, overhang: '+Y' as const, maxIter: 4 }
    const solid = new Uint8Array(grid.nelx * grid.nely)
    solid[50 * grid.nelx + grid.nelx - 1] = 1
    const solver = new Simp2D({ ...makePreset('cantilever', grid, params), passive: { solid } })
    const overhang = new OverhangFilter(grid, '+Y')
    for (let i = 0; i < params.maxIter; i++) {
      const result = solver.step()
      expect(result.compliance).toBeGreaterThan(0)
      expect(Number.isFinite(result.compliance)).toBe(true)
      expect(result.volFrac).toBeCloseTo(params.volFrac, 5)
      expect(overhang.unsupported(result.density, 0.5)).toBe(0)
    }
  }, 20_000)
})

describe('project persistence and translations', () => {
  const settings: Settings = {
    preset: 'bellcrank', resolution: '60 × 20', material: 'pa12', widthMm: 314, thicknessMm: 15,
    params: { ...defaultParams, heaviside: true, symmetry: 'x', overhang: '-X', preconditioner: 'jacobi' },
  }
  const problem = makePreset(settings.preset, projectGrid(settings), settings.params)
  const json = saveProject(settings, problem)

  it('round-trips geometry, material, masks, supports, forces and settings', () => {
    const loaded = loadProject(json)
    expect(loaded.settings).toEqual(settings)
    expect(loaded.design).toEqual({
      supports: problem.supports, loadCases: problem.loadCases, passive: problem.passive,
    })
    expect(JSON.parse(saveProject(loaded.settings, loaded.design))).toEqual(JSON.parse(json))
  })

  it.each(['broken json{', 'null', '{}', json.replace('"version": 1', '"version": 4'),
    json.replace('"thicknessMm": 15', '"thicknessMm": -10'), json.replace('"overhang": "-X"', '"overhang": "left"'),
    json.replace(/"node": \d+/, '"node": 37000'), json.replace('"solid": [', '"solid": [2,')])('rejects an invalid project %#', value => {
    expect(() => loadProject(value)).toThrow(ProjectError)
  })

  it('provides exactly the same nonempty UI messages in EN, DE and RU', () => {
    const keys = Object.keys(dictionaries.en).sort()
    for (const dictionary of Object.values(dictionaries)) {
      expect(Object.keys(dictionary).sort()).toEqual(keys)
      expect(Object.values(dictionary).every(value => value.trim().length > 0)).toBe(true)
    }
  })
})
