import { h8Corners } from './elementH8'
import { tetCorners } from './elementT4'
import { nodalField3D } from './mesh3d'
import { cellSize, elementCount, elementIndex, nodeIndex3D, type ElementType3D, type Grid3D } from './types3d'
import type { PassiveMasks } from '../solver/types'

export interface Surface3D {
  /** Interleaved XYZ coordinates in mm. */
  vertices: Float64Array
  /** Counterclockwise triangle indices as seen from outside. */
  triangles: Uint32Array
  /** Vertices on the boundary of a prescribed material or void cell. */
  pinned?: Uint8Array
}

export const maxSmoothingPasses3D = 12

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
export function marchingCubes(density: ArrayLike<number>, grid: Grid3D, threshold = 0.5, passive?: PassiveMasks): Surface3D {
  if (density.length !== elementCount(grid) || !(threshold > 0 && threshold < 1)) throw new RangeError('Invalid isosurface input')
  const { nelx, nely, nelz } = grid
  const [hx, hy, hz] = cellSize(grid)
  const nx = nelx + 2, ny = nely + 2, nz = nelz + 2
  const area = nx * ny
  const field = new Float64Array(area * nz)
  const ghost = new Uint8Array(field.length)
  const prescribed = passive && new Uint8Array(field.length)
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const index = (z * ny + y) * nx + x
    if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) {
      ghost[index] = 1
      field[index] = -threshold
      continue
    }
    const e = elementIndex(grid, x - 1, y - 1, z - 1)
    if (prescribed) prescribed[index] = Number(!!(passive?.solid?.[e] || passive?.void?.[e]))
    const value = density[e] - threshold
    if (!Number.isFinite(value)) throw new RangeError('Non-finite density')
    // Keep edge crossings separate even at a sample equal to the iso value.
    field[index] = (value < 0 ? -1 : 1) * Math.max(Math.abs(value), 1e-5)
  }
  const vertexCache = new Int32Array(field.length * 3).fill(-1)
  const vertices: number[] = [], triangles: number[] = []
  const pinned: number[] = []
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
    if (prescribed) pinned[index] = prescribed[lo] || prescribed[hi]
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
        if (prescribed) pinned[center] = Number(loop.some(index => pinned[index]))
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
  return { vertices: Float64Array.from(vertices), triangles: Uint32Array.from(triangles),
    ...(prescribed && { pinned: Uint8Array.from(pinned) }) }
}

// Build the cut polygon of each sign case on a positively oriented reference tet.
const tetIsoCases = Array.from({ length: 16 }, (_, mask) => {
  const inside = [0, 1, 2, 3].filter(i => mask & (1 << i))
  const outside = [0, 1, 2, 3].filter(i => !(mask & (1 << i)))
  if (!inside.length || !outside.length) return []
  const polygon = inside.length === 1 ? outside.map(j => [inside[0], j])
    : outside.length === 1 ? inside.map(i => [i, outside[0]])
      : [[inside[0], outside[0]], [inside[0], outside[1]], [inside[1], outside[1]], [inside[1], outside[0]]]
  const points = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]]
  const cuts = polygon.flatMap(([i, j]) => points[i].map((v, axis) => (v + points[j][axis]) / 2))
  const normal = triangleNormal(cuts, 0, 1, 2)
  if (normal.reduce((sum, v, axis) => sum + v * (points[outside[0]][axis] - points[inside[0]][axis]), 0) < 0) {
    polygon.reverse()
  }
  return polygon
})

/** March a continuous nodal field on the same parity subdivision used by Tet4 FEA.
 * Pad with exterior nodes so solids reaching the domain boundary still close. */
export function marchingTetrahedra(density: ArrayLike<number>, grid: Grid3D, threshold = 0.5, passive?: PassiveMasks): Surface3D {
  if (density.length !== elementCount(grid, 'tet4') || !(threshold > 0 && threshold < 1)) {
    throw new RangeError('Invalid Tet4 isosurface input')
  }
  for (let e = 0; e < density.length; e++) if (!Number.isFinite(density[e])) throw new RangeError('Non-finite density')
  const nodal = nodalField3D(grid, 'tet4', density)
  const { nelx, nely, nelz, widthMm, heightMm, depthMm } = grid
  const nx = nelx + 3, ny = nely + 3, nz = nelz + 3, area = nx * ny
  const field = new Float64Array(area * nz).fill(-threshold)
  const ghost = new Uint8Array(field.length).fill(1)
  const prescribed = passive && new Uint8Array(field.length)
  const index = (x: number, y: number, z: number) => (z * ny + y) * nx + x
  for (let z = 0; z <= nelz; z++) for (let y = 0; y <= nely; y++) for (let x = 0; x <= nelx; x++) {
    const i = index(x + 1, y + 1, z + 1)
    ghost[i] = 0
    const value = nodal[nodeIndex3D(grid, x, y, z)] - threshold
    field[i] = (value < 0 ? -1 : 1) * Math.max(Math.abs(value), 1e-5)
  }
  if (prescribed) for (let z = 0; z < nelz; z++) for (let y = 0; y < nely; y++) for (let x = 0; x < nelx; x++) {
    const e = elementIndex(grid, x, y, z)
    if (passive?.solid?.[e] || passive?.void?.[e]) {
      for (const [dx, dy, dz] of h8Corners) prescribed[index(x + dx + 1, y + dy + 1, z + dz + 1)] = 1
    }
  }
  const dimensions = [widthMm, heightMm, depthMm]
  // Keep paired ghost/inner samples on either side of the precise mounting plane.
  const coordinates = [nelx, nely, nelz].map((n, axis) => Float64Array.from({ length: n + 3 }, (_, i) => {
    const h = dimensions[axis] / n
    if (i <= 1) return (i ? 0.25 : -0.25) * h
    if (i >= n + 1) return dimensions[axis] + (i === n + 1 ? -0.25 : 0.25) * h
    return (i - 1) * h
  }))
  const cache = new Map<number, number>()
  const vertices: number[] = [], triangles: number[] = [], pins: number[] = []
  const ids = new Int32Array(8), cuts = new Uint32Array(4)
  for (let z = 0; z < nz - 1; z++) for (let y = 0; y < ny - 1; y++) for (let x = 0; x < nx - 1; x++) {
    let cubeMask = 0
    for (let i = 0; i < 8; i++) {
      const [dx, dy, dz] = h8Corners[i]
      ids[i] = index(x + dx, y + dy, z + dz)
      if (field[ids[i]] > 0) cubeMask |= 1 << i
    }
    if (!cubeMask || cubeMask === 255) continue
    // Subtract the ghost cell from each axis to match the FEM parity.
    for (const tet of tetCorners[(x + y + z + 1) & 1]) {
      let mask = 0
      for (let i = 0; i < 4; i++) if (cubeMask & (1 << tet[i])) mask |= 1 << i
      const polygon = tetIsoCases[mask]
      if (!polygon.length) continue
      for (let i = 0; i < polygon.length; i++) {
        const [j, k] = polygon[i]
        const a = ids[tet[j]], b = ids[tet[k]]
        const key = Math.min(a, b) * field.length + Math.max(a, b)
        let v = cache.get(key)
        if (v === undefined) {
          const t = ghost[a] || ghost[b] ? 0.5 : field[a] / (field[a] - field[b])
          const p = h8Corners[tet[j]], q = h8Corners[tet[k]]
          const cell = [x, y, z]
          v = vertices.length / 3
          for (let axis = 0; axis < 3; axis++) {
            const [start, end] = [cell[axis] + p[axis], cell[axis] + q[axis]]
            const last = coordinates[axis].length - 1
            const lo = Math.min(start, end), hi = Math.max(start, end)
            const u = coordinates[axis][start], w = coordinates[axis][end]
            vertices.push(lo === 0 && hi === 1 ? 0 : lo === last - 1 && hi === last ? dimensions[axis] : u + t * (w - u))
          }
          if (prescribed) pins[v] = prescribed[a] || prescribed[b]
          cache.set(key, v)
        }
        cuts[i] = v
      }
      triangles.push(cuts[0], cuts[1], cuts[2])
      if (polygon.length === 4) triangles.push(cuts[0], cuts[2], cuts[3])
    }
  }
  return { vertices: Float64Array.from(vertices), triangles: Uint32Array.from(triangles),
    ...(prescribed && { pinned: Uint8Array.from(pins) }) }
}

export function triangleNormal(vertices: ArrayLike<number>, a: number, b: number, c: number): [number, number, number] {
  a *= 3; b *= 3; c *= 3
  const ux = vertices[b] - vertices[a], uy = vertices[b + 1] - vertices[a + 1], uz = vertices[b + 2] - vertices[a + 2]
  const vx = vertices[c] - vertices[a], vy = vertices[c + 1] - vertices[a + 1], vz = vertices[c + 2] - vertices[a + 2]
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]
}

/** Six times the oriented tetrahedron volume relative to a reference vertex. */
export function signedTriangleVolume6(vertices: ArrayLike<number>, a: number, b: number, c: number, origin: number) {
  const [nx, ny, nz] = triangleNormal(vertices, a, b, c)
  a *= 3; origin *= 3
  return nx * (vertices[a] - vertices[origin]) + ny * (vertices[a + 1] - vertices[origin + 1])
    + nz * (vertices[a + 2] - vertices[origin + 2])
}

export function taubinSmooth(mesh: Surface3D, grid: Grid3D, passes: number, lambda = 0.5, mu = -0.53): Surface3D {
  if (passes <= 0 || !mesh.triangles.length) return mesh
  const { triangles, pinned } = mesh
  let vertices = mesh.vertices.slice()
  const smoothed = vertices.slice()
  let expanded = vertices.slice()
  const rounded = new Float32Array(vertices.length)
  const limits = [grid.widthMm, grid.heightMm, grid.depthMm]
  const boundary = Uint8Array.from(vertices, (value, i) => Number(!!pinned?.[Math.floor(i / 3)] || value === 0 || value === limits[i % 3]))
  const maxOffset = Math.min(...cellSize(grid)) * 0.08 / Math.sqrt(3)
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
      const original = mesh.vertices[i]
      output[i] = boundary[i] ? original : Math.min(limits[d], original + maxOffset, Math.max(0, original - maxOffset, value))
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
  function volume6(points: Float64Array) {
    let volume = 0
    for (let i = 0; i < triangles.length; i += 3) {
      volume += signedTriangleVolume6(points, triangles[i], triangles[i + 1], triangles[i + 2], 0)
    }
    return volume
  }
  const minimumVolume = 0.97 * volume6(vertices)
  for (let i = 0; i < Math.min(maxSmoothingPasses3D, Math.floor(passes)); i++) {
    // If a local feature limits the step, retain the Taubin ratio and reduce the step.
    let weight = 1
    while (weight >= 1 / 64 &&
      !(pass(vertices, smoothed, lambda * weight) && pass(smoothed, expanded, mu * weight)
        && volume6(expanded) >= minimumVolume)) weight *= 0.5
    if (weight < 1 / 64) break
    const previous = vertices
    vertices = expanded
    expanded = previous
  }
  return { ...mesh, vertices }
}

export function extractSurface3D(density: ArrayLike<number>, grid: Grid3D, threshold = 0.5, passes = 4, passive?: PassiveMasks,
  elementType: ElementType3D = 'hex8') {
  const march = elementType === 'tet4' ? marchingTetrahedra : marchingCubes
  return taubinSmooth(march(density, grid, threshold, passive), grid, passes)
}

export function vertexNormals({ vertices, triangles }: Surface3D) {
  const normals = new Float64Array(vertices.length)
  const facetNormals = new Float64Array(vertices.length)
  for (let i = 0; i < triangles.length; i += 3) {
    const n = triangleNormal(vertices, triangles[i], triangles[i + 1], triangles[i + 2])
    const area = Math.hypot(...n)
    if (!(area > 0 && Number.isFinite(area))) continue
    for (let j = 0; j < 3; j++) {
      const offset = 3 * triangles[i + j]
      if (facetNormals[offset] === 0 && facetNormals[offset + 1] === 0 && facetNormals[offset + 2] === 0) {
        for (let d = 0; d < 3; d++) facetNormals[offset + d] = n[d]
      }
      for (let d = 0; d < 3; d++) normals[offset + d] += n[d]
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2])
    const facetLength = Math.hypot(facetNormals[i], facetNormals[i + 1], facetNormals[i + 2])
    if (Number.isFinite(length) && length > facetLength * 1e-12) {
      for (let d = 0; d < 3; d++) normals[i + d] /= length
    } else if (facetLength > 0) {
      for (let d = 0; d < 3; d++) normals[i + d] = facetNormals[i + d] / facetLength
    } else {
      normals.set([0, 0, 1], i)
    }
  }
  return normals
}
