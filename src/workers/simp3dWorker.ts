/// <reference lib="webworker" />

import { Simp3D, validateProblem3D } from '../solver3d/simp3d'
import { elementCount, ProblemError3D, type SimpProblem3D } from '../solver3d/types3d'
import type { Preview3D, WorkerCommand3D, WorkerEvent3D } from './protocol3d'

const scope = self as unknown as DedicatedWorkerGlobalScope
let problem: SimpProblem3D | undefined
let solver: Simp3D | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let running = false
let finished = false

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
}

function report(error: unknown) {
  reset()
  if (error instanceof ProblemError3D) {
    const { code, relativeResidual } = error
    send({ type: 'error', issue: code, ...(relativeResidual !== undefined && { relativeResidual }) })
  } else send({ type: 'error', issue: 'workerError' })
}

function preview(requestId: number, next: SimpProblem3D) {
  reset()
  problem = next
  const { grid, params, passive, elementType = 'hex8' } = next
  let event: Preview3D
  try {
    if (passive?.solid?.some(Boolean)) {
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

function iterate() {
  timer = undefined
  if (!solver || finished) return
  try {
    const start = performance.now()
    const snapshot = { ...solver.step(), iterMs: performance.now() - start }
    finished = snapshot.done
    send({ type: 'frame', snapshot }, [
      snapshot.density.buffer, snapshot.vonMises.buffer, ...snapshot.displacements.map(u => u.buffer),
    ])
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
      case 'reset':
        reset()
        break
    }
  } catch (error) {
    report(error)
  }
}
