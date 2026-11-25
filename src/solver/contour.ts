import type { Grid } from './types'

export type Point2 = [number, number]

export interface ContourLoop {
  /** Cyclic vertices in grid coordinates with Y up. The closing vertex is implicit. */
  points: Point2[]
  hole: boolean
  /** The immediate enclosing loop, or -1 at the top level. */
  parent: number
}

export function signedArea(points: readonly Point2[]): number {
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i]
    const [nx, ny] = points[(i + 1) % points.length]
    area += x * ny - nx * y
  }
  return area / 2
}

function contains(points: Point2[], [x, y]: Point2) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ax, ay] = points[i]
    const [bx, by] = points[j]
    if ((ay > y) !== (by > y) && x < ax + (bx - ax) * (y - ay) / (by - ay)) inside = !inside
  }
  return inside
}

function orientLoops(polygons: Point2[][]): ContourLoop[] {
  const byArea = polygons.map(points => ({ points, area: signedArea(points) }))
    .sort((a, b) => Math.abs(b.area) - Math.abs(a.area))
  const loops: ContourLoop[] = []
  for (const { points, area } of byArea) {
    let parent = loops.length - 1
    while (parent >= 0 && !contains(loops[parent].points, points[0])) parent--
    const hole = parent >= 0 && !loops[parent].hole
    if ((area < 0) !== hole) points.reverse()
    loops.push({ points, hole, parent })
  }
  return loops
}

/** Interpolate element-center samples, extending boundary cells to the domain edges.
 * An exterior ghost ring closes the contours precisely on those edges.
 */
export function extractContours(
  density: ArrayLike<number>, grid: Grid, threshold = 0.5, smoothing = 0,
): ContourLoop[] {
  const { nelx, nely } = grid
  if (density.length !== nelx * nely || !(threshold > 0 && threshold < 1)) {
    throw new Error('Contours require one density per element and a threshold between 0 and 1.')
  }
  const nx = nelx + 4
  const ny = nely + 4
  const field = new Float64Array(nx * ny).fill(-1)
  const coordinate = (index: number, extent: number) => Math.max(0, Math.min(extent, index - 1.5))
  for (let y = 1; y < ny - 1; y++) {
    for (let x = 1; x < nx - 1; x++) {
      const e = Math.min(nely - 1, Math.max(0, y - 2)) * nelx + Math.min(nelx - 1, Math.max(0, x - 2))
      const value = density[e] - threshold
      if (!Number.isFinite(value)) throw new Error('Contour densities must be finite.')
      // Keep intersections away from sample vertices, including threshold plateaus.
      field[y * nx + x] = value >= 0 ? Math.max(1e-5, value) : Math.min(-1e-5, value)
    }
  }

  const points = new Map<number, Point2>()
  const neighbors = new Map<number, number[]>()
  function edge(a: number, b: number) {
    const id = 2 * a + Number(b - a === nx)
    if (!points.has(id)) {
      const t = field[a] / (field[a] - field[b])
      const ax = coordinate(a % nx, nelx)
      const ay = coordinate(Math.floor(a / nx), nely)
      const bx = coordinate(b % nx, nelx)
      const by = coordinate(Math.floor(b / nx), nely)
      points.set(id, [ax + (bx - ax) * t, ay + (by - ay) * t])
    }
    return id
  }

  function connect(a: number, b: number) {
    const connectOne = (from: number, to: number) => {
      const adjacent = neighbors.get(from)
      if (adjacent) adjacent.push(to)
      else neighbors.set(from, [to])
    }
    connectOne(a, b)
    connectOne(b, a)
  }

  for (let y = 0; y < ny - 1; y++) {
    for (let x = 0; x < nx - 1; x++) {
      const a = y * nx + x, b = a + 1, d = a + nx, c = d + 1
      const sa = field[a] >= 0, sb = field[b] >= 0, sc = field[c] >= 0, sd = field[d] >= 0
      if (sa === sb && sb === sc && sc === sd) continue
      const crossings: number[] = []
      if (sa !== sb) crossings.push(edge(a, b))
      if (sb !== sc) crossings.push(edge(b, c))
      if (sd !== sc) crossings.push(edge(d, c))
      if (sa !== sd) crossings.push(edge(a, d))
      if (crossings.length === 2) connect(crossings[0], crossings[1])
      else {
        const [bottom, right, top, left] = crossings
        // Bilinear asymptotic decider, with a deterministic pairing at equality.
        if (field[a] * field[c] >= field[b] * field[d]) {
          connect(bottom, right)
          connect(top, left)
        } else {
          connect(bottom, left)
          connect(right, top)
        }
      }
    }
  }

  const polygons: Point2[][] = []
  const visited = new Set<number>()
  for (const start of neighbors.keys()) {
    if (visited.has(start)) continue
    const polygon: Point2[] = []
    let previous = -1
    let current = start
    do {
      const point = points.get(current)!
      const last = polygon.at(-1)
      if (!last || last[0] !== point[0] || last[1] !== point[1]) polygon.push(point)
      visited.add(current)
      const [first, second] = neighbors.get(current)!
      const next = first === previous ? second : first
      previous = current
      current = next
    } while (current !== start)
    const first = polygon[0]
    const last = polygon.at(-1)!
    if (last[0] === first[0] && last[1] === first[1]) polygon.pop()
    if (polygon.length >= 3 && signedArea(polygon) !== 0) polygons.push(polygon)
  }
  const loops = orientLoops(polygons)
  return smoothing > 0 ? smoothContours(loops, grid, smoothing) : loops
}

function cross(a: Point2, b: Point2, c: Point2) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

interface Segment {
  a: Point2
  b: Point2
  loop: number
  index: number
}

/** Reject a smoothing pass if it would close a gap, invert a loop, or intersect a boundary. */
function validSmoothing(loops: ContourLoop[], stride: number) {
  const buckets = new Map<number, Segment[]>()
  for (let loop = 0; loop < loops.length; loop++) {
    const { points, hole } = loops[loop]
    if (signedArea(points) * (hole ? -1 : 1) <= 0) return false
    for (let index = 0; index < points.length; index++) {
      const a = points[index]
      const b = points[(index + 1) % points.length]
      if (a[0] === b[0] && a[1] === b[1]) return false
      const segment = { a, b, loop, index }
      for (let y = Math.floor(Math.min(a[1], b[1])); y <= Math.floor(Math.max(a[1], b[1])); y++) {
        for (let x = Math.floor(Math.min(a[0], b[0])); x <= Math.floor(Math.max(a[0], b[0])); x++) {
          const key = y * stride + x
          const bucket = buckets.get(key)
          if (!bucket) {
            buckets.set(key, [segment])
            continue
          }
          for (const other of bucket) {
            if (other.loop === loop && (index - other.index === 1 || index - other.index === points.length - 1)) continue
            const { a: c, b: d } = other
            if (cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0
              && Math.max(a[0], b[0]) >= Math.min(c[0], d[0]) && Math.max(c[0], d[0]) >= Math.min(a[0], b[0])
              && Math.max(a[1], b[1]) >= Math.min(c[1], d[1]) && Math.max(c[1], d[1]) >= Math.min(a[1], b[1])) return false
          }
          bucket.push(segment)
        }
      }
    }
    const parent = loops[loop].parent
    if (parent >= 0 && !contains(loops[parent].points, points[0])) return false
  }
  return true
}

export function smoothContours(loops: ContourLoop[], { nelx, nely }: Grid, iterations: number): ContourLoop[] {
  const locked = loops.map(loop => loop.points.map(([x, y]) => x === 0 || x === nelx || y === 0 || y === nely))
  const minimumAreas = loops.map(loop => Math.abs(signedArea(loop.points)) * 0.5)
  let result = loops
  for (let i = 0; i < iterations; i++) {
    let candidate = result
    for (const weight of [0.5, -0.53]) {
      candidate = candidate.map((loop, l) => ({
        ...loop,
        points: loop.points.map((point, j, points): Point2 => {
          if (locked[l][j]) return point
          const prev = points[(j + points.length - 1) % points.length]
          const next = points[(j + 1) % points.length]
          const [x, y] = point
          const clamp = (v: number, max: number) => Math.max(1e-5, Math.min(max - 1e-5, v))
          return [
            clamp(x + weight * ((prev[0] + next[0]) / 2 - x), nelx),
            clamp(y + weight * ((prev[1] + next[1]) / 2 - y), nely),
          ]
        }),
      }))
    }
    candidate = candidate.map((loop, l) =>
      signedArea(loop.points) * (loop.hole ? -1 : 1) >= minimumAreas[l] ? loop : result[l])
    if (!validSmoothing(candidate, nelx + 1)) break
    result = candidate
  }
  return result
}
