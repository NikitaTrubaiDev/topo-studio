import type { BuildDirection, Grid, PassiveMasks } from './types'

/** Conservative C¹ minimum, exact away from the transition. The band scales
 * with the distance from the empty and full endpoints, and never exceeds either input. */
export function smoothMinimum(a: number, b: number) {
  const sum = a + b
  const band = 0.0005 * sum * (2 - sum)
  const distance = Math.abs(a - b)
  if (distance >= band) return Math.min(a, b)
  return Math.min(a, b) - (band - distance) ** 2 / (4 * band)
}

export function minimumSlope(a: number, b: number) {
  const sum = a + b
  const band = 0.0005 * sum * (2 - sum)
  const t = (a - b) / band
  if (band === 0) return 0.5
  if (t <= -1) return 1
  if (t >= 1) return 0
  return (1 - t) / 2 - 0.00025 * (1 - sum) * (1 - t * t)
}

/** Langelaar layer recursion with a normalized KS support maximum. Subtracting
 * log(neighbor count) bounds it by the strongest of the three support cells. */
export class OverhangFilter {
  private readonly order: Uint32Array
  private readonly neighbors: Int32Array
  private readonly inputSlope: Float64Array
  private readonly supportSlope: Float64Array
  private readonly adjoint: Float64Array
  private readonly width: number

  constructor(grid: Grid, direction: BuildDirection, private readonly exact = false) {
    const { nelx, nely } = grid
    const vertical = direction.endsWith('Y')
    const reversed = direction.startsWith('-')
    const width = this.width = vertical ? nelx : nely
    const layers = vertical ? nely : nelx
    const index = (layer: number, i: number) => {
      const p = reversed ? layers - 1 - layer : layer
      return vertical ? p * nelx + i : i * nelx + p
    }
    const size = nelx * nely
    this.order = new Uint32Array(size)
    this.neighbors = new Int32Array(3 * size).fill(-1)
    this.inputSlope = new Float64Array(size)
    this.supportSlope = new Float64Array(3 * size)
    this.adjoint = new Float64Array(size)
    for (let layer = 0; layer < layers; layer++) {
      for (let i = 0; i < width; i++) {
        const e = index(layer, i)
        this.order[layer * width + i] = e
        if (!layer) continue
        for (let d = -1; d <= 1; d++) {
          if (i + d >= 0 && i + d < width) this.neighbors[3 * e + d + 1] = index(layer - 1, i + d)
        }
      }
    }
  }

  apply(input: Float64Array, output: Float64Array, derivatives = true, mask?: Int8Array) {
    const sharpness = 10_000
    const { neighbors, inputSlope, supportSlope } = this
    for (let i = 0; i < this.order.length; i++) {
      const e = this.order[i]
      const fixed = mask?.[e] ?? 0
      if (fixed || i < this.width) {
        output[e] = fixed ? Number(fixed > 0) : input[e]
        if (derivatives) {
          inputSlope[e] = fixed ? 0 : 1
          supportSlope.fill(0, 3 * e, 3 * e + 3)
        }
        continue
      }
      const start = 3 * e
      const a = neighbors[start] < 0 ? -Infinity : output[neighbors[start]]
      const b = output[neighbors[start + 1]]
      const c = neighbors[start + 2] < 0 ? -Infinity : output[neighbors[start + 2]]
      const peak = Math.max(a, b, c)
      const wanted = input[e]
      if (this.exact) {
        output[e] = Math.min(wanted, peak)
        if (derivatives) {
          const slope = wanted === peak ? 0.5 : Number(wanted < peak)
          const sharing = (1 - slope) / (Number(a === peak) + Number(b === peak) + Number(c === peak))
          inputSlope[e] = slope
          supportSlope[start] = a === peak ? sharing : 0
          supportSlope[start + 1] = b === peak ? sharing : 0
          supportSlope[start + 2] = c === peak ? sharing : 0
        }
        continue
      }
      const wa = Math.exp(sharpness * (a - peak))
      const wb = Math.exp(sharpness * (b - peak))
      const wc = Math.exp(sharpness * (c - peak))
      const sum = (wa + wc) + wb
      const count = 1 + Number(a !== -Infinity) + Number(c !== -Infinity)
      const support = Math.max(0, peak + Math.log(sum / count) / sharpness)
      output[e] = smoothMinimum(wanted, support)
      if (!derivatives) continue
      inputSlope[e] = minimumSlope(wanted, support)
      const slope = minimumSlope(support, wanted) / sum
      supportSlope[start] = wa * slope
      supportSlope[start + 1] = wb * slope
      supportSlope[start + 2] = wc * slope
    }
    return output
  }

  transpose(gradient: Float64Array, output: Float64Array) {
    const { adjoint, order, neighbors, supportSlope, inputSlope } = this
    adjoint.set(gradient)
    for (let i = order.length - 1; i >= 0; i--) {
      const e = order[i]
      const value = adjoint[e]
      output[e] = inputSlope[e] * value
      for (let k = 3 * e; k < 3 * e + 3; k++) {
        const neighbor = neighbors[k]
        if (neighbor >= 0) adjoint[neighbor] += supportSlope[k] * value
      }
    }
    return output
  }

  /** Trace a minimum-added-material path from each prescribed solid to the plate. */
  anchor(passive: PassiveMasks, solid: Uint8Array) {
    const original = passive.solid
    if (!original?.some(Boolean)) return
    const { order, neighbors, width } = this
    const cost = new Float64Array(order.length).fill(Infinity)
    const predecessor = new Int32Array(order.length).fill(-1)
    for (let i = 0; i < order.length; i++) {
      const e = order[i]
      if (passive.void?.[e]) continue
      const added = Number(!solid[e])
      if (i < width) {
        cost[e] = added
        continue
      }
      // Prefer a straight path when it costs the same number of cells.
      const start = 3 * e
      let best = neighbors[start + 1]
      for (let k = 0; k <= 2; k += 2) {
        const neighbor = neighbors[start + k]
        if (neighbor >= 0 && cost[neighbor] < cost[best]) best = neighbor
      }
      cost[e] = added + cost[best]
      predecessor[e] = best
    }
    const connected = new Uint8Array(order.length)
    for (let e = 0; e < order.length; e++) {
      if (!original[e]) continue
      if (!Number.isFinite(cost[e])) throw new Error('A passive solid has no path to the build plate.')
      for (let i = e; i !== -1 && !connected[i]; i = predecessor[i]) {
        solid[i] = 1
        connected[i] = 1
      }
    }
  }

  unsupported(density: Float32Array | Float64Array, threshold: number) {
    let count = 0
    for (let i = this.width; i < this.order.length; i++) {
      const e = this.order[i]
      if (density[e] < threshold) continue
      let supported = false
      for (let k = 3 * e; k < 3 * e + 3; k++) {
        const neighbor = this.neighbors[k]
        if (neighbor >= 0 && density[neighbor] >= threshold) supported = true
      }
      if (!supported) count++
    }
    return count
  }
}

/** Symmetry through the build direction requires paths from both faces. The
 * smooth passes cap density first. A max-min reachability pass removes any
 * marginal threshold violations left by intersecting the smooth fields.
 * Every retained cell then lies on a path between the two plates with
 * capacity at least its density. The active max/min branches are adjointed. */
export class BidirectionalOverhang {
  readonly forward: OverhangFilter
  readonly reverse: OverhangFilter
  private readonly smooth: LayerIntersection
  private readonly reachable: LayerIntersection
  private readonly field: Float64Array

  constructor(grid: Grid, direction: BuildDirection) {
    const opposite = ((direction[0] === '+' ? '-' : '+') + direction[1]) as BuildDirection
    this.forward = new OverhangFilter(grid, direction)
    this.reverse = new OverhangFilter(grid, opposite)
    const size = grid.nelx * grid.nely
    this.smooth = new LayerIntersection(size, this.forward, this.reverse, false)
    this.reachable = new LayerIntersection(size, new OverhangFilter(grid, direction, true), new OverhangFilter(grid, opposite, true), true)
    this.field = new Float64Array(size)
  }

  apply(input: Float64Array, output: Float64Array, derivatives = true, mask?: Int8Array) {
    this.smooth.apply(input, this.field, derivatives, mask)
    this.reachable.apply(this.field, output, derivatives, mask)
    return output
  }

  transpose(gradient: Float64Array, output: Float64Array) {
    this.reachable.transpose(gradient, this.field)
    return this.smooth.transpose(this.field, output)
  }
}

class LayerIntersection {
  private readonly a: Float64Array
  private readonly b: Float64Array
  private readonly ga: Float64Array
  private readonly gb: Float64Array

  constructor(size: number, private readonly forward: OverhangFilter, private readonly reverse: OverhangFilter,
    private readonly exact: boolean) {
    this.a = new Float64Array(size)
    this.b = new Float64Array(size)
    this.ga = new Float64Array(size)
    this.gb = new Float64Array(size)
  }

  apply(input: Float64Array, output: Float64Array, derivatives: boolean, mask?: Int8Array) {
    const { a, b } = this
    this.forward.apply(input, a, derivatives, mask)
    this.reverse.apply(input, b, derivatives, mask)
    for (let e = 0; e < output.length; e++) {
      const fixed = mask?.[e]
      output[e] = fixed ? Number(fixed > 0) : this.exact ? Math.min(a[e], b[e]) : smoothMinimum(a[e], b[e])
    }
  }

  transpose(gradient: Float64Array, output: Float64Array) {
    const { a, b, ga, gb } = this
    for (let e = 0; e < gradient.length; e++) {
      const slopeA = this.exact ? a[e] === b[e] ? 0.5 : Number(a[e] < b[e]) : minimumSlope(a[e], b[e])
      const slopeB = this.exact ? 1 - slopeA : minimumSlope(b[e], a[e])
      ga[e] = gradient[e] * slopeA
      gb[e] = gradient[e] * slopeB
    }
    this.forward.transpose(ga, ga)
    this.reverse.transpose(gb, gb)
    for (let e = 0; e < output.length; e++) output[e] = ga[e] + gb[e]
    return output
  }
}
