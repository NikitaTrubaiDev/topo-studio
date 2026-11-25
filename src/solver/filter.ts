import type { Grid } from './types'

/** Sparse row-normalized cone filter, in compressed sparse row format. */
export class DensityFilter {
  readonly offsets: Uint32Array
  readonly columns: Uint32Array
  readonly weights: Float64Array

  constructor({ nelx, nely }: Grid, radius: number) {
    if (!(radius > 0) || !Number.isFinite(radius)) throw new Error('The filter radius must be positive.')
    const offsets = new Uint32Array(nelx * nely + 1)
    const columns: number[] = []
    const weights: number[] = []
    const reach = Math.ceil(radius) - 1
    for (let y = 0; y < nely; y++) {
      for (let x = 0; x < nelx; x++) {
        const first = weights.length
        let sum = 0
        for (let ny = Math.max(0, y - reach); ny <= Math.min(nely - 1, y + reach); ny++) {
          for (let nx = Math.max(0, x - reach); nx <= Math.min(nelx - 1, x + reach); nx++) {
            const weight = radius - Math.hypot(nx - x, ny - y)
            if (weight <= 0) continue
            columns.push(ny * nelx + nx)
            weights.push(weight)
            sum += weight
          }
        }
        for (let j = first; j < weights.length; j++) weights[j] /= sum
        offsets[y * nelx + x + 1] = weights.length
      }
    }
    this.offsets = offsets
    this.columns = Uint32Array.from(columns)
    this.weights = Float64Array.from(weights)
  }

  apply(input: Float64Array): Float64Array {
    const result = new Float64Array(this.offsets.length - 1)
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
  transpose(gradient: Float64Array): Float64Array {
    const result = new Float64Array(this.offsets.length - 1)
    for (let i = 0; i < result.length; i++) {
      for (let j = this.offsets[i]; j < this.offsets[i + 1]; j++) {
        result[this.columns[j]] += this.weights[j] * gradient[i]
      }
    }
    return result
  }
}
