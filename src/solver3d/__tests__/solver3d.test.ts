import { expect, it } from 'vitest'
import { elasticity3D, h8Corners, h8Stiffness, strainDisplacementH8 } from '../elementH8'
import { DensityFilter3D, projectDensity3D } from '../filter3d'
import { isWatertight } from '../export3d'
import { marchingCubes, taubinSmooth } from '../marchingCubes'
import { defaultParams3D, makePreset3D, presetGrid3D, presets3D, resolutions3D } from '../presets3d'
import { Analysis3D, Simp3D, validateProblem3D } from '../simp3d'
import { elementCount, elementIndex, nodeIndex3D, nodePosition } from '../types3d'
import { dictionaries, languages } from '../../i18n/dictionaries'

const relative = (actual: number, expected: number) => Math.abs(actual / expected - 1)

it('integrates symmetric positive semidefinite H8 stiffness with exactly six rigid-body modes', () => {
  const K = h8Stiffness(123, 0.32, 2, 3, 4)
  const modes = Array.from({ length: 6 }, (_, mode) => h8Corners.flatMap(([i, j, k]) => {
    const x = i * 2, y = j * 3, z = k * 4
    return [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0, -z, y], [z, 0, -x], [-y, x, 0]][mode]
  }))
  for (let r = 0; r < 24; r++) {
    for (let c = 0; c < 24; c++) expect(K[24 * r + c]).toBe(K[24 * c + r])
    for (const mode of modes) {
      expect(Math.abs(mode.reduce((sum, value, c) => sum + value * K[24 * r + c], 0))).toBeLessThan(1e-11)
    }
  }
  // Symmetric pivoted Schur complements establish the positive rank.
  const A = Array.from({ length: 24 }, (_, r) => Array.from(K.slice(r * 24, r * 24 + 24)))
  while (A.length > 6) {
    const p = A.reduce((max, row, r) => row[r] > A[max][max] ? r : max, 0)
    const pivot = A[p][p]
    expect(pivot).toBeGreaterThan(1)
    const column = A.splice(p, 1)[0]
    for (const row of A) row.splice(p, 1)
    column.splice(p, 1)
    A.forEach((row, r) => row.forEach((value, c) => { row[c] = value - column[r] * column[c] / pivot }))
  }
  expect(Math.max(...A.flat().map(Math.abs))).toBeLessThan(1e-10)
})

it.each([1, 1e-100])('recovers uniaxial tension and Poisson contraction at load scale %s', scale => {
  const grid = { nelx: 5, nely: 3, nelz: 2, widthMm: 20, heightMm: 6, depthMm: 8 }
  const problem = makePreset3D('cantilever3d', grid)
  const node = (x: number, y: number, z: number) => nodeIndex3D(grid, x, y, z)
  const force = 480 * scale
  const forces = []
  const supports = []
  for (let y = 0; y <= grid.nely; y++) for (let z = 0; z <= grid.nelz; z++) {
    const weightY = y === 0 || y === grid.nely ? 0.5 : 1
    const weightZ = z === 0 || z === grid.nelz ? 0.5 : 1
    forces.push({ node: node(grid.nelx, y, z), fx: force * weightY * weightZ / (grid.nely * grid.nelz), fy: 0, fz: 0 })
    supports.push({ node: node(0, y, z), fixX: true, fixY: y === 0 && z === 0, fixZ: z === 0 })
  }
  const tension = { ...problem, supports, loadCases: [{ id: 'tension', forces }] }
  const setup = validateProblem3D(tension)
  const analysis = new Analysis3D(tension, setup.fixed, setup.forces)
  analysis.solve(new Float64Array(elementCount(grid)).fill(1), 3, 1e-9)
  const stress = force / (grid.heightMm * grid.depthMm)
  const strain = stress / problem.material.E0
  const [u] = analysis.displacements
  for (let d = 0; d < u.length; d += 3) {
    const [x, y, z] = nodePosition(grid, d / 3)
    for (const [i, exact] of [x * strain, -y * strain * problem.material.nu, -z * strain * problem.material.nu].entries()) {
      expect(exact ? relative(u[d + i], exact) : Math.abs(u[d + i] / (strain * grid.widthMm))).toBeLessThan(1e-5)
      if (setup.fixed[d + i]) expect(u[d + i]).toBe(0)
    }
  }
  for (const actual of analysis.vonMises) expect(relative(actual, stress)).toBeLessThan(1e-5)
  const B = strainDisplacementH8(4, 2, 4)
  const D = elasticity3D(problem.material.E0, problem.material.nu)
  const local = h8Corners.flatMap(([x, y, z]) => Array.from(u.slice(3 * node(x, y, z), 3 * node(x, y, z) + 3)))
  const epsilon = Array.from({ length: 6 }, (_, r) => local.reduce((sum, value, c) => sum + value * B[24 * r + c], 0))
  const sigmaXX = epsilon.reduce((sum, value, c) => sum + value * D[c], 0)
  expect(relative(sigmaXX, stress)).toBeLessThan(1e-5)
})

it('normalizes the spherical filter and excludes passive voids from both passes', () => {
  const grid = presetGrid3D([4, 3, 3])
  const n = elementCount(grid)
  const voidMask = new Uint8Array(n)
  voidMask[5] = 1
  const filter = new DensityFilter3D(grid, 2.1, voidMask)
  const field = new Float64Array(n).fill(1)
  field[5] = 1e10
  const result = filter.apply(field, new Float64Array(n))
  for (let e = 0; e < n; e++) expect(result[e]).toBeCloseTo(e === 5 ? 0 : 1, 14)
  expect(filter.transpose(result, new Float64Array(n))[5]).toBe(0)
})

it('backpropagates compliance and volume through projection and the cone with finite-difference accuracy', () => {
  const grid = presetGrid3D([4, 3, 2])
  const problem = makePreset3D('cantilever3d', grid)
  const { fixed, forces, solid, voidMask } = validateProblem3D(problem)
  voidMask[5] = 1
  solid[3] = 1
  const filter = new DensityFilter3D(grid, 1.8, voidMask)
  const analysis = new Analysis3D(problem, fixed, [...forces, Float64Array.from(forces[0], value => value * 0.5)])
  const n = elementCount(grid)
  const x = Float64Array.from({ length: n }, (_, e) => e === 3 ? 1 : e === 5 ? 0 : 0.28 + e * 0.014)
  const rho = new Float64Array(n), derivative = new Float64Array(n)
  function evaluate() {
    filter.apply(x, rho)
    projectDensity3D(rho, derivative, 2, solid, voidMask)
    return [analysis.solve(rho, 3, 1e-11).compliance, rho.reduce((sum, value) => sum + value, 0)]
  }
  evaluate()
  const dc = filter.transpose(analysis.gradient.map((value, e) => value * derivative[e]), new Float64Array(n))
  const dv = filter.transpose(derivative, new Float64Array(n))
  for (const e of [0, 2, 6, n - 1]) {
    const h = 1e-5
    x[e] += h
    const plus = evaluate()
    x[e] -= 2 * h
    const minus = evaluate()
    x[e] += h
    expect(relative((plus[0] - minus[0]) / (2 * h), dc[e])).toBeLessThan(1e-4)
    expect(relative((plus[1] - minus[1]) / (2 * h), dv[e])).toBeLessThan(1e-4)
  }
})

it('reduces cantilever compliance while meeting physical volume and exact Z symmetry', () => {
  const grid = presetGrid3D([12, 6, 4])
  const params = { ...defaultParams3D, symmetry: 'z' as const, maxIter: 26, changeTol: 0 }
  const solver = new Simp3D(makePreset3D('cantilever3d', grid, params))
  const initial = solver.step()
  let frame = initial
  while (!frame.done) frame = solver.step()
  expect(frame.compliance).toBeLessThan(initial.compliance * 0.65)
  expect(relative(frame.volFrac, params.volFrac)).toBeLessThan(0.01)
  expect(frame.metrics.mass).toBeCloseTo(frame.volFrac * frame.metrics.initialMass, 9)
  expect(frame.metrics.maxDeflection).toBeGreaterThan(0)
  expect(frame.metrics.safetyFactor).toBeGreaterThan(0)
  expect(frame.metrics.p95SafetyFactor).toBeGreaterThanOrEqual(frame.metrics.safetyFactor!)
  expect(isWatertight(taubinSmooth(marchingCubes(frame.density, grid), grid, 4), true)).toBe(true)
  for (let z = 0; z < grid.nelz; z++) for (let y = 0; y < grid.nely; y++) for (let x = 0; x < grid.nelx; x++) {
    expect(frame.density[elementIndex(grid, x, y, z)]).toBeCloseTo(frame.density[elementIndex(grid, x, y, grid.nelz - 1 - z)], 14)
  }
}, 20_000)

it('rejects a clamp leaving rotation around a support line free', () => {
  const grid = presetGrid3D([8, 4, 4])
  const problem = makePreset3D('cantilever3d', grid)
  expect(() => validateProblem3D({ ...problem, supports: problem.supports.slice(0, grid.nely + 1) })).toThrow('support3dError')
})

it('rejects target volumes below the filtered contribution of passive solids', () => {
  const grid = presetGrid3D([6, 4, 4])
  const count = elementCount(grid)
  const problem = makePreset3D('cantilever3d', grid, { ...defaultParams3D, volFrac: 1 / count })
  const solid = new Uint8Array(count)
  solid[0] = 1
  expect(() => new Simp3D({ ...problem, passive: { solid } })).toThrow('volume3dError')
})

it.each(presets3D.flatMap(preset => resolutions3D.map(resolution => ({ preset, resolution }))))(
  'validates $preset on $resolution', ({ preset, resolution }) => {
    const grid = presetGrid3D(resolution)
    const problem = makePreset3D(preset, grid)
    const { solid, voidMask, allowed } = validateProblem3D(problem)
    expect(allowed).toBeGreaterThan(elementCount(grid) * problem.params.volFrac)
    if (preset === 'boltBracket3d') {
      expect(solid.some(Boolean)).toBe(true)
      expect(voidMask.some(Boolean)).toBe(true)
    }
  },
)

it.each(languages)('includes all non-empty 2D and 3D messages in %s', language => {
  expect(Object.keys(dictionaries[language]).sort()).toEqual(Object.keys(dictionaries.en).sort())
  expect(Object.values(dictionaries[language]).every(value => typeof value === 'string' && value.length > 0)).toBe(true)
  for (const preset of presets3D) expect(dictionaries[language]).toHaveProperty(preset)
  const hints = Object.entries(dictionaries[language]).filter(([key]) => key.startsWith('hint3d'))
  expect(hints.length).toBeGreaterThan(25)
  for (const [key, hint] of hints) {
    expect(hint.length).toBeGreaterThan(20)
    if (language !== 'en') expect(hint).not.toBe(dictionaries.en[key as keyof typeof dictionaries.en])
  }
})
