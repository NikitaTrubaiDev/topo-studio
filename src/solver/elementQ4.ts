/** Plane-stress constitutive matrix in [εxx, εyy, γxy] order. */
export function planeStressD(E: number, nu: number): Float64Array {
  const scale = E / (1 - nu * nu)
  return Float64Array.of(scale, nu * scale, 0, nu * scale, scale, 0, 0, 0, scale * (1 - nu) / 2)
}

/** Row-major B for a unit square with counterclockwise nodes BL, BR, TR, TL. */
function strainDisplacement(xi: number, eta: number): Float64Array {
  const B = new Float64Array(24)
  const signs = [-1, -1, 1, -1, 1, 1, -1, 1]
  for (let dof = 0; dof < 8; dof += 2) {
    const sx = signs[dof]
    const sy = signs[dof + 1]
    // The inverse Jacobian for the unit square scales both derivatives by 2.
    const dx = sx * (1 + sy * eta) / 2
    const dy = sy * (1 + sx * xi) / 2
    B[dof] = dx
    B[8 + dof + 1] = dy
    B[16 + dof] = dy
    B[16 + dof + 1] = dx
  }
  return B
}

export const centerB = strainDisplacement(0, 0)

/** Exact 8×8 Q4 stiffness via 2×2 Gauss integration. Thickness is 1 mm. */
export function elementStiffness(E: number, nu: number): Float64Array {
  const D = planeStressD(E, nu)
  const Ke = new Float64Array(64)
  const gauss = 1 / Math.sqrt(3)
  for (const xi of [-gauss, gauss]) {
    for (const eta of [-gauss, gauss]) {
      const B = strainDisplacement(xi, eta)
      for (let i = 0; i < 8; i++) {
        for (let j = i; j < 8; j++) {
          let value = 0
          for (let a = 0; a < 3; a++) {
            for (let b = 0; b < 3; b++) {
              value += B[8 * a + i] * D[3 * a + b] * B[8 * b + j]
            }
          }
          Ke[8 * i + j] += value / 4
          Ke[8 * j + i] = Ke[8 * i + j]
        }
      }
    }
  }
  return Ke
}
