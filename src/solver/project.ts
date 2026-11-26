import { DiagnosticError } from './diagnostics'
import { isValidForce, type Design } from './design'
import { materials, presets, type PresetId } from './presets'
import type { Grid, LoadCase, PassiveMasks, SimpParams, Support } from './types'

export type MaterialId = keyof typeof materials

export const resolutions: Record<string, Grid> = Object.fromEntries(
  [30, 48, 60, 72, 96, 120, 150, 180, 240, 300].map(nelx => [resolutionLabel(nelx, nelx / 3), {
    nelx, nely: nelx / 3,
  }]),
)

function resolutionLabel(nelx: number, nely: number) {
  return `${nelx} × ${nely}`
}

export interface Settings {
  preset: PresetId
  resolution: string
  material: MaterialId
  widthMm: number
  thicknessMm: number
  params: SimpParams
}

export type { Design } from './design'

export function projectGrid({ resolution, widthMm, thicknessMm }: Settings): Grid {
  const grid = resolutions[resolution]
  return { ...grid, cellSizeMm: widthMm / grid.nelx, thicknessMm }
}

export function saveProject(settings: Settings, design: Design) {
  const { resolution, ...configuration } = settings
  const { nelx, nely } = resolutions[resolution]
  const { supports, loadCases, passive } = design
  return JSON.stringify({
    version: 1, ...configuration, grid: { nelx, nely }, supports, loadCases,
    passive: {
      solid: passive?.solid && Array.from(passive.solid),
      void: passive?.void && Array.from(passive.void),
    },
  }, null, 2)
}

export class ProjectError extends DiagnosticError {
  constructor(readonly field: string) {
    super({ code: 'projectError', params: { field } })
  }
}

function check(condition: unknown, field: string): asserts condition {
  if (!condition) throw new ProjectError(field)
}

function object(value: unknown, field: string): Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value), field)
  return value as Record<string, unknown>
}

function number(value: unknown, field: string, min: number, max: number): number {
  check(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, field)
  return value
}

function choice<const T extends string>(value: unknown, options: readonly T[], field: string): T {
  check(typeof value === 'string' && options.includes(value as T), field)
  return value as T
}

export const partBounds = { min: 0.01, max: 100_000 } as const
const caseNames = ['caseMbb', 'caseCantilever', 'caseBridge', 'caseBracket', 'caseBump', 'caseRebound'] as const

export function loadProject(json: string): { settings: Settings; design: Design } {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new ProjectError('json')
  }
  const raw = object(parsed, 'json')
  check(raw.version === 1, 'version')
  const grid = object(raw.grid, 'grid')
  check(typeof grid.nelx === 'number' && typeof grid.nely === 'number', 'grid')
  const resolution = resolutionLabel(grid.nelx, grid.nely)
  check(Object.hasOwn(resolutions, resolution), 'grid')
  const nodes = (grid.nelx + 1) * (grid.nely + 1)
  const elements = grid.nelx * grid.nely
  const preset = choice(raw.preset, Object.keys(presets) as PresetId[], 'preset')
  const material = choice(raw.material, Object.keys(materials) as MaterialId[], 'material')
  const widthMm = number(raw.widthMm, 'widthMm', partBounds.min, partBounds.max)
  const thicknessMm = number(raw.thicknessMm, 'thicknessMm', partBounds.min, partBounds.max)
  const p = object(raw.params, 'params')
  const params: SimpParams = {
    penal: number(p.penal, 'penal', 1, 5), rmin: number(p.rmin, 'rmin', 1, 4),
    volFrac: number(p.volFrac, 'volFrac', 0, 1), moveLimit: number(p.moveLimit, 'moveLimit', Number.EPSILON, 1),
    maxIter: number(p.maxIter, 'maxIter', 1, 100_000), changeTol: number(p.changeTol, 'changeTol', 0, 1),
  }
  check(Number.isInteger(params.maxIter), 'maxIter')
  if (p.heaviside !== undefined) {
    check(typeof p.heaviside === 'boolean', 'heaviside')
    params.heaviside = p.heaviside
  }
  if (p.symmetry !== undefined) params.symmetry = choice(p.symmetry, ['none', 'x', 'y', 'xy'], 'symmetry')
  if (p.overhang !== undefined) params.overhang = choice(p.overhang, ['+Y', '-Y', '+X', '-X'], 'overhang')
  if (p.preconditioner !== undefined) params.preconditioner = choice(p.preconditioner, ['multigrid', 'jacobi'], 'preconditioner')
  const nodeAt = (value: unknown, field: string) => {
    const node = number(value, field, 0, nodes - 1)
    check(Number.isInteger(node), field)
    return node
  }
  check(Array.isArray(raw.supports), 'supports')
  const supportNodes = new Set<number>()
  const supports: Support[] = raw.supports.map(value => {
    const { node: entry, fixedX, fixedY, kind } = object(value, 'supports')
    const node = nodeAt(entry, 'supports')
    check(typeof fixedX === 'boolean' && typeof fixedY === 'boolean' && (fixedX || fixedY) && !supportNodes.has(node), 'supports')
    supportNodes.add(node)
    const support: Support = { node, fixedX, fixedY }
    if (kind !== undefined) {
      support.kind = choice(kind, ['fixed', 'pin', 'roller-x', 'roller-y'], 'supports')
      check(fixedX === (kind !== 'roller-x') && fixedY === (kind !== 'roller-y'), 'supports')
    }
    return support
  })
  const caseIds = new Set<string>()
  check(Array.isArray(raw.loadCases) && raw.loadCases.length > 0, 'loadCases')
  const loadCases: LoadCase[] = raw.loadCases.map(value => {
    const { id, name, forces, presetName, generatedNumber } = object(value, 'loadCases')
    check(typeof id === 'string' && id.trim() && !caseIds.has(id) && typeof name === 'string' && name.trim(), 'loadCases')
    check(Array.isArray(forces), 'forces')
    caseIds.add(id)
    const forceNodes = new Set<number>()
    const load: LoadCase = { id, name, forces: forces.map(value => {
      const { node: entry, fx, fy } = object(value, 'forces')
      const node = nodeAt(entry, 'forces')
      check(typeof fx === 'number' && typeof fy === 'number' && isValidForce(fx, fy) && !forceNodes.has(node), 'forces')
      forceNodes.add(node)
      return { node, fx, fy }
    }) }
    if (presetName !== undefined) load.presetName = choice(presetName, caseNames, 'loadCases')
    if (generatedNumber !== undefined) {
      check(typeof generatedNumber === 'number' && Number.isSafeInteger(generatedNumber) && generatedNumber > 0, 'loadCases')
      load.generatedNumber = generatedNumber
    }
    return load
  })
  const masks = raw.passive === undefined ? {} : object(raw.passive, 'passive')
  const readMask = (value: unknown) => {
    if (value === undefined) return undefined
    check(Array.isArray(value) && value.length === elements && value.every(bit => bit === 0 || bit === 1), 'passive')
    return Uint8Array.from(value)
  }
  const solid = readMask(masks.solid)
  const voidMask = readMask(masks.void)
  check(!solid?.some((bit, i) => bit && voidMask?.[i]), 'passive')
  const passive: PassiveMasks | undefined = solid || voidMask ? { solid, void: voidMask } : undefined
  return { settings: { preset, resolution, material, widthMm, thicknessMm, params }, design: { supports, loadCases, passive } }
}
