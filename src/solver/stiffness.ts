import { nodeIndex, type Grid } from './types'

export function elementDofs(grid: Grid) {
  const { nelx, nely } = grid
  const dofs = new Uint32Array(nelx * nely * 8)
  for (let y = 0; y < nely; y++) {
    for (let x = 0; x < nelx; x++) {
      const bl = 2 * nodeIndex(grid, x, y)
      const tl = 2 * nodeIndex(grid, x, y + 1)
      const start = 8 * (y * nelx + x)
      for (let k = 0; k < 4; k++) dofs[start + k] = bl + k
      dofs[start + 4] = tl + 2
      dofs[start + 5] = tl + 3
      dofs[start + 6] = tl
      dofs[start + 7] = tl + 1
    }
  }
  return dofs
}

export function createQ4Stencil({ nelx, nely }: Grid) {
  const width = nelx + 1
  const size = 2 * width * (nely + 1)
  const offsets = new Uint32Array(size + 1)
  const columns = new Uint32Array(4 * (3 * nelx + 1) * (3 * nely + 1))
  const diagonalSlots = new Uint32Array(size)
  let slot = 0
  for (let row = 0; row < size; row++) {
    offsets[row] = slot
    const x = (row >> 1) % width, y = Math.floor((row >> 1) / width)
    for (let ny = Math.max(0, y - 1); ny <= Math.min(nely, y + 1); ny++) {
      for (let nx = Math.max(0, x - 1); nx <= Math.min(nelx, x + 1); nx++) {
        const col = 2 * (ny * width + nx)
        if (x === nx && y === ny) diagonalSlots[row] = slot + (row & 1)
        columns[slot++] = col
        columns[slot++] = col + 1
      }
    }
  }
  offsets[size] = slot
  return { offsets, columns, diagonalSlots }
}

/** Cache the Q4 stencil for repeated matrix-vector products within each elasticity solve. */
export class Stiffness2D {
  readonly diagonal: Float64Array
  readonly offsets: Uint32Array
  readonly columns: Uint32Array
  readonly entries: Float64Array
  private readonly elementSlots: Uint32Array
  readonly diagonalSlots: Uint32Array

  constructor(grid: Grid, private readonly fixed: Uint8Array, dofs: Uint32Array) {
    const { offsets, columns, diagonalSlots } = createQ4Stencil(grid)
    this.offsets = offsets
    this.columns = columns
    this.diagonalSlots = diagonalSlots
    this.diagonal = new Float64Array(fixed.length)
    this.entries = new Float64Array(columns.length)
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
}
