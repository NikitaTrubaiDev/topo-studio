import { expect, it } from 'vitest'
import { extractContours, signedArea, type ContourLoop } from '../contour'
import { exportDxf, exportStl, exportSvg } from '../export'

const grid = { nelx: 28, nely: 20, cellSizeMm: 0.75 }
const field = Float64Array.from({ length: grid.nelx * grid.nely }, (_, i) =>
  Number(Math.hypot(i % grid.nelx + 0.5 - 14, Math.floor(i / grid.nelx) + 0.5 - 10) >= 4))
const loops = extractContours(field, grid, 0.5, 4)

it('exports an even-odd SVG path with physical units, Y inversion, and one close per ring', () => {
  const svg = exportSvg(loops, grid)
  expect(svg).toContain('width="21mm" height="15mm" viewBox="0 0 21 15"')
  expect(svg).toContain('fill-rule="evenodd"')
  expect(svg.match(/ Z/g)).toHaveLength(2)
  expect(svg).not.toMatch(/NaN|Infinity/)
  expect(exportSvg([{ points: [[0, 1], [1, 1], [1, 2]], parent: -1, hole: false }], grid)).toContain('M0 14.25')
})

it('exports closed LWPOLYLINE entities on the contour layer with finite mm coordinates', () => {
  const dxf = exportDxf(loops, grid).trimEnd().split(/\r?\n/)
  expect(dxf.slice(-2)).toEqual(['0', 'EOF'])
  expect(dxf.join('\n')).toContain('$INSUNITS\n70\n4')
  const layerTable = dxf.indexOf('TABLE')
  expect(dxf.slice(layerTable + 1, layerTable + 9)).toEqual([
    '2', 'LAYER', '5', expect.stringMatching(/^[1-9A-F][0-9A-F]*$/), '100', 'AcDbSymbolTable', '70', '1',
  ])
  const starts = dxf.flatMap((value, i) => value === 'LWPOLYLINE' ? [i] : [])
  expect(starts).toHaveLength(2)
  starts.forEach((start, i) => {
    expect(dxf.slice(start + 1, start + 13)).toEqual([
      '100', 'AcDbEntity', '8', 'CONTOUR', '100', 'AcDbPolyline', '90', String(loops[i].points.length), '70', '1', '10', expect.any(String),
    ])
    for (let j = 0; j < loops[i].points.length; j++) {
      const [x, y] = loops[i].points[j]
      const offset = start + 11 + 4 * j
      expect(dxf[offset]).toBe('10')
      expect(Number(dxf[offset + 1])).toBeCloseTo(x * grid.cellSizeMm, 7)
      expect(dxf[offset + 2]).toBe('20')
      expect(Number(dxf[offset + 3])).toBeCloseTo(y * grid.cellSizeMm, 7)
    }
  })
})

function verifyStl(contours: ContourLoop[], expectedVolume: number, thickness = 10, exportGrid = grid) {
  const mesh = exportStl(contours, exportGrid, thickness)
  const view = new DataView(mesh.data)
  expect(view.getUint32(80, true)).toBe(mesh.triangleCount)
  expect(mesh.triangleCount).toBeGreaterThan(0)
  expect(mesh.data.byteLength).toBe(84 + 50 * mesh.triangleCount)
  const edges = new Map<string, number>()
  let signedVolume = 0
  for (let i = 0; i < mesh.triangleCount; i++) {
    const vectors = Array.from({ length: 4 }, (_, j) => Array.from({ length: 3 }, (_, k) =>
      view.getFloat32(84 + i * 50 + j * 12 + k * 4, true)))
    const [normal, a, b, c] = vectors
    expect(vectors.flat().every(Number.isFinite)).toBe(true)
    expect(Math.hypot(...normal)).toBeCloseTo(1, 6)
    const [ux, uy, uz] = b.map((value, j) => value - a[j])
    const [vx, vy, vz] = c.map((value, j) => value - a[j])
    const cross = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]
    expect(normal.reduce((sum, value, j) => sum + value * cross[j], 0)).toBeGreaterThan(0)
    signedVolume += a.reduce((sum, value, j) => sum + value * cross[j], 0) / 6
    for (const [from, to] of [[a, b], [b, c], [c, a]]) {
      const key = `${from}|${to}`
      edges.set(key, (edges.get(key) ?? 0) + 1)
    }
  }
  for (const [key, count] of edges) {
    const [a, b] = key.split('|')
    expect(count).toBe(1)
    expect(edges.get(`${b}|${a}`)).toBe(1)
  }
  expect(signedVolume).toBeCloseTo(expectedVolume, 2)
}

it('extrudes a smoothed plate with a hole into an exactly watertight STL with outward normals', () => {
  const area = loops.reduce((sum, { points }) => sum + points.reduce((area, [x, y], i) => {
    const [nx, ny] = points[(i + 1) % points.length]
    return area + (x * ny - nx * y) / 2
  }, 0), 0)
  verifyStl(loops, area * grid.cellSizeMm ** 2 * 10)
})

it('extrudes the 30 × 10 collinear contour fixture into a watertight binary STL', () => {
  const fixtureGrid = { nelx: 30, nely: 10, cellSizeMm: 1 }
  const rows = ['0111100000', '0100010000', '0110001000', '0100000100', '0010000010', '0001110010', '0000001110']
  const field = new Float32Array(fixtureGrid.nelx * fixtureGrid.nely)
  rows.forEach((row, y) => field.set(Array.from(row, Number), (y + 1) * fixtureGrid.nelx))
  const contours = extractContours(field, fixtureGrid, 0.5, 0)
  const area = contours.reduce((sum, loop) => sum + signedArea(loop.points), 0)
  verifyStl(contours, area * 10, 10, fixtureGrid)
})

it('keeps exact cap to wall connectivity for multiple holes aligned on the same Y coordinate', () => {
  const square = (x: number, y: number, size: number): ContourLoop['points'] =>
    [[x, y], [x + size, y], [x + size, y + size], [x, y + size]]
  const plate = [
    { points: square(0, 0, 20), hole: false, parent: -1 },
    { points: square(2, 4, 3).reverse(), hole: true, parent: 0 },
    { points: square(8, 4, 3).reverse(), hole: true, parent: 0 },
    { points: square(14, 4, 3).reverse(), hole: true, parent: 0 },
  ]
  verifyStl(plate, (400 - 27) * grid.cellSizeMm ** 2 * 6, 6)
})
