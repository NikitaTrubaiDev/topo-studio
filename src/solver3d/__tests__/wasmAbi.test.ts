import { beforeAll, expect, it, vi } from 'vitest'
import { presetGrid3D } from '../presets3d'
import { loadWasmBackend3D, WasmBackend3D, WasmMemory3D } from '../wasmBackend'

let backend: WasmBackend3D
beforeAll(async () => {
  const loaded = await loadWasmBackend3D()
  if (!loaded) throw new Error('Could not load the SIMD kernel. Run npm run build:wasm.')
  backend = loaded
})

it('rejects invalid TS solver dimensions, lengths, and indices before uploading', () => {
  const allocate = vi.fn(backend.abi.wasm_alloc)
  const wrapped = new WasmBackend3D({ ...backend.abi, wasm_alloc: allocate })
  const grid = presetGrid3D([1, 1, 1])
  const fixed = new Uint8Array(24), hex = new Float64Array(576)
  expect(() => wrapped.structured(grid, fixed.slice(1), 'hex8', [hex], 0.3)).toThrow(RangeError)
  expect(() => wrapped.structured(grid, fixed, 'hex8', [hex.slice(1)], 0.3)).toThrow(RangeError)
  expect(() => wrapped.structured(grid, fixed, 'tet4', [new Float64Array(144)], 0.3)).toThrow(RangeError)
  expect(() => wrapped.structured({ ...grid, nelx: 0x1_0000_0001 }, fixed, 'hex8', [hex], 0.3)).toThrow(RangeError)

  const nodes = Uint32Array.of(0, 1, 2, 3), indices = Int32Array.of(0), tet = new Float64Array(144)
  expect(() => wrapped.adaptive(fixed.slice(1), nodes, indices, [tet])).toThrow(RangeError)
  expect(() => wrapped.adaptive(fixed, nodes.slice(1), indices, [tet])).toThrow(RangeError)
  expect(() => wrapped.adaptive(fixed, nodes, indices, [tet.slice(1)])).toThrow(RangeError)
  expect(() => wrapped.adaptive(fixed, Uint32Array.of(0, 1, 2, 8), indices, [tet])).toThrow(RangeError)
  expect(() => wrapped.adaptive(fixed, nodes, Int32Array.of(-1), [tet])).toThrow(RangeError)
  expect(() => wrapped.adaptive(fixed, nodes, Int32Array.of(1), [tet])).toThrow(RangeError)
  expect(allocate).not.toHaveBeenCalled()
})

it('rejects malformed raw constructor inputs and stale handles without trapping', () => {
  const { abi } = backend
  const stage = new WasmMemory3D(abi)
  try {
    const fixed = stage.allocate(24), shortFixed = stage.allocate(23)
    const hex = stage.allocate(576 * 8), shortHex = stage.allocate(575 * 8)
    const empty = stage.allocate(0)
    expect(abi.solver_structured(1, 1, 1, shortFixed, hex, 0, empty, 0)).toBe(0)
    expect(abi.solver_structured(1, 1, 1, fixed, shortHex, 0, empty, 0)).toBe(0)
    expect(abi.solver_structured(1, 1, 1, fixed, hex + 4, 0, empty, 0)).toBe(0)
    expect(abi.solver_structured(1, 1, 1, fixed, hex, 0, empty, 1)).toBe(0)
    expect(abi.solver_structured(-1, -1, -1, fixed, hex, 0, empty, 0)).toBe(0)
    const tet = stage.allocate(1440 * 8)
    const corners = stage.upload(Uint8Array.from({ length: 40 }, (_, i) => i % 4 === 0 ? 8 : i % 4))
    expect(abi.solver_structured(1, 1, 1, fixed, tet, corners, empty, 0)).toBe(0)

    const nodes = stage.upload(Uint32Array.of(0, 1, 2, 3)), index = stage.upload(Int32Array.of(0))
    const packed = stage.allocate(78 * 8), shortPacked = stage.allocate(77 * 8)
    expect(abi.solver_adaptive(24, fixed, 1, nodes, index, shortPacked, 1)).toBe(0)
    expect(abi.solver_adaptive(24, fixed, 2, nodes, index, packed, 1)).toBe(0)
    expect(abi.solver_adaptive(24, fixed, -1, nodes, index, packed, 1)).toBe(0)
    stage.u32(nodes, 4)[3] = 8
    expect(abi.solver_adaptive(24, fixed, 1, nodes, index, packed, 1)).toBe(0)
    stage.u32(nodes, 4)[3] = 3
    stage.u32(index, 1)[0] = 1
    expect(abi.solver_adaptive(24, fixed, 1, nodes, index, packed, 1)).toBe(0)

    expect(abi.wasm_dealloc(hex, 8)).toBe(-1)
    const handle = abi.solver_structured(1, 1, 1, fixed, hex, 0, empty, 0)
    expect(handle).not.toBe(0)
    expect(abi.solver_drop(handle)).toBe(0)
    expect(abi.solver_drop(handle)).toBe(-1)
    expect(abi.solver_buffer(handle, 0)).toBe(0)
    expect(abi.solver_prepare(handle, 1, 1e-9, 3)).toBe(-1)
    expect(abi.solver_solve(handle, 1e-5, 10)).toBe(0)

    // No allocation follows this free, so the original address remains stale.
    expect(abi.wasm_dealloc(hex, 576 * 8)).toBe(0)
    expect(abi.wasm_dealloc(hex, 576 * 8)).toBe(-1)
    expect(abi.solver_structured(1, 1, 1, fixed, hex, 0, empty, 0)).toBe(0)
  } finally {
    stage.dispose()
  }
})

it('rejects malformed raw CSR and stencil buffers and indices before writing', () => {
  const { abi } = backend
  const stage = new WasmMemory3D(abi)
  try {
    const starts = stage.upload(Uint32Array.of(0, 1))
    const columns = stage.upload(Uint32Array.of(1))
    const weights = stage.upload(Float64Array.of(2))
    const input = stage.upload(Float64Array.of(3))
    const output = stage.upload(Float64Array.of(-5))
    const short = stage.allocate(4)
    const csr = (out = output, rows = starts) => abi.filter_csr(1, 1, rows, columns, weights, input, out, 0)
    expect(csr()).toBe(-1)
    stage.u32(columns, 1)[0] = 0
    expect(csr(input)).toBe(-1)
    expect(csr(short)).toBe(-1)
    expect(csr(output, short)).toBe(-1)
    stage.u32(starts, 2)[1] = 2
    expect(csr()).toBe(-1)
    expect(stage.f64(output, 1)[0]).toBe(-5)
    stage.u32(starts, 2)[1] = 1
    expect(csr()).toBe(0)
    expect(stage.f64(output, 1)[0]).toBe(6)

    const stencilRows = stage.upload(Uint32Array.of(0, 1, 1))
    const offsets = stage.upload(Int32Array.of(0, 0, 0, 1))
    const inverse = stage.upload(Float64Array.of(0.5))
    const stencil = (shifts = offsets, out = output, nx = 1) =>
      abi.filter_stencil(nx, 1, 1, 1, stencilRows, shifts, weights, inverse, input, out, 0)
    expect(stencil()).toBe(-1)
    stage.u32(offsets, 4)[3] = 0
    expect(stencil(short)).toBe(-1)
    expect(stencil(offsets, inverse)).toBe(-1)
    expect(stencil(offsets, output, -1)).toBe(-1)
    expect(stage.f64(output, 1)[0]).toBe(6)
    expect(stencil()).toBe(0)
    expect(stage.f64(output, 1)[0]).toBe(3)
  } finally {
    stage.dispose()
  }
})
