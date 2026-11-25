import type { Grid, LoadCase, NodalForce, PassiveMasks, SimpProblem, Support } from './types'

export type MaskTool = 'void' | 'solid' | 'erase' | 'bolt'
export type SupportKind = NonNullable<Support['kind']>
export type SupportAction = SupportKind | 'cycle' | 'remove'
const supportKinds: SupportKind[] = ['fixed', 'pin', 'roller-x', 'roller-y']

export const MAX_NODAL_FORCE = 1e12

export function isValidForce(fx: number, fy: number): boolean {
  return Math.hypot(fx, fy) <= MAX_NODAL_FORCE
}

export function supportKind(support: Support): SupportKind {
  return support.kind ?? (support.fixedX ? support.fixedY ? 'fixed' : 'roller-y' : 'roller-x')
}

export function supportError(grid: Grid, supports: readonly Support[]): string | undefined {
  const width = grid.nelx + 1
  const rows = new Set<number>()
  const columns = new Set<number>()
  for (const { node, fixedX, fixedY } of supports) {
    if (!Number.isInteger(node) || node < 0 || node >= width * (grid.nely + 1)) return 'Support node is outside the grid.'
    if (fixedX) rows.add(Math.floor(node / width))
    if (fixedY) columns.add(node % width)
  }
  // A rigid motion has Ux = Tx − rotation*y and Uy = Ty + rotation*x.
  if (!rows.size || !columns.size || rows.size + columns.size < 3) {
    return 'Supports must restrain both rigid translations and rotation.'
  }
}

export function editSupport(supports: readonly Support[], node: number, action: SupportAction): readonly Support[] {
  const existing = supports.find(item => item.node === node)
  const kind = action === 'cycle' ? supportKinds[existing ? supportKinds.indexOf(supportKind(existing)) + 1 : 0] : action
  if (!kind || kind === 'remove') return existing ? supports.filter(item => item.node !== node) : supports
  if (existing && supportKind(existing) === kind) return supports
  return [...supports.filter(item => item.node !== node), { node, kind, fixedX: kind !== 'roller-x', fixedY: kind !== 'roller-y' }]
}

export function paintMask(
  { nelx, nely }: Grid, passive: PassiveMasks | undefined, tool: MaskTool, x: number, y: number, radius: number,
): PassiveMasks | undefined {
  const solid = passive?.solid?.slice() ?? new Uint8Array(nelx * nely)
  const voidMask = passive?.void?.slice() ?? new Uint8Array(nelx * nely)
  const extent = tool === 'bolt' ? radius + Math.max(1, radius * 0.35) : radius
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

export function setForce(loadCase: LoadCase, node: number, value: Omit<NodalForce, 'node'> | null): LoadCase {
  const forces = loadCase.forces.filter(force => force.node !== node)
  if (value && (value.fx || value.fy)) return { ...loadCase, forces: [...forces, { node, ...value }] }
  return forces.length === loadCase.forces.length ? loadCase : { ...loadCase, forces }
}

let nextCaseId = 1

export function addLoadCase(loadCases: readonly LoadCase[]): LoadCase[] {
  let number = loadCases.length + 1
  while (loadCases.some(load => load.name === `Case ${number}`)) number++
  return [...loadCases, { id: `case-${nextCaseId++}`, name: `Case ${number}`, forces: [] }]
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
