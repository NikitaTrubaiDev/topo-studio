import { tetVolumeFraction } from './elementT4'
import { h8Corners } from './elementH8'
import { marchingTetrahedra } from './tetSurface3d'
import { signedTriangleVolume6, triangleNormal, type Surface3D } from './surface3d'
import { cellSize, elementCount, elementIndex, type ElementType3D, type Grid3D } from './types3d'
import { surfaceValidator3D, validateSurface3D } from './surfaceValidation3d'
import type { PassiveMasks } from '../solver/types'

export { signedTriangleVolume6, triangleNormal, type Surface3D } from './surface3d'
export { marchingTetrahedra } from './tetSurface3d'

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
    const fraction = field[ids[a]] / (field[ids[a]] - field[ids[b]])
    // Keep crossings distinct after rounding to GPU/STL precision.
    const t = ghost[lo] || ghost[hi] ? 0.5 : Math.max(1e-4, Math.min(1 - 1e-4, fraction))
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

/** Resample the continuous, cell-centered density field at twice the display resolution.
 * Tet4 values are restricted by physical volume, independent of brick parity. */
export function prepareCadSurface3D(density: ArrayLike<number>, grid: Grid3D, threshold: number, passes: number,
  passive?: PassiveMasks, elementType: ElementType3D = 'hex8') {
  const { nelx, nely, nelz } = grid
  const count = elementCount(grid)
  if (density.length !== elementCount(grid, elementType)) throw new RangeError('Invalid CAD density input')
  const brick = new Float64Array(count)
  const peak = elementType === 'tet4' ? new Float64Array(count) : brick
  for (let e = 0; e < count; e++) {
    if (elementType === 'hex8') {
      brick[e] = density[e]
      continue
    }
    for (let t = 0; t < 5; t++) {
      const value = density[5 * e + t]
      brick[e] += value * tetVolumeFraction(t)
      peak[e] = Math.max(peak[e], value)
    }
  }
  const refined = { ...grid, nelx: 2 * nelx, nely: 2 * nely, nelz: 2 * nelz }
  const samples = new Float64Array(elementCount(refined))
  const pins = new Uint8Array(samples.length)
  // Keep near-threshold isolated members at least one sample wide. Protected
  // geometry uses the unmodified field so bore crossings retain their diameter.
  const floor = new Float64Array(count)
  for (let z = 0, e = 0; z < nelz; z++) for (let y = 0; y < nely; y++) for (let x = 0; x < nelx; x++, e++) {
    if (!Number.isFinite(brick[e])) throw new RangeError('Non-finite density')
    if (peak[e] < threshold || passive?.void?.[e] || passive?.solid?.[e]) continue
    const area = nelx * nely
    const neighbors = [
      x > 0 && peak[e - 1] >= threshold, x + 1 < nelx && peak[e + 1] >= threshold,
      y > 0 && peak[e - nelx] >= threshold, y + 1 < nely && peak[e + nelx] >= threshold,
      z > 0 && peak[e - area] >= threshold, z + 1 < nelz && peak[e + area] >= threshold,
    ]
    const narrow = !(neighbors[0] || neighbors[1]) && !(neighbors[2] || neighbors[3])
      || !(neighbors[0] || neighbors[1]) && !(neighbors[4] || neighbors[5])
      || !(neighbors[2] || neighbors[3]) && !(neighbors[4] || neighbors[5])
    if (narrow) floor[e] = threshold + Math.min((1 - threshold) * 0.5, 0.025 + 0.1 * (peak[e] - threshold))
  }
  const stencils = [nelx, nely, nelz].map(n => Array.from({ length: 2 * n }, (_, i) => {
    const position = i / 2 - 0.25
    const low = Math.floor(position)
    return { lo: Math.max(0, low), hi: Math.min(n - 1, low + 1), mix: position - low }
  }))
  for (let z = 0, i = 0; z < refined.nelz; z++) for (let y = 0; y < refined.nely; y++) {
    const sz = stencils[2][z], sy = stencils[1][y]
    for (let x = 0; x < refined.nelx; x++, i++) {
      const sx = stencils[0][x]
      const owner = elementIndex(grid, x >> 1, y >> 1, z >> 1)
      let value = 0, protectedSample = false, voidNeighbor = false
      for (let k = 0; k < 2; k++) for (let j = 0; j < 2; j++) for (let d = 0; d < 2; d++) {
        const e = elementIndex(grid, d ? sx.hi : sx.lo, j ? sy.hi : sy.lo, k ? sz.hi : sz.lo)
        const weight = (d ? sx.mix : 1 - sx.mix) * (j ? sy.mix : 1 - sy.mix) * (k ? sz.mix : 1 - sz.mix)
        value += brick[e] * weight
        protectedSample ||= !!(passive?.void?.[e] || passive?.solid?.[e])
        voidNeighbor ||= !!passive?.void?.[e]
      }
      pins[i] = Number(protectedSample)
      samples[i] = voidNeighbor ? value : Math.max(value, floor[owner])
    }
  }
  // Larger grids already have fine physical sampling. Keep the same 2? field
  // and bound smoothing displacement by the refined cell size.
  const surface = marchingCubes(samples, refined, threshold, { solid: pins })
  return smoothSurface(surface, refined, passes, 0.5, -0.53, 0.35)
}

export function taubinSmooth(mesh: Surface3D, grid: Grid3D, passes: number, lambda = 0.5, mu = -0.53): Surface3D {
  if (passes < 1 || !mesh.triangles.length) return mesh
  return smoothSurface(mesh, grid, passes, lambda, mu).surface
}

function smoothSurface(mesh: Surface3D, grid: Grid3D, passes: number, lambda = 0.5, mu = -0.53, offsetCells = 0.08) {
  if (passes < 1 || !mesh.triangles.length) return { surface: mesh, valid: validateSurface3D(mesh) }
  const { triangles, pinned } = mesh
  const validate = surfaceValidator3D(triangles, mesh.vertices.length / 3)
  const valid = { obj: !!validate?.(mesh.vertices), stl: !!validate?.(Float32Array.from(mesh.vertices)) }
  if (!validate || !valid.obj || !valid.stl) return { surface: mesh, valid }
  let vertices = mesh.vertices.slice()
  const smoothed = vertices.slice()
  let expanded = vertices.slice()
  const rounded = new Float32Array(vertices.length)
  const limits = [grid.widthMm, grid.heightMm, grid.depthMm]
  const boundary = Uint8Array.from(vertices, (value, i) => Number(!!pinned?.[Math.floor(i / 3)] || value === 0 || value === limits[i % 3]))
  const maxOffset = Math.min(...cellSize(grid)) * offsetCells / Math.sqrt(3)
  const adjacency = Array.from({ length: vertices.length / 3 }, () => new Set<number>())
  for (let i = 0; i < triangles.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      const v = triangles[i + j], w = triangles[i + (j + 1) % 3]
      adjacency[v].add(w)
      adjacency[w].add(v)
    }
  }
  const ranges = Float64Array.from(adjacency, (neighbors, vertex) => {
    let limit = maxOffset
    for (const neighbor of neighbors) {
      const a = 3 * vertex, b = 3 * neighbor
      limit = Math.min(limit, 0.3 * Math.hypot(vertices[a] - vertices[b], vertices[a + 1] - vertices[b + 1], vertices[a + 2] - vertices[b + 2]))
    }
    return limit
  })
  function pass(input: Float64Array, output: Float64Array, weight: number) {
    for (let i = 0; i < input.length; i++) {
      const d = i % 3
      const neighbors = adjacency[(i - d) / 3]
      let delta = 0
      for (const neighbor of neighbors) delta += input[3 * neighbor + d] - input[i]
      const value = input[i] + weight * delta / (neighbors.size || 1)
      const original = mesh.vertices[i], range = ranges[(i - d) / 3]
      output[i] = boundary[i] ? original : Math.min(limits[d], original + range, Math.max(0, original - range, value))
    }
    keepOrientations(input, output)
  }
  function keepOrientations(input: Float64Array, output: Float64Array) {
    // A failing facet freezes only its incident vertices. Repeat because
    // reverting a shared vertex can change the orientation of its neighbors.
    let changed: boolean
    do {
      changed = false
      rounded.set(output)
      for (let i = 0; i < triangles.length; i += 3) {
        const a = triangles[i], b = triangles[i + 1], c = triangles[i + 2]
        const before = triangleNormal(input, a, b, c)
        const after = triangleNormal(rounded, a, b, c)
        if (before[0] * after[0] + before[1] * after[1] + before[2] * after[2] > 0) continue
        for (const vertex of [a, b, c]) for (let d = 0; d < 3; d++) {
          const coordinate = 3 * vertex + d
          if (output[coordinate] === input[coordinate]) continue
          output[coordinate] = input[coordinate]
          changed = true
        }
      }
    } while (changed)
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
    let weight = 1
    for (; weight >= 1 / 64; weight *= 0.5) {
      pass(vertices, smoothed, lambda * weight)
      pass(smoothed, expanded, mu * weight)
      const rejected = new Uint8Array(vertices.length / 3)
      const validObject = validate(expanded, rejected)
      const validFloat = validate(rounded, rejected)
      if (!validObject || !validFloat) {
        for (let v = 0; v < rejected.length; v++) if (rejected[v]) expanded.set(vertices.subarray(3 * v, 3 * v + 3), 3 * v)
        keepOrientations(vertices, expanded)
      }
      if (volume6(expanded) >= minimumVolume && ((validObject && validFloat) || (validate(expanded) && validate(rounded)))) break
    }
    if (weight < 1 / 64) break
    const previous = vertices
    vertices = expanded
    expanded = previous
  }
  return { surface: { ...mesh, vertices }, valid }
}

export function extractSurface3D(density: ArrayLike<number>, grid: Grid3D, threshold = 0.5, passes = 4, passive?: PassiveMasks,
  elementType: ElementType3D = 'hex8') {
  if (passes < 1) return (elementType === 'tet4' ? marchingTetrahedra : marchingCubes)(density, grid, threshold, passive)
  return prepareSurface3D(density, grid, threshold, passes, passive, elementType).surface
}

/** Extract and validate at both export precisions, reusing validation from smoothing. */
export function prepareSurface3D(density: ArrayLike<number>, grid: Grid3D, threshold = 0.5, passes = 4, passive?: PassiveMasks,
  elementType: ElementType3D = 'hex8') {
  const march = elementType === 'tet4' ? marchingTetrahedra : marchingCubes
  return smoothSurface(march(density, grid, threshold, passive), grid, passes)
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
