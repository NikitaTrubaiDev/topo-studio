import { isValidForce, type ForceVector } from '../solver/design'
import { nodeIndex, type Grid, type NodalForce, type SimpProblem, type Support } from '../solver/types'

export type Point = [number, number]
export type CanvasLayout = ReturnType<typeof canvasLayout>

export function canvasLayout(width: number, height: number, { nelx, nely }: Grid) {
  const cell = Math.min(Math.max(1, width - 68) / nelx, Math.max(1, height - 82) / nely)
  return { cell, left: (width - nelx * cell) / 2, bottom: (height + nely * cell) / 2 + 3 }
}

export function canvasPoint({ left, bottom, cell }: CanvasLayout, x: number, y: number): Point {
  return [left + x * cell, bottom - y * cell]
}

export function gridPoint({ left, bottom, cell }: CanvasLayout, [x, y]: Point): Point {
  const snap = (coordinate: number) => {
    // Remove floating-point drift at cell edges and at the midpoint between nodes.
    const halfCell = Math.round(coordinate * 2) / 2
    return Math.abs(coordinate - halfCell) < 1e-10 ? halfCell : coordinate
  }
  return [snap((x - left) / cell), snap((bottom - y) / cell)]
}

export function nearestNode(grid: Grid, [x, y]: Point): number {
  return nodeIndex(grid, Math.max(0, Math.min(grid.nelx, Math.round(x))), Math.max(0, Math.min(grid.nely, Math.round(y))))
}

export function aimedForce(start: Point, [x, y]: Point, force: ForceVector): ForceVector | undefined {
  const dx = x - start[0], dy = start[1] - y
  const distance = Math.hypot(dx, dy)
  const magnitude = Math.hypot(force.fx, force.fy)
  if (distance < 4 || !magnitude) return
  const vector = { fx: (dx / distance) * magnitude, fy: (dy / distance) * magnitude }
  if (isValidForce(vector.fx, vector.fy)) return vector
  // A unit vector can round slightly above one when the requested force is at the limit.
  return { fx: vector.fx * (1 - Number.EPSILON), fy: vector.fy * (1 - Number.EPSILON) }
}

export function nodePoint(layout: CanvasLayout, grid: Grid, node: number, positions?: Float64Array): Point {
  return positions ? canvasPoint(layout, positions[2 * node], positions[2 * node + 1])
    : canvasPoint(layout, node % (grid.nelx + 1), Math.floor(node / (grid.nelx + 1)))
}

type SupportMarker = { kind: 'support'; point: Point; support: Support }
type LoadMarker = { kind: 'load'; point: Point; anchor: Point; tail: Point; force: NodalForce; caseIndex: number; length: number; drawn: boolean }
export type Marker = SupportMarker | LoadMarker

export function boundaryMarkers(
  { grid, supports, loadCases }: SimpProblem, layout: CanvasLayout, positions: Float64Array | undefined,
  show: { supports: boolean; forces: boolean }, visibleCase: number,
): Marker[] {
  const markers: Marker[] = []
  if (show.supports) {
    for (const support of supports) {
      if (support.fixedX || support.fixedY) markers.push({ kind: 'support', point: nodePoint(layout, grid, support.node), support })
    }
  }
  if (!show.forces) return markers
  const casesAtNode = new Map<number, number[]>()
  if (visibleCase < 0 && loadCases.length > 1) {
    loadCases.forEach(({ forces }, index) => {
      for (const { node, fx, fy } of forces) {
        if (!(fx || fy) || !isValidForce(fx, fy)) continue
        const cases = casesAtNode.get(node)
        if (!cases) casesAtNode.set(node, [index])
        else if (cases.at(-1) !== index) cases.push(index)
      }
    })
  }
  const stride = Math.max(1, Math.ceil(12 / layout.cell))
  loadCases.forEach(({ forces }, caseIndex) => {
    if (visibleCase >= 0 && caseIndex !== visibleCase) return
    const peak = forces.reduce((max, { fx, fy }) => isValidForce(fx, fy) ? Math.max(max, Math.hypot(fx, fy)) : max, 1)
    forces.forEach((force, index) => {
      const { node, fx, fy } = force
      const magnitude = Math.hypot(fx, fy)
      if (!magnitude || !isValidForce(fx, fy)) return
      const anchor = nodePoint(layout, grid, node, positions)
      const cases = casesAtNode.get(node)
      const shift = cases ? (cases.indexOf(caseIndex) - (cases.length - 1) / 2) * 4 : 0
      const point: Point = [anchor[0] + fy * shift / magnitude, anchor[1] + fx * shift / magnitude]
      const length = 12 + 20 * magnitude / peak
      const tail: Point = [point[0] - fx * length / magnitude, point[1] + fy * length / magnitude]
      const drawn = forces.length <= grid.nelx || index % stride === 0 || index === forces.length - 1
      markers.push({ kind: 'load', point, anchor, tail, force, caseIndex, length, drawn })
    })
  })
  return markers
}

function distanceToSegment([x, y]: Point, [ax, ay]: Point, [bx, by]: Point) {
  const dx = bx - ax, dy = by - ay
  const fraction = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(x - ax - fraction * dx, y - ay - fraction * dy)
}

export function hitBoundaryMarker(
  markers: readonly Marker[], point: Point, cell: number, activeCase: number, tool: string,
): Marker | undefined {
  const nodeTolerance = Math.min(4, cell / 2)
  let best: { marker: Marker; score: number } | undefined
  for (const marker of markers) {
    if (marker.kind === 'load' && marker.caseIndex !== activeCase && tool !== 'loads' && tool !== 'inspect') continue
    const anchor = marker.kind === 'load' ? marker.anchor : marker.point
    const nodeDistance = Math.hypot(point[0] - anchor[0], point[1] - anchor[1])
    let glyphDistance = nodeDistance
    if (marker.kind === 'load' && marker.drawn) glyphDistance = distanceToSegment(point, marker.point, marker.tail)
    if (marker.kind === 'support' && marker.support.fixedY) {
      glyphDistance = distanceToSegment(point, anchor, [anchor[0], anchor[1] + 10])
    } else if (marker.kind === 'support') {
      glyphDistance = distanceToSegment(point, anchor, [anchor[0] - 10, anchor[1]])
    }
    if (nodeDistance > nodeTolerance && glyphDistance > (marker.kind === 'load' && marker.drawn ? 7 : 5)) continue
    const preferred = marker.kind === 'support' ? tool === 'supports' : tool === 'loads'
    const score = (nodeDistance <= nodeTolerance ? nodeDistance - 8 : glyphDistance)
      - (preferred ? 2 : 0) - (marker.kind === 'load' && marker.caseIndex === activeCase ? 0.01 : 0)
    if (!best || score < best.score) best = { marker, score }
  }
  return best?.marker
}
