import type { ProblemIssue3D, SimpProblem3D, Snapshot3D } from '../solver3d/types3d'

export type TimedSnapshot3D = Snapshot3D & { iterMs: number }
export type WorkerCommand3D = { type: 'init'; problem: SimpProblem3D }
  | { type: 'start' | 'pause' | 'step' | 'reset' }
export type WorkerEvent3D = { type: 'frame'; snapshot: TimedSnapshot3D }
  | { type: 'paused' } | { type: 'done' }
  | { type: 'error'; issue: ProblemIssue3D | 'workerError'; relativeResidual?: number }
