import type { Diagnostic } from './diagnostics'
import type { Grid, LoadCase, NodalForce, PassiveMasks, SimpProblem, Support } from './types'

export type MaskTool = 'void' | 'solid' | 'erase' | 'bolt'
export type SupportKind = NonNullable<Support['kind']>
export type SupportAction = SupportKind | 'cycle' | 'remove'
const supportKinds: SupportKind[] = ['fixed', 'pin', 'roller-x', 'roller-y']

export type Design = Pick<SimpProblem, 'supports' | 'loadCases' | 'passive'>
export interface DesignHistory {
  past: Design[]
  present?: Design
  future: Design[]
}

export function recordDesign(history: DesignHistory, preset: Design, design: Design): DesignHistory {
  const { supports, loadCases, passive } = design
  const { supports: previousSupports, loadCases: previousCases, passive: previousPassive } = history.present ?? preset
  return {
    past: [...history.past.slice(-79), { supports: previousSupports, loadCases: previousCases, passive: previousPassive }],
    present: { supports, loadCases, passive },
    future: [],
  }
}

export function undoDesign(history: DesignHistory, preset: Design): DesignHistory {
  const previous = history.past.at(-1)
  if (!previous) return history
  return { past: history.past.slice(0, -1), present: previous, future: [history.present ?? preset, ...history.future] }
}

export function redoDesign(history: DesignHistory, preset: Design): DesignHistory {
  const [next, ...future] = history.future
  if (!next) return history
  return { past: [...history.past, history.present ?? preset], present: next, future }
}

export const MAX_NODAL_FORCE = 1e12
export type ForceVector = Omit<NodalForce, 'node'>
export type ForceDirection = 'down' | 'up' | 'right' | 'left'
const forceDirections: Record<ForceDirection, ForceVector> = {
  down: { fx: 0, fy: -1 }, up: { fx: 0, fy: 1 }, right: { fx: 1, fy: 0 }, left: { fx: -1, fy: 0 },
}

export function directionVector(direction: ForceDirection, magnitude: number): ForceVector {
  const { fx, fy } = forceDirections[direction]
  return { fx: fx ? fx * magnitude : 0, fy: fy ? fy * magnitude : 0 }
}

export function isValidForce(fx: number, fy: number): boolean {
  return Math.hypot(fx, fy) <= MAX_NODAL_FORCE
}

export function supportKind(support: Support): SupportKind {
  return support.kind ?? (support.fixedX ? support.fixedY ? 'fixed' : 'roller-y' : 'roller-x')
}

export function supportError(grid: Grid, supports: readonly Support[]): Diagnostic | undefined {
  const width = grid.nelx + 1
  const rows = new Set<number>()
  const columns = new Set<number>()
  for (const { node, fixedX, fixedY } of supports) {
    if (!Number.isInteger(node) || node < 0 || node >= width * (grid.nely + 1)) return { code: 'supportOutsideGrid' }
    if (fixedX) rows.add(Math.floor(node / width))
    if (fixedY) columns.add(node % width)
  }
  // A rigid motion has Ux = Tx − rotation*y and Uy = Ty + rotation*x.
  if (!rows.size || !columns.size || rows.size + columns.size < 3) {
    return { code: 'unsupportedSupports' }
  }
}

export function attachmentError(
  { grid, supports, loadCases }: SimpProblem, voidMask?: Uint8Array,
): Extract<Diagnostic, { code: 'detachedNodes' }> | undefined {
  if (!voidMask) return
  const { nelx, nely } = grid
  const width = nelx + 1
  const detached = (node: number) => {
    if (!Number.isInteger(node) || node < 0 || node >= width * (nely + 1)) return false
    const x = node % width
    const y = Math.floor(node / width)
    for (let row = Math.max(0, y - 1); row <= Math.min(y, nely - 1); row++) {
      for (let col = Math.max(0, x - 1); col <= Math.min(x, nelx - 1); col++) {
        if (!voidMask[row * nelx + col]) return false
      }
    }
    return true
  }

  const loads = new Set<number>()
  for (const { forces } of loadCases) {
    const net = new Map<number, [number, number]>()
    for (const { node, fx, fy } of forces) {
      const [x, y] = net.get(node) ?? [0, 0]
      net.set(node, [x + fx, y + fy])
    }
    for (const [node, [fx, fy]] of net) if (fx || fy) loads.add(node)
  }
  const nodes: Extract<Diagnostic, { code: 'detachedNodes' }>['params']['nodes'] = []
  for (const [kind, candidates] of [
    ['load', loads], ['support', new Set(supports.map(support => support.node))],
  ] as const) {
    for (const node of candidates) {
      if (detached(node)) nodes.push({ x: node % width, y: Math.floor(node / width), kind })
    }
  }
  if (nodes.length) return { code: 'detachedNodes', params: { nodes } }
}

export function editSupport(supports: readonly Support[], node: number, action: SupportAction): readonly Support[] {
  const existing = supports.find(item => item.node === node)
  const kind = action === 'cycle' ? supportKinds[existing ? supportKinds.indexOf(supportKind(existing)) + 1 : 0] : action
  if (!kind || kind === 'remove') return existing ? supports.filter(item => item.node !== node) : supports
  if (existing && supportKind(existing) === kind) return supports
  return [...supports.filter(item => item.node !== node), { node, kind, fixedX: kind !== 'roller-x', fixedY: kind !== 'roller-y' }]
}

export function brushExtent(tool: MaskTool, radius: number) {
  return tool === 'bolt' ? radius + Math.max(1, radius * 0.35) : radius
}

export function paintMask(
  { nelx, nely }: Grid, passive: PassiveMasks | undefined, tool: MaskTool, x: number, y: number, radius: number,
): PassiveMasks | undefined {
  const solid = passive?.solid?.slice() ?? new Uint8Array(nelx * nely)
  const voidMask = passive?.void?.slice() ?? new Uint8Array(nelx * nely)
  const extent = brushExtent(tool, radius)
  let changed = false
  for (let row = Math.max(0, Math.floor(y - extent)); row < Math.min(nely, Math.ceil(y + extent)); row++) {
    for (let col = Math.max(0, Math.floor(x - extent)); col < Math.min(nelx, Math.ceil(x + extent)); col++) {
      const distance = Math.hypot(col + 0.5 - x, row + 0.5 - y)
      if (distance > extent) continue
      const isSolid = Number(tool === 'solid' || (tool === 'bolt' && distance > radius))
      const isVoid = Number(tool === 'void' || (tool === 'bolt' && distance <= radius))
      const e = row * nelx + col
      changed ||= solid[e] !== isSolid || voidMask[e] !== isVoid
      solid[e] = isSolid
      voidMask[e] = isVoid
    }
  }
  return changed ? { solid, void: voidMask } : passive
}

export function setForce(loadCase: LoadCase, node: number, value: ForceVector | null): LoadCase {
  const index = loadCase.forces.findIndex(force => force.node === node)
  const forces = loadCase.forces.filter(force => force.node !== node)
  if (!value || (!value.fx && !value.fy)) return index < 0 ? loadCase : { ...loadCase, forces }
  const existing = loadCase.forces[index]
  if (existing?.fx === value.fx && existing.fy === value.fy && forces.length + 1 === loadCase.forces.length) return loadCase
  forces.splice(index < 0 ? forces.length : index, 0, { node, ...value })
  return { ...loadCase, forces }
}

export function clearLoads(loadCase: LoadCase): LoadCase {
  return loadCase.forces.length ? { ...loadCase, forces: [] } : loadCase
}

export function replaceLoadCase(design: Design, replacement: LoadCase): Design {
  return { ...design, loadCases: design.loadCases.map(load => load.id === replacement.id ? replacement : load) }
}

let nextCaseId = 1

export function addLoadCase(loadCases: readonly LoadCase[]): LoadCase[] {
  while (loadCases.some(load => load.id === ('case-' + nextCaseId))) nextCaseId++
  let number = loadCases.length + 1
  while (loadCases.some(load => load.name === `Case ${number}`)) number++
  return [...loadCases, { id: `case-${nextCaseId++}`, name: `Case ${number}`, generatedNumber: number, forces: [] }]
}

export function loadCaseIndex(loadCases: readonly LoadCase[], id: string | undefined): number {
  return loadCases.findIndex(load => load.id === id)
}

export function hasFreeLoad({ supports, loadCases }: SimpProblem): boolean {
  const fixedX = new Set(supports.filter(s => s.fixedX).map(s => s.node))
  const fixedY = new Set(supports.filter(s => s.fixedY).map(s => s.node))
  return loadCases.some(load => load.forces.some(({ node, fx, fy }) =>
    (fx !== 0 && !fixedX.has(node)) || (fy !== 0 && !fixedY.has(node))))
}
