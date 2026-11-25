import { describe, expect, it } from 'vitest'
import { centerB, elementStiffness } from '../elementQ4'

describe('unit-square Q4 element', () => {
  it('has a symmetric stiffness and exactly three rigid-body null modes', () => {
    const K = elementStiffness(1, 0.3)
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) expect(K[8 * i + j]).toBe(K[8 * j + i])
    }
    const translationsAndRotation = [
      [1, 0, 1, 0, 1, 0, 1, 0],
      [0, 1, 0, 1, 0, 1, 0, 1],
      [0, 0, 0, 1, -1, 1, -1, 0],
    ]
    for (const mode of translationsAndRotation) {
      for (let i = 0; i < 8; i++) {
        const residual = mode.reduce((sum, value, j) => sum + K[8 * i + j] * value, 0)
        expect(Math.abs(residual)).toBeLessThan(1e-14)
      }
    }

    // Removing DOFs 0, 1 and 3 fixes all three rigid motions. Positive Cholesky
    // pivots on the complementary subspace prove the full matrix is PSD with rank five.
    const free = [2, 4, 5, 6, 7]
    const L = free.map(() => new Float64Array(free.length))
    for (let i = 0; i < free.length; i++) {
      for (let j = 0; j <= i; j++) {
        let value = K[8 * free[i] + free[j]]
        for (let k = 0; k < j; k++) value -= L[i][k] * L[j][k]
        if (i === j) {
          expect(value).toBeGreaterThan(0)
          L[i][j] = Math.sqrt(value)
        } else {
          L[i][j] = value / L[j][j]
        }
      }
    }
  })

  it('recovers the exact engineering strains of an affine displacement field', () => {
    const u = [0, 0, 2, 4, 5, 3, 3, -1]
    const strain = [0, 1, 2].map(i => u.reduce((sum, value, j) => sum + centerB[8 * i + j] * value, 0))
    expect(strain).toEqual([2, -1, 7])
  })
})
