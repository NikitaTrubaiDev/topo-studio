import { elasticity3D, h8Corners } from './elementH8'

/** Each positive-oriented template starts with the central tetrahedron. The corner
 * tetrahedra follow in increasing order of their unshared brick corner. */
export const tetCorners = [
  [[0, 5, 3, 6], [1, 0, 5, 3], [2, 0, 3, 6], [4, 0, 6, 5], [7, 3, 5, 6]],
  [[1, 7, 2, 4], [0, 1, 2, 4], [3, 1, 7, 2], [5, 1, 4, 7], [6, 2, 7, 4]],
] as const

export const tetFaces = [[1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]] as const

export function tetVolumeFraction(tet: number) {
  return tet === 0 ? 1 / 3 : 1 / 6
}

export const tetCentroids = tetCorners.map(parity => parity.map(corners =>
  [0, 1, 2].map(axis => corners.reduce<number>((sum, corner) => sum + h8Corners[corner][axis], 0) / 4)))

type Vector = readonly number[]

function cross(a: Vector, b: Vector) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

export function tet4Templates(E: number, nu: number, hx: number, hy: number, hz: number) {
  const D = elasticity3D(E, nu)
  const size = [hx, hy, hz]
  return tetCorners.flatMap(parity => parity.map(corners => {
    const origin = h8Corners[corners[0]]
    const [a, b, c] = corners.slice(1).map(corner => h8Corners[corner].map((v, d) => v - origin[d]))
    // Invert the unit-brick Jacobian exactly, then scale each derivative to mm.
    const grads = [cross(b, c), cross(c, a), cross(a, b)]
    const det = a.reduce((sum, v, d) => sum + v * grads[0][d], 0)
    grads.unshift(size.map((_, d) => -grads[0][d] - grads[1][d] - grads[2][d]))
    const volume = hx * hy * hz * det / 6
    return tet4Stiffness(grads.map(grad => grad.map((v, d) => v / (det * size[d]))), volume, D)
  }))
}

/** Constant engineering strain and full symmetric stiffness of a linear tetrahedron. */
export function tet4Stiffness(grads: number[][], volume: number, D: Float64Array) {
  const B = new Float64Array(6 * 12)
  grads.forEach(([dx, dy, dz], i) => {
    const j = 3 * i
    B[j] = B[36 + j + 1] = B[60 + j + 2] = dx
    B[12 + j + 1] = B[36 + j] = B[48 + j + 2] = dy
    B[24 + j + 2] = B[48 + j + 1] = B[60 + j] = dz
  })
  const DB = new Float64Array(B.length)
  for (let r = 0; r < 6; r++) for (let j = 0; j < 12; j++) for (let k = 0; k < 6; k++) {
    DB[r * 12 + j] += D[r * 6 + k] * B[k * 12 + j]
  }
  const Ke = new Float64Array(144)
  for (let i = 0; i < 12; i++) for (let j = i; j < 12; j++) {
    let value = 0
    for (let k = 0; k < 6; k++) value += B[k * 12 + i] * DB[k * 12 + j]
    Ke[i * 12 + j] = Ke[j * 12 + i] = value * volume
  }
  return { B, Ke, volume }
}
