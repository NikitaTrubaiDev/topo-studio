import { h8Corners } from './elementH8'
import { cellSize, elementCount, elementIndex, type Grid3D } from './types3d'

export interface Surface3D {
  /** Interleaved XYZ coordinates in mm. */
  vertices: Float64Array
  /** Counterclockwise triangle indices as seen from outside. */
  triangles: Uint32Array
}

const edges = [
  [0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [3, 7], [2, 6],
] as const

// Each face is ordered counterclockwise as seen from outside the cube.
const faces = [
  [[0, 2, 3, 1], [3, 2, 1, 0]], [[4, 5, 7, 6], [4, 5, 6, 7]],
  [[0, 1, 5, 4], [0, 9, 4, 8]], [[2, 6, 7, 3], [11, 6, 10, 2]],
  [[0, 4, 6, 2], [8, 7, 11, 3]], [[1, 3, 7, 5], [1, 10, 5, 9]],
] as const

/**
 * March the cube edges, resolve ambiguous faces bilinearly, and triangulate each
 * oriented contour inside its cube. Shared face segments and edge vertices are
 * identical in adjacent cubes. A zero-density ghost layer closes the surface.
 * Intersections on ghost edges use the exact domain plane so mounting faces
 * remain at the specified dimensions regardless of the chosen threshold.
 */
export function marchingCubes(density: ArrayLike<number>, grid: Grid3D, threshold = 0.5): Surface3D {
  if (density.length !== elementCount(grid) || !(threshold > 0 && threshold < 1)) throw new RangeError('Invalid isosurface input')
  const { nelx, nely, nelz } = grid
  const [hx, hy, hz] = cellSize(grid)
  const nx = nelx + 2, ny = nely + 2, nz = nelz + 2
  const area = nx * ny
  const field = new Float64Array(area * nz)
  const ghost = new Uint8Array(field.length)
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const index = (z * ny + y) * nx + x
    if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) {
      ghost[index] = 1
      field[index] = -threshold
      continue
    }
    const value = density[elementIndex(grid, x - 1, y - 1, z - 1)] - threshold
    if (!Number.isFinite(value)) throw new RangeError('Non-finite density')
    // Keep edge crossings separate even at a sample equal to the iso value.
    field[index] = (value < 0 ? -1 : 1) * Math.max(Math.abs(value), 1e-5)
  }
  const vertexCache = new Int32Array(field.length * 3).fill(-1)
  const vertices: number[] = [], triangles: number[] = []
  const ids = new Int32Array(8), next = new Int8Array(12), cuts = new Int8Array(4)
  const loop: number[] = []

  function vertex(edge: number, x: number, y: number, z: number) {
    const [a, b] = edges[edge]
    const lo = Math.min(ids[a], ids[b]), hi = Math.max(ids[a], ids[b])
    const axis = hi - lo === 1 ? 0 : hi - lo === nx ? 1 : 2
    const key = lo * 3 + axis
    if (vertexCache[key] >= 0) return vertexCache[key]
    const t = ghost[lo] || ghost[hi] ? 0.5 : field[ids[a]] / (field[ids[a]] - field[ids[b]])
    const p = h8Corners[a], q = h8Corners[b]
    const index = vertices.length / 3
    const coordinate = (cell: number, max: number, side: number, d: number) => {
      const offset = cell + p[d] + t * (q[d] - p[d]) - 0.5
      // Force the exact plane coordinate even for floating-point products.
      if (offset === 0) return 0
      if (offset === max) return [grid.widthMm, grid.heightMm, grid.depthMm][d]
      return offset * side
    }
    vertices.push(coordinate(x, nelx, hx, 0), coordinate(y, nely, hy, 1), coordinate(z, nelz, hz, 2))
    vertexCache[key] = index
    return index
  }

  for (let z = 0; z < nz - 1; z++) for (let y = 0; y < ny - 1; y++) for (let x = 0; x < nx - 1; x++) {
    const base = (z * ny + y) * nx + x
    ids[0] = base; ids[1] = base + 1; ids[2] = base + nx; ids[3] = base + nx + 1
    ids[4] = base + area; ids[5] = base + area + 1; ids[6] = base + area + nx; ids[7] = base + area + nx + 1
    let inside = 0
    for (const id of ids) if (field[id] > 0) inside++
    if (inside === 0 || inside === 8) continue
    next.fill(-1)

    for (const [corners, faceEdges] of faces) {
      let count = 0
      for (let k = 0; k < 4; k++) {
        if ((field[ids[corners[k]]] > 0) !== (field[ids[corners[(k + 1) % 4]]] > 0)) cuts[count++] = k
      }
      function connect(a: number, b: number) {
        if (field[ids[corners[a]]] < 0) next[faceEdges[a]] = faceEdges[b]
        else next[faceEdges[b]] = faceEdges[a]
      }
      if (count === 2) connect(cuts[0], cuts[1])
      if (count === 4) {
        const [a, b, c, d] = corners.map(corner => field[ids[corner]])
        const determinant = a * c - b * d
        // A tie separates positive corners, independent of face order.
        if (determinant > 0 || (determinant === 0 && a < 0)) {
          connect(0, 1)
          connect(2, 3)
        } else {
          connect(3, 0)
          connect(1, 2)
        }
      }
    }

    for (let edge = 0; edge < next.length; edge++) {
      if (next[edge] < 0) continue
      loop.length = 0
      let current = edge
      do {
        loop.push(vertex(current, x, y, z))
        const following = next[current]
        next[current] = -1
        current = following
      } while (current !== edge)
      if (loop.length === 3) {
        triangles.push(loop[0], loop[1], loop[2])
      } else {
        // An interior fan vertex keeps face diagonals local to their own cube.
        const center = vertices.length / 3
        for (let d = 0; d < 3; d++) {
          const first = vertices[3 * loop[0] + d]
          let offset = 0
          for (const index of loop) offset += vertices[3 * index + d] - first
          vertices.push(first + offset / loop.length)
        }
        for (let i = 0; i < loop.length; i++) triangles.push(center, loop[i], loop[(i + 1) % loop.length])
      }
    }
  }
  return { vertices: Float64Array.from(vertices), triangles: Uint32Array.from(triangles) }
}

export function triangleNormal(vertices: ArrayLike<number>, a: number, b: number, c: number): [number, number, number] {
  a *= 3; b *= 3; c *= 3
  const ux = vertices[b] - vertices[a], uy = vertices[b + 1] - vertices[a + 1], uz = vertices[b + 2] - vertices[a + 2]
  const vx = vertices[c] - vertices[a], vy = vertices[c + 1] - vertices[a + 1], vz = vertices[c + 2] - vertices[a + 2]
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]
}

export function taubinSmooth(mesh: Surface3D, grid: Grid3D, passes: number, lambda = 0.5, mu = -0.53): Surface3D {
  if (passes <= 0 || !mesh.triangles.length) return mesh
  const { triangles } = mesh
  let vertices = mesh.vertices.slice()
  const smoothed = vertices.slice()
  let expanded = vertices.slice()
  const rounded = new Float32Array(vertices.length)
  const limits = [grid.widthMm, grid.heightMm, grid.depthMm]
  const boundary = Uint8Array.from(vertices, (value, i) => Number(value === 0 || value === limits[i % 3]))
  const adjacency = Array.from({ length: vertices.length / 3 }, () => new Set<number>())
  for (let i = 0; i < triangles.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      const v = triangles[i + j], w = triangles[i + (j + 1) % 3]
      adjacency[v].add(w)
      adjacency[w].add(v)
    }
  }
  function pass(input: Float64Array, output: Float64Array, weight: number) {
    for (let i = 0; i < input.length; i++) {
      const d = i % 3
      const neighbors = adjacency[(i - d) / 3]
      let delta = 0
      for (const neighbor of neighbors) delta += input[3 * neighbor + d] - input[i]
      const value = input[i] + weight * delta / (neighbors.size || 1)
      output[i] = boundary[i] ? mesh.vertices[i] : Math.min(limits[d], Math.max(0, value))
    }
    rounded.set(output)
    // Reject a pass that reverses a facet or collapses it at STL precision.
    for (let i = 0; i < triangles.length; i += 3) {
      const a = triangles[i], b = triangles[i + 1], c = triangles[i + 2]
      const before = triangleNormal(input, a, b, c)
      const after = triangleNormal(rounded, a, b, c)
      if (before[0] * after[0] + before[1] * after[1] + before[2] * after[2] <= 0) return false
    }
    return true
  }
  for (let i = 0; i < passes; i++) {
    // If a local feature limits the step, retain the Taubin ratio and reduce the step.
    let weight = 1
    while (weight >= 1 / 64 &&
      !(pass(vertices, smoothed, lambda * weight) && pass(smoothed, expanded, mu * weight))) weight *= 0.5
    if (weight < 1 / 64) break
    const previous = vertices
    vertices = expanded
    expanded = previous
  }
  return { vertices, triangles }
}

export function vertexNormals({ vertices, triangles }: Surface3D) {
  const normals = new Float64Array(vertices.length)
  for (let i = 0; i < triangles.length; i += 3) {
    const n = triangleNormal(vertices, triangles[i], triangles[i + 1], triangles[i + 2])
    for (let j = 0; j < 3; j++) {
      const offset = 3 * triangles[i + j]
      for (let d = 0; d < 3; d++) normals[offset + d] += n[d]
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2])
    if (length > 0) for (let d = 0; d < 3; d++) normals[i + d] /= length
  }
  return normals
}
