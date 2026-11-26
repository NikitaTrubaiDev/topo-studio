/// <reference lib="webworker" />

import { Simp3D } from '../solver3d/simp3d'
import { ProblemError3D } from '../solver3d/types3d'
import type { WorkerCommand3D, WorkerEvent3D } from './protocol3d'

const scope = self as unknown as DedicatedWorkerGlobalScope
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
  finished = false
}

function report(error: unknown) {
  reset()
  if (error instanceof ProblemError3D) {
    const { code, relativeResidual } = error
    send({ type: 'error', issue: code, ...(relativeResidual !== undefined && { relativeResidual }) })
  } else send({ type: 'error', issue: 'workerError' })
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
      case 'init':
        reset()
        solver = new Simp3D(data.problem)
        break
      case 'start':
        if (solver && !running && !finished) {
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
        else if (solver && !running) iterate()
        else if (!solver) send({ type: 'paused' })
        break
      case 'reset':
        reset()
        break
    }
  } catch (error) {
    report(error)
  }
}
