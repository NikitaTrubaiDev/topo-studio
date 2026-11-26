import { expect, it } from 'vitest'
import { dictionaries, languages } from '../../i18n/dictionaries'
import {
  addCase3D, boundaryHistory3D, caseColor3D, changeBoundary3D, deleteCase3D, deleteForce3D, directionalForce3D,
  directions3D, editCase3D, maxForceMagnitude3D, minForceMagnitude3D, rigidRank3D, setForce3D, setSupport3D, snapNode3D,
} from '../design3d'
import { CadTriangleBudgetError, cadTriangleBudget, marchingCubes, prepareCadSurface3D, triangleNormal, type Surface3D } from '../marchingCubes'
import { elementSurface3D } from '../mesh3d'
import { makePreset3D, presetGrid3D, resolutions3D } from '../presets3d'
import { Simp3D, validateProblem3D } from '../simp3d'
import { creaseGeometry3D } from '../surface3d'
import { isWatertight } from '../surfaceValidation3d'
import { elementCount, elementIndex, nodeIndex3D } from '../types3d'

function uniqueTriangles(vertices: ArrayLike<number>, triangles: Uint32Array) {
  const keys = new Set<string>()
  for (let i = 0; i < triangles.length; i += 3) {
    const key = Array.from(triangles.subarray(i, i + 3), node =>
      [0, 1, 2].map(axis => Math.fround(vertices[3 * node + axis])).join(',')).sort().join('|')
    keys.add(key)
  }
  expect(keys.size).toBe(triangles.length / 3)
}

/** Fraction of surface edge length with a dihedral over 50 degrees. */
function sharpEdgeFraction({ vertices, triangles }: { vertices: ArrayLike<number>; triangles: Uint32Array }) {
  const edges = new Map<number, number[]>()
  const count = vertices.length / 3
  let sharp = 0, total = 0
  for (let f = 0; f < triangles.length; f += 3) {
    const normal = triangleNormal(vertices, triangles[f], triangles[f + 1], triangles[f + 2])
    const unit = normal.map(value => value / Math.hypot(...normal))
    for (let j = 0; j < 3; j++) {
      const a = triangles[f + j], b = triangles[f + (j + 1) % 3]
      const key = Math.min(a, b) * count + Math.max(a, b)
      const other = edges.get(key)
      if (!other) { edges.set(key, unit); continue }
      const len = Math.hypot(...[0, 1, 2].map(d => vertices[3 * a + d] - vertices[3 * b + d]))
      if (unit.reduce((dot, value, d) => dot + value * other[d], 0) < Math.cos(50 * Math.PI / 180)) sharp += len
      total += len
    }
  }
  return sharp / total
}

const modes = ['hex8', 'tet4'] as const
it.each(modes.flatMap(type => (['cantilever3d', 'boltBracket3d'] as const).map(preset => ({ type, preset }))))(
  '$preset $type CAD reduces sharp dihedrals and both meshes contain unique faces',
  ({ type, preset }) => {
    const grid = presetGrid3D(resolutions3D[0])
    const problem = makePreset3D(preset, grid, undefined, undefined, type)
    const solver = new Simp3D(problem)
    let frame = solver.step()
    for (let i = 1; i < 10; i++) frame = solver.step()
    const fem = elementSurface3D(grid, type, frame.density, 0.5, true)
    const { surface, valid } = prepareCadSurface3D(frame.density, grid, 0.5, 4, problem.passive, type)
    expect(valid).toEqual({ obj: true, stl: true })
    uniqueTriangles(fem.positions, fem.triangles)
    uniqueTriangles(surface.vertices, surface.triangles)
    expect(sharpEdgeFraction(surface)).toBeLessThan(0.65 * sharpEdgeFraction({ vertices: fem.positions, triangles: fem.triangles }))
    const { normals } = creaseGeometry3D(surface)
    let worstError = 0
    for (let i = 0; i < normals.length; i += 3) {
      worstError = Math.max(worstError, Math.abs(1 - Math.hypot(normals[i], normals[i + 1], normals[i + 2])))
    }
    expect(worstError).toBeLessThan(1e-6)
  }, 30000)

it('retains distinct corner normals at right-angle creases', () => {
  const mesh = {
    vertices: Float64Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1),
    triangles: Uint32Array.of(0, 1, 2, 0, 3, 1),
  }
  const { normals } = creaseGeometry3D(mesh)
  expect(Array.from(normals.slice(0, 3))).toEqual([0, 0, 1])
  expect(Array.from(normals.slice(9, 12))).toEqual([0, 1, 0])
})

it.each(modes.flatMap(type => [false, true].map(voidRows => ({ type, voidRows }))))(
  'keeps a barely above-threshold, one-cell $type strut connected with passive void rows = $voidRows', ({ type, voidRows }) => {
    const grid = { nelx: 14, nely: 3, nelz: 3, widthMm: 14, heightMm: 3, depthMm: 3 }
    const density = new Float64Array(elementCount(grid, type))
    const voidMask = new Uint8Array(elementCount(grid))
    const perCell = type === 'tet4' ? 5 : 1
    for (let x = 1; x <= 12; x++) {
      const start = elementIndex(grid, x, 1, 1) * perCell
      density.fill(0.505, start, start + perCell)
      if (voidRows) {
        voidMask[elementIndex(grid, x, 0, 1)] = 1
        voidMask[elementIndex(grid, x, 2, 1)] = 1
      }
    }
    const passive = voidRows ? { void: voidMask } : undefined
    const { surface, valid } = prepareCadSurface3D(density, grid, 0.5, 8, passive, type)
    expect(valid).toEqual({ obj: true, stl: true })
    const links = Array.from({ length: surface.vertices.length / 3 }, () => [] as number[])
    for (let i = 0; i < surface.triangles.length; i += 3) {
      for (let j = 0; j < 3; j++) links[surface.triangles[i + j]].push(surface.triangles[i + (j + 1) % 3])
    }
    const reached = new Set([0])
    for (const vertex of reached) for (const neighbor of links[vertex]) reached.add(neighbor)
    expect(reached.size).toBe(links.length)
    expect(surface.vertices.some((value, i) => i % 3 === 0 && value < 1.25)).toBe(true)
    expect(surface.vertices.some((value, i) => i % 3 === 0 && value > 12.75)).toBe(true)
  })

function boreDiameter({ vertices, triangles }: Surface3D, x: number, y: number, centerZ: number) {
  const crossings: number[] = []
  for (let f = 0; f < triangles.length; f += 3) {
    const [a, b, c] = Array.from(triangles.subarray(f, f + 3), vertex => 3 * vertex)
    const ux = vertices[b] - vertices[a], uy = vertices[b + 1] - vertices[a + 1]
    const vx = vertices[c] - vertices[a], vy = vertices[c + 1] - vertices[a + 1]
    const determinant = ux * vy - uy * vx
    if (determinant === 0) continue
    const dx = x - vertices[a], dy = y - vertices[a + 1]
    const u = (dx * vy - dy * vx) / determinant, v = (ux * dy - uy * dx) / determinant
    if (u < 0 || v < 0 || u + v > 1) continue
    const z = vertices[a + 2] + u * (vertices[b + 2] - vertices[a + 2]) + v * (vertices[c + 2] - vertices[a + 2])
    if (Math.abs(z - centerZ) < 6) crossings.push(z)
  }
  expect(crossings).toHaveLength(2)
  return Math.max(...crossings) - Math.min(...crossings)
}

it.each(modes)('keeps all four prescribed bolt bores in refined %s CAD', type => {
  const grid = presetGrid3D(resolutions3D[0])
  const problem = makePreset3D('boltBracket3d', grid, undefined, undefined, type)
  const density = new Simp3D(problem).initialDensity()
  const raw = prepareCadSurface3D(density, grid, 0.5, 0, problem.passive, type).surface
  const { surface } = prepareCadSurface3D(density, grid, 0.5, 12, problem.passive, type)
  for (const y of [15, 45]) for (const z of [10, 30]) {
    const diameter = boreDiameter(surface, 6.31, y - 0.25, z)
    expect(diameter).toBeCloseTo(10, 2)
    expect(diameter).toBeCloseTo(boreDiameter(raw, 6.31, y - 0.25, z), 9)
  }
})

it.each(modes)('holds the %s bolt bore diameter across iso-thresholds', type => {
  const grid = presetGrid3D(resolutions3D[0])
  const problem = makePreset3D('boltBracket3d', grid, undefined, undefined, type)
  const density = new Simp3D(problem).initialDensity()
  for (const threshold of [0.35, 0.5, 0.65]) {
    const { surface, valid } = prepareCadSurface3D(density, grid, threshold, 4, problem.passive, type)
    expect(valid).toEqual({ obj: true, stl: true })
    for (const y of [15, 45]) for (const z of [10, 30]) {
      expect(boreDiameter(surface, 6.31, y - 0.25, z)).toBeCloseTo(10, 6)
    }
  }
})

it('extracts and validates an 80×40×24 CAD mesh with hundreds of cavities within the grid and time budgets', () => {
  const grid = presetGrid3D(resolutions3D[4])
  const density = new Float64Array(elementCount(grid)).fill(1)
  for (let z = 2; z < grid.nelz - 2; z++) for (let y = 2; y < grid.nely - 2; y++) for (let x = 2; x < grid.nelx - 2; x++) {
    if (x % 5 < 2 && y % 5 < 2 && z % 5 < 2) density[elementIndex(grid, x, y, z)] = 0
  }
  const start = performance.now()
  const { surface, valid } = prepareCadSurface3D(density, grid, 0.5, 4)
  expect(performance.now() - start).toBeLessThan(6000)
  expect(valid).toEqual({ obj: true, stl: true })
  expect(surface.triangles.length).toBe(marchingCubes(density, grid).triangles.length)
  expect(surface.triangles.length / 3).toBeLessThan(100_000)
}, 10000)

function checkerboard(grid: ReturnType<typeof presetGrid3D>) {
  const density = new Float64Array(elementCount(grid))
  for (let z = 0; z < grid.nelz; z++) for (let y = 0; y < grid.nely; y++) for (let x = 0; x < grid.nelx; x++) {
    density[elementIndex(grid, x, y, z)] = (x + y + z) & 1
  }
  return density
}

it('falls back to the base grid when CAD checkerboard refinement exceeds the triangle budget', () => {
  const grid = presetGrid3D(resolutions3D[2])
  const density = checkerboard(grid)
  const { surface, valid } = prepareCadSurface3D(density, grid, 0.5, 0)
  expect(valid).toEqual({ obj: true, stl: true })
  expect(surface.triangles.length).toBe(marchingCubes(density, grid).triangles.length)
  expect(surface.triangles.length / 3).toBeLessThan(cadTriangleBudget)
})

it('stops CAD extraction when even the base checkerboard field exceeds the triangle budget', () => {
  const grid = presetGrid3D(resolutions3D[4])
  expect(() => prepareCadSurface3D(checkerboard(grid), grid, 0.5, 4)).toThrow(CadTriangleBudgetError)
})

it('retains watertight outward shells for seed-23 refined Tet4 material', () => {
  const grid = { nelx: 12, nely: 8, nelz: 8, widthMm: 24, heightMm: 24, depthMm: 32 }
  let seed = 23
  const density = Float64Array.from({ length: elementCount(grid, 'tet4') }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 2 ** 32
  })
  const { surface } = prepareCadSurface3D(density, grid, 0.5, 4, undefined, 'tet4')
  expect(isWatertight(surface, true)).toBe(true)
  uniqueTriangles(surface.vertices, surface.triangles)
})

it('solves a stable 76,800-element Hex8 model with multigrid', () => {
  const grid = presetGrid3D(resolutions3D[4])
  expect(elementCount(grid)).toBe(76800)
  const problem = makePreset3D('cantilever3d', grid)
  expect(rigidRank3D(grid, problem.supports)).toBe(6)
  const frame = new Simp3D(problem).step()
  expect(frame.density.length).toBe(76800)
  expect(Number.isFinite(frame.compliance) && frame.compliance > 0).toBe(true)
}, 30000)

it.each([1e155, 1e-200, Infinity, NaN])('rejects an invalid %s N load and accepts the magnitude limits', fy => {
  const grid = presetGrid3D(resolutions3D[0])
  const problem = makePreset3D('cantilever3d', grid)
  const [load] = problem.loadCases
  function withForce(fy: number) {
    return { ...problem, loadCases: [{ ...load, forces: [{ ...load.forces[0], fy }] }] }
  }
  expect(() => validateProblem3D(withForce(fy))).toThrow(expect.objectContaining({ code: 'forceMagnitude3dError' }))
  expect(() => validateProblem3D(withForce(minForceMagnitude3D))).not.toThrow()
  expect(() => validateProblem3D(withForce(maxForceMagnitude3D))).not.toThrow()
})

it.each(modes)('requires independent restraints on each loaded %s island across a void plane', type => {
  const grid = presetGrid3D(resolutions3D[0])
  const problem = makePreset3D('cantilever3d', grid, undefined, undefined, type)
  const voidX = grid.nelx / 2
  for (let z = 0; z < grid.nelz; z++) for (let y = 0; y < grid.nely; y++) {
    problem.passive!.void![elementIndex(grid, voidX, y, z)] = 1
  }
  expect(rigidRank3D(grid, problem.supports)).toBe(6)
  expect(() => validateProblem3D(problem)).toThrow(expect.objectContaining({ code: 'componentSupport3dError' }))
  const rightSupports = Array.from({ length: grid.nely + 1 }, (_, y) => ({
    ...problem.supports[0], node: nodeIndex3D(grid, voidX + 1, y, 0),
  }))
  // A line of fully fixed nodes still permits rotation about the line.
  expect(() => validateProblem3D({ ...problem, supports: [...problem.supports, ...rightSupports] }))
    .toThrow(expect.objectContaining({ code: 'componentSupport3dError' }))
  rightSupports.push({ ...rightSupports[0], node: nodeIndex3D(grid, voidX + 1, 0, 1) })
  expect(() => validateProblem3D({ ...problem, supports: [...problem.supports, ...rightSupports] })).not.toThrow()
})

it('edits, clears and restores individual cases, nodal force components and supports', () => {
  const grid = presetGrid3D(resolutions3D[0])
  const initial = makePreset3D('cantilever3d', grid)
  const initialCase = initial.loadCases[0].id
  expect(caseColor3D(0)).not.toBe(caseColor3D(1))
  const node = snapNode3D(grid, [119.99, 15.1, 25.01])
  expect(snapNode3D(grid, [120, 15, 25])).toBe(node)
  let design = addCase3D(initial, 'case-2')
  for (const [, , axis, sign] of directions3D) {
    const force = directionalForce3D(axis, sign, 125)
    expect(force[axis]).toBe(sign * 125)
    expect(Object.values(force).filter(Boolean)).toHaveLength(1)
    design = setForce3D(design, 'case-2', node, force)
    expect(design.loadCases[1].forces).toEqual([{ node, ...force }])
  }
  const custom = { fx: -12.5, fy: 22, fz: 80 }
  design = setForce3D(design, 'case-2', node, custom)
  expect(design.loadCases[0].forces).toEqual(initial.loadCases[0].forces)
  expect(design.loadCases[1].forces).toEqual([{ node, ...custom }])
  const history = changeBoundary3D(boundaryHistory3D(design), deleteForce3D(design, 'case-2', 0))
  expect(history.present.loadCases[1].forces).toEqual([])
  const undone = changeBoundary3D(history, 'undo')
  expect(undone.present).toBe(design)
  expect(changeBoundary3D(undone, 'redo').present).toBe(history.present)
  expect(setForce3D(design, 'case-2', node).loadCases[1].forces).toEqual([])
  expect(editCase3D(design, initialCase, () => []).loadCases[0].forces).toEqual([])
  expect(deleteCase3D(design, 'case-2').loadCases).toEqual(initial.loadCases)
  const cleared = { ...initial, supports: [] }
  const roller = setSupport3D(cleared, node, 'fixZ')
  expect(roller.supports).toEqual([{ node, fixX: false, fixY: false, fixZ: true }])
  expect(setSupport3D(roller, node, 'fixZ').supports).toEqual([])
  const pin = setSupport3D(roller, node, 'pin')
  expect(rigidRank3D(grid, pin.supports)).toBe(3)
  expect(() => validateProblem3D({ ...initial, ...pin })).toThrow('support3dError')
  expect(setSupport3D(pin, node).supports).toEqual([])
  expect(rigidRank3D(grid, initial.supports)).toBe(6)
})

it('provides localized 3D editor and advanced resolution labels and tooltips', () => {
  const keys = [
    'orbitInspect3d', 'placeLoad3d', 'placeSupport3d', 'clearCaseLoads3d', 'resetPreset3d', 'forcePositiveZ3d', 'forceNegativeZ3d',
    'fixedSupport3d', 'pinSupport3d', 'rollerSupportX3d', 'rollerSupportY3d', 'rollerSupportZ3d', 'frameMemory3d',
    'hint3dFrameMemory', 'hint3dOrbitInspect', 'hint3dPlaceLoad', 'hint3dPlaceSupport', 'hint3dSupportType', 'hint3dCase',
    'hint3dAddCase', 'hint3dRemoveCase', 'hint3dDirection', 'hint3dMagnitude', 'hint3dComponent', 'hint3dDeleteForce',
    'hint3dClearLoads', 'hint3dClearSupports', 'hint3dUndo', 'hint3dRedo', 'hint3dResetPreset', 'hint3dResolution',
    'support3dError', 'componentSupport3dError', 'forceMagnitude3dError', 'cadBudget3dError',
  ] as const
  for (const key of keys) {
    const translations = languages.map(language => dictionaries[language][key])
    expect(translations.every(label => label.trim().length > 0 && !label.includes('???'))).toBe(true)
    expect(new Set(translations).size).toBe(languages.length)
  }
})
