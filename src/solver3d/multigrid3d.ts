import { h8Corners, h8Stiffness } from './elementH8'
import { tetVolumeFraction } from './elementT4'
import { Stiffness3D } from './stiffness3d'
import { cellSize, elementCount, nodeCount, nodeIndex3D, type ElementType3D, type Grid3D } from './types3d'

class Transfer3D {
  private readonly nodes: Int32Array
  private readonly weights: Float64Array

  constructor(private readonly fine: Stiffness3D, coarse: Grid3D, private readonly fixed: Uint8Array) {
    const { grid } = fine
    this.nodes = new Int32Array(8 * nodeCount(grid))
    this.weights = new Float64Array(this.nodes.length)
    const coordinate = (i: number, n: number, m: number) => i * m / n
    for (let z = 0, start = 0; z <= grid.nelz; z++) for (let y = 0; y <= grid.nely; y++) for (let x = 0; x <= grid.nelx; x++, start += 8) {
      const px = coordinate(x, grid.nelx, coarse.nelx), py = coordinate(y, grid.nely, coarse.nely)
      const pz = coordinate(z, grid.nelz, coarse.nelz)
      const i = Math.min(coarse.nelx - 1, Math.floor(px)), j = Math.min(coarse.nely - 1, Math.floor(py))
      const k = Math.min(coarse.nelz - 1, Math.floor(pz))
      const tx = px - i, ty = py - j, tz = pz - k
      for (let c = 0; c < 8; c++) {
        const [dx, dy, dz] = h8Corners[c]
        this.nodes[start + c] = 3 * nodeIndex3D(coarse, i + dx, j + dy, k + dz)
        this.weights[start + c] = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz)
      }
      const nearest = 3 * nodeIndex3D(coarse, Math.round(px), Math.round(py), Math.round(pz))
      const d = start / 8 * 3
      for (let axis = 0; axis < 3; axis++) if (fine.fixed[d + axis]) fixed[nearest + axis] = 1
    }
  }

  restrict(input: Float64Array, output: Float64Array) {
    const { nodes, weights, fixed, fine } = this
    output.fill(0)
    for (let d = 0, start = 0; d < input.length; d += 3, start += 8) {
      const x = fine.fixed[d] ? 0 : input[d], y = fine.fixed[d + 1] ? 0 : input[d + 1]
      const z = fine.fixed[d + 2] ? 0 : input[d + 2]
      for (let k = start; k < start + 8; k++) {
        const j = nodes[k], w = weights[k]
        output[j] += x * w; output[j + 1] += y * w; output[j + 2] += z * w
      }
    }
    for (let j = 0; j < fixed.length; j++) if (fixed[j]) output[j] = 0
  }

  prolongAdd(input: Float64Array, output: Float64Array) {
    const { nodes, weights, fine } = this
    for (let d = 0, start = 0; d < output.length; d += 3, start += 8) {
      let x = 0, y = 0, z = 0
      for (let k = start; k < start + 8; k++) {
        const j = nodes[k], w = weights[k]
        x += w * input[j]; y += w * input[j + 1]; z += w * input[j + 2]
      }
      if (!fine.fixed[d]) output[d] += x
      if (!fine.fixed[d + 1]) output[d + 1] += y
      if (!fine.fixed[d + 2]) output[d + 2] += z
    }
  }
}

function overlaps(fine: number, coarse: number) {
  const ratio = fine / coarse
  return Array.from({ length: coarse }, (_, i) => {
    const lo = i * ratio, hi = (i + 1) * ratio
    const first = Math.floor(lo), end = Math.min(fine, Math.ceil(hi))
    return Array.from({ length: end - first }, (_, k) => {
      const cell = first + k
      return { cell, weight: (Math.min(hi, cell + 1) - Math.max(lo, cell)) / ratio }
    })
  })
}

class Level3D {
  readonly operator: Stiffness3D
  readonly transfer: Transfer3D
  readonly modulus: Float64Array
  readonly rhs: Float64Array
  readonly solution: Float64Array
  readonly fineResidual: Float64Array
  private readonly aggregation: Array<{ cells: Int32Array; weights: Float64Array }> = []

  constructor(fine: Stiffness3D, nu: number) {
    const grid = { ...fine.grid, nelx: Math.floor(fine.grid.nelx / 2), nely: Math.floor(fine.grid.nely / 2),
      nelz: Math.floor(fine.grid.nelz / 2) }
    const fixed = new Uint8Array(3 * nodeCount(grid))
    this.transfer = new Transfer3D(fine, grid, fixed)
    this.operator = new Stiffness3D(grid, [h8Stiffness(1, nu, ...cellSize(grid))], fixed)
    this.modulus = new Float64Array(elementCount(grid))
    this.rhs = new Float64Array(fixed.length)
    this.solution = new Float64Array(fixed.length)
    this.fineResidual = new Float64Array(fine.fixed.length)
    const { nelx, nely, nelz } = fine.grid
    for (const zs of overlaps(nelz, grid.nelz)) for (const ys of overlaps(nely, grid.nely)) for (const xs of overlaps(nelx, grid.nelx)) {
      const cells = new Int32Array(xs.length * ys.length * zs.length)
      const weights = new Float64Array(cells.length)
      let i = 0
      for (const z of zs) for (const y of ys) for (const x of xs) {
        cells[i] = (z.cell * nely + y.cell) * nelx + x.cell
        weights[i++] = x.weight * y.weight * z.weight
      }
      this.aggregation.push({ cells, weights })
    }
  }

  prepare(modulus: Float64Array) {
    for (let e = 0; e < this.modulus.length; e++) {
      const { cells, weights } = this.aggregation[e]
      let value = 0
      for (let i = 0; i < cells.length; i++) value += weights[i] * modulus[cells[i]]
      this.modulus[e] = value
    }
    // Coarse supports can merge when projected. A small diagonal shift removes
    // any resulting coarse rigid modes without modifying the fine equilibrium.
    this.operator.prepare(this.modulus, 1e-8)
  }
}

export class Multigrid3D {
  private readonly levels: Level3D[] = []
  private readonly brickModulus?: Float64Array

  constructor(private readonly fine: Stiffness3D, nu: number, elementType: ElementType3D) {
    if (elementType === 'tet4') this.brickModulus = new Float64Array(elementCount(fine.grid))
    let operator = fine
    while (Math.min(operator.grid.nelx, operator.grid.nely, operator.grid.nelz) >= 4) {
      const level = new Level3D(operator, nu)
      this.levels.push(level)
      operator = level.operator
    }
  }

  prepare(modulus: Float64Array) {
    const { brickModulus } = this
    if (brickModulus) {
      for (let e = 0; e < brickModulus.length; e++) {
        let value = 0
        for (let t = 0; t < 5; t++) value += tetVolumeFraction(t) * modulus[5 * e + t]
        brickModulus[e] = value
      }
      modulus = brickModulus
    }
    for (const level of this.levels) {
      level.prepare(modulus)
      modulus = level.modulus
    }
  }

  apply(rhs: Float64Array, output: Float64Array) {
    this.cycle(0, this.fine, rhs, output)
  }

  private cycle(index: number, operator: Stiffness3D, rhs: Float64Array, output: Float64Array) {
    output.fill(0)
    const coarse = this.levels[index]
    if (!coarse) {
      for (let i = 0; i < 8; i++) {
        operator.relax(output, rhs, 1)
        operator.relax(output, rhs, -1)
      }
      return
    }
    operator.relax(output, rhs, 1)
    const { fineResidual } = coarse
    operator.apply(output, fineResidual)
    for (let i = 0; i < rhs.length; i++) fineResidual[i] = rhs[i] - fineResidual[i]
    coarse.transfer.restrict(fineResidual, coarse.rhs)
    this.cycle(index + 1, coarse.operator, coarse.rhs, coarse.solution)
    coarse.transfer.prolongAdd(coarse.solution, output)
    operator.relax(output, rhs, -1)
  }
}
