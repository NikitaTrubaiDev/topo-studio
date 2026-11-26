import { expect, it } from 'vitest'
import { elasticity3D, h8Corners } from '../elementH8'
import { tet4Templates, tetCorners, tetFaces, tetVolumeFraction } from '../elementT4'
import { exportObj3D, exportStl3D, isWatertight } from '../export3d'
import { extractSurface3D, signedTriangleVolume6 } from '../marchingCubes'
import { elementSurface3D } from '../mesh3d'
import { defaultParams3D, makePreset3D, presetGrid3D, presets3D, resolutions3D } from '../presets3d'
import { Analysis3D, Simp3D, validateProblem3D } from '../simp3d'
import { cellSize, elementCount, elementIndex, nodeCount, nodeIndex3D, nodePosition } from '../types3d'

const grid = { nelx: 4, nely: 3, nelz: 2, widthMm: 8, heightMm: 9, depthMm: 8 }
const templates = tet4Templates(123, 0.32, ...cellSize(grid))
const relative = (actual: number, expected: number) => Math.abs(actual / expected - 1)

it('fills a 4×3×2 brick grid with positive tetrahedra and matching opposite internal faces', () => {
  const faces = new Map<string, number[]>()
  const { nelx, nely, nelz } = grid
  for (let z = 0; z < nelz; z++) for (let y = 0; y < nely; y++) for (let x = 0; x < nelx; x++) {
    const parity = (x + y + z) & 1
    let volume = 0
    for (let t = 0; t < 5; t++) {
      const nodes = tetCorners[parity][t].map(c => {
        const [i, j, k] = h8Corners[c]
        return nodeIndex3D(grid, x + i, y + j, z + k)
      })
      const actual = templates[5 * parity + t].volume
      expect(actual).toBe(t === 0 ? 8 : 4)
      volume += actual
      for (const face of tetFaces) {
        const [a, b, c] = face.map(i => nodes[i])
        const key = [a, b, c].sort((i, j) => i - j).join(',')
        const sign = (a > b ? -1 : 1) * (a > c ? -1 : 1) * (b > c ? -1 : 1)
        const shared = faces.get(key) ?? []
        shared.push(sign)
        faces.set(key, shared)
      }
    }
    expect(volume).toBe(24)
  }
  let boundary = 0
  for (const [key, sides] of faces) {
    const points = key.split(',').map(node => nodePosition(grid, Number(node)))
    const exterior = [grid.widthMm, grid.heightMm, grid.depthMm].some((length, axis) =>
      [0, length].some(plane => points.every(p => p[axis] === plane)))
    if (exterior) {
      expect(sides).toHaveLength(1)
      boundary++
    } else {
      expect(sides).toHaveLength(2)
      expect(sides[0]).toBe(-sides[1])
    }
  }
  expect(boundary).toBe(4 * (nelx * nely + nelx * nelz + nely * nelz))
})

it.each(templates.map(({ Ke }, i) => ({ Ke, i })))('has six rigid modes and six positive modes in Tet4 template $i', ({ Ke, i }) => {
  const dims = cellSize(grid)
  const modes = Array.from({ length: 6 }, (_, mode) => tetCorners[Math.floor(i / 5)][i % 5].flatMap(corner => {
    const [x, y, z] = h8Corners[corner].map((a, d) => a * dims[d])
    return [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0, -z, y], [z, 0, -x], [-y, x, 0]][mode]
  }))
  for (let r = 0; r < 12; r++) {
    for (let c = 0; c < 12; c++) expect(Ke[12 * r + c]).toBe(Ke[12 * c + r])
    for (const mode of modes) expect(Math.abs(mode.reduce((sum, v, c) => sum + v * Ke[12 * r + c], 0))).toBeLessThan(1e-11)
  }
  const A = Array.from({ length: 12 }, (_, r) => Array.from(Ke.slice(r * 12, r * 12 + 12)))
  while (A.length > 6) {
    const p = A.reduce((max, row, r) => row[r] > A[max][max] ? r : max, 0)
    const column = A.splice(p, 1)[0]
    const [pivot] = column.splice(p, 1)
    expect(pivot).toBeGreaterThan(1)
    for (let r = 0; r < A.length; r++) {
      A[r].splice(p, 1)
      for (let c = 0; c < A.length; c++) A[r][c] -= column[r] * column[c] / pivot
    }
  }
  expect(Math.max(...A.flat().map(Math.abs))).toBeLessThan(1e-10)
})

it('recovers exact Tet4 uniaxial stress, extension and Poisson contractions under consistent face traction', () => {
  const problem = makePreset3D('cantilever3d', grid, undefined, undefined, 'tet4')
  const stress = 10, strain = stress / problem.material.E0
  const { nelx, nely, nelz } = grid
  const [, hy, hz] = cellSize(grid)
  const rhs = new Float64Array(nodeCount(grid))
  for (let z = 0; z < nelz; z++) for (let y = 0; y < nely; y++) {
    for (const tet of tetCorners[(nelx - 1 + y + z) & 1]) for (const face of tetFaces) {
      const corners = face.map(i => h8Corners[tet[i]])
      if (!corners.every(([x]) => x === 1)) continue
      for (const [, dy, dz] of corners) rhs[nodeIndex3D(grid, nelx, y + dy, z + dz)] += stress * hy * hz / 6
    }
  }
  const supports = [], forces = []
  for (let z = 0; z <= nelz; z++) for (let y = 0; y <= nely; y++) {
    supports.push({ node: nodeIndex3D(grid, 0, y, z), fixX: true, fixY: y === 0 && z === 0, fixZ: z === 0 })
    const node = nodeIndex3D(grid, nelx, y, z)
    forces.push({ node, fx: rhs[node], fy: 0, fz: 0 })
  }
  expect(rhs.reduce((a, b) => a + b, 0)).toBe(stress * grid.heightMm * grid.depthMm)
  const tension = { ...problem, supports, loadCases: [{ id: 'tension', forces }] }
  const { fixed, forces: loads } = validateProblem3D(tension)
  const analysis = new Analysis3D(tension, fixed, loads)
  analysis.solve(new Float64Array(elementCount(grid, 'tet4')).fill(1), 3, 1e-10)
  const [u] = analysis.displacements
  const { E0, nu } = problem.material
  for (let n = 0; n < rhs.length; n++) {
    const [x, y, z] = nodePosition(grid, n)
    for (const [i, expected] of [x * strain, -y * strain * nu, -z * strain * nu].entries()) {
      expect(expected ? relative(u[3 * n + i], expected) : Math.abs(u[3 * n + i] / (strain * grid.widthMm))).toBeLessThan(1e-5)
    }
  }
  const D = elasticity3D(E0, nu)
  const B = templates[0].B
  const local = tetCorners[0][0].flatMap(corner => {
    const [x, y, z] = h8Corners[corner]
    const d = 3 * nodeIndex3D(grid, x, y, z)
    return Array.from(u.slice(d, d + 3))
  })
  const sigmaXX = [0, 1, 2, 3, 4, 5].reduce((sum, r) =>
    sum + D[r] * local.reduce((eps, v, c) => eps + v * B[12 * r + c], 0), 0)
  expect(relative(sigmaXX, stress)).toBeLessThan(1e-5)
  for (const actual of analysis.vonMises) expect(relative(actual, stress)).toBeLessThan(1e-5)
})

it('matches filtered and projected Tet4 compliance and volume sensitivities to finite differences', () => {
  const params = { ...defaultParams3D, symmetry: 'z' as const, heaviside: true }
  const problem = makePreset3D('cantilever3d', grid, params, undefined, 'tet4')
  const solver = new Simp3D(problem)
  const { forces, fixed, representatives } = validateProblem3D(problem)
  const analysis = new Analysis3D(problem, fixed, forces)
  const design = Float64Array.from(representatives, rep => 0.46 + 0.08 * Math.sin(rep / 11))
  const density = new Float64Array(design.length)
  const run = () => {
    const volume = solver['density'](design, density)
    return { volume, compliance: analysis.solve(density, params.penal, 1e-11).compliance }
  }
  run()
  solver['sensitivities'](analysis.gradient)
  for (const rep of [10, 11]) {
    const h = 1e-5
    const dc = solver['dc'][rep], dv = solver['dv'][rep]
    function perturb(delta: number) {
      for (let e = 0; e < design.length; e++) if (representatives[e] === rep) design[e] += delta
    }
    perturb(h)
    const plus = run()
    perturb(-2 * h)
    const minus = run()
    perturb(h)
    expect(relative(dc, (plus.compliance - minus.compliance) / (2 * h))).toBeLessThan(1e-4)
    expect(relative(dv, (plus.volume - minus.volume) / (2 * h))).toBeLessThan(1e-4)
  }
  expect(solver['dv'][10]).toBeGreaterThan(solver['dv'][11])
})

it.each(['y', 'z', 'yz'] as const)('maintains Tet4 volume, masks, and %s symmetry as SIMP reduces compliance', symmetry => {
  const params = { ...defaultParams3D, symmetry, heaviside: true, changeTol: 0, maxIter: 7 }
  const problem = makePreset3D('cantilever3d', grid, params, undefined, 'tet4')
  problem.passive!.solid![elementIndex(grid, 0, 1, 0)] = 1
  problem.passive!.void![elementIndex(grid, 1, 1, 0)] = 1
  const solver = new Simp3D(problem), setup = validateProblem3D(problem)
  const first = solver.step()
  let last = first
  while (!last.done) last = solver.step()
  expect(last.compliance).toBeLessThan(first.compliance)
  expect(last.volFrac).toBeCloseTo(params.volFrac, 7)
  const weighted = last.density.reduce((sum, v, e) => sum + v * tetVolumeFraction(e % 5), 0)
  expect(last.metrics.mass).toBeCloseTo(weighted * 24 * problem.material.densityKgM3 * 1e-6, 10)
  last.density.forEach((v, e) => {
    expect(v).toBe(last.density[setup.representatives[e]])
    if (setup.solid[e]) expect(v).toBe(1)
    if (setup.voidMask[e]) expect(v).toBe(0)
  })
  if (symmetry === 'z') {
    // Reflect a corner tet across Z explicitly, passing through the parity change.
    const firstCorner = 1
    const reflectedCorner = tetCorners[0][firstCorner][0] ^ 4
    const t = tetCorners[1].findIndex(nodes => nodes[0] === reflectedCorner)
    expect(last.density[firstCorner]).toBe(last.density[5 * elementIndex(grid, 0, 0, 1) + t])
    expect(new Set(last.density.slice(0, 5)).size).toBeGreaterThan(1)
  }
})

it.each(['hex8', 'tet4'] as const)('renders only exposed %s faces and original element edges', elementType => {
  const brick = { ...grid, nelx: 1, nely: 1, nelz: 1 }
  const density = new Float64Array(elementCount(brick, elementType)).fill(1)
  const full = elementSurface3D(brick, elementType, density, 0.5, true)
  expect(full.triangles.length / 3).toBe(12)
  expect(full.edges.length / 2).toBe(elementType === 'tet4' ? 18 : 12)
  if (elementType === 'tet4') {
    density.fill(0)
    density[0] = 0.5
    const central = elementSurface3D(brick, elementType, density, 0.5, true)
    expect(central.triangles).toHaveLength(12)
    expect(central.edges).toHaveLength(12)
  }
})

it.each(['hex8', 'tet4'] as const)('exports a smoothed closed outward %s surface at STL precision', elementType => {
  const grid = presetGrid3D([12, 8, 6])
  const perBrick = elementType === 'tet4' ? 5 : 1
  const density = Float64Array.from({ length: elementCount(grid, elementType) }, (_, e) => {
    const brick = Math.floor(e / perBrick)
    const y = Math.floor(brick / grid.nelx) % grid.nely, z = Math.floor(brick / (grid.nelx * grid.nely))
    return Math.abs(y - 3) + Math.abs(z - 3) <= 3 ? 0.85 - 0.04 * (e % perBrick) : 0.2
  })
  const mesh = extractSurface3D(density, grid, 0.5, 4, undefined, elementType)
  expect(isWatertight(mesh, true)).toBe(true)
  const { vertices, triangles } = mesh
  let signed = 0
  for (let i = 0; i < triangles.length; i += 3) signed += signedTriangleVolume6(vertices, triangles[i], triangles[i + 1], triangles[i + 2], 0)
  expect(signed / 6).toBeGreaterThan(0)
  expect(new DataView(exportStl3D(mesh)).getUint32(80, true)).toBe(triangles.length / 3)
  expect(exportObj3D(mesh)).toContain('\nf ')
})

it.each(presets3D)('validates Tet4 preset %s on 64×32×20', preset => {
  const high = resolutions3D[3]
  expect(high).toEqual([64, 32, 20])
  const grid = presetGrid3D(high)
  const problem = makePreset3D(preset, grid, undefined, undefined, 'tet4')
  const setup = validateProblem3D(problem)
  expect(setup.solid).toHaveLength(204800)
  expect(setup.fixed).toHaveLength(3 * 65 * 33 * 21)
})

it('closes Tet4 material across all six domain planes and orients an internal cavity', () => {
  const grid = presetGrid3D([8, 8, 8])
  const density = new Float64Array(elementCount(grid, 'tet4')).fill(1)
  for (let z = 2; z < 6; z++) for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) {
    const e = 5 * elementIndex(grid, x, y, z)
    density.fill(0, e, e + 5)
  }
  const mesh = extractSurface3D(density, grid, 0.5, 4, undefined, 'tet4')
  expect(isWatertight(mesh, true)).toBe(true)
  for (const [axis, size] of [grid.widthMm, grid.heightMm, grid.depthMm].entries()) {
    expect(mesh.vertices.some((v, i) => i % 3 === axis && v === 0)).toBe(true)
    expect(mesh.vertices.some((v, i) => i % 3 === axis && v === size)).toBe(true)
  }
})
