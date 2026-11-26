import wasmUrl from '../wasm/topo_solver.wasm?url&no-inline'
import { h8Stiffness } from './elementH8'
import { tetCorners } from './elementT4'
import { cellSize, type ElementType3D, type Grid3D, type SimpProblem3D } from './types3d'

export type SolverEngine3D = 'wasm' | 'js'

interface SolverExports {
  memory: WebAssembly.Memory
  wasm_simd_enabled(): number
  wasm_alloc(bytes: number): number
  wasm_dealloc(ptr: number, bytes: number): void
  solver_structured(nx: number, ny: number, nz: number, fixed: number, ke: number, corners: number, coarseKe: number, levels: number): number
  solver_adaptive(dofs: number, fixed: number, count: number, nodes: number, templates: number, packed: number, templateCount: number): number
  solver_drop(handle: number): void
  solver_buffer(handle: number, field: number): number
  solver_colors(handle: number): number
  solver_prepare(handle: number, e0: number, emin: number, penal: number): void
  solver_solve(handle: number, tolerance: number, limit: number): number
  filter_csr(rows: number, count: number, starts: number, columns: number, weights: number, input: number, output: number, transpose: number): void
  filter_stencil(nx: number, ny: number, nz: number, perCell: number, starts: number, offsets: number, weights: number, inverse: number,
    input: number, output: number, transpose: number): void
}

type NumericBuffer = Float64Array | Uint32Array | Int32Array | Uint8Array

export class WasmMemory3D {
  private readonly allocations: [number, number][] = []

  constructor(readonly abi: SolverExports) {}

  allocate(bytes: number) {
    const ptr = this.abi.wasm_alloc(bytes) >>> 0
    if (ptr === 0) throw new RangeError('WASM linear memory allocation failed')
    this.allocations.push([ptr, bytes])
    return ptr
  }

  upload(array: NumericBuffer) {
    const ptr = this.allocate(array.byteLength)
    new Uint8Array(this.abi.memory.buffer, ptr, array.byteLength)
      .set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength))
    return ptr
  }

  f64(ptr: number, length: number) {
    return new Float64Array(this.abi.memory.buffer, ptr, length)
  }

  u32(ptr: number, length: number) {
    return new Uint32Array(this.abi.memory.buffer, ptr, length)
  }

  dispose() {
    for (const [ptr, bytes] of this.allocations) this.abi.wasm_dealloc(ptr, bytes)
    this.allocations.length = 0
  }
}

let compilation: Promise<WebAssembly.Module> | undefined

async function compile() {
  if (typeof process !== 'undefined' && process.versions?.node && import.meta.url.startsWith('file:')) {
    const specifier = 'node:fs/promises'
    const { readFile } = await import(/* @vite-ignore */ specifier) as typeof import('node:fs/promises')
    const asset = wasmUrl.startsWith('file:') ? new URL(wasmUrl) : new URL(['..', 'wasm', 'topo_solver.wasm'].join('/'), import.meta.url)
    return WebAssembly.compile(await readFile(asset))
  }
  const response = await fetch(wasmUrl)
  if (!response.ok) throw new Error(`WASM request failed (${response.status})`)
  return WebAssembly.compile(await response.arrayBuffer())
}

/** Compile once per realm. Each backend instance owns independent linear memory. */
export async function loadWasmBackend3D(engine: SolverEngine3D = 'wasm') {
  if (engine === 'js') return undefined
  try {
    const module = await (compilation ??= compile())
    const instance = await WebAssembly.instantiate(module)
    const abi = instance.exports as unknown as SolverExports
    if (abi.wasm_simd_enabled() === 1) return new WasmBackend3D(abi)
  } catch {
    compilation = undefined
  }
  return undefined
}

export class WasmBackend3D {
  constructor(readonly abi: SolverExports) {}

  structured(grid: Grid3D, fixed: Uint8Array, elementType: ElementType3D, matrices: readonly Float64Array[], nu: number) {
    const { nelx, nely, nelz } = grid
    const tet = elementType === 'tet4'
    const width = tet ? 12 : 24
    const count = nelx * nely * nelz * (tet ? 5 : 1)
    const ke = new Float64Array(matrices.length * width * width)
    matrices.forEach((matrix, i) => ke.set(matrix, i * width * width))
    const coarse = []
    let dims = [nelx, nely, nelz]
    while (Math.min(...dims) >= 4) {
      dims = dims.map(n => Math.floor(n / 2))
      coarse.push(h8Stiffness(1, nu, ...cellSize({ ...grid, nelx: dims[0], nely: dims[1], nelz: dims[2] })))
    }
    const coarseKe = new Float64Array(576 * coarse.length)
    coarse.forEach((matrix, i) => coarseKe.set(matrix, 576 * i))
    const stage = new WasmMemory3D(this.abi)
    try {
      const handle = this.abi.solver_structured(nelx, nely, nelz, stage.upload(fixed), stage.upload(ke),
        tet ? stage.upload(Uint8Array.from(tetCorners.flat(2))) : 0, stage.upload(coarseKe), coarse.length)
      return new WasmSolver3D(this.abi, handle, count, fixed.length, width, tet ? 5 : 1)
    } finally {
      stage.dispose()
    }
  }

  adaptive(fixed: Uint8Array, nodes: Uint32Array, templates: Int32Array, matrices: readonly Float64Array[]) {
    const packed = new Float64Array(78 * matrices.length)
    let k = 0
    for (const matrix of matrices) {
      for (let i = 0; i < 12; i++) for (let j = i; j < 12; j++) packed[k++] = matrix[12 * i + j]
    }
    const stage = new WasmMemory3D(this.abi)
    try {
      const handle = this.abi.solver_adaptive(fixed.length, stage.upload(fixed), templates.length,
        stage.upload(nodes), stage.upload(templates), stage.upload(packed), matrices.length)
      return new WasmSolver3D(this.abi, handle, templates.length, fixed.length, 12, 1)
    } finally {
      stage.dispose()
    }
  }
}

export class WasmSolver3D {
  private readonly addresses: number[]
  private readonly memory: WasmMemory3D

  constructor(private readonly abi: SolverExports, private readonly handle: number, readonly count: number,
    private readonly dofs: number, readonly width: number, readonly perBrick: number) {
    this.memory = new WasmMemory3D(abi)
    this.addresses = Array.from({ length: 10 }, (_, field) => abi.solver_buffer(handle, field) >>> 0)
  }

  get modulus() { return this.memory.f64(this.addresses[0], this.count) }
  get force() { return this.memory.f64(this.addresses[1], this.dofs) }
  get displacements() { return this.memory.f64(this.addresses[2], this.dofs) }
  get gradient() { return this.memory.f64(this.addresses[3], this.count) }
  get elementEnergy() { return this.memory.f64(this.addresses[9], this.count) }
  get nodes() { return this.memory.u32(this.addresses[5], this.count * (this.width / 3)) }
  get templates() { return this.memory.u32(this.addresses[6], this.count) }

  get coloring() {
    return {
      starts: this.memory.u32(this.addresses[7], this.abi.solver_colors(this.handle) + 1),
      order: this.memory.u32(this.addresses[8], this.count / this.perBrick),
    }
  }

  prepare(density: Float64Array, material: SimpProblem3D['material'], penal: number) {
    this.modulus.set(density)
    this.abi.solver_prepare(this.handle, material.E0, material.Emin, penal)
  }

  solve(force: Float64Array, displacements: Float64Array, tolerance: number, limit = 4000) {
    this.force.set(force)
    this.displacements.set(displacements)
    const converged = this.abi.solver_solve(this.handle, tolerance, limit) !== 0
    if (converged) displacements.set(this.displacements)
    const [iterations, relativeResidual, compliance] = this.memory.f64(this.addresses[4], 3)
    return { converged, iterations, relativeResidual, compliance }
  }

  dispose() { this.abi.solver_drop(this.handle) }
}

/** Reuse WASM input/output storage for every forward and transpose pass. */
export class WasmFilter3D {
  private readonly memory: WasmMemory3D
  private readonly input: number
  private readonly output: number
  private readonly kernel: (input: number, output: number, transpose: number) => void

  constructor(backend: WasmBackend3D, private readonly count: number,
    initialize: (memory: WasmMemory3D) => WasmFilter3D['kernel']) {
    this.memory = new WasmMemory3D(backend.abi)
    try {
      this.input = this.memory.allocate(8 * count)
      this.output = this.memory.allocate(8 * count)
      this.kernel = initialize(this.memory)
    } catch (error) {
      this.memory.dispose()
      throw error
    }
  }

  apply(input: Float64Array, output: Float64Array, transpose: boolean) {
    this.memory.f64(this.input, this.count).set(input)
    this.kernel(this.input, this.output, Number(transpose))
    output.set(this.memory.f64(this.output, this.count))
    return output
  }

  dispose() { this.memory.dispose() }
}
