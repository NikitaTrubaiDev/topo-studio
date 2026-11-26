import { expect, it } from 'vitest'
import { dictionaries } from '../../i18n/dictionaries'
import { generateAdaptiveMesh3D, locateAdaptiveTet3D, tetCoordinates3D, transferAdaptiveDensity3D, type AdaptiveMesh3D } from '../adaptiveMesh3d'
import { elasticity3D } from '../elementH8'
import { tetFaces } from '../elementT4'
import { exportObj3D, exportStl3D } from '../export3d'
import { CadTriangleBudgetError, prepareCadSurface3D, signedTriangleVolume6 } from '../marchingCubes'
import { elementSurface3D } from '../mesh3d'
import { defaultParams3D, makePreset3D, presetGrid3D } from '../presets3d'
import { Analysis3D, Simp3D, validateProblem3D } from '../simp3d'
import { elementCount, elementIndex, nodeIndex3D, nodePosition, type Grid3D } from '../types3d'
import { marchingTetrahedra } from '../tetSurface3d'
import { preflightAdaptiveSolver3D, unstructuredSetup3D, unstructuredTet4Element } from '../unstructuredTet4'

const boltGrid = presetGrid3D([24, 12, 8])
const smallGrid = { nelx: 12, nely: 6, nelz: 4, widthMm: 60, heightMm: 30, depthMm: 20 }
const relative = (actual: number, expected: number) => Math.abs(actual / expected - 1)

function checkConformity(mesh: AdaptiveMesh3D, grid: Grid3D) {
  const { tetrahedra, positions, volumes, neighbors, levels } = mesh
  const sides = new Map<string, { e: number; face: number; winding: number }[]>()
  let sum = 0, minDet = Infinity
  for (let e = 0; e < volumes.length; e++) {
    const { det } = tetCoordinates3D(positions, tetrahedra, 4 * e)
    minDet = Math.min(minDet, det)
    sum += det / 6
    tetFaces.forEach((face, i) => {
      const ids = face.map(j => tetrahedra[4 * e + j])
      const [a, b, c] = ids
      const winding = (a > b ? -1 : 1) * (a > c ? -1 : 1) * (b > c ? -1 : 1)
      const key = ids.sort((a, b) => a - b).join(',')
      const group = sides.get(key) ?? []
      group.push({ e, face: i, winding })
      sides.set(key, group)
    })
  }
  expect(minDet).toBeGreaterThan(0)
  expect(relative(sum, grid.widthMm * grid.heightMm * grid.depthMm)).toBeLessThan(1e-9)
  const unmatched: string[] = []
  let maxFaceJump = 0
  for (const [key, group] of sides) {
    const nodes = key.split(',').map(Number)
    const exterior = [grid.widthMm, grid.heightMm, grid.depthMm].some((length, d) => [0, length].some(at =>
      nodes.every(node => Math.abs(positions[3 * node + d] - at) < 1e-10)))
    const [a, b] = group
    if (group.length !== (exterior ? 1 : 2) || neighbors[4 * a.e + a.face] !== (b?.e ?? -1)
      || (b && (neighbors[4 * b.e + b.face] !== a.e || a.winding !== -b.winding))) unmatched.push(key)
    if (b) maxFaceJump = Math.max(maxFaceJump, Math.abs(levels[a.e] - levels[b.e]))
  }
  expect(unmatched).toEqual([])
  expect(maxFaceJump).toBeLessThanOrEqual(1)
  const edges = new Map<string, [number, number]>()
  for (const { origin, size, level } of mesh.leaves) for (let d = 0; d < 3; d++) {
    const axes = [0, 1, 2].filter(axis => axis !== d)
    for (const a of [0, size]) for (const b of [0, size]) for (let i = 0; i < size; i++) {
      const edge = origin.slice()
      edge[d] += i
      edge[axes[0]] += a
      edge[axes[1]] += b
      const key = [d, ...edge].join(',')
      const [lo, hi] = edges.get(key) ?? [level, level]
      edges.set(key, [Math.min(lo, level), Math.max(hi, level)])
    }
  }
  expect(Array.from(edges.values()).every(([lo, hi]) => hi - lo <= 1)).toBe(true)
}

it('fills the four-bolt bracket domain with positive, oppositely paired tetrahedra across all refinement transitions', () => {
  const problem = makePreset3D('boltBracket3d', boltGrid, undefined, undefined, 'adaptiveTet4')
  const mesh = generateAdaptiveMesh3D(problem)
  expect(mesh.stats.levelCounts.every(n => n > 0)).toBe(true)
  expect(mesh.stats.minJacobian).toBeGreaterThan(0)
  expect(mesh.stats.minQuality).toBeGreaterThan(0)
  checkConformity(mesh, boltGrid)
})

it('recovers uniaxial stress, displacement and Poisson contraction on a nonuniform adaptive mesh', () => {
  const problem = makePreset3D('cantilever3d', smallGrid, undefined, undefined, 'adaptiveTet4')
  const mesh = generateAdaptiveMesh3D(problem)
  expect(mesh.stats.levelCounts.every(n => n > 0)).toBe(true)
  const { tetrahedra, positions, neighbors } = mesh
  const { widthMm: L, heightMm: H, depthMm: D } = smallGrid
  const fixed = new Uint8Array(positions.length)
  const rhs = new Float64Array(positions.length)
  const F = 1700, stress = F / (H * D), strain = stress / problem.material.E0
  for (let i = 0; i < positions.length; i += 3) {
    const [x, y, z] = positions.subarray(i, i + 3)
    if (x === 0) fixed[i] = 1
    if (x === 0 && y === 0 && z === 0) fixed[i + 1] = 1
    if (x === 0 && z === 0) fixed[i + 2] = 1
  }
  neighbors.forEach((neighbor, f) => {
    if (neighbor >= 0) return
    const nodes = tetFaces[f % 4].map(j => tetrahedra[f - f % 4 + j])
    if (!nodes.every(node => positions[3 * node] === L)) return
    const [a, b, c] = nodes.map(node => 3 * node)
    const area = Math.abs((positions[b + 1] - positions[a + 1]) * (positions[c + 2] - positions[a + 2])
      - (positions[b + 2] - positions[a + 2]) * (positions[c + 1] - positions[a + 1])) / 2
    for (const node of nodes) rhs[3 * node] += stress * area / 3
  })
  expect(relative(rhs.reduce((sum, v) => sum + v, 0), F)).toBeLessThan(1e-12)
  const analysis = new Analysis3D({ ...problem, mesh }, fixed, [rhs])
  analysis.solve(new Float64Array(mesh.stats.elements).fill(1), 3, 1e-11)
  const [u] = analysis.displacements, { nu, E0 } = problem.material
  for (let i = 0; i < u.length; i += 3) {
    const [x, y, z] = positions.subarray(i, i + 3)
    for (const [d, expected] of [x * strain, -y * strain * nu, -z * strain * nu].entries()) {
      expect(expected ? relative(u[i + d], expected) : Math.abs(u[i + d] / (strain * L))).toBeLessThan(1e-5)
    }
  }
  const material = elasticity3D(E0, nu)
  const { B } = unstructuredTet4Element(positions, tetrahedra.subarray(0, 4), E0, nu)
  const local = Array.from(tetrahedra.subarray(0, 4)).flatMap(node => Array.from(u.subarray(3 * node, 3 * node + 3)))
  const sigmaXX = [0, 1, 2, 3, 4, 5].reduce((sum, r) =>
    sum + material[r] * local.reduce((eps, v, c) => eps + v * B[12 * r + c], 0), 0)
  expect(relative(sigmaXX, stress)).toBeLessThan(1e-5)
  expect(analysis.vonMises.every(value => relative(value, stress) < 1e-5)).toBe(true)
})

it('matches projected cone sensitivities and reduces compliance at the requested physical volume', () => {
  const params = { ...defaultParams3D, heaviside: true, maxIter: 8, changeTol: 0, rmin: 1.15 }
  const solver = new Simp3D(makePreset3D('cantilever3d', smallGrid, params, undefined, 'adaptiveTet4'))
  const { fixed, forces } = validateProblem3D(solver.problem)
  const analysis = new Analysis3D(solver.problem, fixed, forces)
  const mesh = solver.problem.mesh!
  const design = Float64Array.from(mesh.levels, (_, i) => 0.5 + 0.06 * Math.sin(i))
  const physical = new Float64Array(design.length)
  function evaluate() {
    const v = solver['density'](design, physical)
    return { v, c: analysis.solve(physical, params.penal, 1e-11).compliance }
  }
  evaluate()
  solver['sensitivities'](analysis.gradient)
  for (const e of [mesh.levels.indexOf(0), mesh.levels.indexOf(2)]) {
    const h = 1e-4
    design[e] += h
    const plus = evaluate()
    design[e] -= 2 * h
    const minus = evaluate()
    design[e] += h
    expect(relative(solver['dc'][e], (plus.c - minus.c) / (2 * h))).toBeLessThan(1e-4)
    expect(relative(solver['dv'][e], (plus.v - minus.v) / (2 * h))).toBeLessThan(1e-4)
  }
  const first = solver.step()
  let last = first
  while (!last.done) last = solver.step()
  expect(last.compliance).toBeLessThan(0.8 * first.compliance)
  expect(relative(last.volFrac, params.volFrac)).toBeLessThan(1e-7)
  expect(last.metrics.mass).toBeCloseTo(last.volFrac * 60 * 30 * 20 * solver.problem.material.densityKgM3 * 1e-6, 9)
}, 20000)

it('adapts around separate stress and density-interface zones and transfers density to the conforming mesh', () => {
  const grid = { ...smallGrid, nelx: 20, widthMm: 100 }
  const base = makePreset3D('cantilever3d', grid, undefined, undefined, 'adaptiveTet4')
  const problem = { ...base, supports: [], loadCases: [], adaptive: { refineLoads: false, refineFeatures: false, maxLevel: 2 as const } }
  const mesh = generateAdaptiveMesh3D(problem)
  const density = Float64Array.from(mesh.levels, (_, e) => mesh.centroids[3 * e] < 80 ? 0.75 : 0.25)
  const stress = Float64Array.from(mesh.levels, (_, e) => mesh.centroids[3 * e] < 10 ? 120 : 0)
  const next = generateAdaptiveMesh3D(problem, { mesh, density, vonMises: stress })
  expect(next.stats.elements).toBeGreaterThan(mesh.stats.elements)
  expect(next.levels.some((v, e) => v > 0 && next.centroids[3 * e] < 10)).toBe(true)
  expect(next.levels.some((v, e) => v > 0 && Math.abs(next.centroids[3 * e] - 80) < 8)).toBe(true)
  expect(next.levels.every((v, e) => v === 0 || Math.abs(next.centroids[3 * e] - 40) > 8)).toBe(true)
  const mapped = transferAdaptiveDensity3D(next, mesh, density)
  expect(mapped.every((v, e) => v === (next.centroids[3 * e] < 80 ? 0.75 : 0.25))).toBe(true)
  const varying = Float64Array.from(density, (_, e) => 0.5 + 0.4 * Math.sin(e))
  const transferred = transferAdaptiveDensity3D(next, mesh, varying)
  const integral = (m: AdaptiveMesh3D, field: Float64Array) => m.volumes.reduce((sum, v, e) => sum + v * field[e], 0)
  expect(relative(integral(next, transferred), integral(mesh, varying))).toBeLessThan(1e-12)
  const centroid = Float64Array.from(next.volumes, (_, e) => varying[locateAdaptiveTet3D(mesh, next.centroids, 3 * e)])
  expect(relative(integral(next, centroid), integral(mesh, varying))).toBeGreaterThan(1e-5)
  checkConformity(next, grid)
})

it('exports the smoothed thresholded Tet4 boundary as oriented, duplicate-free watertight STL and OBJ', () => {
  const problem = makePreset3D('boltBracket3d', boltGrid, undefined, undefined, 'adaptiveTet4')
  const mesh = generateAdaptiveMesh3D(problem)
  const density = Float64Array.from(mesh.bricks, (brick, e) => {
    const [, y, z] = mesh.centroids.subarray(3 * e, 3 * e + 3)
    return problem.passive?.void?.[brick] || y > 48 || z > 32 ? 0 : 0.8
  })
  const { surface, valid } = prepareCadSurface3D(density, boltGrid, 0.5, 4, undefined, 'adaptiveTet4', mesh)
  expect(valid).toEqual({ stl: true, obj: true })
  const { triangles, vertices } = surface
  const edges = new Map<string, number>()
  const faces = new Set<string>()
  let signed = 0
  for (let i = 0; i < triangles.length; i += 3) {
    const [a, b, c] = triangles.subarray(i, i + 3)
    signed += signedTriangleVolume6(vertices, a, b, c, 0)
    faces.add([a, b, c].sort((a, b) => a - b).join(','))
    for (const [v, w] of [[a, b], [b, c], [c, a]]) {
      const key = [Math.min(v, w), Math.max(v, w)].join(',')
      edges.set(key, (edges.get(key) ?? 0) + 1)
    }
  }
  expect(faces.size).toBe(triangles.length / 3)
  expect(signed).toBeGreaterThan(0)
  expect(Array.from(edges.values()).every(n => n === 2)).toBe(true)
  expect(new DataView(exportStl3D(surface)).getUint32(80, true)).toBe(faces.size)
  const obj = exportObj3D(surface, false, 50)
  expect(obj.match(/^f /gm)).toHaveLength(faces.size)
  expect(obj.match(/^vn /gm)).toHaveLength(triangles.length)
})

it.each(['hex8', 'tet4', 'adaptiveTet4'] as const)('shows only below-threshold %s cells in the ghost geometry', elementType => {
  const problem = makePreset3D('cantilever3d', smallGrid, undefined, undefined, elementType)
  const mesh = elementType === 'adaptiveTet4' ? generateAdaptiveMesh3D(problem) : undefined
  const values = new Float64Array(mesh?.stats.elements ?? elementCount(smallGrid, elementType)).fill(1)
  values[0] = 0.1
  const ghost = elementSurface3D(smallGrid, elementType, values, 0.5, true, mesh, true)
  expect(ghost.triangles.length).toBe(elementType === 'hex8' ? 36 : 12)
  expect(ghost.faceElements.every(e => e === 0)).toBe(true)
})

it('keeps adaptive controls and engineering tooltips localized in English, German and Russian', () => {
  const keys = ['adaptiveTet4Elements3d', 'adaptiveMeshing3d', 'adaptiveLoads3d', 'adaptiveFeatures3d', 'adaptiveDepth3d',
    'adaptiveLevelOne3d', 'adaptiveLevelTwo3d', 'generateMesh3d', 'adaptiveRefine3d', 'meshStats3d', 'meshNodes3d',
    'meshCoarse3d', 'meshMedium3d', 'meshFine3d', 'meshEdges3d', 'meshDensity3d', 'removedGhost3d', 'ghostOpacity3d',
    'hint3dAdaptiveLoads', 'hint3dAdaptiveFeatures', 'hint3dAdaptiveDepth', 'hint3dGenerateMesh', 'hint3dAdaptiveRefine',
    'hint3dMeshStats', 'hint3dMeshDensity', 'hint3dGhost', 'hint3dGhostOpacity', 'refining', 'adaptiveBudget3dError',
    'hint3dElementType', 'hint3dResolution', 'hint3dAdaptiveResolution'] as const
  for (const key of keys) {
    const words = Object.values(dictionaries).map(entry => entry[key].trim())
    expect(words.every(word => word.length > 0 && !word.includes('?'))).toBe(true)
    expect(new Set(words).size).toBe(3)
  }
})

it('preserves both symmetry planes, passive masks and stability under multiple tiny-load cases', () => {
  const params = { ...defaultParams3D, symmetry: 'yz' as const, rmin: 0.9 }
  const problem = makePreset3D('cantilever3d', smallGrid, params, undefined, 'adaptiveTet4')
  problem.loadCases = [{ id: 'y', forces: [{ node: nodeIndex3D(smallGrid, 12, 3, 2), fx: 0, fy: -1e-6, fz: 0 }] },
    { id: 'z', forces: [{ node: nodeIndex3D(smallGrid, 12, 3, 2), fx: 0, fy: 0, fz: 1e-6 }] }]
  problem.passive!.solid![0] = 1
  problem.passive!.void![50] = 1
  const solver = new Simp3D(problem)
  const { representatives, solid, voidMask } = validateProblem3D(solver.problem)
  const snapshot = solver.step()
  expect(snapshot.displacements).toHaveLength(2)
  expect(snapshot.compliance).toBeGreaterThan(0)
  expect(snapshot.density.every((rho, e) => rho === snapshot.density[representatives[e]]
    && (!solid[e] || rho === 1) && (!voidMask[e] || rho === 0))).toBe(true)
})

it.each([
  { contact: 'vertex', offset: [1, 1, 1] },
  { contact: 'edge', offset: [1, 1, 0] },
  { contact: 'face', offset: [1, 0, 0] },
])('checks rigid modes for two bricks touching at a $contact', ({ contact, offset: [x, y, z] }) => {
  const grid = { nelx: 2, nely: 2, nelz: 2, widthMm: 10, heightMm: 10, depthMm: 10 }
  const problem = makePreset3D('cantilever3d', grid, { ...defaultParams3D, volFrac: 0.2 }, undefined, 'adaptiveTet4')
  problem.adaptive = { refineLoads: false, refineFeatures: false, maxLevel: 1 }
  problem.passive!.void!.fill(1)
  problem.passive!.void![0] = 0
  problem.passive!.void![elementIndex(grid, x, y, z)] = 0
  problem.supports = problem.supports.filter(s => {
    const [, y, z] = nodePosition(grid, s.node)
    return y <= 5 && z <= 5
  })
  problem.loadCases = [{ id: 'test', forces: [{ node: nodeIndex3D(grid, 2, y + 1, z + 1), fx: 0, fy: -10, fz: 0 }] }]
  const mesh = generateAdaptiveMesh3D(problem)
  if (contact === 'face') {
    expect(() => unstructuredSetup3D(problem, mesh)).not.toThrow()
    expect(() => validateProblem3D({ ...problem, mesh })).not.toThrow()
  } else {
    expect(() => unstructuredSetup3D(problem, mesh)).toThrow('componentSupport3dError')
    expect(() => validateProblem3D({ ...problem, mesh })).toThrow('componentSupport3dError')
    // The second body can be stabilized by its own supports.
    for (const node of [[2, y, z], [2, y + 1, z], [2, y, z + 1]]) {
      problem.supports = [...problem.supports, { node: nodeIndex3D(grid, node[0], node[1], node[2]), fixX: true, fixY: true, fixZ: true }]
    }
    expect(() => unstructuredSetup3D(problem, mesh)).not.toThrow()
  }
})

it('keeps every adaptive stress sample on the material side of a passive-void boundary after smoothing', () => {
  const problem = makePreset3D('cantilever3d', smallGrid, undefined, undefined, 'adaptiveTet4')
  const voidMask = problem.passive!.void!
  voidMask.forEach((_, e) => { voidMask[e] = Number(e % smallGrid.nelx >= smallGrid.nelx / 2) })
  const mesh = generateAdaptiveMesh3D(problem)
  const density = new Float64Array(mesh.stats.elements).fill(0.8)
  const { surface, valid } = prepareCadSurface3D(density, smallGrid, 0.5, 2, problem.passive, 'adaptiveTet4', mesh)
  expect(valid).toEqual({ obj: true, stl: true })
  expect(surface.faceElements).toHaveLength(surface.triangles.length / 3)
  let voidSideCorners = 0
  surface.triangles.forEach((node, corner) => {
    const relocated = locateAdaptiveTet3D(mesh, surface.vertices, 3 * node)
    if (voidMask[mesh.bricks[relocated]]) voidSideCorners++
    expect(voidMask[mesh.bricks[surface.faceElements![Math.floor(corner / 3)]]]).toBe(0)
  })
  expect(voidSideCorners).toBeGreaterThan(0)
})

it('bounds both the initial Tet4 extraction and the additional facets from contact trimming', () => {
  const problem = makePreset3D('cantilever3d', smallGrid, undefined, undefined, 'adaptiveTet4')
  const mesh = generateAdaptiveMesh3D(problem)
  const first = new Set(mesh.tetrahedra.subarray(0, 4))
  const other = mesh.levels.findIndex((_, e) =>
    mesh.tetrahedra.subarray(4 * e, 4 * e + 4).filter(node => first.has(node)).length === 1)
  expect(other).toBeGreaterThan(0)
  const density = new Float64Array(mesh.stats.elements)
  density[0] = density[other] = 1
  const full = marchingTetrahedra(density, smallGrid, 0.5, undefined, mesh)
  expect(full.triangles.length / 3).toBeGreaterThan(8)
  expect(() => marchingTetrahedra(density, smallGrid, 0.5, undefined, mesh, 7)).toThrow(CadTriangleBudgetError)
  expect(() => marchingTetrahedra(density, smallGrid, 0.5, undefined, mesh, 8)).toThrow(CadTriangleBudgetError)
})

it.each(['hex8', 'tet4', 'adaptiveTet4'] as const)('deduplicates shared solid and ghost %s wireframe edges', elementType => {
  const mesh = elementType === 'adaptiveTet4'
    ? generateAdaptiveMesh3D(makePreset3D('cantilever3d', smallGrid, undefined, undefined, elementType))
    : undefined
  const perBrick = elementType === 'tet4' ? 5 : 1
  const density = Float64Array.from({ length: mesh?.stats.elements ?? elementCount(smallGrid, elementType) },
    (_, e) => Number((mesh?.bricks[e] ?? Math.floor(e / perBrick)) % smallGrid.nelx < smallGrid.nelx / 2))
  const solid = elementSurface3D(smallGrid, elementType, density, 0.5, true, mesh)
  const ghost = elementSurface3D(smallGrid, elementType, density, 0.5, true, mesh, true)
  const combined = elementSurface3D(smallGrid, elementType, density, 0.5, true, mesh, true, solid.edges)
  function keys(edges: Uint32Array) {
    const result = new Set<string>()
    for (let i = 0; i < edges.length; i += 2) result.add(edges.slice(i, i + 2).sort().join(','))
    return result
  }
  const solidKeys = keys(solid.edges)
  expect([...keys(ghost.edges)].some(key => solidKeys.has(key))).toBe(true)
  expect(keys(combined.edges)).toEqual(new Set([...keys(ghost.edges)].filter(key => !solidKeys.has(key))))
  expect(combined.triangles).toEqual(ghost.triangles)
})

it('checks each loaded island independently of disconnected unloaded material', () => {
  const grid = { nelx: 6, nely: 2, nelz: 2, widthMm: 30, heightMm: 10, depthMm: 10 }
  const problem = makePreset3D('cantilever3d', grid, { ...defaultParams3D, volFrac: 0.06 }, undefined, 'adaptiveTet4')
  problem.passive!.void!.fill(1)
  problem.passive!.void![0] = problem.passive!.void![4] = 0
  problem.supports = problem.supports.filter(s => {
    const [, y, z] = nodePosition(grid, s.node)
    return y <= 5 && z <= 5
  })
  const load = (x: number) => [{ id: 'test', forces: [{ node: nodeIndex3D(grid, x, 0, 0), fx: 0, fy: -10, fz: 0 }] }]
  problem.loadCases = load(1)
  const mesh = generateAdaptiveMesh3D(problem)
  expect(() => unstructuredSetup3D(problem, mesh)).not.toThrow()
  // The old grid node x=4 is already a reference-aligned mesh corner.
  problem.loadCases = load(4)
  expect(() => unstructuredSetup3D(problem, mesh)).toThrow('componentSupport3dError')
})

it('guards tetrahedron count and retained typed-array memory before solver allocation', () => {
  const problem = makePreset3D('cantilever3d', smallGrid, undefined, undefined, 'adaptiveTet4')
  expect(() => generateAdaptiveMesh3D({ ...problem, grid: { ...smallGrid, nelx: 200, nely: 200, nelz: 200 } }))
    .toThrow('adaptiveBudget3dError')
  const mesh = generateAdaptiveMesh3D(problem)
  expect(() => preflightAdaptiveSolver3D(problem, mesh, 512 * 1024 ** 2)).toThrow('adaptiveBudget3dError')
})

it.each(['cantilever3d', 'boltBracket3d', 'archBridge3d', 'lBracket3d'] as const)(
  'keeps the default coarse adaptive %s preset within budget', preset => {
    const problem = makePreset3D(preset, boltGrid, undefined, undefined, 'adaptiveTet4')
    const mesh = generateAdaptiveMesh3D(problem)
    expect(() => preflightAdaptiveSolver3D(problem, mesh)).not.toThrow()
  })
