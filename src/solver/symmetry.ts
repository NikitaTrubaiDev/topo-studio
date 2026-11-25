import type { Grid, PassiveMasks, Symmetry } from './types'

/** Projection onto mirror orbits. Its transpose is the same averaging operation. */
export class MirrorSymmetry {
  private readonly representatives: Uint32Array
  private readonly counts: Uint8Array
  private readonly sums: Float64Array

  constructor({ nelx, nely }: Grid, mode: Symmetry) {
    const size = nelx * nely
    this.representatives = new Uint32Array(size)
    this.counts = new Uint8Array(size)
    this.sums = new Float64Array(size)
    for (let y = 0; y < nely; y++) {
      for (let x = 0; x < nelx; x++) {
        const i = (mode.includes('y') ? Math.min(y, nely - 1 - y) : y) * nelx
          + (mode.includes('x') ? Math.min(x, nelx - 1 - x) : x)
        this.representatives[y * nelx + x] = i
        this.counts[i]++
      }
    }
  }

  masks(passive?: PassiveMasks): PassiveMasks | undefined {
    if (!passive) return undefined
    const { representatives } = this
    const solid = new Uint8Array(representatives.length)
    const voidMask = new Uint8Array(representatives.length)
    for (let e = 0; e < representatives.length; e++) {
      const i = representatives[e]
      solid[i] |= passive.solid?.[e] ?? 0
      voidMask[i] |= passive.void?.[e] ?? 0
      if (solid[i] && voidMask[i]) throw new Error('Mirror symmetry conflicts with the passive masks.')
    }
    for (let e = 0; e < representatives.length; e++) {
      solid[e] = solid[representatives[e]]
      voidMask[e] = voidMask[representatives[e]]
    }
    return { solid, void: voidMask }
  }

  apply(input: Float64Array, output = input) {
    const { representatives, counts, sums } = this
    sums.fill(0)
    for (let e = 0; e < input.length; e++) sums[representatives[e]] += input[e]
    for (let e = 0; e < input.length; e++) {
      const i = representatives[e]
      output[e] = sums[i] / counts[i]
    }
    return output
  }
}
