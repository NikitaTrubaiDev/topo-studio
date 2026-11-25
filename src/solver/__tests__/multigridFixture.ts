import { elementStiffness } from '../elementQ4'
import { Multigrid2D } from '../multigrid'
import { pcg, PcgWorkspace } from '../pcg'
import { makePreset } from '../presets'
import { elementDofs, Stiffness2D } from '../stiffness'
import type { Grid } from '../types'

export function elasticityFixture(grid: Grid, kind: 'mbb' | 'bellcrank' = 'mbb') {
  const { supports, loadCases, material } = makePreset(kind, grid)
  const size = 2 * (grid.nelx + 1) * (grid.nely + 1)
  const fixed = new Uint8Array(size)
  for (const { node, fixedX, fixedY } of supports) {
    fixed[node * 2] = Number(fixedX)
    fixed[node * 2 + 1] = Number(fixedY)
  }
  const force = new Float64Array(size)
  for (const { node, fx, fy } of loadCases[0].forces) {
    force[node * 2] += fx
    force[node * 2 + 1] += fy
  }
  const stiffness = new Stiffness2D(grid, fixed, elementDofs(grid))
  const modulus = Float64Array.from({ length: grid.nelx * grid.nely }, (_, i) => {
    const x = (i % grid.nelx) / grid.nelx, y = Math.floor(i / grid.nelx) / grid.nely
    const density = 0.45 + 0.22 * Math.sin(x * 10) * Math.cos(y * 6)
    return material.Emin + (material.E0 - material.Emin) * density ** 3
  })
  stiffness.assemble(modulus, elementStiffness(10, material.nu))
  const multigrid = new Multigrid2D(grid, fixed, stiffness)
  const workspace = new PcgWorkspace(size)
  return {
    fixed, multigrid,
    solve: (useMultigrid: boolean, tolerance = 1e-7) => pcg(stiffness.multiply, stiffness.diagonal, force, fixed, {
      precondition: useMultigrid ? multigrid.prepare() : undefined,
      tolerance, maxIterations: size, workspace,
    }),
  }
}
