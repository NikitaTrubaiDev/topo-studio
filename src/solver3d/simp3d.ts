import { elasticity3D, h8Corners, h8Stiffness, strainDisplacementH8, vonMises3D } from './elementH8'
import { DensityFilter3D, projectDensity3D } from './filter3d'
import { fixedDofs3D, Pcg3D } from './pcg3d'
import {
  cellSize, elementCount, elementIndex, maxCellAspectRatio3D, nodeCount, nodeIndex3D, nodePosition, ProblemError3D,
  type Grid3D, type SimpProblem3D, type Snapshot3D,
} from './types3d'

const positive = (value: number) => Number.isFinite(value) && value > 0
const clamp = (x: number, low: number, high: number) => Math.min(high, Math.max(low, x))
const sum = (values: Float64Array) => values.reduce((total, value) => total + value, 0)

function rigidRank(grid: Grid3D, fixed: Uint8Array) {
  const scale = Math.max(grid.widthMm, grid.heightMm, grid.depthMm)
  const basis: number[][] = []
  for (let d = 0; d < fixed.length; d++) {
    if (!fixed[d]) continue
    const [x, y, z] = nodePosition(grid, Math.floor(d / 3)).map(value => value / scale - 0.5)
    // Rows of the six rigid modes: Tx, Ty, Tz, Rx, Ry, Rz.
    const row = d % 3 === 0 ? [1, 0, 0, 0, z, -y]
      : d % 3 === 1 ? [0, 1, 0, -z, 0, x] : [0, 0, 1, y, -x, 0]
    for (const direction of basis) {
      const projection = row.reduce((total, value, i) => total + value * direction[i], 0)
      for (let i = 0; i < 6; i++) row[i] -= projection * direction[i]
    }
    const length = Math.hypot(...row)
    if (length > 1e-10) basis.push(row.map(value => value / length))
    if (basis.length === 6) break
  }
  return basis.length
}

export function validateProblem3D(problem: SimpProblem3D) {
  const { grid, params, material, passive, supports, loadCases } = problem
  const { nelx, nely, nelz } = grid
  const count = elementCount(grid)
  if (![nelx, nely, nelz, params.maxIter].every(value => Number.isSafeInteger(value) && value > 0)
    || ![grid.widthMm, grid.heightMm, grid.depthMm, material.E0, material.Emin, material.yieldMPa,
      material.densityKgM3, params.rmin, params.volFrac, params.moveLimit].every(positive)
    || !(material.nu > -1 && material.nu < 0.5) || material.Emin > material.E0
    || !(params.penal >= 1 && Number.isFinite(params.penal)) || !(params.changeTol >= 0 && params.changeTol < 1)
    || params.volFrac > 1 || params.moveLimit > 1 || !['none', 'y', 'z', 'yz'].includes(params.symmetry ?? 'none')) {
    throw new ProblemError3D('settings3dError')
  }
  const size = cellSize(grid)
  if (Math.max(...size) / Math.min(...size) > maxCellAspectRatio3D) throw new ProblemError3D('aspectRatio3dError')
  if ((passive?.void && passive.void.length !== count) || (passive?.solid && passive.solid.length !== count)) {
    throw new ProblemError3D('mask3dError')
  }
  const representatives = new Int32Array(count)
  const solid = new Uint8Array(count)
  const voidMask = new Uint8Array(count)
  const mirrorY = params.symmetry?.includes('y'), mirrorZ = params.symmetry?.includes('z')
  let e = 0
  for (let z = 0; z < nelz; z++) for (let y = 0; y < nely; y++) for (let x = 0; x < nelx; x++, e++) {
    const rep = elementIndex(grid, x, mirrorY ? Math.min(y, nely - 1 - y) : y, mirrorZ ? Math.min(z, nelz - 1 - z) : z)
    representatives[e] = rep
    if (passive?.solid?.[e]) solid[rep] = 1
    if (passive?.void?.[e]) voidMask[rep] = 1
    if (solid[rep] && voidMask[rep]) throw new ProblemError3D('mask3dError')
  }
  let solids = 0, allowed = 0
  const nodes = nodeCount(grid)
  const attached = new Uint8Array(nodes)
  e = 0
  for (let z = 0; z < nelz; z++) for (let y = 0; y < nely; y++) for (let x = 0; x < nelx; x++, e++) {
    solid[e] = solid[representatives[e]]
    voidMask[e] = voidMask[representatives[e]]
    solids += solid[e]
    if (voidMask[e]) continue
    allowed++
    for (const [dx, dy, dz] of h8Corners) attached[nodeIndex3D(grid, x + dx, y + dy, z + dz)] = 1
  }
  const target = count * params.volFrac
  if (target < solids - 1e-9 || target > allowed + 1e-9) throw new ProblemError3D('volume3dError')
  const validNode = (node: number) => Number.isInteger(node) && node >= 0 && node < nodes
  for (const support of supports) {
    if (!validNode(support.node)) throw new ProblemError3D('support3dError')
    if ((support.fixX || support.fixY || support.fixZ) && !attached[support.node]) throw new ProblemError3D('attachment3dError')
  }
  const fixed = fixedDofs3D(grid, supports)
  if (rigidRank(grid, fixed) < 6) throw new ProblemError3D('support3dError')
  const ids = new Set<string>()
  const forces = loadCases.map(load => {
    if (!load.id || ids.has(load.id)) throw new ProblemError3D('load3dError')
    ids.add(load.id)
    const rhs = new Float64Array(fixed.length)
    for (const { node, fx, fy, fz } of load.forces) {
      if (!validNode(node) || ![fx, fy, fz].every(Number.isFinite)) throw new ProblemError3D('load3dError')
      if ((fx || fy || fz) && !attached[node]) throw new ProblemError3D('attachment3dError')
      if (!fixed[3 * node]) rhs[3 * node] += fx
      if (!fixed[3 * node + 1]) rhs[3 * node + 1] += fy
      if (!fixed[3 * node + 2]) rhs[3 * node + 2] += fz
    }
    if (rhs.some(value => !Number.isFinite(value))) throw new ProblemError3D('load3dError')
    return rhs
  })
  if (!forces.some(rhs => rhs.some(value => value !== 0))) throw new ProblemError3D('load3dError')
  return { solid, voidMask, fixed, forces, representatives, allowed }
}

/** Same-grid engineering analysis. The PCG work vectors and displacements remain warm between calls. */
export class Analysis3D {
  private readonly pcg: Pcg3D
  private readonly B: Float64Array
  private readonly D: Float64Array
  private readonly stress = new Float64Array(6)
  private readonly strain = new Float64Array(6)
  private readonly loadedNodes: Uint8Array
  private readonly displacementNodes: Uint8Array
  readonly displacements: Float64Array[]
  readonly vonMises: Float64Array
  readonly gradient: Float64Array

  constructor(readonly problem: SimpProblem3D, fixed: Uint8Array, readonly forces: Float64Array[]) {
    const size = cellSize(problem.grid)
    this.pcg = new Pcg3D(problem.grid, h8Stiffness(1, problem.material.nu, ...size), fixed)
    this.B = strainDisplacementH8(...size)
    this.D = elasticity3D(1, problem.material.nu)
    this.displacements = forces.map(force => new Float64Array(force.length))
    this.loadedNodes = new Uint8Array(fixed.length / 3)
    for (const force of forces) for (let d = 0; d < force.length; d += 3) {
      if (force[d] || force[d + 1] || force[d + 2]) this.loadedNodes[d / 3] = 1
    }
    this.displacementNodes = this.loadedNodes.slice()
    this.vonMises = new Float64Array(elementCount(problem.grid))
    this.gradient = new Float64Array(this.vonMises.length)
  }

  solve(density: Float64Array, penal: number, tolerance: number) {
    const { pcg, B, D, stress, strain, vonMises, gradient, displacementNodes } = this
    const { E0, Emin } = this.problem.material
    pcg.prepare(density, E0, Emin, penal)
    displacementNodes.set(this.loadedNodes)
    for (let e = 0, offset = 0; e < density.length; e++, offset += 24) {
      if (density[e] < 0.25) continue
      for (let j = 0; j < 24; j += 3) displacementNodes[pcg.dofs[offset + j] / 3] = 1
    }
    let compliance = 0, maxDeflection = 0
    gradient.fill(0)
    vonMises.fill(0)
    for (let c = 0; c < this.forces.length; c++) {
      const force = this.forces[c], u = this.displacements[c]
      const result = pcg.solve(force, u, tolerance)
      if (!result.converged) throw new ProblemError3D('solve3dError', result.relativeResidual)
      for (let d = 0; d < u.length; d += 3) {
        compliance += force[d] * u[d] + force[d + 1] * u[d + 1] + force[d + 2] * u[d + 2]
        if (displacementNodes[d / 3]) maxDeflection = Math.max(maxDeflection, Math.hypot(u[d], u[d + 1], u[d + 2]))
      }
      for (let e = 0, offset = 0; e < density.length; e++, offset += 24) {
        let energy = 0
        strain.fill(0)
        for (let j = 0; j < 24; j++) {
          const q = u[pcg.dofs[offset + j]]
          let Ku = 0
          for (let k = 0; k < 24; k++) Ku += pcg.Ke[j * 24 + k] * u[pcg.dofs[offset + k]]
          energy += q * Ku
          for (let k = 0; k < 6; k++) strain[k] += B[k * 24 + j] * q
        }
        gradient[e] -= penal * (E0 - Emin) * density[e] ** (penal - 1) * Math.max(0, energy)
        for (let j = 0; j < 6; j++) {
          let value = 0
          for (let k = 0; k < 6; k++) value += D[j * 6 + k] * strain[k]
          stress[j] = pcg.modulus[e] * value
        }
        vonMises[e] = Math.max(vonMises[e], vonMises3D(stress[0], stress[1], stress[2], stress[3], stress[4], stress[5]))
      }
    }
    if (!Number.isFinite(compliance) || !Number.isFinite(maxDeflection) || vonMises.some(value => !Number.isFinite(value))) {
      throw new ProblemError3D('solve3dError')
    }
    return { compliance, maxDeflection }
  }
}

export class Simp3D {
  private readonly setup
  private readonly filter: DensityFilter3D
  private analysis?: Analysis3D
  private readonly design: Float64Array
  private readonly candidate: Float64Array
  private readonly physical: Float64Array
  private readonly scratch: Float64Array
  private readonly derivative: Float64Array
  private readonly dc: Float64Array
  private readonly dv: Float64Array
  private beta: number
  private iteration = 0

  constructor(readonly problem: SimpProblem3D) {
    const { grid, params } = problem
    const count = elementCount(grid)
    this.setup = validateProblem3D(problem)
    this.filter = new DensityFilter3D(grid, params.rmin, this.setup.voidMask)
    this.design = new Float64Array(count)
    this.candidate = new Float64Array(count)
    this.physical = new Float64Array(count)
    this.scratch = new Float64Array(count)
    this.derivative = new Float64Array(count)
    this.dc = new Float64Array(count)
    this.dv = new Float64Array(count)
    this.beta = params.heaviside ? 1 : 0
    this.matchVolume()
  }

  private density(input: Float64Array, output: Float64Array) {
    this.filter.apply(input, output)
    projectDensity3D(output, this.derivative, this.beta, this.setup.solid, this.setup.voidMask)
    return sum(output)
  }

  private matchVolume() {
    const { solid, voidMask } = this.setup
    const target = this.problem.params.volFrac * this.design.length
    // Prescribed solid cells also contribute to their free neighbors through H.
    this.candidate.set(solid)
    const minimum = this.density(this.candidate, this.scratch)
    if (target < minimum - 1e-9) throw new ProblemError3D('volume3dError')
    let low = -1, high = 1
    for (let i = 0; i < 40; i++) {
      const shift = (low + high) * 0.5
      for (let e = 0; e < this.design.length; e++) {
        this.candidate[e] = solid[e] ? 1 : voidMask[e] ? 0 : clamp(this.design[e] + shift, 0, 1)
      }
      if (this.density(this.candidate, this.scratch) > target) high = shift
      else low = shift
    }
    this.design.set(this.candidate)
  }

  initialDensity() {
    this.density(this.design, this.physical)
    return this.physical.slice()
  }

  get passiveMasks() {
    return { solid: this.setup.solid, void: this.setup.voidMask }
  }

  private update(gradient: Float64Array) {
    const { representatives, solid, voidMask } = this.setup
    const { moveLimit, volFrac } = this.problem.params
    for (let e = 0; e < gradient.length; e++) this.scratch[e] = gradient[e] * this.derivative[e]
    this.filter.transpose(this.scratch, this.dc)
    this.filter.transpose(this.derivative, this.dv)
    for (let e = 0; e < representatives.length; e++) {
      const rep = representatives[e]
      if (rep === e) continue
      this.dc[rep] += this.dc[e]
      this.dv[rep] += this.dv[e]
    }

    // Normalize the gradient ratio before bisection so the update is load-scale invariant.
    let scale = 0
    for (let e = 0; e < this.dc.length; e++) {
      if (solid[e] || voidMask[e] || representatives[e] !== e || this.dv[e] === 0) continue
      scale = Math.max(scale, -this.dc[e] / this.dv[e])
    }
    if (!positive(scale)) return 0
    for (let e = 0; e < this.dc.length; e++) {
      if (representatives[e] === e) this.dc[e] = this.dv[e] > 0 ? (-this.dc[e] / this.dv[e]) / scale : 0
    }
    const target = volFrac * this.design.length
    let low = 0, high = 1e5
    for (let i = 0; i < 64; i++) {
      const multiplier = (low + high) * 0.5
      for (let e = 0; e < this.design.length; e++) {
        if (solid[e] || voidMask[e]) {
          this.candidate[e] = solid[e]
          continue
        }
        const x = this.design[e]
        const ratio = this.dc[representatives[e]]
        this.candidate[e] = clamp(Math.max(x, 1e-9) * Math.sqrt(ratio / multiplier),
          Math.max(0, x - moveLimit), Math.min(1, x + moveLimit))
      }
      const error = this.density(this.candidate, this.scratch) - target
      if (Math.abs(error) <= this.design.length * 1e-8) break
      if (error > 0) low = multiplier
      else high = multiplier
    }
    let change = 0
    for (let e = 0; e < this.design.length; e++) change = Math.max(change, Math.abs(this.candidate[e] - this.design[e]))
    this.design.set(this.candidate)
    return change
  }

  step(): Snapshot3D {
    const { params, grid, material } = this.problem
    this.iteration++
    const nextBeta = params.heaviside ? 2 ** Math.min(3, Math.floor((this.iteration - 1) / 20)) : 0
    if (nextBeta !== this.beta) {
      this.beta = nextBeta
      this.matchVolume()
    }
    const volume = this.density(this.design, this.physical)
    const analysis = this.analysis ??= new Analysis3D(this.problem, this.setup.fixed, this.setup.forces)
    const { compliance, maxDeflection } = analysis.solve(this.physical, params.penal, this.iteration <= 10 ? 1e-5 : 1e-6)
    const { vonMises, displacements } = analysis
    let maxVonMises = 0
    const stress: number[] = []
    for (let e = 0; e < vonMises.length; e++) {
      if (this.setup.voidMask[e]) continue
      maxVonMises = Math.max(maxVonMises, vonMises[e])
      if (this.physical[e] > 0.2) stress.push(vonMises[e])
    }
    stress.sort((a, b) => a - b)
    const p95VonMises = stress[Math.ceil(stress.length * 0.95) - 1] ?? 0
    const massPerCell = cellSize(grid).reduce((a, b) => a * b) * material.densityKgM3 * 1e-6
    const mass = volume * massPerCell
    const initialMass = this.setup.allowed * massPerCell
    const change = this.update(analysis.gradient)
    const done = this.iteration >= params.maxIter || (change <= params.changeTol && (!params.heaviside || this.beta === 8))
    return { iteration: this.iteration, density: this.physical.slice(), vonMises: vonMises.slice(),
      displacements: displacements.map(u => u.slice()), compliance, volFrac: volume / vonMises.length, change,
      maxVonMises, p95VonMises, metrics: { mass, initialMass, saved: 100 * (1 - mass / initialMass), maxDeflection,
        safetyFactor: maxVonMises > 0 ? material.yieldMPa / maxVonMises : undefined,
        p95SafetyFactor: p95VonMises > 0 ? material.yieldMPa / p95VonMises : undefined },
      beta: this.beta || undefined, done }
  }
}
