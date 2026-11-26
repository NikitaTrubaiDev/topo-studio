import { tetCentroids, tetVolumeFraction } from './elementT4'
import { cellSize, elementCount, type ElementType3D, type Grid3D } from './types3d'

type FilterStencil = {
  offsets: number[][]
  delta: Int32Array
  weights: Float64Array
  sum: number
}

export class DensityFilter3D {
  private readonly inverseWeight: Float64Array
  private readonly stencils: FilterStencil[][]
  private readonly perCell: number
  private readonly rim: number[]
  private readonly voidMask?: Uint8Array

  constructor(private readonly grid: Grid3D, radius: number, passiveVoid?: Uint8Array, elementType: ElementType3D = 'hex8') {
    const { nelx, nely, nelz } = grid
    const count = elementCount(grid, elementType)
    const isTet = elementType === 'tet4'
    const perCell = isTet ? 5 : 1
    const centroids = isTet ? tetCentroids : [[[0.5, 0.5, 0.5]], [[0.5, 0.5, 0.5]]]
    const size = cellSize(grid)
    const [hx, hy, hz] = size
    const radiusMm = radius * Math.min(...size)
    const counts = [nelx, nely, nelz]
    const [rx, ry, rz] = size.map((side, axis) =>
      Math.min(counts[axis] - 1, Math.max(0, Math.ceil(radiusMm / side + (isTet ? 0.5 : 0)) - 1)))
    this.perCell = perCell
    this.rim = [rx, ry, rz]
    this.voidMask = passiveVoid?.some(Boolean) ? passiveVoid : undefined
    this.stencils = centroids.map((parity, p) => parity.map(([cx, cy, cz]) => {
      const offsets: number[][] = [], delta: number[] = [], weights: number[] = []
      let sum = 0
      for (let z = -rz; z <= rz; z++) for (let y = -ry; y <= ry; y++) for (let x = -rx; x <= rx; x++) {
        centroids[(p + x + y + z) & 1].forEach(([nx, ny, nz], tet) => {
          const distance = Math.hypot((x + nx - cx) * hx, (y + ny - cy) * hy, (z + nz - cz) * hz)
          const weight = (radiusMm - distance) * (isTet ? tetVolumeFraction(tet) : 1)
          if (weight <= 0) return
          offsets.push([x, y, z])
          delta.push(((z * nely + y) * nelx + x) * perCell + tet)
          weights.push(weight)
          sum += weight
        })
      }
      return { offsets, delta: Int32Array.from(delta), weights: Float64Array.from(weights), sum }
    }))
    // Geometry and cone weights repeat every two cells. Store only the small
    // stencils and one normalization per element, even at the largest radius.
    this.inverseWeight = new Float64Array(count)
    this.multiply(undefined, this.inverseWeight, false)
  }

  private multiply(input: Float64Array | undefined, output: Float64Array, transpose: boolean) {
    const { nelx, nely, nelz } = this.grid
    const { inverseWeight, stencils, perCell, voidMask } = this
    const [rx, ry, rz] = this.rim
    let base = 0
    for (let z = 0; z < nelz; z++) for (let y = 0; y < nely; y++) for (let x = 0; x < nelx; x++, base += perCell) {
      const interior = x >= rx && x < nelx - rx && y >= ry && y < nely - ry && z >= rz && z < nelz - rz
      const family = stencils[(x + y + z) & 1]
      for (let t = 0; t < perCell; t++) {
        const e = base + t
        if (voidMask?.[e]) {
          if (!transpose) output[e] = 0
          continue
        }
        const { offsets, delta, weights, sum } = family[t]
        if (input && interior && !voidMask) {
          if (transpose) {
            const value = input[e] * inverseWeight[e]
            for (let i = 0; i < delta.length; i++) output[base + delta[i]] += weights[i] * value
          } else {
            let value = 0
            for (let i = 0; i < delta.length; i++) value += weights[i] * input[base + delta[i]]
            output[e] = value * inverseWeight[e]
          }
          continue
        }
        if (!input && interior && !voidMask) {
          output[e] = 1 / sum
          continue
        }
        let value = 0
        const scaled = transpose ? input![e] * inverseWeight[e] : 0
        for (let i = 0; i < delta.length; i++) {
          if (!interior) {
            const shift = offsets[i]
            const a = x + shift[0], b = y + shift[1], c = z + shift[2]
            if (a < 0 || a >= nelx || b < 0 || b >= nely || c < 0 || c >= nelz) continue
          }
          const other = base + delta[i]
          if (voidMask?.[other]) continue
          if (transpose) output[other] += weights[i] * scaled
          else value += input ? weights[i] * input[other] : weights[i]
        }
        if (!transpose) output[e] = input ? value * inverseWeight[e] : 1 / value
      }
    }
  }

  apply(input: Float64Array, output: Float64Array) {
    this.multiply(input, output, false)
    return output
  }

  transpose(input: Float64Array, output: Float64Array) {
    output.fill(0)
    this.multiply(input, output, true)
    return output
  }
}

/** Project the filtered field in place and record the derivative for HбµЂ. */
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
