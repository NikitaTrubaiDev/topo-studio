import { centerB, elementStiffness, planeStressD } from './elementQ4'
import { DensityFilter } from './filter'
import { pcg } from './pcg'
import { nodeIndex, type IterationSnapshot, type SimpProblem } from './types'

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

interface Analysis {
  gradient: Float64Array
  displacements: Float64Array[]
  vonMises: Float32Array
  compliance: number
  maxVonMises: number
}

export class Simp2D {
  readonly volumeRange: readonly [number, number]
  private readonly filter: DensityFilter
  private readonly dofs: Uint32Array
  private readonly fixed: Uint8Array
  private readonly forces: Float64Array[]
  private readonly mask: Int8Array
  private readonly volumeGradient: Float64Array
  private readonly fixedVolume: number
  private readonly ke: Float64Array
  private readonly stressD: Float64Array
  private readonly design: Float64Array
  private previous?: Analysis
  private iteration = 0
  private done = false

  constructor(private readonly problem: SimpProblem) {
    const { grid, params, material, supports, loadCases, passive } = problem
    const { nelx, nely } = grid
    if (!Number.isSafeInteger(nelx) || !Number.isSafeInteger(nely) || nelx < 1 || nely < 1) {
      throw new Error('Grid dimensions must be positive integers.')
    }
    if (!Number.isFinite(material.E0) || !(material.E0 > material.Emin && material.Emin > 0)
      || !(material.nu > -1 && material.nu < 0.5)) {
      throw new Error('Material requires E0 > Emin > 0 and −1 < ν < 0.5.')
    }
    if (!Number.isFinite(params.penal) || params.penal < 1
      || !(params.volFrac >= 0 && params.volFrac <= 1)
      || !(params.moveLimit > 0 && params.moveLimit <= 1)
      || !Number.isSafeInteger(params.maxIter) || params.maxIter < 1
      || !Number.isFinite(params.changeTol) || params.changeTol < 0) {
      throw new Error('Invalid SIMP parameters.')
    }
    const elements = nelx * nely
    const nodes = (nelx + 1) * (nely + 1)
    this.ke = elementStiffness(1, material.nu)
    this.stressD = planeStressD(1, material.nu)
    this.dofs = new Uint32Array(elements * 8)
    for (let y = 0; y < nely; y++) {
      for (let x = 0; x < nelx; x++) {
        const bl = nodeIndex(grid, x, y)
        const tl = nodeIndex(grid, x, y + 1)
        const corners = [bl, bl + 1, tl + 1, tl]
        const offset = 8 * (y * nelx + x)
        for (let k = 0; k < 4; k++) {
          this.dofs[offset + 2 * k] = 2 * corners[k]
          this.dofs[offset + 2 * k + 1] = 2 * corners[k] + 1
        }
      }
    }
    this.fixed = new Uint8Array(nodes * 2)
    const supportRows = new Set<number>()
    const supportColumns = new Set<number>()
    for (const { node, fixedX, fixedY } of supports) {
      if (!Number.isInteger(node) || node < 0 || node >= nodes) throw new Error('Support node is outside the grid.')
      if (fixedX) {
        this.fixed[2 * node] = 1
        supportRows.add(Math.floor(node / (nelx + 1)))
      }
      if (fixedY) {
        this.fixed[2 * node + 1] = 1
        supportColumns.add(node % (nelx + 1))
      }
    }
    if (!supportRows.size || !supportColumns.size || supportRows.size + supportColumns.size < 3) {
      throw new Error('Supports must restrain both rigid translations and rotation.')
    }
    if (!loadCases.length) throw new Error('At least one load case is required.')
    this.forces = loadCases.map(({ forces }) => {
      const vector = new Float64Array(nodes * 2)
      for (const { node, fx, fy } of forces) {
        if (!Number.isInteger(node) || node < 0 || node >= nodes || !Number.isFinite(fx) || !Number.isFinite(fy)) {
          throw new Error('Invalid nodal load.')
        }
        vector[2 * node] += fx
        vector[2 * node + 1] += fy
      }
      return vector
    })

    if ([passive?.solid, passive?.void].some(mask => mask && mask.length !== elements)) {
      throw new Error('Passive masks must contain one entry per element.')
    }
    this.filter = new DensityFilter(grid, params.rmin)
    this.mask = new Int8Array(elements)
    this.design = new Float64Array(elements)
    const volumeAtOutput = new Float64Array(elements)
    let solidCount = 0
    for (let e = 0; e < elements; e++) {
      if (passive?.solid?.[e] && passive?.void?.[e]) throw new Error('Passive solid and void masks overlap.')
      if (passive?.solid?.[e]) {
        this.mask[e] = 1
        this.design[e] = 1
        solidCount++
      } else if (passive?.void?.[e]) {
        this.mask[e] = -1
      } else {
        volumeAtOutput[e] = 1
      }
    }

    // Passive variables act as fixed filter inputs, and passive outputs are overwritten.
    // Only free output rows contribute derivatives with respect to the filter inputs.
    this.volumeGradient = this.filter.transpose(volumeAtOutput)
    this.fixedVolume = solidCount + this.volumeGradient.reduce((sum, weight, e) => sum + weight * this.design[e], 0)
    let freeVolume = 0
    for (let e = 0; e < elements; e++) {
      if (this.mask[e]) this.volumeGradient[e] = 0
      freeVolume += this.volumeGradient[e]
    }
    this.volumeRange = [this.fixedVolume / elements, (this.fixedVolume + freeVolume) / elements]
    const [min, max] = this.volumeRange
    if (params.volFrac < min - 1e-12 || params.volFrac > max + 1e-12) {
      throw new Error('The target volume fraction is infeasible with the passive masks and filter radius.')
    }
    const initial = max > min ? Math.max(0, Math.min(1, (params.volFrac - min) / (max - min))) : 0
    for (let e = 0; e < elements; e++) {
      if (!this.mask[e]) this.design[e] = initial
    }
  }

  private physicalDensity() {
    const density = this.filter.apply(this.design)
    for (let e = 0; e < density.length; e++) {
      if (this.mask[e]) density[e] = this.mask[e] === 1 ? 1 : 0
      else density[e] = Math.min(1, density[e])
    }
    return density
  }

  private analyze(density: Float64Array): Analysis {
    const { E0, Emin } = this.problem.material
    const { penal } = this.problem.params
    const { dofs, ke, fixed, stressD } = this
    const modulus = density.map(value => Emin + (E0 - Emin) * value ** penal)
    const diagonal = new Float64Array(fixed.length)
    for (let e = 0; e < modulus.length; e++) {
      const start = 8 * e
      for (let i = 0; i < 8; i++) diagonal[dofs[start + i]] += modulus[e] * ke[9 * i]
    }
    const multiply = (input: Float64Array, output: Float64Array) => {
      output.fill(0)
      for (let e = 0; e < modulus.length; e++) {
        const start = 8 * e
        const scale = modulus[e]
        for (let i = 0; i < 8; i++) {
          output[dofs[start + i]] += scale * dotElement(ke, 8 * i, input, dofs, start)
        }
      }
    }
    const gradient = new Float64Array(density.length)
    const vonMises = new Float32Array(density.length)
    let compliance = 0
    let maxVonMises = 0
    const displacements = this.forces.map((force, caseIndex) => {
      const result = pcg(multiply, diagonal, force, fixed, {
        initial: this.previous?.displacements[caseIndex],
        tolerance: 1e-9,
        maxIterations: Math.max(1000, fixed.length * 4),
      })
      if (!result.converged) {
        throw new Error(`PCG failed for load case ${caseIndex + 1} (relative residual ${result.relativeResidual.toExponential(2)}).`)
      }
      const { u } = result
      for (let i = 0; i < force.length; i++) compliance += force[i] * u[i]
      for (let e = 0; e < density.length; e++) {
        if (this.mask[e] === -1) continue
        const start = 8 * e
        if (!this.mask[e]) {
          let energy = 0
          for (let i = 0; i < 8; i++) {
            energy += u[dofs[start + i]] * dotElement(ke, 8 * i, u, dofs, start)
          }
          gradient[e] -= penal * (E0 - Emin) * density[e] ** (penal - 1) * Math.max(0, energy)
        }
        const ex = dotElement(centerB, 0, u, dofs, start)
        const ey = dotElement(centerB, 8, u, dofs, start)
        const gamma = dotElement(centerB, 16, u, dofs, start)
        const sx = modulus[e] * (stressD[0] * ex + stressD[1] * ey)
        const sy = modulus[e] * (stressD[3] * ex + stressD[4] * ey)
        const shear = modulus[e] * stressD[8] * gamma
        const stress = Math.sqrt(sx * sx - sx * sy + sy * sy + 3 * shear * shear)
        vonMises[e] = Math.max(vonMises[e], stress)
        maxVonMises = Math.max(maxVonMises, stress)
      }
      return u
    })
    return { gradient: this.filter.transpose(gradient), displacements, vonMises, compliance, maxVonMises }
  }

  private update(gradient: Float64Array): number {
    const { design, volumeGradient } = this
    const { moveLimit, volFrac } = this.problem.params
    const target = volFrac * design.length
    const drive = new Float64Array(design.length)
    let maxDrive = 0
    for (let e = 0; e < design.length; e++) {
      if (volumeGradient[e] === 0) continue
      drive[e] = -gradient[e] / volumeGradient[e]
      maxDrive = Math.max(maxDrive, drive[e])
    }
    if (maxDrive === 0) return 0

    const lower = design.map(value => Math.max(0, value - moveLimit))
    const upper = design.map(value => Math.min(1, value + moveLimit))
    const trial = design.slice()
    let lo = 0
    let hi = 0
    // Search in the Lagrange multiplier coordinate t = sqrt(maxDrive / lambda).
    // A small positive seed lets a variable at zero regain material if its sensitivity rises.
    for (let e = 0; e < design.length; e++) {
      if (volumeGradient[e] === 0) continue
      drive[e] = Math.max(1e-8, design[e]) * Math.sqrt(Math.max(1e-12, drive[e] / maxDrive))
      hi = Math.max(hi, upper[e] / drive[e])
    }
    for (let i = 0; i < 90; i++) {
      const t = (lo + hi) / 2
      let volume = this.fixedVolume
      for (let e = 0; e < design.length; e++) {
        if (volumeGradient[e] === 0) continue
        trial[e] = Math.max(lower[e], Math.min(upper[e], drive[e] * t))
        volume += volumeGradient[e] * trial[e]
      }
      if (Math.abs(volume - target) <= 1e-9 * design.length) break
      if (volume < target) lo = t
      else hi = t
    }
    let change = 0
    for (let e = 0; e < design.length; e++) {
      change = Math.max(change, Math.abs(trial[e] - design[e]))
      design[e] = trial[e]
    }
    return change
  }

  step(): IterationSnapshot {
    if (this.done) throw new Error('This optimization has already finished.')
    const { params } = this.problem
    if (!this.previous) this.previous = this.analyze(this.physicalDensity())
    const change = this.update(this.previous.gradient)
    const physical = this.physicalDensity()
    const analysis = this.analyze(physical)
    this.previous = analysis
    this.iteration++
    this.done = this.iteration >= params.maxIter || change <= params.changeTol
    return {
      iteration: this.iteration,
      density: Float32Array.from(physical),
      vonMises: analysis.vonMises,
      displacements: analysis.displacements.map(u => u.slice()),
      compliance: analysis.compliance,
      volFrac: physical.reduce((sum, value) => sum + value, 0) / physical.length,
      change,
      maxVonMises: analysis.maxVonMises,
      done: this.done,
    }
  }
}
