import { describe, expect, it } from 'vitest'
import { DensityFilter } from '../filter'

describe('cone density filter', () => {
  const grid = { nelx: 9, nely: 5 }
  const size = grid.nelx * grid.nely
  const filter = new DensityFilter(grid, 2.5)

  it('preserves uniform density at corners, edges, and inside the grid', () => {
    for (const value of filter.apply(new Float64Array(size).fill(1))) expect(value).toBeCloseTo(1, 14)
  })

  it('preserves mirror symmetry in both axes', () => {
    const impulse = new Float64Array(size)
    impulse[Math.floor(size / 2)] = 1
    const density = filter.apply(impulse)
    for (let y = 0; y < grid.nely; y++) {
      for (let x = 0; x < grid.nelx; x++) {
        const value = density[y * grid.nelx + x]
        expect(value).toBeCloseTo(density[y * grid.nelx + grid.nelx - 1 - x], 14)
        expect(value).toBeCloseTo(density[(grid.nely - 1 - y) * grid.nelx + x], 14)
      }
    }
  })

  it('uses the exact transpose for chain-rule sensitivity at nonuniform row sums', () => {
    const input = Float64Array.from({ length: size }, (_, i) => Math.cos(i + 1))
    const gradient = Float64Array.from({ length: size }, (_, i) => Math.sin(i + 1))
    const left = filter.apply(input).reduce((sum, value, i) => sum + value * gradient[i], 0)
    const right = filter.transpose(gradient).reduce((sum, value, i) => sum + value * input[i], 0)
    expect(left).toBeCloseTo(right, 13)
  })
})
