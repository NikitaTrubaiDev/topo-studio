import { beforeAll, describe, expect, it, vi } from 'vitest'
import { generateAdaptiveMesh3D } from '../adaptiveMesh3d'
import { h8Stiffness } from '../elementH8'
import { tet4Templates } from '../elementT4'
import { DensityFilter3D } from '../filter3d'
import { defaultParams3D, makePreset3D, presetGrid3D } from '../presets3d'
import { Analysis3D, Simp3D, validateProblem3D } from '../simp3d'
import { cellSize, type ElementType3D, type SimpProblem3D } from '../types3d'
import { adaptiveElementTemplates3D, preflightAdaptiveSolver3D, UnstructuredConeFilter3D } from '../unstructuredTet4'
import { loadWasmBackend3D, WasmBackend3D } from '../wasmBackend'

let backend: WasmBackend3D
beforeAll(async () => {
  const loaded = await loadWasmBackend3D()
  if (!loaded) throw new Error('Could not load the SIMD kernel. Run npm run build:wasm.')
  backend = loaded
})

function problemFor(elementType: ElementType3D, bracket = false, resolution: readonly [number, number, number] = [24, 12, 8]) {
  const problem = makePreset3D(bracket ? 'boltBracket3d' : 'cantilever3d', presetGrid3D(resolution),
    { ...defaultParams3D, maxIter: 6, changeTol: 0 }, undefined, elementType)
  if (elementType !== 'adaptiveTet4') return problem
  return { ...problem, mesh: generateAdaptiveMesh3D(problem) }
}

function relative(actual: ArrayLike<number>, expected: ArrayLike<number>, tolerance = 1e-5) {
  expect(actual.length).toBe(expected.length)
  let error = 0, norm = 0
  for (let i = 0; i < actual.length; i++) {
    error += (actual[i] - expected[i]) ** 2
    norm += expected[i] ** 2
  }
  expect(Math.sqrt(error / (norm || 1))).toBeLessThan(tolerance)
}

it('loads a native SIMD128-enabled module in Node', () => {
  expect(backend.abi.wasm_simd_enabled()).toBe(1)
  expect(backend.abi.memory).toBeInstanceOf(WebAssembly.Memory)
})

describe.each([
  ['hex8', false], ['hex8', true], ['tet4', false], ['adaptiveTet4', true],
] as const)('%s analysis and SIMP (bolt bracket = %s)', (type, bracket) => {
  it('matches displacements, compliance, sensitivities, and stress, with exact supports', () => {
    const problem = problemFor(type, bracket, type === 'hex8' && !bracket ? [11, 7, 5] : undefined)
    const { fixed, forces, voidMask } = validateProblem3D(problem)
    const loadCases = [...forces, forces[0].map(v => -0.3 * v)]
    const js = new Analysis3D(problem, fixed, loadCases)
    const wasm = new Analysis3D(problem, fixed, loadCases, backend)
    try {
      const density = Float64Array.from(voidMask, (v, e) => v ? 0 : 0.4 + 0.15 * Math.sin(0.7 * e))
      const expected = js.solve(density, 3, 1e-8)
      const actual = wasm.solve(density, 3, 1e-8)
      expect(wasm.engine).toBe('wasm')
      relative([actual.compliance, actual.maxDeflection], [expected.compliance, expected.maxDeflection])
      relative(wasm.gradient, js.gradient)
      relative(wasm.vonMises, js.vonMises)
      for (let i = 0; i < loadCases.length; i++) {
        const u = wasm.displacements[i]
        relative(u, js.displacements[i])
        expect(u.every((value, d) => !fixed[d] || value === 0)).toBe(true)
      }
    } finally {
      wasm.setBackend()
    }
  }, 60_000)

  it('matches multiple SIMP iterations', () => {
    const input = problemFor(type, bracket, type === 'tet4' || !bracket ? [12, 6, 4] : undefined)
    const problem: SimpProblem3D = { ...input,
      params: { ...input.params, heaviside: type === 'hex8', symmetry: type === 'hex8' ? 'z' : 'none' } }
    const js = new Simp3D(problem)
    const wasm = new Simp3D(problem, undefined, undefined, backend)
    try {
      for (let i = 0; i < 3; i++) {
        const expected = js.step(), actual = wasm.step()
        expect(wasm.engine).toBe('wasm')
        relative(actual.density, expected.density)
        relative(wasm.designDensity, js.designDensity)
        relative([actual.compliance, actual.volFrac], [expected.compliance, expected.volFrac])
        relative(actual.vonMises, expected.vonMises)
        relative(actual.displacements[0], expected.displacements[0])
      }
    } finally {
      wasm.setBackend()
    }
  }, 60_000)
})

it.each(['hex8', 'tet4', 'adaptiveTet4'] as const)('matches forward and transpose sparse filters for %s', type => {
  const problem = problemFor(type, true)
  const { grid, mesh, params } = problem
  const { voidMask } = validateProblem3D(problem)
  const filter = mesh ? new UnstructuredConeFilter3D(mesh, preflightAdaptiveSolver3D(problem, mesh))
    : new DensityFilter3D(grid, params.rmin, voidMask, type)
  const input = Float64Array.from(voidMask, (_, i) => Math.cos(i * 0.137))
  const apply = (transpose: boolean) => filter[transpose ? 'transpose' : 'apply'](input, new Float64Array(input.length))
  const expected = [apply(false), apply(true)]
  const tracked = new WasmBackend3D({ ...backend.abi })
  const kernel = vi.spyOn(tracked.abi, type === 'adaptiveTet4' ? 'filter_csr' : 'filter_stencil')
  try {
    filter.setBackend(tracked)
    relative(apply(false), expected[0], 1e-12)
    relative(apply(true), expected[1], 1e-12)
    expect(kernel).toHaveBeenCalledTimes(2)
  } finally {
    filter.setBackend()
    kernel.mockRestore()
  }
}, 30_000)

it.each(['hex8', 'tet4', 'adaptiveTet4'] as const)('has disjoint node sets per color for %s', type => {
  const problem = problemFor(type, type === 'adaptiveTet4')
  const { grid, mesh, material } = problem
  const { fixed } = validateProblem3D(problem)
  const geometry = mesh && adaptiveElementTemplates3D(mesh, material.nu)
  const solver = mesh && geometry ? backend.adaptive(fixed, mesh.tetrahedra, geometry.templateIndex, geometry.matrices)
    : backend.structured(grid, fixed, type, type === 'hex8' ? [h8Stiffness(1, material.nu, ...cellSize(grid))]
      : tet4Templates(1, material.nu, ...cellSize(grid)).map(t => t.Ke), material.nu)
  try {
    const { starts, order } = solver.coloring
    if (!mesh) expect(starts.length - 1).toBe(8)
    expect(new Set(order).size).toBe(solver.count / solver.perBrick)
    const corners = solver.width / 3
    const nodes = solver.nodes
    const marks = new Uint32Array(fixed.length / 3)
    for (let c = 0; c < starts.length - 1; c++) {
      for (const item of order.subarray(starts[c], starts[c + 1])) {
        const first = item * solver.perBrick * corners
        const local = new Set(nodes.subarray(first, first + solver.perBrick * corners))
        for (const node of local) {
          if (marks[node] === c + 1) throw new Error(`Color ${c} shares node ${node}`)
          marks[node] = c + 1
        }
      }
    }
  } finally {
    solver.dispose()
  }
}, 30_000)

it('falls back cleanly when the WASM module cannot instantiate', async () => {
  const instantiate = vi.spyOn(WebAssembly, 'instantiate').mockRejectedValueOnce(new WebAssembly.LinkError('unavailable'))
  try {
    const backend = await loadWasmBackend3D()
    expect(backend).toBeUndefined()
    const problem = problemFor('hex8', false, [12, 6, 4])
    expect(new Simp3D(problem, undefined, undefined, backend).step()).toEqual(new Simp3D(problem).step())
  } finally {
    instantiate.mockRestore()
  }
})

it('supports forced JS, preserves iteration history across switches, and falls back on a WASM trap', async () => {
  const problem = problemFor('hex8', false, [12, 6, 4])
  const js = new Simp3D(problem)
  const switched = new Simp3D(problem, undefined, undefined, await loadWasmBackend3D('js'))
  expect(switched.engine).toBe('js')
  expect(switched.step()).toEqual(js.step())
  switched.setBackend(backend)
  relative([switched.step().compliance], [js.step().compliance])
  expect(switched.engine).toBe('wasm')
  switched.setBackend()
  const failure = new WebAssembly.RuntimeError('simulated kernel trap')
  const failing = new WasmBackend3D({
    ...backend.abi, solver_solve() { throw failure },
  })
  switched.setBackend(failing)
  const frame = switched.step()
  expect(switched.engine).toBe('js')
  expect(frame.iteration).toBe(3)
  relative(frame.density, js.step().density)
})
