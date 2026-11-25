import type { Grid } from './types'

/** Cache the Q4 stencil for repeated matrix-vector products within each elasticity solve. */
export class Stiffness2D {
  readonly diagonal: Float64Array
  private readonly offsets: Uint32Array
  private readonly columns: Uint32Array
  private readonly entries: Float64Array
  private readonly elementSlots: Uint32Array
  private readonly diagonalSlots: Uint32Array
  private readonly factor: Float64Array
  private readonly factorsInverse: Float64Array

  constructor({ nelx, nely }: Grid, private readonly fixed: Uint8Array, dofs: Uint32Array) {
    const width = nelx + 1
    this.offsets = new Uint32Array(fixed.length + 1)
    this.diagonal = new Float64Array(fixed.length)
    this.diagonalSlots = new Uint32Array(fixed.length)
    const columns: number[] = []
    for (let row = 0; row < fixed.length; row++) {
      const node = row >> 1
      const x = node % width, y = Math.floor(node / width)
      this.offsets[row] = columns.length
      for (let ny = Math.max(0, y - 1); ny <= Math.min(nely, y + 1); ny++) {
        for (let nx = Math.max(0, x - 1); nx <= Math.min(nelx, x + 1); nx++) {
          const column = 2 * (ny * width + nx)
          if (row === column || row === column + 1) this.diagonalSlots[row] = columns.length + (row % 2)
          columns.push(column, column + 1)
        }
      }
    }
    this.offsets[fixed.length] = columns.length
    this.columns = Uint32Array.from(columns)
    this.entries = new Float64Array(columns.length)
    this.factor = new Float64Array(columns.length)
    this.factorsInverse = new Float64Array(fixed.length)
    this.elementSlots = new Uint32Array(dofs.length * 8)
    for (let e = 0; e < dofs.length; e += 8) {
      for (let i = 0; i < 8; i++) {
        const row = dofs[e + i]
        for (let j = 0; j < 8; j++) {
          const offset = this.offsets[row]
          this.elementSlots[e * 8 + i * 8 + j] = columns.indexOf(dofs[e + j], offset)
        }
      }
    }
  }

  assemble(modulus: Float64Array, ke: Float64Array) {
    const { entries, elementSlots, offsets, columns, fixed, diagonal, diagonalSlots } = this
    entries.fill(0)
    for (let e = 0; e < modulus.length; e++) {
      for (let k = 0; k < 64; k++) entries[elementSlots[e * 64 + k]] += modulus[e] * ke[k]
    }
    for (let row = 0; row < fixed.length; row++) {
      diagonal[row] = fixed[row] ? 1 : entries[diagonalSlots[row]]
      for (let k = offsets[row]; k < offsets[row + 1]; k++) {
        if (fixed[row] || fixed[columns[k]]) entries[k] = columns[k] === row ? 1 : 0
      }
    }
  }

  readonly multiply = (input: Float64Array, output: Float64Array) => {
    const { offsets, columns, entries } = this
    for (let row = 0; row < output.length; row++) {
      let k = offsets[row]
      const end = offsets[row + 1]
      let sum = 0
      for (; k + 5 < end; k += 6) {
        sum += entries[k] * input[columns[k]] + entries[k + 1] * input[columns[k + 1]]
          + entries[k + 2] * input[columns[k + 2]] + entries[k + 3] * input[columns[k + 3]]
          + entries[k + 4] * input[columns[k + 4]] + entries[k + 5] * input[columns[k + 5]]
      }
      for (; k < end; k++) sum += entries[k] * input[columns[k]]
      output[row] = sum
    }
  }

  /** IC(0) with diagonal shifts for stiff/soft layouts that would cause a nonpositive pivot. */
  preparePreconditioner() {
    const { offsets, columns, diagonalSlots, entries, factor, factorsInverse, diagonal } = this
    for (const shift of [0, 0.01, 0.05, 0.2, 1]) {
      let row = 0
      for (; row < diagonal.length; row++) {
        const start = offsets[row], end = diagonalSlots[row]
        let pivot = diagonal[row] * (1 + shift)
        for (let k = start; k < end; k++) {
          const column = columns[k]
          let value = entries[k]
          let a = start, b = offsets[column]
          const stop = diagonalSlots[column]
          while (a < k && b < stop) {
            if (columns[a] < columns[b]) a++
            else if (columns[b] < columns[a]) b++
            else value -= factor[a++] * factor[b++]
          }
          factor[k] = value * factorsInverse[column]
          pivot -= factor[k] * factor[k]
        }
        if (!(pivot > 1e-8 * diagonal[row])) break
        factorsInverse[row] = 1 / Math.sqrt(pivot)
      }
      if (row === diagonal.length) return this.precondition
    }
    return undefined
  }

  private readonly precondition = (input: Float64Array, output: Float64Array) => {
    const { offsets, columns, factor, factorsInverse, diagonalSlots } = this
    for (let row = 0; row < output.length; row++) {
      let sum = input[row]
      for (let k = offsets[row]; k < diagonalSlots[row]; k++) sum -= factor[k] * output[columns[k]]
      output[row] = sum * factorsInverse[row]
    }
    for (let row = output.length - 1; row >= 0; row--) {
      output[row] *= factorsInverse[row]
      for (let k = offsets[row]; k < diagonalSlots[row]; k++) output[columns[k]] -= factor[k] * output[row]
    }
  }
}
