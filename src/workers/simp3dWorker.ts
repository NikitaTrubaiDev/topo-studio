/// <reference lib="webworker" />

import { generateAdaptiveMesh3D, transferAdaptiveDensity3D } from '../solver3d/adaptiveMesh3d'
import { Simp3D, validateProblem3D } from '../solver3d/simp3d'
import { elementCount, ProblemError3D, type SimpProblem3D } from '../solver3d/types3d'
import type { Preview3D, TimedSnapshot3D, WorkerCommand3D, WorkerEvent3D } from './protocol3d'

const scope = self as unknown as DedicatedWorkerGlobalScope
let problem: SimpProblem3D | undefined
let solver: Simp3D | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let running = false
let finished = false
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
  solver = undefined
  problem = undefined
  finished = false
  latest = undefined
}

function report(error: unknown, recoverable = false) {
  if (!recoverable) reset()
  const recovery = recoverable ? { recoverable } : {}
  if (error instanceof ProblemError3D) {
    const { code, relativeResidual } = error
    send({ type: 'error', issue: code, ...recovery, ...(relativeResidual !== undefined && { relativeResidual }) })
  } else send({ type: 'error', issue: 'workerError', ...recovery })
}

function preview(requestId: number, next: SimpProblem3D) {
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
}

function ensureSolver() {
  if (!solver && problem) solver = new Simp3D(problem)
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
    finished = false
    send({ type: 'paused' })
    return
  }
  const start = performance.now()
  const design = transferAdaptiveDensity3D(mesh, previous, solver.designDensity)
  const next = new Simp3D({ ...solver.problem, mesh }, { design, iteration: latest.iteration })
  const snapshot = { ...next.step(false), iterMs: performance.now() - start }
  solver = next
  problem = next.problem
  latest = { iteration: snapshot.iteration, density: snapshot.density.slice(), vonMises: snapshot.vonMises.slice() }
  finished = false
  send({ type: 'refined', mesh, snapshot }, snapshotBuffers(snapshot))
}

function iterate() {
  timer = undefined
  if (!solver || finished) return
  try {
    const start = performance.now()
    const snapshot = { ...solver.step(), iterMs: performance.now() - start }
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
        preview(data.requestId, data.problem)
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
  }
}
