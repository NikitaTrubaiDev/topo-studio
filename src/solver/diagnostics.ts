export type Diagnostic =
  | { code: 'detachedNodes'; params: { nodes: { x: number; y: number; kind: 'load' | 'support' }[] } }
  | { code: 'amConflict'; params: { cells: number[] } }
  | { code: 'volumeError'; params: { target: number; min: number; max: number } }
  | { code: 'nodalForceLimit' | 'netForceLimit'; params: { limit: number; case: number } }
  | { code: 'pcgFailure'; params: { case: number; residual: number } }
  | { code: 'projectError'; params: { field?: string } }
  | { code: 'stressOverflow'; params: { case: number } }
  | { code: 'gridSize' | 'elementSize' | 'invalidMaterial' | 'simpParams' | 'partThickness'
    | 'supportOutsideGrid' | 'unsupportedSupports' | 'missingLoadCases' | 'invalidNodalLoad'
    | 'freeLoad' | 'maskSize' | 'maskOverlap' | 'maskConflict' | 'filterRadius'
    | 'stiffnessDiagonal' | 'alreadyFinished' | 'workerError' | 'stlThickness'
    | 'stlTriangulation' | 'stlPrecision' | 'contourInput' | 'contourDensity'
    params?: never }

export class DiagnosticError extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.code)
    this.name = 'DiagnosticError'
  }
}

export function getDiagnostic(error: unknown): Diagnostic {
  return error instanceof DiagnosticError ? error.diagnostic : { code: 'workerError' }
}
