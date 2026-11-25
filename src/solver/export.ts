import earcut from 'earcut'
import { signedArea, type ContourLoop, type Point2 } from './contour'
import type { Grid } from './types'

const scaleOf = (grid: Grid) => grid.cellSizeMm ?? 1
const decimal = (value: number) => String(Number(value.toFixed(8)))

export function exportSvg(loops: readonly ContourLoop[], grid: Grid): string {
  const scale = scaleOf(grid)
  const width = decimal(grid.nelx * scale)
  const height = decimal(grid.nely * scale)
  const path = loops.map(({ points }) => points.map(([x, y], i) =>
    `${i === 0 ? 'M' : 'L'}${decimal(x * scale)} ${decimal((grid.nely - y) * scale)}`).join(' ') + ' Z').join(' ')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}">\n  <path d="${path}" fill-rule="evenodd"/>\n</svg>\n`
}

export function exportDxf(loops: readonly ContourLoop[], grid: Grid): string {
  const scale = scaleOf(grid)
  const codes: (string | number)[] = [
    0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1015', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC',
    0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER', 5, '10', 100, 'AcDbSymbolTable', 70, 1,
    0, 'LAYER', 100, 'AcDbSymbolTableRecord', 100, 'AcDbLayerTableRecord', 2, 'CONTOUR', 70, 0, 62, 7, 6, 'CONTINUOUS',
    0, 'ENDTAB', 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES',
  ]
  for (const { points } of loops) {
    codes.push(0, 'LWPOLYLINE', 100, 'AcDbEntity', 8, 'CONTOUR', 100, 'AcDbPolyline', 90, points.length, 70, 1)
    for (const [x, y] of points) codes.push(10, decimal(x * scale), 20, decimal(y * scale))
  }
  codes.push(0, 'ENDSEC', 0, 'EOF')
  return codes.join('\r\n') + '\r\n'
}

type Point3 = [number, number, number]
type Triangle = [Point3, Point3, Point3]

function area2(a: Point2, b: Point2, c: Point2) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

function between(a: Point2, b: Point2, c: Point2) {
  return (b[0] - a[0]) * (b[0] - c[0]) + (b[1] - a[1]) * (b[1] - c[1]) < 0
}

function redundant(a: Point2, b: Point2, c: Point2) {
  return area2(a, b, c) === 0 && between(a, b, c)
}

function removeRedundant(points: Point2[], scale: number): Point2[] {
  const result: Point2[] = []
  for (const [x, y] of points) {
    // Build caps and walls from the exact coordinates stored in the STL.
    const point: Point2 = [Math.fround(x * scale), Math.fround(y * scale)]
    const last = result.at(-1)
    if (last && last[0] === point[0] && last[1] === point[1]) continue
    while (result.length >= 2 && redundant(result.at(-2)!, result.at(-1)!, point)) result.pop()
    result.push(point)
  }
  if (result.length > 1 && result[0][0] === result.at(-1)![0] && result[0][1] === result.at(-1)![1]) result.pop()
  while (result.length >= 3) {
    if (redundant(result.at(-2)!, result.at(-1)!, result[0])) result.pop()
    else if (redundant(result.at(-1)!, result[0], result[1])) result.shift()
    else break
  }
  return result
}

type Indices = [number, number, number]

function openCapEdges(faces: Indices[], points: Point2[]): Set<number> | undefined {
  const stride = points.length
  const unmatched = new Set<number>()
  const seen = new Set<number>()
  for (const [a, b, c] of faces) {
    if (!(area2(points[a], points[b], points[c]) > 0)) return undefined
    for (const [from, to] of [[a, b], [b, c], [c, a]]) {
      const key = from * stride + to
      if (seen.has(key)) return undefined
      seen.add(key)
      if (!unmatched.delete(to * stride + from)) unmatched.add(key)
    }
  }
  return unmatched
}

/** Restore vertices skipped on a straight cap edge before joining it to the walls. */
function splitCapEdges(faces: Indices[], points: Point2[], open: Set<number>, boundary: Set<number>): Indices[] {
  const stride = points.length
  const splits = new Map<number, number[]>()
  for (const edge of open) {
    if (boundary.has(edge)) continue
    const a = points[Math.floor(edge / stride)], b = points[edge % stride]
    const vertices: number[] = []
    points.forEach((point, i) => {
      if (area2(a, b, point) === 0 && between(a, point, b)) vertices.push(i)
    })
    if (!vertices.length) continue
    const axis = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? 0 : 1
    const direction = Math.sign(b[axis] - a[axis])
    vertices.sort((i, j) => direction * (points[i][axis] - points[j][axis]))
    splits.set(edge, vertices)
  }

  const pending = faces.slice()
  const repaired: Indices[] = []
  while (pending.length) {
    const face = pending.pop()!
    const side = face.findIndex((from, i) => splits.has(from * stride + face[(i + 1) % 3]))
    if (side < 0) {
      repaired.push(face)
      continue
    }
    const from = face[side], to = face[(side + 1) % 3], opposite = face[(side + 2) % 3]
    let start = from
    for (const end of [...splits.get(from * stride + to)!, to]) {
      pending.push([start, end, opposite])
      start = end
    }
  }
  return repaired
}

function triangulate(rings: Point2[][]): Indices[] {
  const points = rings.flat()
  const stride = points.length
  const holes: number[] = []
  const boundary = new Set<number>()
  let start = 0
  for (const ring of rings) {
    if (start > 0) holes.push(start)
    for (let i = 0; i < ring.length; i++) {
      boundary.add((start + i) * stride + start + (i + 1) % ring.length)
    }
    start += ring.length
  }

  const matchesBoundary = (open: Set<number>) =>
    open.size === boundary.size && [...open].every(edge => boundary.has(edge))

  // Retry with different hole-bridge directions while retaining the exact STL vertices.
  for (const shear of [0, Math.SQRT2 - 1, -Math.sqrt(3) / 3]) {
    const cap = earcut(points.flatMap(([x, y]) => [x, y + shear * x]), holes)
    const faces: Indices[] = []
    for (let i = 0; i < cap.length; i += 3) {
      const a = cap[i], b = cap[i + 1], c = cap[i + 2]
      const cross = area2(points[a], points[b], points[c])
      if (cross !== 0) faces.push(cross > 0 ? [a, b, c] : [a, c, b])
    }
    const open = openCapEdges(faces, points)
    if (!open) continue
    if (matchesBoundary(open)) return faces
    const repaired = splitCapEdges(faces, points, open, boundary)
    const repairedOpen = openCapEdges(repaired, points)
    if (repairedOpen && matchesBoundary(repairedOpen)) return repaired
  }
  throw new Error('Could not triangulate a watertight STL from these contours.')
}

export interface StlMesh {
  triangleCount: number
  data: ArrayBuffer
}

/** Extrude each outer ring and its immediate holes. Nested material islands are separate shells. */
export function exportStl(loops: readonly ContourLoop[], grid: Grid, thicknessMm = 10): StlMesh {
  const thickness = Math.fround(thicknessMm)
  if (!(thickness > 0) || !Number.isFinite(thickness)) throw new Error('Extrusion thickness must be finite and positive.')
  const scale = scaleOf(grid)
  const triangles: Triangle[] = []
  loops.forEach((outer, index) => {
    if (outer.hole) return
    const rings = [outer, ...loops.filter(loop => loop.hole && loop.parent === index)]
      .map(loop => {
        const ring = removeRedundant(loop.points, scale)
        const area = signedArea(ring)
        if (ring.length < 3 || area === 0 || !Number.isFinite(area)) {
          throw new Error('A contour is too small for the precision of binary STL.')
        }
        if ((area < 0) !== loop.hole) ring.reverse()
        return ring
      })
    const top: Point3[] = rings.flatMap(ring => ring.map(([x, y]): Point3 => [x, y, thickness]))
    const bottom: Point3[] = top.map(([x, y]) => [x, y, 0])
    for (const [a, b, c] of triangulate(rings)) {
      triangles.push([top[a], top[b], top[c]], [bottom[a], bottom[c], bottom[b]])
    }
    let start = 0
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = start + i, b = start + (i + 1) % ring.length
        triangles.push([bottom[a], bottom[b], top[b]], [bottom[a], top[b], top[a]])
      }
      start += ring.length
    }
  })

  const data = new ArrayBuffer(84 + 50 * triangles.length)
  const view = new DataView(data)
  const header = 'TopoStudio binary STL | mm'
  for (let i = 0; i < header.length; i++) view.setUint8(i, header.charCodeAt(i))
  view.setUint32(80, triangles.length, true)
  let offset = 84
  function write(values: Point3) {
    for (const value of values) {
      view.setFloat32(offset, value, true)
      offset += 4
    }
  }
  for (const [a, b, c] of triangles) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const length = Math.hypot(nx, ny, nz)
    write([nx / length, ny / length, nz / length])
    write(a)
    write(b)
    write(c)
    offset += 2
  }
  return { triangleCount: triangles.length, data }
}
