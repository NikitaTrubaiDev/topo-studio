import { adaptiveBoundary3D, maxAdaptiveTetrahedra3D, tetCoordinates3D, type AdaptiveMesh3D } from './adaptiveMesh3d'
import { brickMasks3D, rigidComponents3D, rigidComponentsStable3D } from './design3d'
import { elasticity3D } from './elementH8'
import { tet4Stiffness } from './elementT4'
import { cellSize, ProblemError3D, type SimpProblem3D } from './types3d'
import { WasmFilter3D, type WasmBackend3D } from './wasmBackend'

export function unstructuredTet4Element(positions: Float64Array, ids: ArrayLike<number>, E: number, nu: number) {
  const { rows, det } = tetCoordinates3D(positions, ids)
  if (!(det > 0)) throw new RangeError('Tet4 requires a positive Jacobian')
  const grads = rows.map(row => row.map(value => value / det))
  grads.unshift(grads[0].map((_, d) => -grads[0][d] - grads[1][d] - grads[2][d]))
  const centroid = [0, 1, 2].map(d => (positions[3 * ids[0] + d] + positions[3 * ids[1] + d]
    + positions[3 * ids[2] + d] + positions[3 * ids[3] + d]) / 4)
  return { ...tet4Stiffness(grads, det / 6, elasticity3D(E, nu)), centroid }
}

export function adaptiveElementTemplates3D(mesh: AdaptiveMesh3D, nu: number) {
  const { tetrahedra, positions } = mesh
  const templateIndex = new Int32Array(tetrahedra.length / 4)
  const matrices: Float64Array[] = [], strains: Float64Array[] = []
  const templates = new Map<string, number>()
  for (let e = 0; e < templateIndex.length; e++) {
    const ids = tetrahedra.subarray(4 * e, 4 * e + 4)
    // Cache only geometrically identical local Jacobians.
    const key = Array.from(ids.subarray(1)).flatMap(id => [0, 1, 2].map(d =>
      positions[3 * id + d] - positions[3 * ids[0] + d])).join(',')
    let template = templates.get(key)
    if (template === undefined) {
      template = matrices.length
      const { B, Ke } = unstructuredTet4Element(positions, ids, 1, nu)
      matrices.push(Ke)
      strains.push(B)
      templates.set(key, template)
    }
    templateIndex[e] = template
  }
  return { templateIndex, matrices, strains }
}

export class UnstructuredStiffness3D {
  readonly width = 12
  readonly dofs: Int32Array
  readonly templateIndex: Int32Array
  readonly matrices: Float64Array[]
  readonly strains: Float64Array[]
  readonly inverseDiagonal: Float64Array
  private readonly starts: Int32Array
  private readonly columns: Int32Array
  private readonly values: Float64Array
  private readonly slots: Int32Array
  private readonly diagonal: Int32Array

  constructor(readonly mesh: AdaptiveMesh3D, nu: number, readonly fixed: Uint8Array,
    geometry = adaptiveElementTemplates3D(mesh, nu)) {
    const { tetrahedra, positions } = mesh
    const count = tetrahedra.length / 4, nodes = positions.length / 3
    this.dofs = new Int32Array(count * 12)
    this.templateIndex = geometry.templateIndex
    this.matrices = geometry.matrices
    this.strains = geometry.strains
    this.inverseDiagonal = new Float64Array(fixed.length)
    this.starts = new Int32Array(nodes + 1)
    this.diagonal = new Int32Array(nodes)
    this.slots = new Int32Array(count * 16)
    const adjacency = Array.from({ length: nodes }, () => new Map<number, number>())
    for (let e = 0; e < count; e++) {
      const ids = tetrahedra.subarray(4 * e, 4 * e + 4)
      for (let i = 0; i < 4; i++) {
        for (const j of ids) adjacency[ids[i]].set(j, 0)
        for (let d = 0; d < 3; d++) this.dofs[12 * e + 3 * i + d] = 3 * ids[i] + d
      }
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

const filterChunkSize = 65_536
const maxCachedPairs = 192 * filterChunkSize
const maxFilterPairs = 72_000_000
const maxCandidatePairs = 200_000_000
const maxAdaptiveBytes = 512 * 1024 ** 2

function filterWeight(centroids: Float64Array, e: number, j: number, radius: number) {
  const a = 3 * e, b = 3 * j
  const dx = centroids[a] - centroids[b], dy = centroids[a + 1] - centroids[b + 1], dz = centroids[a + 2] - centroids[b + 2]
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
  return distance < radius ? 1 - distance / radius : 0
}

type FilterBin = { elements: number[]; neighbors: number[][]; min: number[]; max: number[] }

export function preflightAdaptiveSolver3D(problem: SimpProblem3D, mesh: AdaptiveMesh3D, retainedBytes = 0) {
  const { elements, nodes } = mesh.stats
  const { centroids } = mesh
  const radius = problem.params.rmin * Math.min(...cellSize(problem.grid))
  // Worst-case CSR blocks and unique local Jacobians, plus mesh, solver,
  // transfer, analysis, and snapshot arrays, including per-case DOF storage.
  const bytes = elements * (16 * 76 + (144 + 72) * 8 + 256)
    + nodes * (256 + 3 * 8 * 4 * problem.loadCases.length)
    + mesh.owners.byteLength + mesh.leafOffsets.byteLength
  if (elements > maxAdaptiveTetrahedra3D || bytes + retainedBytes > maxAdaptiveBytes) {
    throw new ProblemError3D('adaptiveBudget3dError')
  }
  if (!(radius > 0 && Number.isFinite(radius))) throw new ProblemError3D('settings3dError')
  const { voidMask } = brickMasks3D(problem)
  const buckets = new Map<string, FilterBin>()
  const rows: (FilterBin | undefined)[] = new Array(elements)
  const binSize = radius / 2 || radius
  for (let e = 0; e < elements; e++) {
    if (voidMask[mesh.bricks[e]]) continue
    // Cap bin indices to keep adjacent-bin iteration safe even for tiny radii.
    const key = [0, 1, 2].map(d => Math.min(Number.MAX_SAFE_INTEGER - 4, Math.floor(centroids[3 * e + d] / binSize))).join(',')
    let bin = buckets.get(key)
    if (!bin) {
      bin = { elements: [], neighbors: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
      buckets.set(key, bin)
    }
    for (let d = 0; d < 3; d++) {
      const x = centroids[3 * e + d]
      bin.min[d] = Math.min(bin.min[d], x)
      bin.max[d] = Math.max(bin.max[d], x)
    }
    bin.elements.push(e)
    rows[e] = bin
  }
  let pairs = 0
  for (const [key, bin] of buckets) {
    const [x, y, z] = key.split(',').map(Number)
    for (let k = z - 2; k <= z + 2; k++) for (let j = y - 2; j <= y + 2; j++) for (let i = x - 2; i <= x + 2; i++) {
      const other = buckets.get([i, j, k].join(','))
      if (!other) continue
      let square = 0
      for (let d = 0; d < 3; d++) square += Math.max(0, bin.min[d] - other.max[d], other.min[d] - bin.max[d]) ** 2
      if (square > radius * radius) continue
      pairs += bin.elements.length * other.elements.length
      if (pairs > maxCandidatePairs) throw new ProblemError3D('adaptiveBudget3dError')
      bin.neighbors.push(other.elements)
    }
  }
  // Count actual neighbors only if bin occupancy cannot prove the work fits.
  if (pairs > maxFilterPairs) {
    pairs = 0
    for (let e = 0; e < elements; e++) for (const bin of rows[e]?.neighbors ?? []) for (const j of bin) {
      if (filterWeight(centroids, e, j, radius) > 0 && ++pairs > maxFilterPairs) throw new ProblemError3D('adaptiveBudget3dError')
    }
  }
  const available = Math.floor((maxAdaptiveBytes - bytes - retainedBytes) / (12 * filterChunkSize))
  const capacity = Math.min(maxCachedPairs, available * filterChunkSize, Math.ceil(pairs / filterChunkSize) * filterChunkSize)
  return { radius, rows, capacity, estimatedBytes: bytes + 12 * capacity, spareBytes: maxAdaptiveBytes - bytes - 12 * capacity - retainedBytes }
}

/** Normalize the volume-weighted cone. Rows beyond the cache limit use the
 * preflighted spatial bins, which also bound work for both filter passes. */
export class UnstructuredConeFilter3D {
  private readonly starts: Uint32Array
  private readonly columns: Uint32Array[] = []
  private readonly weights: Float64Array[] = []
  private readonly inverse: Float64Array
  private readonly uncached: (number[][] | undefined)[]
  private readonly cachedRows: number
  private readonly radius: number
  private wasm?: WasmFilter3D
  private wasmRows = 0
  private readonly wasmEntryLimit: number

  constructor(private readonly mesh: AdaptiveMesh3D, plan: ReturnType<typeof preflightAdaptiveSolver3D>) {
    const { volumes } = mesh
    const { rows, capacity } = plan
    this.radius = plan.radius
    this.wasmEntryLimit = Math.max(0, Math.floor((plan.spareBytes - 20 * volumes.length - 4) / 12))
    const starts = this.starts = new Uint32Array(volumes.length + 1)
    this.inverse = new Float64Array(volumes.length)
    let cachedRows = volumes.length, length = 0
    for (let e = 0; e < volumes.length; e++) {
      starts[e] = length
      let sum = 0
      for (const bin of rows[e]?.neighbors ?? []) for (const j of bin) {
        const weight = this.weight(e, j)
        if (!weight) continue
        sum += weight
        if (e >= cachedRows) continue
        if (length === capacity) {
          cachedRows = e
          length = starts[e]
          continue
        }
        if (length % filterChunkSize === 0) {
          this.columns.push(new Uint32Array(filterChunkSize))
          this.weights.push(new Float64Array(filterChunkSize))
        }
        this.columns[length >>> 16][length & 65535] = j
        this.weights[length >>> 16][length & 65535] = weight
        length++
      }
      if (sum > 0) this.inverse[e] = 1 / sum
      for (let i = starts[e]; i < length; i++) this.weights[i >>> 16][i & 65535] /= sum
    }
    starts[volumes.length] = length
    this.cachedRows = cachedRows
    this.uncached = rows.slice(cachedRows).map(bin => bin?.neighbors)
  }

  private weight(e: number, j: number) {
    return this.mesh.volumes[j] * filterWeight(this.mesh.centroids, e, j, this.radius)
  }

  setBackend(backend?: WasmBackend3D) {
    this.wasm?.dispose()
    this.wasm = undefined
    this.wasmRows = 0
    if (!backend || !this.cachedRows) return
    const { starts, columns, weights, cachedRows } = this
    // Retain the JS cache for live switching and respect the AMR budget.
    let rows = 0
    while (rows < cachedRows && starts[rows + 1] <= this.wasmEntryLimit) rows++
    if (rows === 0) return
    const count = this.mesh.volumes.length
    const entries = starts[rows]
    try {
      this.wasm = new WasmFilter3D(backend, count, memory => {
        const rowPtr = memory.upload(starts.subarray(0, rows + 1))
        const colPtr = memory.allocate(entries * 4), weightPtr = memory.allocate(entries * 8)
        const cols = memory.u32(colPtr, entries), values = memory.f64(weightPtr, entries)
        for (let i = 0; i < entries; i += filterChunkSize) {
          const end = Math.min(entries - i, filterChunkSize), chunk = i / filterChunkSize
          cols.set(columns[chunk].subarray(0, end), i)
          values.set(weights[chunk].subarray(0, end), i)
        }
        return (input, output, transpose) => backend.abi.filter_csr(rows, count, rowPtr, colPtr, weightPtr, input, output, transpose)
      })
      this.wasmRows = rows
    } catch {
      this.wasm = undefined
    }
  }

  get wasmBytes() {
    return this.wasm ? 16 * this.mesh.volumes.length + 4 * (this.wasmRows + 1) + 12 * this.starts[this.wasmRows] : 0
  }

  private accelerate(input: Float64Array, output: Float64Array, transpose: boolean) {
    if (!this.wasm) return 0
    try {
      this.wasm.apply(input, output, transpose)
      return this.wasmRows
    } catch {
      this.setBackend()
      return 0
    }
  }

  apply(input: Float64Array, output: Float64Array) {
    const { starts, columns, weights, cachedRows, uncached, inverse } = this
    for (let e = this.accelerate(input, output, false); e < output.length; e++) {
      let sum = 0
      for (let j = starts[e]; j < starts[e + 1]; j++) sum += weights[j >>> 16][j & 65535] * input[columns[j >>> 16][j & 65535]]
      if (e >= cachedRows) {
        for (const bin of uncached[e - cachedRows] ?? []) for (const j of bin) sum += this.weight(e, j) * input[j]
        sum *= inverse[e]
      }
      output[e] = sum
    }
    return output
  }

  transpose(input: Float64Array, output: Float64Array) {
    const { starts, columns, weights, cachedRows, uncached, inverse } = this
    const first = this.accelerate(input, output, true)
    if (first === 0) output.fill(0)
    for (let e = first; e < input.length; e++) {
      const value = input[e]
      if (value === 0) continue
      for (let j = starts[e]; j < starts[e + 1]; j++) output[columns[j >>> 16][j & 65535]] += weights[j >>> 16][j & 65535] * value
      if (e >= cachedRows) {
        const scaled = inverse[e] * value
        for (const bin of uncached[e - cachedRows] ?? []) for (const j of bin) output[j] += this.weight(e, j) * scaled
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
  const { neighbors, tetrahedra, positions } = mesh
  const components = rigidComponents3D(voidMask, nodes, e => neighbors.subarray(4 * e, 4 * e + 4),
    e => tetrahedra.subarray(4 * e, 4 * e + 4))
  const live = components.firstBody
  let allowed = 0
  for (let e = 0; e < elements; e++) if (!voidMask[e]) allowed += mesh.volumes[e]
  const fixed = Uint8Array.from({ length: 3 * nodes }, (_, d) => Number(live[Math.floor(d / 3)] < 0))
  for (const s of supports) {
    if (live[s.node] < 0) continue
    for (const [d, flag] of [s.fixX, s.fixY, s.fixZ].entries()) if (flag) fixed[3 * s.node + d] = 1
  }
  const loaded = new Uint8Array(nodes)
  const forces = loadCases.map(({ forces }) => {
    const rhs = new Float64Array(fixed.length)
    for (const { node, fx, fy, fz } of forces) {
      if (!(fx || fy || fz)) continue
      if (!(live[node] >= 0)) throw new ProblemError3D('attachment3dError')
      loaded[node] = 1
      if (!fixed[3 * node]) rhs[3 * node] += fx
      if (!fixed[3 * node + 1]) rhs[3 * node + 1] += fy
      if (!fixed[3 * node + 2]) rhs[3 * node + 2] += fz
    }
    return rhs
  })
  if (!forces.some(rhs => rhs.some(value => value !== 0))) throw new ProblemError3D('load3dError')
  const { widthMm, heightMm, depthMm } = problem.grid
  if (!rigidComponentsStable3D(components, supports, Math.max(widthMm, heightMm, depthMm),
    n => positions.subarray(3 * n, 3 * n + 3), loaded)) throw new ProblemError3D('componentSupport3dError')
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
