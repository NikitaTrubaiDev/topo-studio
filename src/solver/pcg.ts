export interface PcgOptions {
  /** Relative tolerance against the norm of the force on the free DOFs. */
  tolerance?: number
  maxIterations?: number
  initial?: Float64Array
  /** Optional solution buffer. It may also be supplied as the warm start. */
  output?: Float64Array
  workspace?: PcgWorkspace
  /** Optional SPD inverse preconditioner on the free DOFs. Defaults to Jacobi. */
  precondition?: Multiply
}

export class PcgWorkspace {
  readonly residual: Float64Array
  readonly direction: Float64Array
  readonly product: Float64Array
  readonly inverse: Float64Array
  readonly conditioned: Float64Array

  constructor(size: number) {
    this.residual = new Float64Array(size)
    this.direction = new Float64Array(size)
    this.product = new Float64Array(size)
    this.inverse = new Float64Array(size)
    this.conditioned = new Float64Array(size)
  }
}

export interface PcgResult {
  u: Float64Array
  iterations: number
  relativeResidual: number
  converged: boolean
}

export type Multiply = (input: Float64Array, output: Float64Array) => void

/** Solve a reduced SPD system via operator products, with Jacobi as the default preconditioner. */
export function pcg(
  multiply: Multiply,
  diagonal: Float64Array,
  force: Float64Array,
  fixed: Uint8Array,
  {
    tolerance = 1e-6, maxIterations = force.length * 2, initial,
    output = new Float64Array(force.length), workspace = new PcgWorkspace(force.length), precondition,
  }: PcgOptions = {},
): PcgResult {
  const size = force.length
  const u = output
  if (!initial) u.fill(0)
  else if (initial !== u) u.set(initial)
  const { residual, direction, product, inverse, conditioned } = workspace
  let forceSquared = 0
  for (let i = 0; i < size; i++) {
    if (fixed[i]) {
      u[i] = 0
      inverse[i] = 0
    } else {
      if (!(diagonal[i] > 0) || !Number.isFinite(diagonal[i])) {
        throw new Error('The free stiffness diagonal must be finite and positive.')
      }
      inverse[i] = 1 / diagonal[i]
      forceSquared += force[i] * force[i]
    }
  }
  if (forceSquared === 0) {
    u.fill(0)
    return { u, iterations: 0, relativeResidual: 0, converged: true }
  }

  let squared = 0
  let preconditioned = 0
  function restartResidual() {
    multiply(u, product)
    squared = 0
    preconditioned = 0
    for (let i = 0; i < size; i++) {
      const r = fixed[i] ? 0 : force[i] - product[i]
      residual[i] = r
      squared += r * r
    }
    if (precondition) precondition(residual, direction)
    for (let i = 0; i < size; i++) {
      direction[i] = fixed[i] ? 0 : precondition ? direction[i] : residual[i] * inverse[i]
      preconditioned += residual[i] * direction[i]
    }
  }

  const target = forceSquared * tolerance ** 2
  restartResidual()
  let iterations = 0
  while (squared > target && iterations < maxIterations) {
    multiply(direction, product)
    let curvature = 0
    for (let i = 0; i < size; i++) {
      if (!fixed[i]) curvature += direction[i] * product[i]
    }
    const alpha = preconditioned / curvature
    if (!(curvature > 0) || !Number.isFinite(alpha)) break
    let nextPreconditioned = 0
    squared = 0
    for (let i = 0; i < size; i++) {
      if (fixed[i]) continue
      u[i] += alpha * direction[i]
      const r = residual[i] - alpha * product[i]
      residual[i] = r
      squared += r * r
      if (!precondition) nextPreconditioned += r * r * inverse[i]
    }
    iterations++
    if (squared <= target) {
      // Check the true residual before accepting convergence to catch recurrence drift.
      restartResidual()
      continue
    }
    if (precondition) {
      precondition(residual, conditioned)
      for (let i = 0; i < size; i++) nextPreconditioned += residual[i] * conditioned[i]
    }
    const beta = nextPreconditioned / preconditioned
    if (!Number.isFinite(beta)) break
    for (let i = 0; i < size; i++) {
      if (!fixed[i]) direction[i] = (precondition ? conditioned[i] : residual[i] * inverse[i]) + beta * direction[i]
    }
    preconditioned = nextPreconditioned
  }

  if (squared > target) restartResidual()
  const relativeResidual = Math.sqrt(squared / forceSquared)
  return { u, iterations, relativeResidual, converged: relativeResidual <= tolerance }
}
