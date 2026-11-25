/** Square elements, numbered left to right and bottom to top. */
export interface Grid {
  nelx: number
  nely: number
  /** Side length in mm. Defaults to 1 for element counts without a physical scale. */
  cellSizeMm?: number
  /** Plane-stress thickness in mm. Defaults to 1 for legacy solver callers. */
  thicknessMm?: number
}

/** Elastic moduli and yield stress in MPa. Density is in kg/m³. */
export interface Material {
  name: string
  E0: number
  Emin: number
  nu: number
  densityKgM3: number
  yieldMPa: number
}

export type Symmetry = 'none' | 'x' | 'y' | 'xy'
export type BuildDirection = '+Y' | '-Y' | '+X' | '-X'

export interface SimpParams {
  /** Enable tanh projection with beta continuation and eta = 0.5. */
  heaviside?: boolean
  /** Mirror left/right (x), bottom/top (y), or both. */
  symmetry?: Symmetry
  /** Build direction for the 45-degree additive manufacturing filter. */
  overhang?: BuildDirection
  /** Defaults to multigrid where the grid can be coarsened. */
  preconditioner?: 'multigrid' | 'jacobi'
  /** SIMP stiffness penalization exponent (at least 1). */
  penal: number
  /** Cone radius in element widths. */
  rmin: number
  /** Target physical volume as a fraction of the entire grid, including passive elements. */
  volFrac: number
  /** Maximum per-step change in the unfiltered design variable. */
  moveLimit: number
  maxIter: number
  /** Stop once the maximum absolute design change reaches this tolerance. */
  changeTol: number
}

export interface Support {
  node: number
  fixedX: boolean
  fixedY: boolean
  /** Drawing symbol. Pins and clamps both fix the two translational DOFs. */
  kind?: 'fixed' | 'pin' | 'roller-x' | 'roller-y'
}

export interface NodalForce {
  node: number
  fx: number
  fy: number
}

export interface LoadCase {
  id: string
  name: string
  generatedNumber?: number
  /** Translation key for the default name of a preset load case. */
  presetName?: 'caseMbb' | 'caseCantilever' | 'caseBridge' | 'caseBracket' | 'caseBump' | 'caseRebound'
  forces: readonly NodalForce[]
}

export interface PassiveMasks {
  solid?: Uint8Array
  void?: Uint8Array
}

export interface SimpProblem {
  grid: Grid
  material: Material
  params: SimpParams
  supports: readonly Support[]
  loadCases: readonly LoadCase[]
  passive?: PassiveMasks
}

export interface IterationSnapshot {
  iteration: number
  density: Float32Array
  /** Peak center von Mises stress per element across load cases, in MPa. */
  vonMises: Float32Array
  /** Center von Mises stress (MPa), one element field per load case. */
  caseVonMises: Float32Array[]
  /** Interleaved X and Y translations in mm, one vector per load case. */
  displacements: Float64Array[]
  /** Sum of Fᵀu for all load cases, in N·mm. */
  compliance: number
  volFrac: number
  change: number
  maxVonMises: number
  beta?: number
  done: boolean
}

export function nodeIndex(grid: Grid, x: number, y: number): number {
  return y * (grid.nelx + 1) + x
}
