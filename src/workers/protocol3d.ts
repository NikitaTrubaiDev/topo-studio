import type { PassiveMasks } from '../solver/types'
import type { elementSurface3D } from '../solver3d/mesh3d'
import type { Surface3D, creaseGeometry3D } from '../solver3d/surface3d'
import type { SurfaceValidity3D } from '../solver3d/surfaceValidation3d'
import type { ElementType3D, Grid3D, ProblemIssue3D, SimpProblem3D, Snapshot3D } from '../solver3d/types3d'

export type TimedSnapshot3D = Snapshot3D & { iterMs: number }
export type WorkerCommand3D = { type: 'init'; problem: SimpProblem3D }
  | { type: 'preview'; requestId: number; problem: SimpProblem3D }
  | { type: 'start' | 'pause' | 'step' | 'reset' }
export type WorkerEvent3D = { type: 'frame'; snapshot: TimedSnapshot3D }
  | Preview3D
  | { type: 'paused' } | { type: 'done' }
  | { type: 'error'; issue: WorkerIssue3D; relativeResidual?: number }

type WorkerIssue3D = ProblemIssue3D | 'workerError'

export type Preview3D = {
  type: 'preview'
  requestId: number
  density: Float64Array
  passive?: PassiveMasks
  issue?: WorkerIssue3D
}

export type SurfaceInput3D = {
  density: Float64Array
  grid: Grid3D
  threshold: number
  smoothing: number
  passive?: PassiveMasks
  elementType: ElementType3D
  cad?: boolean
}

export type SurfaceRequest3D = SurfaceInput3D & { requestId: number }
export type SurfaceEvent3D = { requestId: number } & (
  { type: 'surface'; surface: Surface3D; valid: SurfaceValidity3D; render?: ReturnType<typeof creaseGeometry3D> } | { type: 'error' }
)


export type FemRequest3D = Pick<SurfaceInput3D, 'grid' | 'density' | 'threshold' | 'elementType'> & {
  type: 'fem'
  wireframe: boolean
}

export type FemEvent3D = ReturnType<typeof elementSurface3D>
