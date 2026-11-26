import { brickMasks3D } from './design3d'
import { tetFaces } from './elementT4'
import { cellSize, elementIndex, nodePosition, nodeIndex3D, ProblemError3D, type Grid3D, type SimpProblem3D } from './types3d'

export interface AdaptiveOptions3D {
  refineLoads: boolean
  refineFeatures: boolean
  maxLevel: 1 | 2
}

export const defaultAdaptiveOptions3D: AdaptiveOptions3D = { refineLoads: true, refineFeatures: true, maxLevel: 2 }

type Point = [number, number, number]
export type OctreeLeaf3D = { origin: Point; size: number; level: number }

export interface AdaptiveMesh3D {
  positions: Float64Array
  tetrahedra: Uint32Array
  neighbors: Int32Array
  levels: Uint8Array
  bricks: Uint32Array
  centroids: Float64Array
  volumes: Float64Array
  stats: { nodes: number; elements: number; levelCounts: Point; minEdgeMm: number; maxEdgeMm: number; minJacobian: number; minQuality: number }
  leaves: OctreeLeaf3D[]
  leafOffsets: Uint32Array
  /** Ownership of each integer lattice voxel, including passive voids. */
  owners: Int32Array
  dimensions: Point
  pitch: Point
}

export interface AdaptiveField3D {
  mesh: AdaptiveMesh3D
  density: Float64Array
  vonMises: Float64Array
  threshold?: number
}

const corners = Array.from({ length: 8 }, (_, i) => [i & 1, i >> 1 & 1, i >> 2])
const axes = [0, 1, 2]
const point = (values: number[]) => values as Point

export function tetCoordinates3D(positions: Float64Array, ids: ArrayLike<number>, offset = 0) {
  const i = 3 * ids[offset]
  const vectors = [1, 2, 3].map(j => {
    const k = 3 * ids[offset + j]
    return axes.map(d => positions[k + d] - positions[i + d])
  })
  return simplex(vectors)
}

function simplex([a, b, c]: number[][]) {
  const cross = (u: number[], v: number[]) => point([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]])
  const rows = [cross(b, c), cross(c, a), cross(a, b)]
  return { rows, det: a[0] * rows[0][0] + a[1] * rows[0][1] + a[2] * rows[0][2] }
}

function split({ origin, size, level }: OctreeLeaf3D): OctreeLeaf3D[] {
  const half = size / 2
  return corners.map(corner => ({ origin: point(origin.map((v, d) => v + half * corner[d])), size: half, level: level + 1 }))
}

function ownerIndex(dims: Point, x: number, y: number, z: number) {
  return x + dims[0] * (y + dims[1] * z)
}

function ownersOf(leaves: OctreeLeaf3D[], dims: Point) {
  const owners = new Int32Array(dims[0] * dims[1] * dims[2])
  leaves.forEach(({ origin: [x, y, z], size }, i) => {
    for (let k = z; k < z + size; k++) for (let j = y; j < y + size; j++) {
      const start = ownerIndex(dims, x, j, k)
      owners.fill(i, start, start + size)
    }
  })
  return owners
}

function brickAt(grid: Grid3D, xyz: number[]) {
  const size = cellSize(grid)
  const dims = [grid.nelx, grid.nely, grid.nelz]
  return elementIndex(grid, ...point(xyz.map((v, d) => Math.min(dims[d] - 1, Math.max(0, Math.floor(v / size[d]))))))
}

function featureTargets(problem: SimpProblem3D, options: AdaptiveOptions3D, dims: Point, pitch: Point, size: number) {
  const { grid, supports, loadCases } = problem
  const { solid, voidMask } = brickMasks3D(problem)
  const { nelx: nx, nely: ny, nelz: nz } = grid
  const counts = [nx, ny, nz]
  const targets = new Uint8Array(dims[0] * dims[1] * dims[2])
  const voxelWidth = dims.map((n, d) => n / counts[d])
  const stamp = (low: number[], high: number[], level: number) => {
    for (let z = Math.max(0, low[2]); z < Math.min(dims[2], high[2]); z++) {
      for (let y = Math.max(0, low[1]); y < Math.min(dims[1], high[1]); y++) {
        for (let x = Math.max(0, low[0]); x < Math.min(dims[0], high[0]); x++) {
          const i = ownerIndex(dims, x, y, z)
          targets[i] = Math.max(targets[i], level)
        }
      }
    }
  }
  const physicalPoint = (node: number) => nodePosition(grid, node).map((v, d) => Math.round(v / pitch[d]))
  const markPoint = (node: number, padding: number, level: number) => {
    const xyz = physicalPoint(node)
    stamp(xyz.map(v => v - 1 - padding), xyz.map(v => v + 1 + padding), level)
  }
  // Keep edited boundary conditions at their exact coordinates even when the
  // optional surrounding refinement is disabled.
  const anchors = [...supports.filter(s => s.fixX || s.fixY || s.fixZ), ...loadCases.flatMap(load => load.forces.filter(f => f.fx || f.fy || f.fz))]
  for (const { node } of anchors) {
    if (node < 0 || node >= (nx + 1) * (ny + 1) * (nz + 1) || !Number.isInteger(node)) continue
    if (options.refineLoads) markPoint(node, Math.floor(size / 4), 1)
    else if (physicalPoint(node).some(v => v % size !== 0)) markPoint(node, 0, 1)
  }
  if (options.refineLoads && options.maxLevel === 2) {
    for (const load of loadCases) for (const force of load.forces) {
      if (Number.isInteger(force.node) && force.node >= 0 && force.node < (nx + 1) * (ny + 1) * (nz + 1)
        && (force.fx || force.fy || force.fz)) markPoint(force.node, 0, 2)
    }
  }
  const kind = (x: number, y: number, z: number) => {
    const e = elementIndex(grid, x, y, z)
    return voidMask[e] ? 2 : solid[e]
  }
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const value = kind(x, y, z)
    if (!value) continue
    const xyz = [x, y, z]
    const hasInterface = axes.some(d => [-1, 1].some(step => {
      const near = xyz.slice()
      near[d] += step
      return near[d] >= 0 && near[d] < counts[d] && kind(near[0], near[1], near[2]) !== value
    }))
    if (!hasInterface) continue
    // Level one resolves the original mask exactly when it cuts a base brick.
    // Optional feature refinement adds detail to both sides of the interface.
    const padding = options.refineFeatures ? 1 : 0
    stamp(xyz.map((v, d) => v * voxelWidth[d] - padding),
      xyz.map((v, d) => (v + 1) * voxelWidth[d] + padding), options.refineFeatures ? options.maxLevel : 1)
  }
  return targets
}

function mirrorVoxel(i: number, dims: Point, sy: boolean, sz: boolean) {
  const x = i % dims[0], y = Math.floor(i / dims[0]) % dims[1], z = Math.floor(i / (dims[0] * dims[1]))
  return ownerIndex(dims, x, sy ? dims[1] - 1 - y : y, sz ? dims[2] - 1 - z : z)
}

export function generateAdaptiveMesh3D(problem: SimpProblem3D, field?: AdaptiveField3D): AdaptiveMesh3D {
  const { grid, params, adaptive = defaultAdaptiveOptions3D } = problem
  const latticeSize = 4
  const counts = [grid.nelx, grid.nely, grid.nelz]
  if (!counts.every(n => Number.isSafeInteger(n) && n > 0) || ![grid.widthMm, grid.heightMm, grid.depthMm]
    .every(n => Number.isFinite(n) && n > 0) || ![1, 2].includes(adaptive.maxLevel)) throw new ProblemError3D('settings3dError')
  const base = counts.map(n => n % 2 ? n : n / 2)
  const dims = point(base.map(n => n * latticeSize))
  const pitch = point([grid.widthMm, grid.heightMm, grid.depthMm].map((v, d) => v / dims[d]))
  let leaves: OctreeLeaf3D[] = []
  for (let z = 0; z < dims[2]; z += latticeSize) for (let y = 0; y < dims[1]; y += latticeSize) for (let x = 0; x < dims[0]; x += latticeSize) {
    leaves.push({ origin: [x, y, z], size: latticeSize, level: 0 })
  }
  const targets = featureTargets(problem, adaptive, dims, pitch, latticeSize)
  if (field) {
    const { density, vonMises, mesh, threshold = 0.5 } = field
    if (density.length !== mesh.stats.elements || vonMises.length !== mesh.stats.elements
      || dims.some((n, d) => n !== mesh.dimensions[d] || pitch[d] !== mesh.pitch[d])) throw new RangeError('AMR field does not match the domain')
    leaves = mesh.leaves
    const stresses = Array.from(vonMises).filter((v, e) => density[e] > 0.2 && v > 0).sort((a, b) => a - b)
    const cutoff = stresses[Math.floor(0.9 * stresses.length)] ?? Infinity
    leaves.forEach(({ origin: [x, y, z], size, level }, leaf) => {
      if (level >= adaptive.maxLevel) return
      for (let e = mesh.leafOffsets[leaf]; e < mesh.leafOffsets[leaf + 1]; e++) {
        if ((density[e] > 0.2 && vonMises[e] >= cutoff)
          || mesh.neighbors.subarray(4 * e, 4 * e + 4).some(n => n >= 0 && (density[e] >= threshold) !== (density[n] >= threshold))) {
          targets[ownerIndex(dims, x + size / 2 | 0, y + size / 2 | 0, z + size / 2 | 0)] = level + 1
          break
        }
      }
    })
  }
  const sy = !!params.symmetry?.includes('y'), sz = !!params.symmetry?.includes('z')
  if (sy || sz) for (let i = 0; i < targets.length; i++) {
    if (sy) targets[i] = targets[mirrorVoxel(i, dims, true, false)] = Math.max(targets[i], targets[mirrorVoxel(i, dims, true, false)])
    if (sz) targets[i] = targets[mirrorVoxel(i, dims, false, true)] = Math.max(targets[i], targets[mirrorVoxel(i, dims, false, true)])
  }
  function refine(leaf: OctreeLeaf3D): OctreeLeaf3D[] {
    const { origin: [x, y, z], size, level } = leaf
    if (level < adaptive.maxLevel) {
      for (let k = z; k < z + size; k++) for (let j = y; j < y + size; j++) for (let i = x; i < x + size; i++) {
        if (targets[ownerIndex(dims, i, j, k)] > level) return split(leaf).flatMap(refine)
      }
    }
    return [leaf]
  }
  leaves = leaves.flatMap(refine)
  let owners = ownersOf(leaves, dims)
  // Balance across faces and edges. Check each pair of finest voxels once.
  const offsets = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [-1, 1, 0],
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1]]
  for (;;) {
    const marked = new Set<number>()
    for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++) {
      const a = owners[ownerIndex(dims, x, y, z)]
      for (const [dx, dy, dz] of offsets) {
        if (x + dx < 0 || x + dx >= dims[0] || y + dy < 0 || y + dy >= dims[1] || z + dz >= dims[2]) continue
        const b = owners[ownerIndex(dims, x + dx, y + dy, z + dz)]
        if (leaves[a].level + 1 < leaves[b].level) marked.add(a)
        if (leaves[b].level + 1 < leaves[a].level) marked.add(b)
      }
    }
    if (!marked.size) break
    leaves = leaves.flatMap((leaf, i) => marked.has(i) ? split(leaf) : [leaf])
    owners = ownersOf(leaves, dims)
  }
  if (field && leaves.length === field.mesh.leaves.length) return field.mesh
  return tetrahedralize(grid, leaves, owners, dims, pitch, sy || sz)
}

function tetrahedralize(grid: Grid3D, leaves: OctreeLeaf3D[], owners: Int32Array, dims: Point, pitch: Point, symmetric: boolean): AdaptiveMesh3D {
  const positions: number[] = [], tetrahedra: number[] = [], levels: number[] = [], bricks: number[] = []
  const centroids: number[] = [], volumes: number[] = [], leafOffsets = new Uint32Array(leaves.length + 1)
  const vertices = new Map<number, number>()
  const levelCounts: Point = [0, 0, 0]
  let minEdgeMm = Infinity, maxEdgeMm = 0, minJacobian = Infinity, minQuality = Infinity
  const key = (p: number[]) => 2 * p[0] + (2 * dims[0] + 1) * (2 * p[1] + (2 * dims[1] + 1) * 2 * p[2])
  function vertex(p: number[]) {
    const k = key(p)
    const old = vertices.get(k)
    if (old !== undefined) return old
    const id = positions.length / 3
    vertices.set(k, id)
    positions.push(...p.map((v, d) => v * pitch[d]))
    return id
  }
  // Keep corner membership separate from subsequently allocated face/cell
  // centers. Either side of a face then discovers exactly the same edge nodes.
  for (const { origin, size } of leaves) for (const corner of corners) vertex(origin.map((v, d) => v + size * corner[d]))
  const leafCorners = new Set(vertices.keys())
  leaves.forEach(({ origin, size, level }, leaf) => {
    const center = vertex(origin.map(v => v + size / 2))
    const brick = brickAt(grid, origin.map((v, d) => (v + size / 2) * pitch[d]))
    leafOffsets[leaf] = levels.length
    function emit(a: number, b: number, c: number) {
      const ids = [center, a, b, c]
      const vectors = ids.slice(1).map(id => axes.map(d => positions[3 * id + d] - positions[3 * center + d]))
      const det = simplex(vectors).det
      if (!det) throw new Error('Degenerate adaptive tetrahedron')
      if (det < 0) [ids[2], ids[3]] = [ids[3], ids[2]]
      let longest = 0
      for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
        const length = Math.hypot(...axes.map(d => positions[3 * ids[i] + d] - positions[3 * ids[j] + d]))
        minEdgeMm = Math.min(minEdgeMm, length)
        longest = Math.max(longest, length)
      }
      maxEdgeMm = Math.max(maxEdgeMm, longest)
      minJacobian = Math.min(minJacobian, Math.abs(det))
      minQuality = Math.min(minQuality, Math.SQRT2 * Math.abs(det) / longest ** 3)
      volumes.push(Math.abs(det) / 6)
      centroids.push(...axes.map(d => ids.reduce((sum, id) => sum + positions[3 * id + d], 0) / 4))
      tetrahedra.push(...ids)
      levelCounts[level]++
      levels.push(level)
      bricks.push(brick)
    }
    for (const normal of axes) for (const side of [0, 1]) {
      const u = (normal + 1) % 3, v = (normal + 2) % 3
      const face = origin.slice()
      face[normal] += side * size
      const probe = origin.map(p => p + Math.floor(size / 2))
      probe[normal] = face[normal] + side - 1
      const other = probe[normal] >= 0 && probe[normal] < dims[normal]
        ? leaves[owners[ownerIndex(dims, probe[0], probe[1], probe[2])]] : undefined
      const tile = Math.min(size, other?.size ?? size)
      for (let j = 0; j < size; j += tile) for (let i = 0; i < size; i += tile) {
        const at = (a: number, b: number) => {
          const p = face.slice()
          p[u] += i + a * tile
          p[v] += j + b * tile
          return p
        }
        const loop = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]]
          .map(([a, b]) => at(a, b)).filter((p, k) => !(k & 1) || leafCorners.has(key(p))).map(vertex)
        if (loop.length === 4 && !symmetric) {
          emit(loop[0], loop[1], loop[2])
          emit(loop[0], loop[2], loop[3])
        } else {
          const mid = vertex(at(0.5, 0.5))
          for (let k = 0; k < loop.length; k++) emit(mid, loop[k], loop[(k + 1) % loop.length])
        }
      }
    }
  })
  leafOffsets[leaves.length] = levels.length
  const neighbors = new Int32Array(tetrahedra.length).fill(-1)
  const faces = new Map<string, number>()
  for (let e = 0; e < levels.length; e++) tetFaces.forEach((face, i) => {
    const key = face.map(j => tetrahedra[4 * e + j]).sort((a, b) => a - b).join(',')
    const f = 4 * e + i
    const prior = faces.get(key)
    if (prior === undefined) faces.set(key, f)
    else {
      neighbors[prior] = e
      neighbors[f] = Math.floor(prior / 4)
      faces.delete(key)
    }
  })
  return { positions: Float64Array.from(positions), tetrahedra: Uint32Array.from(tetrahedra), neighbors,
    levels: Uint8Array.from(levels), bricks: Uint32Array.from(bricks), centroids: Float64Array.from(centroids),
    volumes: Float64Array.from(volumes), leaves, leafOffsets, owners, dimensions: dims, pitch,
    stats: { nodes: positions.length / 3, elements: levels.length, levelCounts, minEdgeMm, maxEdgeMm, minJacobian, minQuality } }
}

export function locateAdaptiveTet3D(mesh: AdaptiveMesh3D, xyz: ArrayLike<number>, offset = 0) {
  const { dimensions: dims, pitch, owners, leafOffsets, tetrahedra, positions } = mesh
  const at = axes.map(d => Math.min(dims[d] - 1, Math.max(0, Math.floor(xyz[offset + d] / pitch[d] + 1e-10))))
  const leaf = owners[ownerIndex(dims, at[0], at[1], at[2])]
  for (let e = leafOffsets[leaf]; e < leafOffsets[leaf + 1]; e++) {
    const { rows, det } = tetCoordinates3D(positions, tetrahedra, 4 * e)
    const n = 3 * tetrahedra[4 * e]
    const weights = rows.map(row => row.reduce((sum, v, d) => sum + v * (xyz[offset + d] - positions[n + d]), 0) / det)
    if (weights.every(v => v >= -1e-9) && weights[0] + weights[1] + weights[2] <= 1 + 1e-9) return e
  }
  throw new Error('Point outside adaptive mesh')
}

export function transferAdaptiveDensity3D(mesh: AdaptiveMesh3D, previous: AdaptiveMesh3D, density: Float64Array) {
  return Float64Array.from(mesh.volumes, (_, e) => density[locateAdaptiveTet3D(previous, mesh.centroids, 3 * e)])
}

/** Restrain new nodes on fully supported reference faces/edges as well as the
 * original point supports. Point forces stay at their exact reference nodes. */
export function adaptiveBoundary3D(problem: SimpProblem3D, mesh: AdaptiveMesh3D) {
  const { grid } = problem
  const counts = [grid.nelx, grid.nely, grid.nelz]
  const steps = cellSize(grid)
  const flags = ['fixX', 'fixY', 'fixZ'] as const
  const byNode = new Map<number, number>()
  for (const s of problem.supports) {
    const value = flags.reduce((mask, axis, i) => mask | (s[axis] ? 1 << i : 0), byNode.get(s.node) ?? 0)
    byNode.set(s.node, value)
  }
  const original = new Map<number, number>()
  const supports: SimpProblem3D['supports'][number][] = []
  for (let node = 0; node < mesh.stats.nodes; node++) {
    const q = axes.map(d => mesh.positions[3 * node + d] / steps[d])
    const lo = q.map((v, d) => Math.max(0, Math.min(counts[d], Math.floor(v + 1e-9))))
    const hi = q.map((v, d) => Math.max(0, Math.min(counts[d], Math.ceil(v - 1e-9))))
    if (lo.every((v, d) => v === hi[d])) original.set(nodeIndex3D(grid, ...point(lo)), node)
    if (!byNode.size) continue
    let mask = 7
    for (const corner of corners) {
      const reference = nodeIndex3D(grid, ...point(corner.map((v, d) => (v ? hi : lo)[d])))
      mask &= byNode.get(reference) ?? 0
      if (!mask) break
    }
    if (mask) supports.push({ node, fixX: !!(mask & 1), fixY: !!(mask & 2), fixZ: !!(mask & 4) })
  }
  return { supports, original,
    loadCases: problem.loadCases.map(load => ({ ...load, forces: load.forces.map(f => ({ ...f, node: original.get(f.node) ?? -1 })) })) }
}
