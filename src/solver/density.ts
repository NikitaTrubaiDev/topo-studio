import { DensityFilter } from './filter'
import type { SimpProblem } from './types'

type DensityProblem = Pick<SimpProblem, 'grid' | 'params' | 'passive'>

export function initializeDensity({ grid, params, passive }: DensityProblem) {
  const elements = grid.nelx * grid.nely
  if ([passive?.solid, passive?.void].some(mask => mask && mask.length !== elements)) {
    throw new Error('Passive masks must contain one entry per element.')
  }
  const filter = new DensityFilter(grid, params.rmin, passive?.void)
  const mask = new Int8Array(elements)
  const design = new Float64Array(elements)
  const volumeAtOutput = new Float64Array(elements)
  let solidCount = 0
  for (let e = 0; e < elements; e++) {
    if (passive?.solid?.[e] && passive?.void?.[e]) throw new Error('Passive solid and void masks overlap.')
    if (passive?.solid?.[e]) {
      mask[e] = 1
      design[e] = 1
      solidCount++
    } else if (passive?.void?.[e]) {
      mask[e] = -1
    } else {
      volumeAtOutput[e] = 1
    }
  }

  // Only free output rows contribute derivatives with respect to filter inputs.
  const volumeGradient = filter.transpose(volumeAtOutput)
  const fixedVolume = solidCount + volumeGradient.reduce((sum, weight, e) => sum + weight * design[e], 0)
  let freeVolume = 0
  for (let e = 0; e < elements; e++) {
    if (mask[e]) volumeGradient[e] = 0
    freeVolume += volumeGradient[e]
  }
  const min = fixedVolume / elements
  const max = (fixedVolume + freeVolume) / elements
  // During mask edits the target can be infeasible. Preview the closest feasible field.
  const initial = max > min ? Math.max(0, Math.min(1, (params.volFrac - min) / (max - min))) : 0
  for (let e = 0; e < elements; e++) {
    if (!mask[e]) design[e] = initial
  }
  return { filter, mask, design, volumeGradient, fixedVolume, volumeRange: [min, max] as const }
}

export function filterPhysicalDensity(
  filter: DensityFilter, mask: Int8Array, design: Float64Array, output?: Float64Array,
): Float64Array {
  const density = filter.apply(design, output)
  for (let e = 0; e < density.length; e++) {
    if (mask[e] === 1) density[e] = 1
  }
  return density
}

export function initialPhysicalDensity(problem: DensityProblem): Float32Array {
  const { filter, mask, design } = initializeDensity(problem)
  return Float32Array.from(filterPhysicalDensity(filter, mask, design))
}
