import { elementCount, elementIndex, type Grid3D } from './types3d'

export class DensityFilter3D {
  private readonly rows: Int32Array
  private readonly columns: Int32Array
  private readonly weights: Float64Array

  constructor(grid: Grid3D, radius: number, passiveVoid?: Uint8Array) {
    const { nelx, nely, nelz } = grid
    const rows = new Int32Array(elementCount(grid) + 1)
    const columns: number[] = []
    const weights: number[] = []
    const offsets: [number, number, number, number][] = []
    const reach = Math.ceil(radius) - 1
    for (let z = -reach; z <= reach; z++) for (let y = -reach; y <= reach; y++) for (let x = -reach; x <= reach; x++) {
      const weight = radius - Math.hypot(x, y, z)
      if (weight > 0) offsets.push([x, y, z, weight])
    }
    let e = 0
    for (let z = 0; z < nelz; z++) for (let y = 0; y < nely; y++) for (let x = 0; x < nelx; x++, e++) {
      let sum = 0
      if (!passiveVoid?.[e]) for (const [dx, dy, dz, weight] of offsets) {
        const i = x + dx, j = y + dy, k = z + dz
        if (i < 0 || i >= nelx || j < 0 || j >= nely || k < 0 || k >= nelz) continue
        const other = elementIndex(grid, i, j, k)
        if (passiveVoid?.[other]) continue
        columns.push(other)
        weights.push(weight)
        sum += weight
      }
      rows[e + 1] = weights.length
      for (let i = rows[e]; i < rows[e + 1]; i++) weights[i] /= sum
    }
    this.rows = rows
    this.columns = Int32Array.from(columns)
    this.weights = Float64Array.from(weights)
  }

  apply(input: Float64Array, output: Float64Array) {
    const { rows, columns, weights } = this
    for (let r = 0; r < output.length; r++) {
      let value = 0
      for (let i = rows[r]; i < rows[r + 1]; i++) value += weights[i] * input[columns[i]]
      output[r] = value
    }
    return output
  }

  transpose(input: Float64Array, output: Float64Array) {
    const { rows, columns, weights } = this
    output.fill(0)
    for (let r = 0; r < input.length; r++) {
      for (let i = rows[r]; i < rows[r + 1]; i++) output[columns[i]] += weights[i] * input[r]
    }
    return output
  }
}

/** Project the filtered field in place and record the derivative for Hᵀ. */
export function projectDensity3D(
  density: Float64Array, derivative: Float64Array, beta: number, solid: Uint8Array, voidMask: Uint8Array,
) {
  const edge = Math.tanh(beta * 0.5)
  for (let i = 0; i < density.length; i++) {
    if (solid[i] || voidMask[i]) {
      density[i] = solid[i]
      derivative[i] = 0
    } else if (beta > 0) {
      const mid = Math.tanh(beta * (density[i] - 0.5))
      density[i] = (edge + mid) / (2 * edge)
      derivative[i] = beta * (1 - mid * mid) / (2 * edge)
    } else {
      derivative[i] = 1
    }
  }
}
