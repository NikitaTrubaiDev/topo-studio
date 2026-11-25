import { densitySum } from './manufacturing'
import type { IterationSnapshot, SimpProblem } from './types'

export function engineeringMetrics(
  { grid, material, passive }: Pick<SimpProblem, 'grid' | 'material' | 'passive'>,
  density: Float32Array, result?: Pick<IterationSnapshot, 'displacements' | 'vonMises' | 'maxVonMises'>,
) {
  const mask = passive?.void
  const unitMass = (grid.cellSizeMm ?? 1) ** 2 * (grid.thicknessMm ?? 1) * material.densityKgM3 * 1e-6
  const initialMass = (density.length - (mask ? mask.reduce((sum, bit) => sum + bit, 0) : 0)) * unitMass
  const mass = densitySum(density) * unitMass
  const saved = initialMass > 0 ? 100 * (1 - mass / initialMass) : 0
  if (!result) return { initialMass, mass, saved }

  let maxDeflectionSquared = 0
  for (const u of result.displacements) {
    for (let i = 0; i < u.length; i += 2) {
      maxDeflectionSquared = Math.max(maxDeflectionSquared, u[i] ** 2 + u[i + 1] ** 2)
    }
  }
  const sample: number[] = []
  for (let e = 0; e < density.length; e++) if (density[e] > 0.2) sample.push(result.vonMises[e])
  sample.sort((a, b) => a - b)
  const p95 = sample[Math.ceil(0.95 * sample.length) - 1]
  const safetyFactor = p95 > 0 ? material.yieldMPa / p95 : undefined
  return { initialMass, mass, saved, maxDeflection: Math.sqrt(maxDeflectionSquared),
    safetyFactor, p95, peak: result.maxVonMises }
}
