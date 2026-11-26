import { Multigrid3D } from './multigrid3d'
import { Stiffness3D } from './stiffness3d'
import { elementCount, nodeCount, type ElementType3D, type Grid3D, type Support3D } from './types3d'

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

export class Pcg3D {
  readonly stiffness: Stiffness3D
  readonly modulus: Float64Array
  private readonly multigrid?: Multigrid3D
  private readonly rhs: Float64Array
  private readonly residual: Float64Array
  private readonly direction: Float64Array
  private readonly product: Float64Array
  private readonly trial: Float64Array
  private readonly preconditioned: Float64Array

  constructor(grid: Grid3D, readonly Ke: Float64Array, readonly fixed: Uint8Array,
    options: { nu?: number; elementType?: ElementType3D; matrices?: readonly Float64Array[] } = {}) {
    const { nu, elementType = 'hex8', matrices = [Ke] } = options
    this.stiffness = new Stiffness3D(grid, matrices, fixed, elementType)
    if (nu !== undefined && Math.min(grid.nelx, grid.nely, grid.nelz) >= 4) {
      this.multigrid = new Multigrid3D(this.stiffness, nu, elementType)
    }
    this.modulus = new Float64Array(elementCount(grid, elementType))
    this.rhs = new Float64Array(fixed.length)
    this.residual = new Float64Array(fixed.length)
    this.direction = new Float64Array(fixed.length)
    this.product = new Float64Array(fixed.length)
    this.trial = new Float64Array(fixed.length)
    this.preconditioned = new Float64Array(fixed.length)
  }

  get dofs() { return this.stiffness.dofs }

  prepare(density: Float64Array, E0: number, Emin: number, penal: number) {
    if (density.length !== this.modulus.length) throw new RangeError('Invalid 3D density length')
    for (let e = 0; e < density.length; e++) this.modulus[e] = Emin + (E0 - Emin) * density[e] ** penal
    this.stiffness.prepare(this.modulus)
    this.multigrid?.prepare(this.modulus)
  }

  apply(u: Float64Array, out: Float64Array) {
    this.stiffness.apply(u, out)
  }

  /** u holds the previous solution on entry and the solution in mm on exit. */
  solve(force: Float64Array, u: Float64Array, tolerance = 1e-6, maxIterations = 4000) {
    const { fixed, rhs, residual, direction, product, trial, preconditioned } = this
    const { inverseDiagonal } = this.stiffness
    let multigrid = this.multigrid
    const precondition = () => {
      if (multigrid) multigrid.apply(residual, preconditioned)
      else for (let j = 0; j < u.length; j++) preconditioned[j] = inverseDiagonal[j] * residual[j]
      return dot(residual, preconditioned)
    }
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
      for (let j = 0; j < u.length; j++) residual[j] = rhs[j] - product[j]
      return dot(residual, residual)
    }
    const restart = () => {
      const error = refresh()
      if (error > target) {
        energy = precondition()
        direction.set(preconditioned)
      }
      return error
    }
    const normSquared = dot(rhs, rhs)
    const target = normSquared * tolerance ** 2
    let errorSquared = restart()
    if (!Number.isFinite(errorSquared)) {
      u.fill(0)
      multigrid = undefined
      errorSquared = restart()
    }
    let bestError = errorSquared
    let iterations = 0
    let lastProgress = 0, restarts = 0
    while (Number.isFinite(errorSquared) && errorSquared > target && iterations < maxIterations) {
      this.apply(direction, product)
      iterations++
      const curvature = dot(direction, product)
      const alpha = energy / curvature
      let breakdown = !(alpha > 0 && Number.isFinite(alpha) && curvature > 0)
      if (!breakdown) {
        errorSquared = 0
        for (let j = 0; j < u.length; j++) {
          trial[j] = u[j] + alpha * direction[j]
          const r = residual[j] - alpha * product[j]
          residual[j] = r
          errorSquared += r * r
          if (!Number.isFinite(trial[j])) breakdown = true
        }
        breakdown ||= !Number.isFinite(errorSquared)
        if (!breakdown) {
          u.set(trial)
          if (errorSquared > target) {
            const nextEnergy = precondition()
            breakdown = !(nextEnergy > 0 && Number.isFinite(nextEnergy))
            const beta = nextEnergy / energy
            for (let j = 0; j < u.length; j++) direction[j] = preconditioned[j] + beta * direction[j]
            energy = nextEnergy
          }
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
        if (breakdown || stalled) multigrid = undefined
        bestError = errorSquared = restart()
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
