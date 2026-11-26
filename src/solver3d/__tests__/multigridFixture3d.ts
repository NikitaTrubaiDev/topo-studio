import { h8Stiffness } from '../elementH8'
import { tet4Templates } from '../elementT4'
import { Pcg3D } from '../pcg3d'
import { makePreset3D, presetGrid3D } from '../presets3d'
import { validateProblem3D } from '../simp3d'
import { cellSize, elementCount, type ElementType3D } from '../types3d'

export function cantileverFixture3D(resolution: readonly [number, number, number], elementType: ElementType3D) {
  const grid = presetGrid3D(resolution)
  const problem = makePreset3D('cantilever3d', grid, undefined, undefined, elementType)
  const { fixed, forces: [force] } = validateProblem3D(problem)
  const { nu, E0, Emin } = problem.material
  const matrices = elementType === 'tet4' ? tet4Templates(1, nu, ...cellSize(grid)).map(t => t.Ke)
    : [h8Stiffness(1, nu, ...cellSize(grid))]
  const density = Float64Array.from({ length: elementCount(grid, elementType) }, (_, e) => 0.45 + 0.12 * Math.sin(e / 29))
  function create(multigrid: boolean) {
    const pcg = new Pcg3D(grid, matrices[0], fixed, { elementType, matrices, ...(multigrid && { nu }) })
    const u = new Float64Array(fixed.length)
    return { pcg, u, solve(tolerance = 1e-6) {
      u.fill(0)
      pcg.prepare(density, E0, Emin, 3)
      return pcg.solve(force, u, tolerance)
    } }
  }
  return { create, fixed, nu }
}
