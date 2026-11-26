import { h8Corners } from './elementH8'
import { elementCount, nodeCount, nodeIndex3D, type Grid3D, type Support3D } from './types3d'

const maxRestarts = 4
const stallIterations = 256

export function fixedDofs3D(grid: Grid3D, supports: readonly Support3D[]) {
  const fixed = new Uint8Array(3 * nodeCount(grid))
  for (const { node, fixX, fixY, fixZ } of supports) {
    if (fixX) fixed[3 * node] = 1
    if (fixY) fixed[3 * node + 1] = 1
    if (fixZ) fixed[3 * node + 2] = 1
  }
  return fixed
}

function dot(a: Float64Array, b: Float64Array) {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}

/** Element-by-element stiffness action with Jacobi preconditioning and reused workspace. */
export class Pcg3D {
  readonly dofs: Int32Array
  readonly modulus: Float64Array
  private readonly inverseDiagonal: Float64Array
  private readonly rhs: Float64Array
  private readonly residual: Float64Array
  private readonly direction: Float64Array
  private readonly product: Float64Array
  private readonly trial: Float64Array
  private readonly elementVector = new Float64Array(24)

  constructor(grid: Grid3D, readonly Ke: Float64Array, readonly fixed: Uint8Array) {
    const count = elementCount(grid)
    this.modulus = new Float64Array(count)
    this.dofs = new Int32Array(count * 24)
    this.inverseDiagonal = new Float64Array(fixed.length)
    this.rhs = new Float64Array(fixed.length)
    this.residual = new Float64Array(fixed.length)
    this.direction = new Float64Array(fixed.length)
    this.product = new Float64Array(fixed.length)
    this.trial = new Float64Array(fixed.length)
    let e = 0
    for (let z = 0; z < grid.nelz; z++) for (let y = 0; y < grid.nely; y++) for (let x = 0; x < grid.nelx; x++, e++) {
      h8Corners.forEach(([dx, dy, dz], k) => {
        const d = 3 * nodeIndex3D(grid, x + dx, y + dy, z + dz)
        const index = e * 24 + 3 * k
        this.dofs[index] = d
        this.dofs[index + 1] = d + 1
        this.dofs[index + 2] = d + 2
      })
    }
  }

  prepare(density: Float64Array, E0: number, Emin: number, penal: number) {
    const { modulus, Ke, dofs, inverseDiagonal, fixed } = this
    inverseDiagonal.fill(0)
    for (let e = 0; e < density.length; e++) {
      const E = Emin + (E0 - Emin) * density[e] ** penal
      modulus[e] = E
      for (let j = 0; j < 24; j++) inverseDiagonal[dofs[e * 24 + j]] += E * Ke[j * 25]
    }
    for (let j = 0; j < fixed.length; j++) inverseDiagonal[j] = fixed[j] ? 0 : 1 / inverseDiagonal[j]
  }

  apply(u: Float64Array, out: Float64Array) {
    const { dofs, modulus, Ke, elementVector, fixed } = this
    out.fill(0)
    for (let e = 0, offset = 0; e < modulus.length; e++, offset += 24) {
      for (let j = 0; j < 24; j++) elementVector[j] = u[dofs[offset + j]]
      const E = modulus[e]
      for (let j = 0, row = 0; j < 24; j++, row += 24) {
        let a = 0, b = 0, c = 0, d = 0
        for (let k = 0; k < 24; k += 4) {
          a += Ke[row + k] * elementVector[k]
          b += Ke[row + k + 1] * elementVector[k + 1]
          c += Ke[row + k + 2] * elementVector[k + 2]
          d += Ke[row + k + 3] * elementVector[k + 3]
        }
        out[dofs[offset + j]] += E * (a + b + c + d)
      }
    }
    for (let j = 0; j < fixed.length; j++) if (fixed[j]) out[j] = 0
  }

  /** u holds the previous solution on entry and the solution in mm on exit. */
  solve(force: Float64Array, u: Float64Array, tolerance = 1e-6, maxIterations = 4000) {
    const { fixed, rhs, residual, direction, product, inverseDiagonal, trial } = this
    let scale = 0
    for (let j = 0; j < fixed.length; j++) if (!fixed[j]) scale = Math.max(scale, Math.abs(force[j]))
    if (scale === 0) {
      u.fill(0)
      return { converged: true, iterations: 0, relativeResidual: 0 }
    }
    for (let j = 0; j < u.length; j++) {
      rhs[j] = fixed[j] ? 0 : force[j] / scale
      u[j] = fixed[j] ? 0 : u[j] / scale
    }
    if (u.some(value => !Number.isFinite(value))) u.fill(0)
    let energy = 0
    const refresh = () => {
      this.apply(u, product)
      energy = 0
      for (let j = 0; j < u.length; j++) {
        residual[j] = rhs[j] - product[j]
        direction[j] = inverseDiagonal[j] * residual[j]
        energy += residual[j] * direction[j]
      }
      return dot(residual, residual)
    }
    const normSquared = dot(rhs, rhs)
    let errorSquared = refresh(), bestError = errorSquared
    let iterations = 0
    let lastProgress = 0, restarts = 0
    const target = normSquared * tolerance ** 2
    while (Number.isFinite(errorSquared) && errorSquared > target && iterations < maxIterations) {
      this.apply(direction, product)
      iterations++
      const curvature = dot(direction, product)
      const alpha = energy / curvature
      let breakdown = !(alpha > 0 && Number.isFinite(alpha) && curvature > 0)
      if (!breakdown) {
        let nextEnergy = 0
        errorSquared = 0
        for (let j = 0; j < u.length; j++) {
          trial[j] = u[j] + alpha * direction[j]
          const r = residual[j] - alpha * product[j]
          residual[j] = r
          errorSquared += r * r
          nextEnergy += r * r * inverseDiagonal[j]
          if (!Number.isFinite(trial[j])) breakdown = true
        }
        breakdown ||= !Number.isFinite(errorSquared) || !Number.isFinite(nextEnergy)
        if (!breakdown) {
          u.set(trial)
          const beta = nextEnergy / energy
          for (let j = 0; j < u.length; j++) direction[j] = inverseDiagonal[j] * residual[j] + beta * direction[j]
          energy = nextEnergy
        }
      }
      if (errorSquared < 0.99 * bestError) {
        bestError = errorSquared
        lastProgress = iterations
      }
      const stalled = iterations - lastProgress >= stallIterations
      // An apparently converged recurrence can drift from the true equilibrium residual.
      if (breakdown || errorSquared <= target || (stalled && restarts < maxRestarts)) {
        if (restarts >= maxRestarts || iterations >= maxIterations) break
        bestError = errorSquared = refresh()
        lastProgress = iterations
        restarts++
      }
    }
    // Check the true residual before returning a warm start to subsequent iterations.
    errorSquared = refresh()
    for (let j = 0; j < u.length; j++) u[j] = fixed[j] ? 0 : u[j] * scale
    const finite = u.every(Number.isFinite)
    return { converged: finite && errorSquared <= target, iterations, relativeResidual: Math.sqrt(errorSquared / normSquared) }
  }
}
