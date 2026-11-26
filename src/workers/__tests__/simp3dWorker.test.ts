import { afterEach, expect, it, vi } from 'vitest'
import { defaultParams3D, makePreset3D, presetGrid3D } from '../../solver3d/presets3d'
import type { WorkerCommand3D, WorkerEvent3D } from '../protocol3d'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
})

it('posts preview while WASM is pending and ignores readiness from a superseded request', async () => {
  const events: WorkerEvent3D[] = []
  const scope = {
    onmessage: undefined as ((event: { data: WorkerCommand3D }) => void) | undefined,
    postMessage(event: WorkerEvent3D, transfer: ArrayBuffer[]) {
      events.push(structuredClone(event, { transfer }))
    },
  }
  vi.stubGlobal('self', scope)
  const wasm = await import('../../solver3d/wasmBackend')
  const backend = await wasm.loadWasmBackend3D()
  expect(backend).toBeDefined()
  let resolve!: (backend: Awaited<ReturnType<typeof wasm.loadWasmBackend3D>>) => void
  const pending = new Promise<typeof backend>(done => { resolve = done })
  vi.spyOn(wasm, 'loadWasmBackend3D').mockReturnValueOnce(pending)
  await import('../simp3dWorker')
  const problem = makePreset3D('cantilever3d', presetGrid3D([6, 4, 4]))
  const send = (data: WorkerCommand3D) => scope.onmessage!({ data })

  send({ type: 'preview', problem, requestId: 17, engine: 'wasm' })
  expect(events).toEqual([expect.objectContaining({ type: 'preview', requestId: 17, density: expect.any(Float64Array) })])
  send({ type: 'step' })
  expect(events[1]).toMatchObject({ type: 'frame', snapshot: { iteration: 1 } })
  send({ type: 'engine', engine: 'js' })
  resolve(backend)
  await pending
  expect(events.filter(event => event.type === 'engine')).toEqual([{ type: 'engine', engine: 'js' }])
  expect(events.filter(event => event.type === 'preview')).toHaveLength(1)
})

it.each(['hex8', 'tet4'] as const)('switches engines after a finished %s run without restarting it', async elementType => {
  const events: WorkerEvent3D[] = []
  const scope = {
    onmessage: undefined as ((event: { data: WorkerCommand3D }) => void) | undefined,
    postMessage(event: WorkerEvent3D, transfer: ArrayBuffer[]) {
      events.push(structuredClone(event, { transfer }))
    },
  }
  vi.stubGlobal('self', scope)
  const wasm = await import('../../solver3d/wasmBackend')
  const backend = await wasm.loadWasmBackend3D()
  expect(backend).toBeDefined()
  const tracked = new wasm.WasmBackend3D({ ...backend!.abi })
  const drop = vi.spyOn(tracked.abi, 'solver_drop')
  vi.spyOn(wasm, 'loadWasmBackend3D').mockResolvedValue(tracked)
  await import('../simp3dWorker')
  const problem = makePreset3D('cantilever3d', presetGrid3D([6, 4, 4]),
    { ...defaultParams3D, maxIter: 1 }, undefined, elementType)
  const send = (data: WorkerCommand3D) => scope.onmessage!({ data })

  send({ type: 'preview', problem, requestId: 19, engine: 'wasm' })
  await Promise.resolve()
  expect(events.at(-1)).toEqual({ type: 'engine', engine: 'wasm' })
  send({ type: 'step' })
  expect(events.at(-1)).toMatchObject({ type: 'frame', snapshot: { iteration: 1, done: true } })
  send({ type: 'engine', engine: 'js' })
  expect(events.at(-1)).toEqual({ type: 'engine', engine: 'js' })
  expect(drop).toHaveBeenCalledTimes(1)
  send({ type: 'engine', engine: 'wasm' })
  await Promise.resolve()
  expect(events.at(-1)).toEqual({ type: 'engine', engine: 'wasm' })
  send({ type: 'step' })
  expect(events.at(-1)).toEqual({ type: 'done' })
  expect(events.filter(event => event.type === 'frame')).toHaveLength(1)
  send({ type: 'reset' })
})

it('transfers frames and preserves warm state across step, pause, and resume until reset', async () => {
  vi.useFakeTimers()
  const events: WorkerEvent3D[] = []
  const scope = {
    onmessage: undefined as ((event: { data: WorkerCommand3D }) => void) | undefined,
    postMessage(event: WorkerEvent3D, transfer: ArrayBuffer[]) {
      if (event.type === 'frame') expect(transfer).toHaveLength(2 + event.snapshot.displacements.length)
      events.push(structuredClone(event, { transfer }))
    },
  }
  vi.stubGlobal('self', scope)
  await import('../simp3dWorker')
  const grid = presetGrid3D([6, 4, 4])
  const problem = makePreset3D('cantilever3d', grid, { ...defaultParams3D, maxIter: 3, changeTol: 0 })
  const send = (data: WorkerCommand3D) => scope.onmessage!({ data })
  send({ type: 'init', problem })
  send({ type: 'step' })
  expect(events[0]).toMatchObject({ type: 'frame', snapshot: { iteration: 1, done: false } })
  expect(events[1]).toEqual({ type: 'paused' })
  expect(vi.getTimerCount()).toBe(0)
  send({ type: 'start' })
  vi.advanceTimersToNextTimer()
  send({ type: 'pause' })
  expect(events[2]).toMatchObject({ type: 'frame', snapshot: { iteration: 2, done: false } })
  expect(vi.getTimerCount()).toBe(0)
  send({ type: 'start' })
  vi.runAllTimers()
  expect(events.at(-1)).toMatchObject({ type: 'frame', snapshot: { iteration: 3, done: true } })
  expect(vi.getTimerCount()).toBe(0)
  send({ type: 'step' })
  expect(events.at(-1)).toEqual({ type: 'done' })
  send({ type: 'init', problem })
  send({ type: 'start' })
  send({ type: 'reset' })
  vi.runAllTimers()
  expect(events.at(-1)).toEqual({ type: 'done' })
  send({ type: 'init', problem })
  send({ type: 'step' })
  expect(events.at(-2)).toMatchObject({ type: 'frame', snapshot: { iteration: 1 } })
})

it('reports the final true relative residual when PCG fails', async () => {
  const scope = {
    onmessage: undefined as ((event: { data: WorkerCommand3D }) => void) | undefined,
    postMessage: vi.fn<(event: WorkerEvent3D) => void>(),
  }
  vi.stubGlobal('self', scope)
  const { Pcg3D } = await import('../../solver3d/pcg3d')
  const solve = vi.spyOn(Pcg3D.prototype, 'solve').mockReturnValue({ converged: false, iterations: 4000, relativeResidual: 0.0125 })
  try {
    await import('../simp3dWorker')
    const problem = makePreset3D('cantilever3d', presetGrid3D([6, 4, 4]))
    scope.onmessage!({ data: { type: 'init', problem } })
    scope.onmessage!({ data: { type: 'step' } })
    expect(scope.postMessage.mock.calls[0][0]).toEqual({ type: 'error', issue: 'solve3dError', relativeResidual: 0.0125 })
  } finally {
    solve.mockRestore()
  }
})

it('transfers the tagged nonlinear Tet4 starting field and reuses solver state for Step', async () => {
  const events: WorkerEvent3D[] = []
  const scope = {
    onmessage: undefined as ((event: { data: WorkerCommand3D }) => void) | undefined,
    postMessage(event: WorkerEvent3D, transfer: ArrayBuffer[]) {
      if (event.type === 'preview') expect(transfer).toEqual([event.density.buffer])
      events.push(structuredClone(event, { transfer }))
    },
  }
  vi.stubGlobal('self', scope)
  const { Simp3D } = await import('../../solver3d/simp3d')
  const problem = makePreset3D('archBridge3d', presetGrid3D([12, 6, 4]),
    { ...defaultParams3D, rmin: 4, heaviside: true }, undefined, 'tet4')
  const expected = new Simp3D(problem)
  await import('../simp3dWorker')
  scope.onmessage!({ data: { type: 'preview', problem, requestId: 41 } })
  expect(events[0]).toMatchObject({ type: 'preview', requestId: 41, density: expected.initialDensity(), passive: expected.passiveMasks })
  scope.onmessage!({ data: { type: 'step' } })
  expect(events[1]).toMatchObject({ type: 'frame', snapshot: { iteration: 1, density: expected.step().density } })
}, 15000)

it('generates adaptive geometry before solving and continues the same iteration history after AMR', async () => {
  const events: WorkerEvent3D[] = []
  const scope = {
    onmessage: undefined as ((event: { data: WorkerCommand3D }) => void) | undefined,
    postMessage(event: WorkerEvent3D, transfer: ArrayBuffer[]) {
      events.push(structuredClone(event, { transfer }))
    },
  }
  vi.stubGlobal('self', scope)
  await import('../simp3dWorker')
  const grid = { ...presetGrid3D([12, 6, 4]), widthMm: 60, heightMm: 30, depthMm: 20 }
  const problem = makePreset3D('cantilever3d', grid, { ...defaultParams3D, rmin: 1, changeTol: 0 }, undefined, 'adaptiveTet4')
  problem.adaptive = { maxLevel: 2, refineLoads: false, refineFeatures: false }
  const send = (data: WorkerCommand3D) => scope.onmessage!({ data })
  send({ type: 'preview', problem, requestId: 72 })
  const generated = events[0]
  expect(generated).toMatchObject({ type: 'preview', requestId: 72, mesh: { stats: { elements: expect.any(Number) } } })
  if (generated.type !== 'preview' || !generated.mesh) throw new Error('Missing adaptive preview')
  expect(generated.density).toHaveLength(generated.mesh.stats.elements)
  send({ type: 'step' })
  expect(events[1]).toMatchObject({ type: 'frame', snapshot: { iteration: 1 } })
  send({ type: 'refine', threshold: 0.5 })
  const refined = events.at(-1)
  expect(refined).toMatchObject({ type: 'refined', snapshot: { iteration: 1 } })
  if (refined?.type !== 'refined') throw new Error('Missing AMR frame')
  expect(refined.mesh.stats.elements).toBeGreaterThan(generated.mesh.stats.elements)
  expect(refined.snapshot.volFrac).toBeCloseTo(problem.params.volFrac, 7)
  send({ type: 'step' })
  expect(events.at(-2)).toMatchObject({ type: 'frame', snapshot: { iteration: 2 } })
  send({ type: 'reset' })
  send({ type: 'preview', problem, requestId: 73 })
  expect(events.at(-1)).toMatchObject({ type: 'preview', requestId: 73, mesh: { stats: { elements: generated.mesh.stats.elements } } })
}, 15000)

it('rejects AMR when the replacement filter exceeds its budget and keeps the existing run', async () => {
  const events: WorkerEvent3D[] = []
  const scope = {
    onmessage: undefined as ((event: { data: WorkerCommand3D }) => void) | undefined,
    postMessage(event: WorkerEvent3D, transfer: ArrayBuffer[]) {
      events.push(structuredClone(event, { transfer }))
    },
  }
  vi.stubGlobal('self', scope)
  const { Simp3D } = await import('../../solver3d/simp3d')
  const step = Simp3D.prototype.step
  const uniformStress = vi.spyOn(Simp3D.prototype, 'step').mockImplementation(function (this: InstanceType<typeof Simp3D>, advance) {
    const snapshot = step.call(this, advance)
    snapshot.vonMises.fill(1)
    return snapshot
  })
  try {
    await import('../simp3dWorker')
    const grid = { ...presetGrid3D([24, 12, 4]), widthMm: 120, heightMm: 60, depthMm: 20 }
    const params = { ...defaultParams3D, rmin: 50, maxIter: 3, changeTol: 0 }
    const problem = makePreset3D('cantilever3d', grid, params, undefined, 'adaptiveTet4')
    problem.adaptive = { maxLevel: 1, refineLoads: false, refineFeatures: false }
    const baseline = new Simp3D(problem)
    const first = baseline.step()
    const second = baseline.step()
    const send = (data: WorkerCommand3D) => scope.onmessage!({ data })
    send({ type: 'init', problem })
    send({ type: 'step' })
    expect(events.at(-2)).toMatchObject({ type: 'frame', snapshot: { iteration: 1, density: first.density } })
    send({ type: 'refine' })
    expect(events.at(-1)).toEqual({ type: 'error', issue: 'adaptiveBudget3dError', recoverable: true })
    send({ type: 'step' })
    expect(events.at(-2)).toMatchObject({ type: 'frame', snapshot: { iteration: 2, density: second.density, compliance: second.compliance } })
  } finally {
    uniformStress.mockRestore()
  }
}, 15000)

it('keeps a finished run at maxIter after a no-op adaptive refinement', async () => {
  vi.useFakeTimers()
  const events: WorkerEvent3D[] = []
  const scope = {
    onmessage: undefined as ((event: { data: WorkerCommand3D }) => void) | undefined,
    postMessage(event: WorkerEvent3D, transfer: ArrayBuffer[]) {
      events.push(structuredClone(event, { transfer }))
    },
  }
  vi.stubGlobal('self', scope)
  await import('../simp3dWorker')
  const grid = { ...presetGrid3D([2, 2, 2]), widthMm: 10, heightMm: 10, depthMm: 10 }
  const problem = makePreset3D('cantilever3d', grid, { ...defaultParams3D, maxIter: 1 }, undefined, 'adaptiveTet4')
  problem.adaptive = { maxLevel: 1, refineLoads: true, refineFeatures: false }
  const send = (data: WorkerCommand3D) => scope.onmessage!({ data })
  send({ type: 'preview', problem, requestId: 1 })
  expect(events[0]).toMatchObject({ type: 'preview', mesh: { stats: { levelCounts: [0, 96, 0] } } })
  send({ type: 'step' })
  expect(events.at(-1)).toMatchObject({ type: 'frame', snapshot: { done: true, iteration: 1 } })
  send({ type: 'refine' })
  expect(events.at(-1)).toEqual({ type: 'done' })
  send({ type: 'start' })
  expect(vi.getTimerCount()).toBe(0)
  send({ type: 'step' })
  expect(events.at(-1)).toEqual({ type: 'done' })
  expect(events.filter(event => event.type === 'frame')).toHaveLength(1)
})
