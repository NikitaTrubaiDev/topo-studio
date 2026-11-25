import type { Grid } from './types'

/** Sparse row-normalized cone filter, in compressed sparse row format. */
export class DensityFilter {
  readonly offsets: Uint32Array
  readonly columns: Uint32Array
  readonly weights: Float64Array

  constructor({ nelx, nely }: Grid, radius: number, passiveVoid?: Uint8Array) {
    if (!(radius > 0) || !Number.isFinite(radius)) throw new Error('The filter radius must be positive.')
    if (passiveVoid && passiveVoid.length !== nelx * nely) {
      throw new Error('The filter mask must contain one entry per element.')
    }
    const offsets = new Uint32Array(nelx * nely + 1)
    const columns: number[] = []
    const weights: number[] = []
    const reach = Math.ceil(radius) - 1
    for (let y = 0; y < nely; y++) {
      for (let x = 0; x < nelx; x++) {
        const row = y * nelx + x
        if (passiveVoid?.[row]) {
          offsets[row + 1] = weights.length
          continue
        }
        const first = weights.length
        let sum = radius
        for (let ny = Math.max(0, y - reach); ny <= Math.min(nely - 1, y + reach); ny++) {
          for (let nx = Math.max(0, x - reach); nx <= Math.min(nelx - 1, x + reach); nx++) {
            const column = ny * nelx + nx
            if (column === row || passiveVoid?.[column]) continue
            const weight = radius - Math.hypot(nx - x, ny - y)
            if (weight <= 0) continue
            columns.push(column)
            weights.push(weight)
            sum += weight
          }
        }
        let normalized = 0
        for (let j = first; j < weights.length; j++) {
          weights[j] /= sum
          normalized += weights[j]
        }
        // Put the largest weight last so rounding preserves a constant field exactly.
        columns.push(row)
        weights.push(1 - normalized)
        offsets[row + 1] = weights.length
      }
    }
    this.offsets = offsets
    this.columns = Uint32Array.from(columns)
    this.weights = Float64Array.from(weights)
  }

  apply(input: Float64Array, result: Float64Array = new Float64Array(this.offsets.length - 1)): Float64Array {
    for (let i = 0; i < result.length; i++) {
      let value = 0
      for (let j = this.offsets[i]; j < this.offsets[i + 1]; j++) {
        value += this.weights[j] * input[this.columns[j]]
      }
      result[i] = value
    }
    return result
  }

  /** Apply Hᵀ to gradients at the filter output, after any downstream chain rule. */
  transpose(gradient: Float64Array, result: Float64Array = new Float64Array(this.offsets.length - 1)): Float64Array {
    result.fill(0)
    for (let i = 0; i < this.offsets.length - 1; i++) {
      for (let j = this.offsets[i]; j < this.offsets[i + 1]; j++) {
        result[this.columns[j]] += this.weights[j] * gradient[i]
      }
    }
    return result
  }
}
