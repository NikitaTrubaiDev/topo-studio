import { expect, it } from 'vitest'
import { exportObj3D, exportStl3D, isWatertight } from '../export3d'
import { extractSurface3D, marchingCubes, taubinSmooth, triangleNormal, vertexNormals, type Surface3D } from '../marchingCubes'
import { makePreset3D, presetGrid3D, resolutions3D } from '../presets3d'
import { Simp3D } from '../simp3d'
import { elementCount, elementIndex, type Grid3D } from '../types3d'

const grid: Grid3D = { nelx: 12, nely: 12, nelz: 12, widthMm: 30, heightMm: 30, depthMm: 30 }

it.each(['block', 'sphere'] as const)('closes a padded %s and exports valid STL and OBJ', shape => {
  const density = new Float64Array(elementCount(grid))
  for (let z = 0; z < grid.nelz; z++) for (let y = 0; y < grid.nely; y++) for (let x = 0; x < grid.nelx; x++) {
    density[elementIndex(grid, x, y, z)] = shape === 'block' ? 1
      : Math.max(0, 1 - Math.hypot(x - 5.5, y - 5.5, z - 5.5) / 9)
  }
  const raw = marchingCubes(density, grid, 0.55)
  const surface = taubinSmooth(raw, grid, 4)
  expect(isWatertight(raw, true)).toBe(true)
  expect(isWatertight(surface, true)).toBe(true)
  expect(surface.vertices.some((value, i) => value !== raw.vertices[i])).toBe(true)
  for (let i = 0; i < raw.vertices.length; i++) {
    if ([0, 30].includes(raw.vertices[i])) expect(surface.vertices[i]).toBe(raw.vertices[i])
  }
  if (shape === 'block') {
    for (let d = 0; d < 3; d++) {
      expect(surface.vertices.some((value, i) => i % 3 === d && value === 0)).toBe(true)
      expect(surface.vertices.some((value, i) => i % 3 === d && value === 30)).toBe(true)
    }
  }
  const count = surface.triangles.length / 3
  const stl = exportStl3D(surface)
  expect(stl.byteLength).toBe(84 + 50 * count)
  const data = new DataView(stl)
  expect(data.getUint32(80, true)).toBe(count)
  for (let j = 0; j < count; j++) {
    const offset = 84 + j * 50
    const normal = [0, 1, 2].map(d => data.getFloat32(offset + 4 * d, true))
    expect(normal.every(Number.isFinite)).toBe(true)
    expect(Math.hypot(...normal)).toBeCloseTo(1, 6)
    const outward = normal.reduce((dot, value, d) => dot + value *
      (([0, 1, 2].reduce((sum, v) => sum + data.getFloat32(offset + 12 + 12 * v + 4 * d, true), 0) / 3) - 15), 0)
    expect(outward).toBeGreaterThan(0)
  }
  const obj = exportObj3D(surface)
  expect(obj.match(/^v /gm)).toHaveLength(surface.vertices.length / 3)
  const normals = obj.match(/^vn .*$/gm)!
  expect(normals).toHaveLength(surface.vertices.length / 3)
  for (const normal of normals) expect(Math.hypot(...normal.slice(3).split(' ').map(Number))).toBeCloseTo(1, 10)
  expect(obj.match(/^f \d+\/\/\d+ \d+\/\/\d+ \d+\/\/\d+$/gm)).toHaveLength(count)
})

it('resolves checkerboard faces consistently and handles samples equal to the threshold', () => {
  const density = Float64Array.from({ length: elementCount(grid) }, (_, i) => {
    const x = i % grid.nelx, y = Math.floor(i / grid.nelx) % grid.nely, z = Math.floor(i / (grid.nelx * grid.nely))
    return (x + y + z) % 2 ? 0.5 : 0
  })
  const mesh = marchingCubes(density, grid)
  expect(isWatertight(mesh, true)).toBe(true)
  expect(isWatertight(taubinSmooth(mesh, grid, 3), true)).toBe(true)
  expect(triangleNormal(mesh.vertices, mesh.triangles[0], mesh.triangles[1], mesh.triangles[2]).some(Boolean)).toBe(true)
})

it('refuses open surfaces and empty exports', () => {
  const mesh = marchingCubes(new Float64Array(elementCount(grid)), grid)
  expect(mesh.triangles).toHaveLength(0)
  expect(() => exportStl3D(mesh)).toThrow(/watertight/)
  expect(() => exportObj3D(mesh)).toThrow(/watertight/)
})

function reverse({ vertices, triangles }: Surface3D) {
  return { vertices, triangles: triangles.map((index, i) => i % 3 === 0 ? index : triangles[i + (i % 3 === 1 ? 1 : -1)]) }
}

it('rejects an inverted outer shell even beside a larger outward shell', () => {
  const outer = marchingCubes(new Float64Array(elementCount(grid)).fill(1), grid)
  expect(() => exportStl3D(reverse(outer))).toThrow(/watertight/)
  const smallGrid = { nelx: 1, nely: 1, nelz: 1, widthMm: 1, heightMm: 1, depthMm: 1 }
  const flipped = reverse(marchingCubes(Float64Array.of(1), smallGrid))
  const vertices = Float64Array.from([...outer.vertices, ...flipped.vertices.map(value => value + 40)])
  const triangles = Uint32Array.from([...outer.triangles, ...flipped.triangles.map(value => value + outer.vertices.length / 3)])
  expect(isWatertight({ vertices, triangles }, true)).toBe(false)
})

it('accepts inward cavity walls and outward material islands nested inside them', () => {
  const density = new Float64Array(elementCount(grid)).fill(1)
  for (let z = 3; z < 9; z++) for (let y = 3; y < 9; y++) for (let x = 3; x < 9; x++) {
    density[elementIndex(grid, x, y, z)] = Number([x, y, z].every(value => value >= 5 && value <= 6))
  }
  const surface = extractSurface3D(density, grid)
  expect(isWatertight(surface, true)).toBe(true)
  expect(() => exportStl3D(reverse(surface))).toThrow(/watertight/)
})

it('uses an incident facet normal when the area-weighted vertex normals cancel', () => {
  const mesh = { vertices: Float64Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, -2, 0, 0, 0, 0.5, 0, 0, 0, 1),
    triangles: Uint32Array.of(0, 1, 2, 0, 3, 4) }
  const normals = vertexNormals(mesh)
  expect(Array.from(normals.slice(0, 3))).toEqual([0, 0, 1])
  expect(Array.from(normals.slice(-3))).toEqual([0, 0, 1])
})

it('preserves more than 95% of a one-cell strut volume and caps smoothing at 12 passes', () => {
  const strutGrid = { nelx: 14, nely: 3, nelz: 3, widthMm: 14, heightMm: 3, depthMm: 3 }
  const density = new Float64Array(elementCount(strutGrid))
  for (let x = 1; x <= 12; x++) density[elementIndex(strutGrid, x, 1, 1)] = 1
  const raw = marchingCubes(density, strutGrid)
  function volume({ vertices, triangles }: Surface3D) {
    let result = 0
    for (let i = 0; i < triangles.length; i += 3) {
      const normal = triangleNormal(vertices, triangles[i], triangles[i + 1], triangles[i + 2])
      result += normal.reduce((sum, value, d) => sum + value * vertices[3 * triangles[i] + d], 0) / 6
    }
    return result
  }
  const standard = extractSurface3D(density, strutGrid)
  const maximum = taubinSmooth(raw, strutGrid, 12)
  for (const mesh of [standard, maximum]) {
    expect(volume(mesh) / volume(raw)).toBeGreaterThan(0.95)
    expect(isWatertight(mesh, true)).toBe(true)
  }
  expect(taubinSmooth(raw, strutGrid, 50).vertices).toEqual(maximum.vertices)
})

it('preserves the inside diameter of all four prescribed bolt bores at 12 passes', () => {
  const bracketGrid = presetGrid3D(resolutions3D[0])
  const problem = makePreset3D('boltBracket3d', bracketGrid)
  const density = new Simp3D(problem).initialDensity()
  const raw = marchingCubes(density, bracketGrid)
  const smooth = extractSurface3D(density, bracketGrid, 0.5, 12, problem.passive)
  function boreDiameter({ vertices, triangles }: Surface3D, x: number, y: number, centerZ: number) {
    const crossings = []
    for (let i = 0; i < triangles.length; i += 3) {
      const [a, b, c] = Array.from(triangles.subarray(i, i + 3), vertex => 3 * vertex)
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
  for (const y of [15, 45]) for (const z of [10, 30]) {
    expect(boreDiameter(raw, 6.25, y - 0.25, z)).toBeCloseTo(10, 10)
    expect(boreDiameter(smooth, 6.25, y - 0.25, z)).toBeCloseTo(10, 10)
  }
})

it.each([0, undefined])('preserves a connected one-cell Tet4 strut at %s smoothing passes', passes => {
  const strutGrid = { nelx: 14, nely: 3, nelz: 3, widthMm: 14, heightMm: 3, depthMm: 3 }
  const density = new Float64Array(elementCount(strutGrid, 'tet4'))
  for (let x = 1; x <= 12; x++) {
    const e = 5 * elementIndex(strutGrid, x, 1, 1)
    density.fill(1, e, e + 5)
  }
  const mesh = extractSurface3D(density, strutGrid, 0.5, passes, undefined, 'tet4')
  expect(mesh.triangles.length / 3).toBe(100)
  const links = Array.from({ length: mesh.vertices.length / 3 }, () => new Set<number>())
  for (let i = 0; i < mesh.triangles.length; i += 3) {
    const face = mesh.triangles.subarray(i, i + 3)
    for (const a of face) for (const b of face) links[a].add(b)
  }
  const reached = new Set([0])
  for (const vertex of reached) for (const neighbor of links[vertex]) reached.add(neighbor)
  expect(reached.size).toBe(links.length)
  expect(isWatertight(mesh, true)).toBe(true)
  expect(new DataView(exportStl3D(mesh)).getUint32(80, true)).toBe(100)
  expect(exportObj3D(mesh).match(/^f /gm)).toHaveLength(100)
})

it('keeps all four outward faces of a single Tet4 exactly at the threshold', () => {
  const cell = { nelx: 1, nely: 1, nelz: 1, widthMm: 2, heightMm: 3, depthMm: 4 }
  const mesh = extractSurface3D(Float64Array.of(0.5, 0, 0, 0, 0), cell, 0.5, 0, undefined, 'tet4')
  expect(mesh.vertices).toHaveLength(12)
  expect(mesh.triangles).toHaveLength(12)
  expect(isWatertight(mesh, true)).toBe(true)
})

it('keeps seed-23 Tet4 material exportable before and after smoothing', () => {
  const randomGrid = { nelx: 12, nely: 8, nelz: 8, widthMm: 24, heightMm: 24, depthMm: 32 }
  let seed = 23
  const density = Float64Array.from({ length: elementCount(randomGrid, 'tet4') }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 2 ** 32
  })
  for (const passes of [0, 1, 4]) {
    const mesh = extractSurface3D(density, randomGrid, 0.5, passes, undefined, 'tet4')
    const count = mesh.triangles.length / 3
    expect(count).toBeGreaterThan(0)
    expect(new DataView(exportStl3D(mesh)).getUint32(80, true)).toBe(count)
    expect(exportObj3D(mesh).match(/^f /gm)).toHaveLength(count)
  }
})

it('keeps the last valid surface when smoothing would move an outer wall through a cavity', () => {
  const vertices = Float64Array.of(
    1, 1, 1, 5, 1, 1, 1, 5, 1, 5, 5, 1,
    1, 1, 5, 5, 1, 5, 1, 5, 5, 5, 5, 5,
    1.001, 1.1, 1.18, 1.003, 1.1, 1.18, 1.001, 1.11, 1.18, 1.001, 1.1, 1.19,
  )
  const triangles = Uint32Array.of(
    0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6,
    0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3,
    0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5,
    9, 11, 10, 8, 10, 11, 8, 11, 9, 8, 9, 10,
  )
  const pinned = Uint8Array.from({ length: 12 }, (_, i) => Number(i !== 0))
  const mesh = { vertices, triangles, pinned }
  const proposed = vertices.slice()
  proposed.fill(1.015, 0, 3)
  expect(isWatertight({ ...mesh, vertices: proposed }, true)).toBe(false)
  expect(isWatertight(mesh, true)).toBe(true)
  const limits = { nelx: 10, nely: 10, nelz: 10, widthMm: 10, heightMm: 10, depthMm: 10 }
  const smooth = taubinSmooth(mesh, limits, 1, 0.5, 0)
  expect(smooth.vertices).toEqual(mesh.vertices)
})
