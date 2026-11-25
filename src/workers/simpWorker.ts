/// <reference lib="webworker" />

import { Simp2D } from '../solver/simp2d'
import type { WorkerCommand, WorkerEvent } from './protocol'

const scope = self as unknown as DedicatedWorkerGlobalScope
let solver: Simp2D | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let running = false
let finished = false

function send(event: WorkerEvent, transfer: Transferable[] = []) {
  scope.postMessage(event, transfer)
}

function stop() {
  running = false
  clearTimeout(timer)
  timer = undefined
}

function reportError(error: unknown) {
  stop()
  finished = true
  send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
}

function iterate() {
  timer = undefined
  if (!solver || finished) return
  try {
    const start = performance.now()
    const snapshot = { ...solver.step(), iterMs: performance.now() - start }
    finished = snapshot.done
    send({ type: 'frame', snapshot }, [
      snapshot.density.buffer,
      snapshot.vonMises.buffer,
      ...snapshot.displacements.map(u => u.buffer),
    ])
    if (finished) stop()
    else if (running) timer = setTimeout(iterate, 0)
  } catch (error) {
    reportError(error)
  }
}

scope.onmessage = ({ data }: MessageEvent<WorkerCommand>) => {
  try {
    switch (data.type) {
      case 'init':
        stop()
        finished = false
        solver = new Simp2D(data.problem)
        break
      case 'start':
        if (solver && !running && !finished) {
          running = true
          timer = setTimeout(iterate, 0)
        }
        break
      case 'pause':
        stop()
        send({ type: 'paused' })
        break
      case 'step':
        if (!running) iterate()
        break
    }
  } catch (error) {
    reportError(error)
  }
}
