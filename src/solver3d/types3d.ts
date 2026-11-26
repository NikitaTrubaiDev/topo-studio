import type { Material, PassiveMasks } from '../solver/types'
import type { AdaptiveMesh3D, AdaptiveOptions3D } from './adaptiveMesh3d'

export interface Grid3D {
  nelx: number
  nely: number
  nelz: number
  widthMm: number
  heightMm: number
  depthMm: number
}

export type ElementType3D = 'hex8' | 'tet4' | 'adaptiveTet4'

export type Symmetry3D = 'none' | 'z' | 'y' | 'yz'

export interface SimpParams3D {
  /** Power applied to physical density in the stiffness interpolation. */
  penal: number
  /** Radius of the spherical cone in multiples of the shortest cell side. */
  rmin: number
  /** Physical volume fraction of the full domain, including passive cells. */
  volFrac: number
  /** Maximum change in a design variable per OC update. */
  moveLimit: number
  maxIter: number
  /** Maximum absolute design change at convergence. */
  changeTol: number
  heaviside?: boolean
  symmetry?: Symmetry3D
}

export interface Support3D {
  node: number
  fixX: boolean
  fixY: boolean
  fixZ: boolean
}

export interface Force3D {
  node: number
  fx: number
  fy: number
  fz: number
}

export interface LoadCase3D {
  id: string
  forces: readonly Force3D[]
}

export interface SimpProblem3D {
  elementType?: ElementType3D
  grid: Grid3D
  adaptive?: AdaptiveOptions3D
  mesh?: AdaptiveMesh3D
  material: Material
  params: SimpParams3D
  supports: readonly Support3D[]
  loadCases: readonly LoadCase3D[]
  /** One mask entry per brick. In Tet4 mode all five tetrahedra inherit it. */
  passive?: PassiveMasks
}

export interface Metrics3D {
  initialMass: number
  mass: number
  saved: number
  maxDeflection: number
  safetyFactor?: number
  p95SafetyFactor?: number
}

export interface Snapshot3D {
  iteration: number
  density: Float64Array
  vonMises: Float64Array
  displacements: Float64Array[]
  compliance: number
  volFrac: number
  change: number
  maxVonMises: number
  p95VonMises: number
  metrics: Metrics3D
  beta?: number
  done: boolean
}

export const maxCellAspectRatio3D = 4

export type ProblemIssue3D = 'settings3dError' | 'aspectRatio3dError' | 'mask3dError' | 'support3dError' | 'load3dError'
  | 'forceMagnitude3dError' | 'componentSupport3dError' | 'attachment3dError' | 'volume3dError' | 'solve3dError' | 'adaptiveBudget3dError'

export class ProblemError3D extends Error {
  constructor(readonly code: ProblemIssue3D, readonly relativeResidual?: number) {
    super(relativeResidual === undefined ? code : `${code}: relative residual ${relativeResidual}`)
  }
}

export function elementCount(grid: Grid3D, elementType: ElementType3D = 'hex8') {
  return grid.nelx * grid.nely * grid.nelz * (elementType === 'tet4' ? 5 : 1)
}

export function nodeCount(grid: Grid3D) {
  return (grid.nelx + 1) * (grid.nely + 1) * (grid.nelz + 1)
}

export function elementIndex(grid: Grid3D, x: number, y: number, z: number) {
  return (z * grid.nely + y) * grid.nelx + x
}

export function nodeIndex3D(grid: Grid3D, x: number, y: number, z: number) {
  return (z * (grid.nely + 1) + y) * (grid.nelx + 1) + x
}

export function cellSize(grid: Grid3D): [number, number, number] {
  return [grid.widthMm / grid.nelx, grid.heightMm / grid.nely, grid.depthMm / grid.nelz]
}

export function nodePosition(grid: Grid3D, node: number): [number, number, number] {
  const nx = grid.nelx + 1
  const ny = grid.nely + 1
  const [hx, hy, hz] = cellSize(grid)
  return [(node % nx) * hx, (Math.floor(node / nx) % ny) * hy, Math.floor(node / (nx * ny)) * hz]
}
