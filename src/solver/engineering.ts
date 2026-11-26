import { densitySum } from './manufacturing'
import type { IterationSnapshot, SimpProblem } from './types'

export function engineeringMetrics(
  { grid, material, passive }: Pick<SimpProblem, 'grid' | 'material' | 'passive'>,
  density: Float32Array, result?: Pick<IterationSnapshot, 'displacements' | 'p95VonMises' | 'maxVonMises'>,
) {
  const mask = passive?.void
  const unitMass = (grid.cellSizeMm ?? 1) ** 2 * (grid.thicknessMm ?? 1) * material.densityKgM3 * 1e-6
  const initialMass = (density.length - (mask ? mask.reduce((sum, bit) => sum + bit, 0) : 0)) * unitMass
  const mass = densitySum(density) * unitMass
  const saved = initialMass > 0 ? 100 * (1 - mass / initialMass) : 0
  if (!result) return { initialMass, mass, saved }

  let maxDeflection = 0
  for (const u of result.displacements) {
    for (let i = 0; i < u.length; i += 2) {
      maxDeflection = Math.max(maxDeflection, Math.hypot(u[i], u[i + 1]))
    }
  }
  const { maxVonMises: peak, p95VonMises: p95 } = result
  const safetyFactor = peak > 0 ? material.yieldMPa / peak : undefined
  const p95SafetyFactor = p95 !== undefined && p95 > 0 ? material.yieldMPa / p95 : undefined
  const status = safetyFactor === undefined ? undefined : peak > material.yieldMPa ? 'fail'
    : safetyFactor < 1.5 ? 'caution' : 'safe'
  return { initialMass, mass, saved, maxDeflection, safetyFactor, p95SafetyFactor, p95, peak, status }
}
