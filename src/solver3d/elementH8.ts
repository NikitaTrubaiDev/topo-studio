/** Local node order. X varies fastest, then Y, then Z. */
export const h8Corners = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
] as const

/** Row-major elasticity in the order xx, yy, zz, xy, yz, zx (engineering shear). */
export function elasticity3D(E: number, nu: number) {
  const D = new Float64Array(36)
  const shear = E / (2 * (1 + nu))
  const lambda = 2 * shear * nu / (1 - 2 * nu)
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) D[i * 6 + j] = lambda + (i === j ? 2 * shear : 0)
    D[(i + 3) * 7] = shear
  }
  return D
}

/** Row-major 6×24 strain-displacement matrix, evaluated at the center by default. */
export function strainDisplacementH8(hx: number, hy: number, hz: number, xi = 0, eta = 0, zeta = 0) {
  const B = new Float64Array(6 * 24)
  h8Corners.forEach(([x, y, z], i) => {
    const sx = 2 * x - 1, sy = 2 * y - 1, sz = 2 * z - 1
    const dx = sx * (1 + sy * eta) * (1 + sz * zeta) / (4 * hx)
    const dy = sy * (1 + sx * xi) * (1 + sz * zeta) / (4 * hy)
    const dz = sz * (1 + sx * xi) * (1 + sy * eta) / (4 * hz)
    const d = 3 * i
    B[d] = B[3 * 24 + d + 1] = B[5 * 24 + d + 2] = dx
    B[24 + d + 1] = B[3 * 24 + d] = B[4 * 24 + d + 2] = dy
    B[2 * 24 + d + 2] = B[4 * 24 + d + 1] = B[5 * 24 + d] = dz
  })
  return B
}

export function h8Stiffness(E: number, nu: number, hx: number, hy: number, hz: number) {
  const Ke = new Float64Array(24 * 24)
  const D = elasticity3D(E, nu)
  const g = 1 / Math.sqrt(3)
  const detJacobian = hx * hy * hz / 8
  for (const xi of [-g, g]) for (const eta of [-g, g]) for (const zeta of [-g, g]) {
    const B = strainDisplacementH8(hx, hy, hz, xi, eta, zeta)
    const DB = new Float64Array(B.length)
    for (let r = 0; r < 6; r++) for (let c = 0; c < 24; c++) {
      for (let j = 0; j < 6; j++) DB[r * 24 + c] += D[r * 6 + j] * B[j * 24 + c]
    }
    for (let r = 0; r < 24; r++) for (let c = r; c < 24; c++) {
      let value = 0
      for (let j = 0; j < 6; j++) value += B[j * 24 + r] * DB[j * 24 + c]
      Ke[r * 24 + c] += value * detJacobian
    }
  }
  for (let r = 0; r < 24; r++) for (let c = 0; c < r; c++) Ke[r * 24 + c] = Ke[c * 24 + r]
  return Ke
}

export function vonMises3D(xx: number, yy: number, zz: number, xy: number, yz: number, zx: number) {
  return Math.hypot((xx - yy) / Math.SQRT2, (yy - zz) / Math.SQRT2, (zz - xx) / Math.SQRT2,
    Math.sqrt(3) * xy, Math.sqrt(3) * yz, Math.sqrt(3) * zx)
}
