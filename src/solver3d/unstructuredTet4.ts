import { adaptiveBoundary3D, tetCoordinates3D, type AdaptiveMesh3D } from './adaptiveMesh3d'
import { brickMasks3D, rigidRankAt3D } from './design3d'
import { elasticity3D } from './elementH8'
import { tet4Stiffness } from './elementT4'
import { ProblemError3D, type SimpProblem3D, type Support3D } from './types3d'

export function unstructuredTet4Element(positions: Float64Array, ids: ArrayLike<number>, E: number, nu: number) {
  const { rows, det } = tetCoordinates3D(positions, ids)
  if (!(det > 0)) throw new RangeError('Tet4 requires a positive Jacobian')
  const grads = rows.map(row => row.map(value => value / det))
  grads.unshift(grads[0].map((_, d) => -grads[0][d] - grads[1][d] - grads[2][d]))
  const centroid = [0, 1, 2].map(d => (positions[3 * ids[0] + d] + positions[3 * ids[1] + d]
    + positions[3 * ids[2] + d] + positions[3 * ids[3] + d]) / 4)
  return { ...tet4Stiffness(grads, det / 6, elasticity3D(E, nu)), centroid }
}

export class UnstructuredStiffness3D {
  readonly width = 12
  readonly dofs: Int32Array
  readonly templateIndex: Int32Array
  readonly matrices: Float64Array[] = []
  readonly strains: Float64Array[] = []
  readonly inverseDiagonal: Float64Array
  private readonly starts: Int32Array
  private readonly columns: Int32Array
  private readonly values: Float64Array
  private readonly slots: Int32Array
  private readonly diagonal: Int32Array

  constructor(readonly mesh: AdaptiveMesh3D, nu: number, readonly fixed: Uint8Array) {
    const { tetrahedra, positions } = mesh
    const count = tetrahedra.length / 4, nodes = positions.length / 3
    this.dofs = new Int32Array(count * 12)
    this.templateIndex = new Int32Array(count)
    this.inverseDiagonal = new Float64Array(fixed.length)
    this.starts = new Int32Array(nodes + 1)
    this.diagonal = new Int32Array(nodes)
    this.slots = new Int32Array(count * 16)
    const adjacency = Array.from({ length: nodes }, () => new Map<number, number>())
    const templates = new Map<string, number>()
    for (let e = 0; e < count; e++) {
      const ids = tetrahedra.subarray(4 * e, 4 * e + 4)
      for (let i = 0; i < 4; i++) {
        for (const j of ids) adjacency[ids[i]].set(j, 0)
        for (let d = 0; d < 3; d++) this.dofs[12 * e + 3 * i + d] = 3 * ids[i] + d
      }
      // Cache only geometrically identical local Jacobians.
      const key = Array.from(ids.subarray(1)).flatMap(id => [0, 1, 2].map(d =>
        positions[3 * id + d] - positions[3 * ids[0] + d])).join(',')
      let template = templates.get(key)
      if (template === undefined) {
        template = this.matrices.length
        const { B, Ke } = unstructuredTet4Element(positions, ids, 1, nu)
        this.matrices.push(Ke)
        this.strains.push(B)
        templates.set(key, template)
      }
      this.templateIndex[e] = template
    }
    const columns: number[] = []
    for (let i = 0; i < nodes; i++) {
      this.starts[i] = columns.length
      for (const j of adjacency[i].keys()) {
        if (j === i) this.diagonal[i] = 9 * columns.length
        adjacency[i].set(j, 9 * columns.length)
        columns.push(3 * j)
      }
    }
    this.starts[nodes] = columns.length
    this.columns = Int32Array.from(columns)
    this.values = new Float64Array(9 * columns.length)
    for (let e = 0; e < count; e++) for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      this.slots[16 * e + 4 * i + j] = adjacency[tetrahedra[4 * e + i]].get(tetrahedra[4 * e + j])!
    }
  }

  prepare(modulus: Float64Array) {
    const { matrices, templateIndex, values, fixed, dofs, slots, inverseDiagonal, diagonal } = this
    values.fill(0)
    for (let e = 0; e < modulus.length; e++) {
      const Ke = matrices[templateIndex[e]], E = modulus[e]
      for (let i = 0; i < 12; i += 3) for (let j = 0; j < 12; j += 3) {
        const block = slots[16 * e + 4 * (i / 3) + j / 3]
        const col = dofs[12 * e + j]
        for (let d = 0; d < 3; d++) {
          if (fixed[dofs[12 * e + i + d]]) continue
          const k = 12 * (i + d) + j, at = block + 3 * d
          if (!fixed[col]) values[at] += E * Ke[k]
          if (!fixed[col + 1]) values[at + 1] += E * Ke[k + 1]
          if (!fixed[col + 2]) values[at + 2] += E * Ke[k + 2]
        }
      }
    }
    for (let d = 0; d < fixed.length; d++) inverseDiagonal[d] = fixed[d] ? 0 : 1 / values[diagonal[Math.floor(d / 3)] + 4 * (d % 3)]
  }

  apply(input: Float64Array, output: Float64Array) {
    const { columns, starts, values } = this
    for (let i = 0; i < starts.length - 1; i++) {
      let x = 0, y = 0, z = 0
      for (let n = starts[i], k = 9 * n; n < starts[i + 1]; n++, k += 9) {
        const d = columns[n], a = input[d], b = input[d + 1], c = input[d + 2]
        x += values[k] * a + values[k + 1] * b + values[k + 2] * c
        y += values[k + 3] * a + values[k + 4] * b + values[k + 5] * c
        z += values[k + 6] * a + values[k + 7] * b + values[k + 8] * c
      }
      output[3 * i] = x
      output[3 * i + 1] = y
      output[3 * i + 2] = z
    }
  }
}

/** Each row is the isotropic cone times source volume, normalized to unit sum.
 * The grid limits candidate searches to 27 bins. Work scales with the number
 * of candidate pairs, including the unavoidable neighbors in dense regions. */
export class UnstructuredConeFilter3D {
  private readonly starts: Uint32Array
  private readonly columns: Uint32Array[] = []
  private readonly weights: Float64Array[] = []
  private readonly inverse: Float64Array
  private readonly nearRows: (number[][] | undefined)[]
  private cachedRows = 0

  constructor(private readonly centroids: Float64Array, private readonly volumes: Float64Array,
    private readonly rminPhys: number, voidMask: Uint8Array) {
    const count = volumes.length
    const starts = this.starts = new Uint32Array(count + 1)
    this.inverse = new Float64Array(count)
    this.nearRows = new Array(count)
    const buckets = new Map<string, number[]>()
    const xyz = Array.from({ length: count }, (_, e) =>
      [0, 1, 2].map(d => Math.floor(centroids[3 * e + d] / rminPhys)))
    for (let e = 0; e < count; e++) {
      if (voidMask[e]) continue
      const key = xyz[e].join(',')
      const bucket = buckets.get(key)
      if (bucket) bucket.push(e)
      else buckets.set(key, [e])
    }
    const chunk = 65536
    // Cap adjacency storage. Large radii reuse the same spatial bins for
    // uncached rows instead of allocating a nearly dense matrix.
    const capacity = 384 * chunk
    let length = 0
    const neighborhood = new Map<string, number[][]>()
    for (let e = 0; e < count; e++) {
      starts[e] = length
      if (length < capacity) this.cachedRows = e + 1
      if (voidMask[e]) continue
      const [x, y, z] = xyz[e]
      const key = xyz[e].join(',')
      let near = neighborhood.get(key)
      if (!near) {
        near = []
        for (let k = z - 1; k <= z + 1; k++) for (let j = y - 1; j <= y + 1; j++) for (let i = x - 1; i <= x + 1; i++) {
          const bucket = buckets.get([i, j, k].join(','))
          if (bucket) near.push(bucket)
        }
        neighborhood.set(key, near)
      }
      if (length >= capacity) this.nearRows[e] = near
      let sum = 0
      for (const bucket of near) for (const j of bucket) {
        const weight = this.weight(e, j)
        if (!weight) continue
        sum += weight
        if (length === capacity) {
          this.cachedRows = Math.min(this.cachedRows, e)
          this.nearRows[e] = near
          continue
        }
        if (length % chunk === 0) {
          this.columns.push(new Uint32Array(chunk))
          this.weights.push(new Float64Array(chunk))
        }
        this.columns[length >>> 16][length & 65535] = j
        this.weights[length >>> 16][length & 65535] = weight
        length++
      }
      this.inverse[e] = 1 / sum
      if (e < this.cachedRows) for (let i = starts[e]; i < length; i++) this.weights[i >>> 16][i & 65535] /= sum
    }
    starts[count] = length
  }

  private weight(e: number, j: number) {
    const { centroids, rminPhys, volumes } = this
    const a = 3 * e, b = 3 * j
    const dx = centroids[a] - centroids[b], dy = centroids[a + 1] - centroids[b + 1], dz = centroids[a + 2] - centroids[b + 2]
    const square = dx * dx + dy * dy + dz * dz
    return square < rminPhys * rminPhys ? volumes[j] * (rminPhys - Math.sqrt(square)) : 0
  }

  apply(input: Float64Array, output: Float64Array) {
    const { starts, columns, weights, cachedRows, nearRows, inverse } = this
    for (let e = 0; e < output.length; e++) {
      const near = nearRows[e]
      let sum = 0
      if (e < cachedRows) {
        for (let j = starts[e]; j < starts[e + 1]; j++) sum += weights[j >>> 16][j & 65535] * input[columns[j >>> 16][j & 65535]]
      } else if (near) {
        for (const bucket of near) for (const j of bucket) sum += this.weight(e, j) * input[j]
        sum *= inverse[e]
      }
      output[e] = sum
    }
    return output
  }

  transpose(input: Float64Array, output: Float64Array) {
    const { starts, columns, weights, cachedRows, nearRows, inverse } = this
    output.fill(0)
    for (let e = 0; e < input.length; e++) {
      const value = input[e], near = nearRows[e]
      if (value === 0) continue
      if (e < cachedRows) {
        for (let j = starts[e]; j < starts[e + 1]; j++) output[columns[j >>> 16][j & 65535]] += weights[j >>> 16][j & 65535] * value
      } else if (near) {
        const scaled = value * inverse[e]
        for (const bucket of near) for (const j of bucket) output[j] += this.weight(e, j) * scaled
      }
    }
    return output
  }
}

export function unstructuredSetup3D(problem: SimpProblem3D, mesh: AdaptiveMesh3D) {
  const brickMasks = brickMasks3D(problem)
  const solid = Uint8Array.from(mesh.bricks, e => brickMasks.solid[e])
  const voidMask = Uint8Array.from(mesh.bricks, e => brickMasks.voidMask[e])
  const { supports, loadCases } = adaptiveBoundary3D(problem, mesh)
  const { nodes, elements } = mesh.stats
  const parent = Int32Array.from({ length: nodes }, (_, i) => i)
  const live = new Uint8Array(nodes)
  function root(i: number) {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  let allowed = 0
  for (let e = 0; e < elements; e++) {
    if (voidMask[e]) continue
    allowed += mesh.volumes[e]
    const first = root(mesh.tetrahedra[4 * e])
    for (let j = 0; j < 4; j++) {
      const node = mesh.tetrahedra[4 * e + j]
      live[node] = 1
      parent[root(node)] = first
    }
  }
  const fixed = Uint8Array.from({ length: 3 * nodes }, (_, d) => 1 - live[Math.floor(d / 3)])
  const components = new Map<number, Support3D[]>()
  for (let node = 0; node < nodes; node++) if (live[node] && root(node) === node) components.set(node, [])
  for (const s of supports) {
    if (!live[s.node]) continue
    components.get(root(s.node))!.push(s)
    for (const [d, flag] of [s.fixX, s.fixY, s.fixZ].entries()) if (flag) fixed[3 * s.node + d] = 1
  }
  const { widthMm, heightMm, depthMm } = problem.grid
  for (const restrained of components.values()) {
    if (rigidRankAt3D(restrained, nodes, Math.max(widthMm, heightMm, depthMm), n => mesh.positions.subarray(3 * n, 3 * n + 3)) < 6) {
      throw new ProblemError3D('componentSupport3dError')
    }
  }
  const forces = loadCases.map(({ forces }) => {
    const rhs = new Float64Array(fixed.length)
    for (const { node, fx, fy, fz } of forces) {
      if (!(fx || fy || fz)) continue
      if (!live[node]) throw new ProblemError3D('attachment3dError')
      if (!fixed[3 * node]) rhs[3 * node] += fx
      if (!fixed[3 * node + 1]) rhs[3 * node + 1] += fy
      if (!fixed[3 * node + 2]) rhs[3 * node + 2] += fz
    }
    return rhs
  })
  if (!forces.some(rhs => rhs.some(value => value !== 0))) throw new ProblemError3D('load3dError')
  const representatives = Int32Array.from(mesh.levels, (_, e) => e)
  const sy = problem.params.symmetry?.includes('y'), sz = problem.params.symmetry?.includes('z')
  if (sy || sz) {
    const stride = 8
    const dims = mesh.dimensions.map(n => n * stride)
    const coords = (e: number) => [0, 1, 2].map(d => Math.round(mesh.centroids[3 * e + d] * stride / mesh.pitch[d]))
    const byPoint = new Map<string, number>()
    for (let e = 0; e < elements; e++) byPoint.set(coords(e).join(','), e)
    for (let e = 0; e < elements; e++) {
      const [x, y, z] = coords(e)
      const rep = byPoint.get([x, sy ? Math.min(y, dims[1] - y) : y, sz ? Math.min(z, dims[2] - z) : z].join(','))
      if (rep === undefined) throw new Error('Missing mirrored tetrahedron')
      representatives[e] = rep
    }
  }
  return { solid, voidMask, fixed, forces, representatives, allowed, brickMasks: { solid: brickMasks.solid, void: brickMasks.voidMask } }
}
