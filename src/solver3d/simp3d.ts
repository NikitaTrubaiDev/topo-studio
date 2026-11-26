import { generateAdaptiveMesh3D } from './adaptiveMesh3d'
import { preflightAdaptiveSolver3D, unstructuredSetup3D, UnstructuredConeFilter3D, UnstructuredStiffness3D } from './unstructuredTet4'
import { brickMasks3D, forceMagnitude3D, nodeTouchesMaterial3D, rigidComponents3D, rigidComponentsStable3D, rigidRank3D, validForceMagnitude3D } from './design3d'
import { elasticity3D, h8Corners, h8Stiffness, strainDisplacementH8, vonMises3D } from './elementH8'
import { tet4Templates, tetCorners, tetVolumeFraction } from './elementT4'
import { DensityFilter3D, projectDensity3D } from './filter3d'
import type { Stiffness3D } from './stiffness3d'
import { fixedDofs3D, Pcg3D } from './pcg3d'
import {
  cellSize, elementCount, maxCellAspectRatio3D, nodeCount, nodeIndex3D, nodePosition, ProblemError3D,
  type SimpProblem3D, type Snapshot3D,
} from './types3d'

const positive = (value: number) => Number.isFinite(value) && value > 0
const clamp = (x: number, low: number, high: number) => Math.min(high, Math.max(low, x))
function dot(a: Float64Array, b: Float64Array) {
  let value = 0
  for (let i = 0; i < a.length; i++) value += a[i] * b[i]
  return value
}

function validateComponentSupports(problem: SimpProblem3D, voidMask: Uint8Array, loaded: Uint8Array) {
  if (!voidMask.some(Boolean)) return
  const { grid, supports } = problem
  const { nelx, nely, nelz } = grid
  const layer = nelx * nely
  const coords = (e: number) => [e % nelx, Math.floor(e / nelx) % nely, Math.floor(e / layer)]
  // A non-void brick is rigid, including its five face-connected Tet4s.
  const components = rigidComponents3D(voidMask, loaded.length, e => {
    const [x, y, z] = coords(e)
    return [x > 0 ? e - 1 : -1, x + 1 < nelx ? e + 1 : -1,
      y > 0 ? e - nelx : -1, y + 1 < nely ? e + nelx : -1,
      z > 0 ? e - layer : -1, z + 1 < nelz ? e + layer : -1]
  }, e => {
    const [x, y, z] = coords(e)
    return h8Corners.map(([dx, dy, dz]) => nodeIndex3D(grid, x + dx, y + dy, z + dz))
  })
  if (!rigidComponentsStable3D(components, supports, Math.max(grid.widthMm, grid.heightMm, grid.depthMm),
    node => nodePosition(grid, node), loaded)) throw new ProblemError3D('componentSupport3dError')
}

export function validateProblem3D(problem: SimpProblem3D) {
  const { grid, params, material, passive, supports, loadCases, elementType = 'hex8' } = problem
  const { nelx, nely, nelz } = grid
  const count = elementCount(grid)
  if (elementType === 'adaptiveTet4') {
    if (problem.adaptive && ![1, 2].includes(problem.adaptive.maxLevel)) throw new ProblemError3D('settings3dError')
    const mesh = problem.mesh ?? generateAdaptiveMesh3D(problem)
    validateProblem3D({ ...problem, elementType: 'hex8' })
    return unstructuredSetup3D(problem, mesh)
  }
  if ((elementType !== 'hex8' && elementType !== 'tet4') || ![nelx, nely, nelz, params.maxIter].every(value => Number.isSafeInteger(value) && value > 0)
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
  const { representatives, solid, voidMask } = brickMasks3D(problem)
  const mirrorY = params.symmetry?.includes('y'), mirrorZ = params.symmetry?.includes('z')
  let solids = 0, allowed = 0
  const nodes = nodeCount(grid)
  for (let e = 0; e < count; e++) {
    if (solid[e] && voidMask[e]) throw new ProblemError3D('mask3dError')
    solids += solid[e]
    allowed += 1 - voidMask[e]
  }
  const target = count * params.volFrac
  if (target < solids - 1e-9 || target > allowed + 1e-9) throw new ProblemError3D('volume3dError')
  const validNode = (node: number) => Number.isInteger(node) && node >= 0 && node < nodes
  for (const support of supports) {
    if (!validNode(support.node)) throw new ProblemError3D('support3dError')
    if ((support.fixX || support.fixY || support.fixZ) && !nodeTouchesMaterial3D(grid, support.node, voidMask)) {
      throw new ProblemError3D('attachment3dError')
    }
  }
  const fixed = fixedDofs3D(grid, supports)
  if (rigidRank3D(grid, supports) < 6) throw new ProblemError3D('support3dError')
  const ids = new Set<string>()
  const loaded = new Uint8Array(nodes)
  const forces = loadCases.map(load => {
    if (!load.id || ids.has(load.id)) throw new ProblemError3D('load3dError')
    ids.add(load.id)
    const rhs = new Float64Array(fixed.length)
    for (const { node, fx, fy, fz } of load.forces) {
      if (!validNode(node)) throw new ProblemError3D('load3dError')
      const magnitude = forceMagnitude3D({ fx, fy, fz })
      if (magnitude !== 0) {
        if (!validForceMagnitude3D(magnitude)) throw new ProblemError3D('forceMagnitude3dError')
        if (!nodeTouchesMaterial3D(grid, node, voidMask)) throw new ProblemError3D('attachment3dError')
        loaded[node] = 1
      }
      if (!fixed[3 * node]) rhs[3 * node] += fx
      if (!fixed[3 * node + 1]) rhs[3 * node + 1] += fy
      if (!fixed[3 * node + 2]) rhs[3 * node + 2] += fz
    }
    if (rhs.some(value => !Number.isFinite(value))) throw new ProblemError3D('load3dError')
    return rhs
  })
  if (!forces.some(rhs => rhs.some(value => value !== 0))) throw new ProblemError3D('load3dError')
  validateComponentSupports(problem, voidMask, loaded)
  if (elementType === 'hex8') return { solid, voidMask, fixed, forces, representatives, allowed, brickMasks: { solid, void: voidMask } }

  const tetSolid = new Uint8Array(5 * count), tetVoid = new Uint8Array(5 * count)
  const tetRepresentatives = new Int32Array(5 * count)
  // Across an odd number of cells the mirrored brick has the opposite subdivision
  // from the reflected one. Its overlapping tetrahedra must share a single value.
  const tieBrick = (mirrorY && nely % 2 === 1) || (mirrorZ && nelz % 2 === 1)
  for (let z = 0, brick = 0; z < nelz; z++) for (let y = 0; y < nely; y++) for (let x = 0; x < nelx; x++, brick++) {
    const ry = mirrorY ? Math.min(y, nely - 1 - y) : y, rz = mirrorZ ? Math.min(z, nelz - 1 - z) : z
    const reflection = (y === ry ? 0 : 2) | (z === rz ? 0 : 4)
    const side = tetCorners[(x + y + z) & 1]
    const reflectedSide = tetCorners[(x + ry + rz) & 1]
    for (let t = 0; t < 5; t++) {
      const e = 5 * brick + t
      const corner = t && !tieBrick ? side[t][0] ^ reflection : -1
      const mirrored = corner < 0 ? 0 : reflectedSide.findIndex((nodes, i) => i > 0 && nodes[0] === corner)
      tetRepresentatives[e] = 5 * representatives[brick] + mirrored
      tetSolid[e] = solid[brick]
      tetVoid[e] = voidMask[brick]
    }
  }
  return { solid: tetSolid, voidMask: tetVoid, fixed, forces, representatives: tetRepresentatives, allowed,
    brickMasks: { solid, void: voidMask } }
}

/** Same-grid engineering analysis. The PCG work vectors and displacements remain warm between calls. */
export class Analysis3D {
  private readonly pcg: Pcg3D<Stiffness3D | UnstructuredStiffness3D>
  private readonly B: readonly Float64Array[]
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
    const { elementType = 'hex8' } = problem
    const mesh = elementType === 'adaptiveTet4' ? problem.mesh ?? generateAdaptiveMesh3D(problem) : undefined
    const { nu } = problem.material
    const templates = elementType === 'tet4' ? tet4Templates(1, nu, ...size)
      : mesh ? [] : [{ Ke: h8Stiffness(1, nu, ...size), B: strainDisplacementH8(...size) }]
    this.pcg = new Pcg3D(problem.grid, templates[0]?.Ke ?? new Float64Array(), fixed,
      { nu, elementType, stiffness: mesh ? new UnstructuredStiffness3D(mesh, nu, fixed) : undefined, matrices: templates.map(t => t.Ke) })
    this.B = this.pcg.stiffness instanceof UnstructuredStiffness3D ? this.pcg.stiffness.strains : templates.map(t => t.B)
    this.D = elasticity3D(1, problem.material.nu)
    this.displacements = forces.map(force => new Float64Array(force.length))
    this.loadedNodes = new Uint8Array(fixed.length / 3)
    for (const force of forces) for (let d = 0; d < force.length; d += 3) {
      if (force[d] || force[d + 1] || force[d + 2]) this.loadedNodes[d / 3] = 1
    }
    this.displacementNodes = this.loadedNodes.slice()
    this.vonMises = new Float64Array(this.pcg.modulus.length)
    this.gradient = new Float64Array(this.vonMises.length)
  }

  solve(density: Float64Array, penal: number, tolerance: number) {
    const { pcg, B, D, stress, strain, vonMises, gradient, displacementNodes } = this
    const { E0, Emin } = this.problem.material
    const { width, matrices, templateIndex, dofs } = pcg.stiffness
    pcg.prepare(density, E0, Emin, penal)
    displacementNodes.set(this.loadedNodes)
    for (let e = 0, offset = 0; e < density.length; e++, offset += width) {
      if (density[e] < 0.25) continue
      for (let j = 0; j < width; j += 3) displacementNodes[dofs[offset + j] / 3] = 1
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
      for (let e = 0, offset = 0; e < density.length; e++, offset += width) {
        const template = templateIndex[e], Ke = matrices[template], Be = B[template]
        let energy = 0
        strain.fill(0)
        for (let j = 0; j < width; j++) {
          const q = u[dofs[offset + j]]
          let Ku = 0
          for (let k = 0; k < width; k++) Ku += Ke[j * width + k] * u[dofs[offset + k]]
          energy += q * Ku
          for (let k = 0; k < 6; k++) strain[k] += Be[k * width + j] * q
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
  private readonly filter: DensityFilter3D | UnstructuredConeFilter3D
  private analysis?: Analysis3D
  private readonly design: Float64Array
  private readonly candidate: Float64Array
  private readonly physical: Float64Array
  private readonly scratch: Float64Array
  private readonly derivative: Float64Array
  private readonly dc: Float64Array
  private readonly dv: Float64Array
  private readonly volumes: Float64Array
  private readonly volumeWeights: Float64Array
  private readonly totalVolume: number
  private readonly orbitVolume?: Float64Array
  private readonly orbitValues?: Float64Array
  private beta: number
  private iteration = 0

  readonly problem: SimpProblem3D

  readonly adaptiveBytes: number

  constructor(input: SimpProblem3D, previous?: { design: Float64Array; iteration: number },
    prepared?: ReturnType<typeof preflightAdaptiveSolver3D>) {
    this.problem = input.elementType === 'adaptiveTet4' && !input.mesh ? { ...input, mesh: generateAdaptiveMesh3D(input) } : input
    const { grid, params, elementType = 'hex8', mesh } = this.problem
    const count = mesh?.stats.elements ?? elementCount(grid, elementType)
    const plan = mesh && (prepared ?? preflightAdaptiveSolver3D(this.problem, mesh))
    this.adaptiveBytes = plan?.estimatedBytes ?? 0
    this.setup = validateProblem3D(this.problem)
    this.filter = mesh && plan ? new UnstructuredConeFilter3D(mesh, plan)
      : new DensityFilter3D(grid, params.rmin, this.setup.voidMask, elementType)
    this.design = new Float64Array(count)
    this.candidate = new Float64Array(count)
    this.physical = new Float64Array(count)
    this.scratch = new Float64Array(count)
    this.derivative = new Float64Array(count)
    this.dc = new Float64Array(count)
    this.dv = new Float64Array(count)
    this.totalVolume = mesh ? grid.widthMm * grid.heightMm * grid.depthMm : elementCount(grid)
    this.volumes = mesh?.volumes ?? Float64Array.from({ length: count }, (_, i) => elementType === 'tet4' ? tetVolumeFraction(i % 5) : 1)
    this.volumeWeights = new Float64Array(count)
    for (let e = 0; e < count; e++) {
      this.scratch[e] = this.setup.solid[e] || this.setup.voidMask[e] ? 0 : this.volumes[e]
    }
    this.filter.transpose(this.scratch, this.volumeWeights)
    const { representatives } = this.setup
    if (representatives.some((rep, e) => rep !== e)) {
      this.orbitVolume = new Float64Array(count)
      this.orbitValues = new Float64Array(count)
      for (let e = 0; e < count; e++) this.orbitVolume[representatives[e]] += this.volumes[e]
    }
    this.iteration = previous?.iteration ?? 0
    this.beta = this.projectionBeta(Math.max(1, this.iteration))
    if (previous) {
      this.design.set(previous.design)
      if (this.orbitValues && this.orbitVolume) {
        for (let e = 0; e < count; e++) this.orbitValues[representatives[e]] += this.design[e] * this.volumes[e]
        for (let e = 0; e < count; e++) this.design[e] = this.orbitValues[representatives[e]] / this.orbitVolume[representatives[e]]
      }
      this.matchVolume()
    } else if (this.setup.solid.some(Boolean)) this.matchVolume()
    else {
      const physical = params.volFrac * this.totalVolume / this.setup.allowed
      const value = this.beta ? 0.5 + Math.atanh((2 * physical - 1) * Math.tanh(this.beta / 2)) / this.beta : physical
      for (let e = 0; e < count; e++) this.design[e] = this.setup.voidMask[e] ? 0 : value
    }
  }

  get designDensity() { return this.design.slice() }

  private projectionBeta(iteration: number) {
    return this.problem.params.heaviside ? 2 ** Math.min(3, Math.floor((iteration - 1) / 20)) : 0
  }

  private density(input: Float64Array, output: Float64Array) {
    this.filter.apply(input, output)
    const { orbitVolume, orbitValues, volumes } = this
    if (orbitVolume && orbitValues) {
      const { representatives } = this.setup
      orbitValues.fill(0)
      for (let e = 0; e < output.length; e++) orbitValues[representatives[e]] += output[e] * volumes[e]
      for (let e = 0; e < output.length; e++) {
        const rep = representatives[e]
        output[e] = orbitValues[rep] / orbitVolume[rep]
      }
    }
    projectDensity3D(output, this.derivative, this.beta, this.setup.solid, this.setup.voidMask)
    return dot(output, volumes)
  }

  private matchVolume() {
    const { solid, voidMask } = this.setup
    const target = this.problem.params.volFrac * this.totalVolume
    // Prescribed solid cells also contribute to their free neighbors through H.
    this.candidate.set(solid)
    const minimum = this.density(this.candidate, this.scratch)
    const linearOffset = this.beta ? 0 : minimum - dot(this.candidate, this.volumeWeights)
    if (target < minimum - 1e-10 * this.totalVolume) throw new ProblemError3D('volume3dError')
    let low = -1, high = 1
    for (let i = 0; i < 40; i++) {
      const shift = (low + high) * 0.5
      for (let e = 0; e < this.design.length; e++) {
        this.candidate[e] = solid[e] ? 1 : voidMask[e] ? 0 : clamp(this.design[e] + shift, 0, 1)
      }
      const volume = this.beta ? this.density(this.candidate, this.scratch) : linearOffset + dot(this.candidate, this.volumeWeights)
      if (volume > target) high = shift
      else low = shift
    }
    this.design.set(this.candidate)
  }

  initialDensity() {
    this.density(this.design, this.physical)
    return this.physical.slice()
  }

  get passiveMasks() {
    return this.setup.brickMasks
  }

  private transposeDensity(input: Float64Array, output: Float64Array) {
    const { orbitVolume, orbitValues, volumes } = this
    if (orbitVolume && orbitValues) {
      const { representatives } = this.setup
      orbitValues.fill(0)
      for (let e = 0; e < input.length; e++) orbitValues[representatives[e]] += input[e]
      for (let e = 0; e < input.length; e++) {
        const rep = representatives[e]
        input[e] = volumes[e] * orbitValues[rep] / orbitVolume[rep]
      }
    }
    this.filter.transpose(input, output)
  }

  private sensitivities(gradient: Float64Array) {
    const { representatives } = this.setup
    for (let e = 0; e < gradient.length; e++) this.scratch[e] = gradient[e] * this.derivative[e]
    this.transposeDensity(this.scratch, this.dc)
    for (let e = 0; e < gradient.length; e++) this.scratch[e] = this.volumes[e] * this.derivative[e]
    this.transposeDensity(this.scratch, this.dv)
    for (let e = 0; e < representatives.length; e++) {
      const rep = representatives[e]
      if (rep === e) continue
      this.dc[rep] += this.dc[e]
      this.dv[rep] += this.dv[e]
    }
  }

  private update(gradient: Float64Array) {
    this.sensitivities(gradient)
    const { representatives, solid, voidMask } = this.setup
    const { moveLimit, volFrac } = this.problem.params
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
    const target = volFrac * this.totalVolume
    const linearOffset = this.beta ? 0 : dot(this.physical, this.volumes) - dot(this.design, this.volumeWeights)
    // The normalized sensitivity ratio is at most one, so this upper
    // endpoint cannot increase the current volume.
    let low = 0, high = 1
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
      const volume = this.beta ? this.density(this.candidate, this.scratch) : linearOffset + dot(this.candidate, this.volumeWeights)
      const error = volume - target
      if (Math.abs(error) <= this.totalVolume * 1e-8) break
      if (error > 0) low = multiplier
      else high = multiplier
    }
    let change = 0
    for (let e = 0; e < this.design.length; e++) change = Math.max(change, Math.abs(this.candidate[e] - this.design[e]))
    this.design.set(this.candidate)
    return change
  }

  step(advance = true): Snapshot3D {
    const { params, grid, material, mesh } = this.problem
    if (advance) this.iteration++
    const nextBeta = this.projectionBeta(Math.max(1, this.iteration))
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
    const massPerCell = (mesh ? 1 : cellSize(grid).reduce((a, b) => a * b)) * material.densityKgM3 * 1e-6
    const mass = volume * massPerCell
    const initialMass = this.setup.allowed * massPerCell
    const change = advance ? this.update(analysis.gradient) : 0
    const done = advance && (this.iteration >= params.maxIter || (change <= params.changeTol && (!params.heaviside || this.beta === 8)))
    return { iteration: this.iteration, density: this.physical.slice(), vonMises: vonMises.slice(),
      displacements: displacements.map(u => u.slice()), compliance, volFrac: volume / this.totalVolume, change,
      maxVonMises, p95VonMises, metrics: { mass, initialMass, saved: 100 * (1 - mass / initialMass), maxDeflection,
        safetyFactor: maxVonMises > 0 ? material.yieldMPa / maxVonMises : undefined,
        p95SafetyFactor: p95VonMises > 0 ? material.yieldMPa / p95VonMises : undefined },
      beta: this.beta || undefined, done }
  }
}
