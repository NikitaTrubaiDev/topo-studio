import { createQ4Stencil, type Stiffness2D } from './stiffness'
import type { Grid } from './types'

interface Matrix {
  offsets: Uint32Array
  columns: Uint32Array
  entries: Float64Array
  diagonalSlots: Uint32Array
}

class Level implements Matrix {
  readonly fixed: Uint8Array
  readonly inverse: Float64Array
  readonly residual: Float64Array
  readonly rhs: Float64Array
  readonly solution: Float64Array
  readonly diagonalSlots: Uint32Array
  readonly offsets: Uint32Array
  readonly columns: Uint32Array
  readonly entries: Float64Array

  constructor(readonly nx: number, readonly ny: number, fixed?: Uint8Array, matrix?: Matrix) {
    const size = 2 * (nx + 1) * (ny + 1)
    this.fixed = fixed ?? new Uint8Array(size)
    this.inverse = new Float64Array(size)
    this.residual = new Float64Array(size)
    this.rhs = new Float64Array(size)
    this.solution = new Float64Array(size)
    const stencil = matrix ?? createQ4Stencil({ nelx: nx, nely: ny })
    this.offsets = stencil.offsets
    this.columns = stencil.columns
    this.diagonalSlots = stencil.diagonalSlots
    this.entries = matrix?.entries ?? new Float64Array(stencil.columns.length)
  }
}

/** P uses bilinear shape functions. Pᵀ is full weighting up to a constant scale
 * (the same scale is used in the Galerkin operator). Fixed rows are identically zero. */
class Transfer {
  private readonly nodes: Uint32Array
  private readonly weights: Float64Array
  private readonly counts: Uint8Array
  private readonly entries: Uint32Array

  constructor(private readonly fine: Level, private readonly coarse: Level) {
    const size = fine.fixed.length
    this.nodes = new Uint32Array(size * 4)
    this.weights = new Float64Array(size * 4)
    this.counts = new Uint8Array(size)
    const used = new Uint8Array(coarse.fixed.length)
    for (let row = 0; row < used.length; row++) {
      const x = Math.min(fine.nx, 2 * ((row >> 1) % (coarse.nx + 1)))
      const y = Math.min(fine.ny, 2 * Math.floor((row >> 1) / (coarse.nx + 1)))
      coarse.fixed[row] = fine.fixed[2 * (y * (fine.nx + 1) + x) + (row & 1)]
    }
    for (let row = 0; row < size; row++) {
      if (fine.fixed[row]) continue
      const x = (row >> 1) % (fine.nx + 1), y = Math.floor((row >> 1) / (fine.nx + 1))
      const spanX = x === fine.nx ? 0 : x % 2
      const spanY = y === fine.ny ? 0 : y % 2
      const cx = x === fine.nx ? coarse.nx : x >> 1
      const cy = y === fine.ny ? coarse.ny : y >> 1
      for (let dy = 0; dy <= spanY; dy++) {
        for (let dx = 0; dx <= spanX; dx++) {
          const node = 2 * ((cy + dy) * (coarse.nx + 1) + cx + dx) + (row & 1)
          if (coarse.fixed[node]) continue
          const slot = 4 * row + this.counts[row]++
          this.nodes[slot] = node
          this.weights[slot] = 1 / ((1 + spanX) * (1 + spanY))
          used[node] = 1
        }
      }
    }
    for (let i = 0; i < used.length; i++) if (!used[i]) coarse.fixed[i] = 1

    let count = 0
    for (let row = 0; row < size; row++) {
      for (let k = fine.offsets[row]; k < fine.offsets[row + 1]; k++) {
        count += this.counts[row] * this.counts[fine.columns[k]]
      }
    }
    this.entries = new Uint32Array(count)
    let slot = 0
    for (let row = 0; row < size; row++) {
      for (let k = fine.offsets[row]; k < fine.offsets[row + 1]; k++) {
        const col = fine.columns[k]
        for (let a = 0; a < this.counts[row]; a++) {
          const target = this.nodes[4 * row + a]
          for (let b = 0; b < this.counts[col]; b++) {
            this.entries[slot++] = coarse.columns.indexOf(this.nodes[4 * col + b], coarse.offsets[target])
          }
        }
      }
    }
  }

  assemble() {
    const { fine, coarse, weights, counts, entries } = this
    coarse.entries.fill(0)
    let slot = 0
    for (let row = 0; row < counts.length; row++) {
      for (let k = fine.offsets[row]; k < fine.offsets[row + 1]; k++) {
        const col = fine.columns[k]
        for (let a = 0; a < counts[row]; a++) {
          const value = fine.entries[k] * weights[4 * row + a]
          for (let b = 0; b < counts[col]; b++) {
            coarse.entries[entries[slot++]] += value * weights[4 * col + b]
          }
        }
      }
    }
    for (let i = 0; i < coarse.fixed.length; i++) {
      if (coarse.fixed[i]) coarse.entries[coarse.diagonalSlots[i]] = 1
    }
  }

  restrict(input: Float64Array) {
    const { rhs } = this.coarse
    rhs.fill(0)
    for (let row = 0; row < input.length; row++) {
      for (let a = 4 * row; a < 4 * row + this.counts[row]; a++) {
        rhs[this.nodes[a]] += this.weights[a] * input[row]
      }
    }
  }

  prolong(output: Float64Array) {
    const { solution } = this.coarse
    for (let row = 0; row < output.length; row++) {
      for (let a = 4 * row; a < 4 * row + this.counts[row]; a++) {
        output[row] += this.weights[a] * solution[this.nodes[a]]
      }
    }
  }
}

/** Galerkin Q4 V-cycle with symmetric damped Gauss–Seidel smoothing and an exact coarse solve. */
export class Multigrid2D {
  private readonly levels: Level[] = []
  private readonly transfers: Transfer[] = []
  private readonly cholesky: Float64Array

  constructor({ nelx, nely }: Grid, fixed: Uint8Array, stiffness: Stiffness2D) {
    let fine = new Level(nelx, nely, fixed, stiffness)
    this.levels.push(fine)
    while (Math.min(fine.nx, fine.ny) >= 2 && (fine.nx + 1) * (fine.ny + 1) > 40) {
      const coarse = new Level(Math.ceil(fine.nx / 2), Math.ceil(fine.ny / 2))
      this.transfers.push(new Transfer(fine, coarse))
      this.levels.push(coarse)
      fine = coarse
    }
    // Extremely thin grids can stop coarsening before reaching a cheap dense solve.
    this.cholesky = new Float64Array(this.transfers.length && fine.fixed.length <= 128 ? fine.fixed.length ** 2 : 0)
  }

  prepare() {
    if (!this.cholesky.length) return undefined
    for (const transfer of this.transfers) transfer.assemble()
    for (const level of this.levels) {
      for (let i = 0; i < level.inverse.length; i++) {
        level.inverse[i] = level.fixed[i] ? 0 : 0.95 / level.entries[level.diagonalSlots[i]]
      }
    }
    const coarse = this.levels[this.levels.length - 1]
    const { cholesky } = this
    const n = coarse.fixed.length
    cholesky.fill(0)
    for (let i = 0; i < n; i++) {
      for (let k = coarse.offsets[i]; k <= coarse.diagonalSlots[i]; k++) {
        cholesky[i * n + coarse.columns[k]] = coarse.entries[k]
      }
      for (let j = 0; j <= i; j++) {
        let value = cholesky[i * n + j]
        for (let k = 0; k < j; k++) value -= cholesky[i * n + k] * cholesky[j * n + k]
        if (i === j && !(value > 0)) return undefined
        cholesky[i * n + j] = i === j ? Math.sqrt(value) : value / cholesky[j * n + j]
      }
    }
    return this.apply
  }

  private readonly apply = (rhs: Float64Array, output: Float64Array) => this.cycle(0, rhs, output)

  private cycle(index: number, rhs: Float64Array, output: Float64Array): void {
    const { offsets, columns, entries, inverse, residual, fixed } = this.levels[index]
    const n = output.length
    if (index === this.transfers.length) {
      const { cholesky } = this
      for (let i = 0; i < n; i++) {
        let value = fixed[i] ? 0 : rhs[i]
        for (let k = 0; k < i; k++) value -= cholesky[i * n + k] * output[k]
        output[i] = value / cholesky[i * n + i]
      }
      for (let i = n - 1; i >= 0; i--) {
        let value = output[i]
        for (let k = i + 1; k < n; k++) value -= cholesky[k * n + i] * output[k]
        output[i] = value / cholesky[i * n + i]
      }
      return
    }
    // The starting correction is zero, so the first sweep only needs lower entries.
    const { diagonalSlots } = this.levels[index]
    for (let i = 0; i < n; i++) {
      let value = rhs[i]
      for (let k = offsets[i]; k < diagonalSlots[i]; k++) value -= entries[k] * output[columns[k]]
      output[i] = value * inverse[i]
    }
    for (let i = 0; i < n; i++) {
      let value = rhs[i]
      for (let k = offsets[i]; k < offsets[i + 1]; k++) value -= entries[k] * output[columns[k]]
      residual[i] = fixed[i] ? 0 : value
    }
    const transfer = this.transfers[index]
    transfer.restrict(residual)
    const coarse = this.levels[index + 1]
    this.cycle(index + 1, coarse.rhs, coarse.solution)
    transfer.prolong(output)
    for (let i = n - 1; i >= 0; i--) {
      let value = rhs[i]
      for (let k = offsets[i]; k < offsets[i + 1]; k++) value -= entries[k] * output[columns[k]]
      output[i] += value * inverse[i]
    }
  }
}
