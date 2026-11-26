import { expect, it } from 'vitest'
import { exportObj3D, exportStl3D, isWatertight } from '../export3d'
import { marchingCubes, taubinSmooth, triangleNormal } from '../marchingCubes'
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
  expect(obj.match(/^vn /gm)).toHaveLength(surface.vertices.length / 3)
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
