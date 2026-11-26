/// <reference lib="webworker" />

import { generateAdaptiveMesh3D, transferAdaptiveDensity3D } from '../solver3d/adaptiveMesh3d'
import { preflightAdaptiveSolver3D } from '../solver3d/unstructuredTet4'
import { Simp3D, validateProblem3D } from '../solver3d/simp3d'
import { elementCount, ProblemError3D, type SimpProblem3D } from '../solver3d/types3d'
import { loadWasmBackend3D, type SolverEngine3D, type WasmBackend3D } from '../solver3d/wasmBackend'
import type { Preview3D, TimedSnapshot3D, WorkerCommand3D, WorkerEvent3D } from './protocol3d'

const scope = self as unknown as DedicatedWorkerGlobalScope
let problem: SimpProblem3D | undefined
let solver: Simp3D | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let running = false
let finished = false
let engineRequest = 0
let backend: WasmBackend3D | undefined
let latest: Pick<TimedSnapshot3D, 'density' | 'vonMises' | 'iteration'> | undefined

function send(event: WorkerEvent3D, transfer: Transferable[] = []) {
  scope.postMessage(event, transfer)
}

function stop() {
  clearTimeout(timer)
  timer = undefined
  running = false
}

function reset() {
  stop()
  engineRequest++
  const previous = solver
  backend = undefined
  solver = undefined
  problem = undefined
  finished = false
  latest = undefined
  previous?.setBackend()
}

async function selectEngine(engine: SolverEngine3D) {
  const request = ++engineRequest
  const next = engine === 'wasm' ? backend ?? await loadWasmBackend3D() : undefined
  if (request !== engineRequest) return
  backend = next
  solver?.setBackend(backend)
  send({ type: 'engine', engine: backend ? 'wasm' : 'js' })
}

function reportEngineFallback(next: Simp3D) {
  if (backend && next.engine === 'js') {
    backend = undefined
    send({ type: 'engine', engine: 'js' })
  }
}

function report(error: unknown, recoverable = false) {
  if (!recoverable) reset()
  const recovery = recoverable ? { recoverable } : {}
  if (error instanceof ProblemError3D) {
    const { code, relativeResidual } = error
    send({ type: 'error', issue: code, ...recovery, ...(relativeResidual !== undefined && { relativeResidual }) })
  } else send({ type: 'error', issue: 'workerError', ...recovery })
}

function preview(requestId: number, next: SimpProblem3D, engine?: SolverEngine3D) {
  reset()
  problem = next
  const { grid, params, passive, elementType = 'hex8' } = next
  let event: Preview3D
  try {
    if (elementType === 'adaptiveTet4') {
      const mesh = generateAdaptiveMesh3D(next)
      problem = { ...next, mesh }
      try {
        solver = new Simp3D(problem)
        event = { type: 'preview', requestId, mesh, density: solver.initialDensity(), passive: solver.passiveMasks }
      } catch (error) {
        const density = Float64Array.from(mesh.bricks, e => passive?.void?.[e] ? 0 : passive?.solid?.[e] ? 1 : params.volFrac)
        event = { type: 'preview', requestId, mesh, density, passive,
          issue: error instanceof ProblemError3D ? error.code : 'workerError' }
      }
    } else if (passive?.solid?.some(Boolean)) {
      solver = new Simp3D(next)
      event = { type: 'preview', requestId, density: solver.initialDensity(), passive: solver.passiveMasks }
    } else {
      // With zero prescribed solids, the exact initial field is constant on all allowed elements.
      const setup = validateProblem3D(next)
      const value = params.volFrac * elementCount(grid) / setup.allowed
      event = { type: 'preview', requestId, density: Float64Array.from(setup.voidMask, mask => mask ? 0 : value), passive: setup.brickMasks }
    }
  } catch (error) {
    reset()
    const perBrick = elementType === 'tet4' ? 5 : 1
    const density = Float64Array.from({ length: elementCount(grid, elementType) }, (_, e) => {
      const brick = Math.floor(e / perBrick)
      return passive?.void?.[brick] ? 0 : passive?.solid?.[brick] ? 1 : params.volFrac
    })
    event = { type: 'preview', requestId, density, passive, issue: error instanceof ProblemError3D ? error.code : 'workerError' }
  }
  send(event, [event.density.buffer])
  if (engine) void selectEngine(engine)
}

function ensureSolver() {
  if (!solver && problem) solver = new Simp3D(problem, undefined, undefined, backend)
  return solver
}

function snapshotBuffers(snapshot: TimedSnapshot3D) {
  return [snapshot.density.buffer, snapshot.vonMises.buffer, ...snapshot.displacements.map(u => u.buffer)]
}

function refine(threshold?: number) {
  const previous = solver?.problem.mesh
  if (!previous || !solver || !latest) return
  stop()
  const mesh = generateAdaptiveMesh3D(solver.problem, { mesh: previous, density: latest.density, vonMises: latest.vonMises, threshold })
  if (mesh === previous) {
    send({ type: finished ? 'done' : 'paused' })
    return
  }
  const start = performance.now()
  const plan = preflightAdaptiveSolver3D(solver.problem, mesh, solver.adaptiveBytes)
  const design = transferAdaptiveDensity3D(mesh, previous, solver.designDensity)
  const next = new Simp3D({ ...solver.problem, mesh }, { design, iteration: latest.iteration }, plan)
  let snapshot: TimedSnapshot3D
  try {
    next.setBackend(backend)
    snapshot = { ...next.step(false), done: latest.iteration >= next.problem.params.maxIter, iterMs: performance.now() - start }
  } catch (error) {
    next.setBackend()
    throw error
  }
  solver.setBackend()
  solver = next
  problem = next.problem
  latest = { iteration: snapshot.iteration, density: snapshot.density.slice(), vonMises: snapshot.vonMises.slice() }
  finished = snapshot.done
  reportEngineFallback(next)
  send({ type: 'refined', mesh, snapshot }, snapshotBuffers(snapshot))
}

function iterate() {
  timer = undefined
  if (!solver || finished) return
  try {
    const start = performance.now()
    const snapshot = { ...solver.step(), iterMs: performance.now() - start }
    reportEngineFallback(solver)
    finished = snapshot.done
    if (solver.problem.mesh) latest = { iteration: snapshot.iteration, density: snapshot.density.slice(), vonMises: snapshot.vonMises.slice() }
    send({ type: 'frame', snapshot }, snapshotBuffers(snapshot))
    if (finished) stop()
    else if (running) timer = setTimeout(iterate, 0)
    else send({ type: 'paused' })
  } catch (error) {
    report(error)
  }
}

scope.onmessage = ({ data }: MessageEvent<WorkerCommand3D>) => {
  try {
    switch (data.type) {
      case 'preview':
        preview(data.requestId, data.problem, data.engine)
        break
      case 'engine':
        void selectEngine(data.engine)
        break
      case 'init':
        reset()
        solver = new Simp3D(data.problem)
        break
      case 'start':
        if (!running && !finished && ensureSolver()) {
          running = true
          timer = setTimeout(iterate, 0)
        }
        break
      case 'pause':
        stop()
        if (!finished) send({ type: 'paused' })
        break
      case 'step':
        if (finished) send({ type: 'done' })
        else if (!running) {
          if (ensureSolver()) iterate()
          else send({ type: 'paused' })
        }
        break
      case 'refine':
        refine(data.threshold)
        break
      case 'reset':
        reset()
        break
    }
  } catch (error) {
    report(error, data.type === 'refine')
    if (data.type === 'refine' && finished) send({ type: 'done' })
  }
}
