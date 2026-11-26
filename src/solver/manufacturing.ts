import { DiagnosticError, type Diagnostic } from './diagnostics'
import { initializeDensity, filterPhysicalDensity } from './density'
import { projectHeaviside } from './filter'
import { BidirectionalOverhang, OverhangFilter } from './overhang'
import { MirrorSymmetry } from './symmetry'
import type { PassiveMasks, SimpProblem } from './types'

export class ManufacturingDensity {
  readonly setup: ReturnType<typeof initializeDensity>
  readonly symmetry?: MirrorSymmetry
  private readonly projection?: Float64Array
  private readonly overhang?: OverhangFilter | BidirectionalOverhang
  private readonly intermediates: Float64Array
  private readonly adjoint: Float64Array
  readonly passive?: PassiveMasks
  readonly addedAnchors: number
  readonly nonlinear: boolean
  private readonly targetVolume: number

  constructor({ grid, params, passive }: Pick<SimpProblem, 'grid' | 'params' | 'passive'>) {
    this.targetVolume = params.volFrac
    const size = grid.nelx * grid.nely
    if ([passive?.solid, passive?.void].some(mask => mask && mask.length !== size)) {
      throw new DiagnosticError({ code: 'maskSize' })
    }
    if (params.symmetry && params.symmetry !== 'none') this.symmetry = new MirrorSymmetry(grid, params.symmetry)
    if (!this.symmetry && passive?.solid?.some((bit, e) => bit && passive.void?.[e])) {
      throw new DiagnosticError({ code: 'maskOverlap' })
    }
    const mirrored = this.symmetry?.masks(passive) ?? passive
    let manufactured = mirrored
    if (params.overhang) {
      const bidirectional = params.symmetry?.includes(params.overhang[1].toLowerCase())
      this.overhang = bidirectional
        ? new BidirectionalOverhang(grid, params.overhang) : new OverhangFilter(grid, params.overhang)
      if (mirrored?.solid?.some(Boolean)) {
        const solid = mirrored.solid.slice()
        const blocked = this.overhang instanceof BidirectionalOverhang
          ? [...this.overhang.forward.anchor(mirrored, solid), ...this.overhang.reverse.anchor(mirrored, solid)]
          : this.overhang.anchor(mirrored, solid)
        if (blocked.length) throw new DiagnosticError({ code: 'amConflict', params: { cells: [...new Set(blocked)] } })
        manufactured = { solid, void: mirrored.void }
        manufactured = this.symmetry?.masks(manufactured) ?? manufactured
      }
    }
    this.passive = manufactured
    this.addedAnchors = manufactured?.solid?.reduce((sum, bit, e) =>
      sum + Number(bit && !mirrored?.solid?.[e]), 0) ?? 0
    this.setup = initializeDensity({ grid, params, passive: manufactured })
    this.nonlinear = !!(params.heaviside || params.overhang)
    this.intermediates = new Float64Array(size)
    this.adjoint = new Float64Array(size)
    if (params.heaviside) this.projection = new Float64Array(size)
  }

  apply(design: Float64Array, output: Float64Array, beta: number, derivatives = true) {
    const { filter, mask } = this.setup
    const field = filterPhysicalDensity(filter, mask, design, this.overhang ? this.intermediates : output)
    this.symmetry?.apply(field)
    if (this.projection) projectHeaviside(field, beta, field, derivatives ? this.projection : undefined)
    this.overhang?.apply(field, output, derivatives, mask)
    this.symmetry?.apply(output)
    return output
  }

  transpose(gradient: Float64Array, output: Float64Array) {
    const { adjoint, setup, projection } = this
    adjoint.set(gradient)
    this.symmetry?.apply(adjoint)
    this.overhang?.transpose(adjoint, adjoint)
    for (let e = 0; e < adjoint.length; e++) {
      if (projection) adjoint[e] *= projection[e]
    }
    this.symmetry?.apply(adjoint)
    for (let e = 0; e < adjoint.length; e++) if (setup.mask[e]) adjoint[e] = 0
    setup.filter.transpose(adjoint, output)
    for (let e = 0; e < output.length; e++) if (setup.mask[e]) output[e] = 0
    return this.symmetry?.apply(output) ?? output
  }

  initialState() {
    const target = this.targetVolume
    const density = new Float64Array(this.setup.design.length)
    const volumeRange = this.nonlinear
      ? this.seed(1, target, density)
      : this.setup.volumeRange
    if (!this.nonlinear) this.apply(this.setup.design, density, 1, false)
    const [min, max] = volumeRange
    const diagnostic: Diagnostic | undefined = target < min - 1e-12 || target > max + 1e-12
      ? { code: 'volumeError', params: { target, min, max } } : undefined
    return { density, volumeRange, diagnostic }
  }

  /** Monotone uniform seed that meets the physical volume at the current beta. */
  private seed(beta: number, target: number, output: Float64Array) {
    const { design, mask } = this.setup
    const evaluate = (value: number) => {
      for (let e = 0; e < design.length; e++) if (!mask[e]) design[e] = value
      this.apply(design, output, beta, false)
      return densitySum(output) / output.length
    }
    const min = evaluate(0)
    const max = evaluate(1)
    let lo = 0, hi = 1
    if (target <= min) hi = 0
    else if (target >= max) lo = 1
    else {
      for (let i = 0; i < 28; i++) {
        const value = (lo + hi) / 2
        if (evaluate(value) < target) lo = value
        else hi = value
      }
    }
    evaluate((lo + hi) / 2)
    return [min, max] as const
  }
}

export function densitySum(field: Float64Array | Float32Array) {
  let sum = 0
  for (let e = 0; e < field.length; e++) sum += field[e]
  return sum
}
