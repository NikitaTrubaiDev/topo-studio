import type { IterationSnapshot, SimpProblem } from '../solver/types'

export type WorkerCommand =
  | { type: 'init'; problem: SimpProblem }
  | { type: 'start' | 'pause' | 'step' }

export interface TimedSnapshot extends IterationSnapshot {
  iterMs: number
}

export type WorkerEvent =
  | { type: 'frame'; snapshot: TimedSnapshot }
  | { type: 'paused' }
  | { type: 'done' }
  | { type: 'error'; message: string }
