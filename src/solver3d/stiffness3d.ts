import { h8Corners } from './elementH8'
import { tetCorners } from './elementT4'
import { elementCount, nodeCount, nodeIndex3D, type ElementType3D, type Grid3D } from './types3d'

/** Assemble into a regular 3x3 block stencil. Applying each nodal row once avoids
 * gathering and scattering the same DOFs for each incident element. */
export class Stiffness3D {
  readonly dofs: Int32Array
  readonly templateIndex: Uint8Array
  readonly width: number
  readonly inverseDiagonal: Float64Array
  private readonly neighbors: Int32Array
  private readonly values: Float64Array
  private readonly self: number
  private readonly elementSlots: Int8Array
  private readonly stencilSize: number

  constructor(readonly grid: Grid3D, readonly matrices: readonly Float64Array[],
    readonly fixed: Uint8Array, elementType: ElementType3D = 'hex8') {
    const isTet = elementType === 'tet4'
    const elements = elementCount(grid, elementType)
    const nodes = nodeCount(grid)
    this.width = isTet ? 12 : 24
    const cornersPerElement = this.width / 3
    this.dofs = new Int32Array(elements * this.width)
    this.templateIndex = new Uint8Array(elements)
    this.inverseDiagonal = new Float64Array(fixed.length)
    const offsets: number[][] = []
    const slot = new Int8Array(27).fill(-1)
    const offsetIndex = (x: number, y: number, z: number) => (z + 1) * 9 + (y + 1) * 3 + x + 1
    for (let z = -1; z <= 1; z++) for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
      if (isTet && Math.abs(x) + Math.abs(y) + Math.abs(z) === 3) continue
      slot[offsetIndex(x, y, z)] = offsets.length
      offsets.push([x, y, z])
    }
    this.self = slot[13]
    this.stencilSize = offsets.length
    this.neighbors = new Int32Array(nodes * this.stencilSize)
    this.values = new Float64Array(this.neighbors.length * 9)
    this.elementSlots = Int8Array.from((isTet ? tetCorners.flat() : [[0, 1, 2, 3, 4, 5, 6, 7]]).flatMap(corners =>
      corners.flatMap(i => corners.map(j => {
        const a = h8Corners[i], b = h8Corners[j]
        return slot[offsetIndex(b[0] - a[0], b[1] - a[1], b[2] - a[2])]
      }))))

    const { nelx, nely, nelz } = grid
    for (let z = 0; z <= nelz; z++) for (let y = 0; y <= nely; y++) for (let x = 0; x <= nelx; x++) {
      const offset = nodeIndex3D(grid, x, y, z) * this.stencilSize
      for (let k = 0; k < offsets.length; k++) {
        const [dx, dy, dz] = offsets[k]
        const i = x + dx, j = y + dy, l = z + dz
        if (i >= 0 && i <= nelx && j >= 0 && j <= nely && l >= 0 && l <= nelz) {
          this.neighbors[offset + k] = 3 * nodeIndex3D(grid, i, j, l)
        }
      }
    }
    let e = 0
    function firstDof(x: number, y: number, z: number, corner: number) {
      const [dx, dy, dz] = h8Corners[corner]
      return 3 * nodeIndex3D(grid, x + dx, y + dy, z + dz)
    }
    for (let z = 0; z < nelz; z++) for (let y = 0; y < nely; y++) for (let x = 0; x < nelx; x++) {
      const parity = (x + y + z) & 1
      for (let t = 0; t < (isTet ? 5 : 1); t++, e++) {
        this.templateIndex[e] = isTet ? 5 * parity + t : 0
        for (let j = 0; j < cornersPerElement; j++) {
          const d = firstDof(x, y, z, isTet ? tetCorners[parity][t][j] : j)
          const i = e * this.width + 3 * j
          this.dofs[i] = d
          this.dofs[i + 1] = d + 1
          this.dofs[i + 2] = d + 2
        }
      }
    }
  }

  prepare(modulus: Float64Array, diagonalShift = 0) {
    const { dofs, templateIndex, matrices, elementSlots, inverseDiagonal, fixed, self, stencilSize, width, values } = this
    const corners = width / 3
    values.fill(0)
    for (let e = 0, offset = 0; e < modulus.length; e++, offset += width) {
      const template = templateIndex[e], Ke = matrices[template], E = modulus[e]
      let slot = template * corners * corners
      for (let i = 0; i < width; i += 3) {
        const rowBase = dofs[offset + i] / 3 * stencilSize
        for (let j = 0; j < width; j += 3, slot++) {
          const block = (rowBase + elementSlots[slot]) * 9
          const col = dofs[offset + j]
          for (let r = 0; r < 3; r++) {
            if (fixed[dofs[offset + i + r]]) continue
            const k = (i + r) * width + j
            if (!fixed[col]) values[block + 3 * r] += E * Ke[k]
            if (!fixed[col + 1]) values[block + 3 * r + 1] += E * Ke[k + 1]
            if (!fixed[col + 2]) values[block + 3 * r + 2] += E * Ke[k + 2]
          }
        }
      }
    }
    for (let i = 0; i < fixed.length; i += 3) for (let r = 0; r < 3; r++) {
      const j = (i / 3 * stencilSize + self) * 9 + r * 4
      values[j] *= 1 + diagonalShift
      inverseDiagonal[i + r] = fixed[i + r] ? 0 : 1 / values[j]
    }
  }

  apply(input: Float64Array, output: Float64Array) {
    this.sweep(input, output, 0, 1)
  }

  relax(solution: Float64Array, rhs: Float64Array, step: 1 | -1) {
    this.sweep(solution, rhs, 1, step)
  }

  private sweep(input: Float64Array, output: Float64Array, relax: number, step: 1 | -1) {
    const { neighbors, values, inverseDiagonal, stencilSize, self } = this
    const end = step === 1 ? input.length : -3
    for (let i = step === 1 ? 0 : input.length - 3; i !== end; i += 3 * step) {
      let a = 0, b = 0, c = 0
      const start = i / 3 * stencilSize
      for (let n = start, k = start * 9; n < start + stencilSize; n++, k += 9) {
        const j = neighbors[n], x = input[j], y = input[j + 1], z = input[j + 2]
        a += values[k] * x + values[k + 1] * y + values[k + 2] * z
        b += values[k + 3] * x + values[k + 4] * y + values[k + 5] * z
        c += values[k + 6] * x + values[k + 7] * y + values[k + 8] * z
      }
      if (!relax) {
        output[i] = a; output[i + 1] = b; output[i + 2] = c
      } else {
        // Use the latest components of the diagonal block in the scalar GS order.
        const k = (start + self) * 9
        if (step === 1) {
          const dx = (output[i] - a) * inverseDiagonal[i]
          const dy = (output[i + 1] - b - values[k + 3] * dx) * inverseDiagonal[i + 1]
          input[i] += dx; input[i + 1] += dy
          input[i + 2] += (output[i + 2] - c - values[k + 6] * dx - values[k + 7] * dy) * inverseDiagonal[i + 2]
        } else {
          const dz = (output[i + 2] - c) * inverseDiagonal[i + 2]
          const dy = (output[i + 1] - b - values[k + 5] * dz) * inverseDiagonal[i + 1]
          input[i + 2] += dz; input[i + 1] += dy
          input[i] += (output[i] - a - values[k + 1] * dy - values[k + 2] * dz) * inverseDiagonal[i]
        }
      }
    }
  }
}
