import { DiagnosticError } from './diagnostics'
import { attachmentError, isValidForce, MAX_NODAL_FORCE, supportError } from './design'
import { densitySum, ManufacturingDensity } from './manufacturing'
import { Multigrid2D } from './multigrid'
import { elementDofs, Stiffness2D } from './stiffness'
import { centerB, elementStiffness, planeStressD } from './elementQ4'
import { pcg, PcgWorkspace } from './pcg'
import type { IterationSnapshot, SimpProblem } from './types'

function dotElement(matrix: Float64Array, row: number, vector: Float64Array, dofs: Uint32Array, start: number) {
  return matrix[row] * vector[dofs[start]]
    + matrix[row + 1] * vector[dofs[start + 1]]
    + matrix[row + 2] * vector[dofs[start + 2]]
    + matrix[row + 3] * vector[dofs[start + 3]]
    + matrix[row + 4] * vector[dofs[start + 4]]
    + matrix[row + 5] * vector[dofs[start + 5]]
    + matrix[row + 6] * vector[dofs[start + 6]]
    + matrix[row + 7] * vector[dofs[start + 7]]
}

export class Simp2D {
  /** Attainable physical volume fractions at the initial projection beta. */
  readonly volumeRange: readonly [number, number]
  private readonly manufacturing: ManufacturingDensity
  private readonly multigrid?: Multigrid2D
  private readonly volumeAtOutput: Float64Array
  private readonly dofs: Uint32Array
  private readonly fixed: Uint8Array
  private readonly forces: Float64Array[]
  private readonly mask: Int8Array
  private readonly volumeGradient: Float64Array
  private readonly fixedVolume: number
  private readonly ke: Float64Array
  private readonly stressD: Float64Array
  private readonly design: Float64Array
  private readonly density: Float64Array
  private readonly modulus: Float64Array
  private readonly stiffness: Stiffness2D
  private readonly pcgWorkspace: PcgWorkspace
  private readonly displacements: Float64Array[]
  private readonly vonMises: Float64Array
  private readonly caseVonMises: Float32Array[]
  private readonly physicalGradient: Float64Array
  private readonly gradient: Float64Array
  private readonly drive: Float64Array
  private readonly lower: Float64Array
  private readonly upper: Float64Array
  private readonly trial: Float64Array
  private beta = 1
  private betaSince = 0
  private advanceBeta = false
  private iteration = 0
  private done = false

  constructor(private readonly problem: SimpProblem) {
    const { grid, params, material, supports, loadCases } = problem
    const { nelx, nely } = grid
    if (!Number.isSafeInteger(nelx) || !Number.isSafeInteger(nely) || nelx < 1 || nely < 1) {
      throw new DiagnosticError({ code: 'gridSize' })
    }
    const cellSize = grid.cellSizeMm ?? 1
    if (!Number.isFinite(cellSize) || cellSize <= 0) throw new DiagnosticError({ code: 'elementSize' })
    if (!Number.isFinite(material.E0) || !(material.E0 > material.Emin && material.Emin > 0)
      || !(material.nu > -1 && material.nu < 0.5)) {
      throw new DiagnosticError({ code: 'invalidMaterial' })
    }
    if (!Number.isFinite(params.penal) || params.penal < 1
      || !(params.volFrac >= 0 && params.volFrac <= 1)
      || !(params.moveLimit > 0 && params.moveLimit <= 1)
      || !Number.isSafeInteger(params.maxIter) || params.maxIter < 1
      || !Number.isFinite(params.changeTol) || params.changeTol < 0) {
      throw new DiagnosticError({ code: 'simpParams' })
    }
    const elements = nelx * nely
    const nodes = (nelx + 1) * (nely + 1)
    const thickness = grid.thicknessMm ?? 1
    if (!Number.isFinite(thickness) || thickness <= 0) throw new DiagnosticError({ code: 'partThickness' })
    this.ke = elementStiffness(thickness, material.nu)
    // Square element stiffness is invariant to side length. Strain scales as 1 / side length.
    this.stressD = planeStressD(1 / cellSize, material.nu)
    this.dofs = elementDofs(grid)
    this.fixed = new Uint8Array(nodes * 2)
    const issue = supportError(grid, supports)
    if (issue) throw new DiagnosticError(issue)
    for (const { node, fixedX, fixedY } of supports) {
      if (fixedX) this.fixed[2 * node] = 1
      if (fixedY) this.fixed[2 * node + 1] = 1
    }
    if (!loadCases.length) throw new DiagnosticError({ code: 'missingLoadCases' })
    this.forces = loadCases.map(({ forces }, caseIndex) => {
      const vector = new Float64Array(nodes * 2)
      for (const { node, fx, fy } of forces) {
        if (!Number.isInteger(node) || node < 0 || node >= nodes) {
          throw new DiagnosticError({ code: 'invalidNodalLoad' })
        }
        if (!isValidForce(fx, fy)) {
          throw new DiagnosticError({ code: 'nodalForceLimit', params: { case: caseIndex + 1, limit: MAX_NODAL_FORCE } })
        }
        vector[2 * node] += fx
        vector[2 * node + 1] += fy
      }
      for (const { node } of forces) {
        if (!isValidForce(vector[2 * node], vector[2 * node + 1])) {
          throw new DiagnosticError({ code: 'netForceLimit', params: { case: caseIndex + 1, limit: MAX_NODAL_FORCE } })
        }
      }
      return vector
    })

    this.manufacturing = new ManufacturingDensity(problem)
    const detached = attachmentError(problem, this.manufacturing.passive?.void)
    if (detached) throw new DiagnosticError(detached)
    const { mask, design, volumeGradient, fixedVolume } = this.manufacturing.setup
    const { density, volumeRange, diagnostic } = this.manufacturing.initialState()
    if (diagnostic) throw new DiagnosticError(diagnostic)
    this.volumeAtOutput = new Float64Array(elements).fill(1)
    this.mask = mask
    this.design = design
    this.volumeGradient = volumeGradient
    this.fixedVolume = fixedVolume
    this.volumeRange = volumeRange
    this.density = density
    this.modulus = new Float64Array(elements)
    this.stiffness = new Stiffness2D(grid, this.fixed, this.dofs)
    if (params.preconditioner !== 'jacobi' && Math.min(nelx, nely) >= 2 && nodes > 40) {
      this.multigrid = new Multigrid2D(grid, this.fixed, this.stiffness)
    }
    this.pcgWorkspace = new PcgWorkspace(this.fixed.length)
    this.displacements = this.forces.map(force => new Float64Array(force.length))
    this.vonMises = new Float64Array(elements)
    this.caseVonMises = this.forces.map(() => new Float32Array(elements))
    this.physicalGradient = new Float64Array(elements)
    this.gradient = new Float64Array(elements)
    this.drive = new Float64Array(elements)
    this.lower = new Float64Array(elements)
    this.upper = new Float64Array(elements)
    this.trial = new Float64Array(elements)
  }

  private physicalDensity() {
    return this.manufacturing.apply(this.design, this.density, this.beta)
  }

  private analyze(density: Float64Array) {
    const { E0, Emin } = this.problem.material
    const { penal } = this.problem.params
    const { dofs, ke, fixed, stressD, modulus, stiffness, physicalGradient, vonMises } = this
    for (let e = 0; e < modulus.length; e++) modulus[e] = Emin + (E0 - Emin) * density[e] ** penal
    stiffness.assemble(modulus, ke)
    const precondition = this.multigrid?.prepare()
    const tolerance = density.length >= 4_800 && this.iteration < 20 ? 1e-5 : 1e-6
    physicalGradient.fill(0)
    vonMises.fill(0)
    let compliance = 0
    let maxVonMises = 0
    for (let caseIndex = 0; caseIndex < this.forces.length; caseIndex++) {
      const force = this.forces[caseIndex]
      const u = this.displacements[caseIndex]
      const caseStress = this.caseVonMises[caseIndex]
      const result = pcg(stiffness.multiply, stiffness.diagonal, force, fixed, {
        precondition,
        tolerance,
        initial: u,
        output: u,
        workspace: this.pcgWorkspace,
        maxIterations: Math.max(1000, fixed.length * 4),
      })
      if (!result.converged) {
        throw new DiagnosticError({ code: 'pcgFailure', params: { case: caseIndex + 1, residual: result.relativeResidual } })
      }
      for (let i = 0; i < force.length; i++) compliance += force[i] * u[i]
      for (let e = 0; e < density.length; e++) {
        if (this.mask[e] === -1) continue
        const start = 8 * e
        if (!this.mask[e]) {
          let energy = 0
          for (let i = 0; i < 8; i++) {
            energy += u[dofs[start + i]] * dotElement(ke, 8 * i, u, dofs, start)
          }
          physicalGradient[e] -= penal * (E0 - Emin) * density[e] ** (penal - 1) * Math.max(0, energy)
        }
        const ex = dotElement(centerB, 0, u, dofs, start)
        const ey = dotElement(centerB, 8, u, dofs, start)
        const gamma = dotElement(centerB, 16, u, dofs, start)
        const sx = modulus[e] * (stressD[0] * ex + stressD[1] * ey)
        const sy = modulus[e] * (stressD[3] * ex + stressD[4] * ey)
        const shear = modulus[e] * stressD[8] * gamma
        // This form of von Mises avoids explicitly squaring tiny stress components.
        const stress = Math.hypot((sx + sy) / 2, Math.sqrt(3) * (sx - sy) / 2, Math.sqrt(3) * shear)
        const storedStress = Math.fround(stress)
        if (!Number.isFinite(storedStress)) {
          throw new DiagnosticError({ code: 'stressOverflow', params: { case: caseIndex + 1 } })
        }
        caseStress[e] = storedStress
        vonMises[e] = Math.max(vonMises[e], stress)
        maxVonMises = Math.max(maxVonMises, stress)
      }
    }
    this.manufacturing.transpose(physicalGradient, this.gradient)
    this.manufacturing.transpose(this.volumeAtOutput, this.volumeGradient)
    return { compliance, maxVonMises }
  }

  private update(gradient: Float64Array): number {
    const { design, volumeGradient, drive, lower, upper, trial } = this
    const { moveLimit, volFrac } = this.problem.params
    const target = volFrac * design.length
    let maxDrive = 0
    for (let e = 0; e < design.length; e++) {
      if (this.mask[e]) continue
      drive[e] = volumeGradient[e] > 0 ? -gradient[e] / volumeGradient[e] : 0
      maxDrive = Math.max(maxDrive, drive[e])
    }
    if (maxDrive === 0 && !this.manufacturing.nonlinear) return 0

    let lo = 0
    let hi = 0
    // Search in the Lagrange multiplier coordinate t = sqrt(maxDrive / lambda).
    // A small positive seed lets a variable at zero regain material if its sensitivity rises.
    for (let e = 0; e < design.length; e++) {
      if (this.mask[e]) continue
      lower[e] = Math.max(0, design[e] - moveLimit)
      upper[e] = Math.min(1, design[e] + moveLimit)
      drive[e] = Math.max(1e-8, design[e]) * Math.sqrt(Math.max(1e-12, maxDrive > 0 ? drive[e] / maxDrive : 1))
      hi = Math.max(hi, upper[e] / drive[e])
    }
    const evaluate = (t: number) => {
      let volume = this.fixedVolume
      for (let e = 0; e < design.length; e++) {
        if (this.mask[e]) {
          trial[e] = design[e]
        } else {
          trial[e] = Math.max(lower[e], Math.min(upper[e], drive[e] * t))
          volume += volumeGradient[e] * trial[e]
        }
      }
      return this.manufacturing.nonlinear
        ? densitySum(this.manufacturing.apply(trial, this.density, this.beta, false)) : volume
    }

    // Bracket close to the active update instead of bisecting from the
    // largest saturation point, which can be orders of magnitude away.
    const limit = hi
    hi = Math.min(1, limit)
    let volume = evaluate(hi)
    while (volume < target && hi < limit) {
      lo = hi
      hi = Math.min(2 * hi, limit)
      volume = evaluate(hi)
    }
    const tolerance = (this.manufacturing.nonlinear ? 1e-7 : 1e-9) * design.length
    const bracketed = volume >= target
    for (let i = 0; bracketed && i < 42 && Math.abs(volume - target) > tolerance; i++) {
      const t = (lo + hi) / 2
      volume = evaluate(t)
      if (volume < target) lo = t
      else hi = t
    }
    let change = 0
    for (let e = 0; e < design.length; e++) {
      if (this.mask[e]) continue
      change = Math.max(change, Math.abs(trial[e] - design[e]))
      design[e] = trial[e]
    }
    return change
  }

  private betaFeasible(beta: number) {
    const { design, trial, density, mask } = this
    const { moveLimit, volFrac } = this.problem.params
    for (const sign of [-1, 1]) {
      for (let e = 0; e < design.length; e++) {
        trial[e] = mask[e] ? design[e] : Math.max(0, Math.min(1, design[e] + sign * moveLimit))
      }
      const bound = densitySum(this.manufacturing.apply(trial, density, beta, false)) / density.length
      if (sign * (bound - volFrac) < -1e-7) return false
    }
    return true
  }

  step(): IterationSnapshot {
    if (this.done) throw new DiagnosticError({ code: 'alreadyFinished' })
    const { params } = this.problem
    const attempted = this.advanceBeta
    const continued = attempted && this.betaFeasible(2 * this.beta)
    if (attempted) this.betaSince = this.iteration
    if (continued) this.beta *= 2
    if (this.iteration === 0 || continued) this.analyze(this.physicalDensity())
    const change = this.update(this.gradient)
    const physical = this.physicalDensity()
    const analysis = this.analyze(physical)
    const stressSample = this.vonMises.filter((_, e) => physical[e] > 0.2)
    stressSample.sort()
    const p95VonMises = stressSample[Math.ceil(0.95 * stressSample.length) - 1]
    this.iteration++
    this.advanceBeta = !!params.heaviside && this.beta < 16
      && (this.iteration - this.betaSince >= 20 || (change <= params.changeTol && (!attempted || continued)))
    this.done = this.iteration >= params.maxIter || (!this.advanceBeta && change <= params.changeTol)
    return {
      iteration: this.iteration,
      density: Float32Array.from(physical),
      vonMises: Float32Array.from(this.vonMises),
      p95VonMises,
      caseVonMises: this.caseVonMises.map(stress => stress.slice()),
      displacements: this.displacements.map(u => u.slice()),
      compliance: analysis.compliance,
      volFrac: densitySum(physical) / physical.length,
      change,
      maxVonMises: analysis.maxVonMises,
      done: this.done,
      beta: params.heaviside ? this.beta : undefined,
    }
  }
}
