import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import type { ContourLoop } from '../solver/contour'
import { initialPhysicalDensity } from '../solver/density'
import { editSupport, isValidForce, loadCaseIndex, MAX_NODAL_FORCE, paintMask, setForce, supportKind, type MaskTool, type SupportAction } from '../solver/design'
import { nodeIndex, type Grid, type LoadCase, type SimpProblem } from '../solver/types'
import { DEFORMED_DENSITY_THRESHOLD, deformedNodes, hitTestDeformedMesh, quadNodes } from './deformedMesh'
import { caseColor } from './LoadCases'
import type { TimedSnapshot } from '../workers/protocol'

export type ViewMode = 'density' | 'stress' | 'deformed' | 'cad'
type Overlays = { supports: boolean; forces: boolean; passive: boolean; smooth: boolean }
type Point = [number, number]

const modes: Record<ViewMode, string> = { density: 'Density', stress: 'Von Mises', deformed: 'Deformed mesh', cad: 'CAD contour' }
const densityStops = [[20, 32, 41], [32, 95, 104], [131, 233, 219]]
const stressStops = [[24, 40, 64], [18, 123, 168], [60, 195, 156], [244, 213, 104], [248, 107, 96]]

function colorAt(stops: number[][], value: number) {
  const position = (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0) * (stops.length - 1)
  const index = Math.min(stops.length - 2, Math.floor(position))
  return stops[index].map((channel, i) => Math.round(channel + (stops[index + 1][i] - channel) * (position - index)))
}

function drawSupport(ctx: CanvasRenderingContext2D, point: Point, fixedX: boolean, fixedY: boolean, clamp: boolean) {
  ctx.save()
  ctx.translate(...point)
  if (fixedX && !fixedY) ctx.rotate(Math.PI / 2)
  if (clamp) {
    ctx.strokeRect(-3, -3, 6, 6)
  } else {
    ctx.beginPath()
    ctx.moveTo(0, 2)
    ctx.lineTo(-5, 10)
    ctx.lineTo(5, 10)
    ctx.closePath()
    ctx.stroke()
    if (!fixedX || !fixedY) {
      ctx.beginPath()
      ctx.arc(-2.5, 12.5, 1.3, 0, 2 * Math.PI)
      ctx.arc(2.5, 12.5, 1.3, 0, 2 * Math.PI)
      ctx.stroke()
    }
  }
  ctx.restore()
}

function drawForce(ctx: CanvasRenderingContext2D, point: Point, fx: number, fy: number, length: number) {
  const angle = Math.atan2(-fy, fx)
  ctx.save()
  ctx.translate(...point)
  ctx.rotate(angle)
  ctx.beginPath()
  ctx.moveTo(-length, 0)
  ctx.lineTo(0, 0)
  ctx.moveTo(-6, -3.5)
  ctx.lineTo(0, 0)
  ctx.lineTo(-6, 3.5)
  ctx.stroke()
  ctx.restore()
}

function paint(
  canvas: HTMLCanvasElement, raster: HTMLCanvasElement, problem: SimpProblem, density: Float32Array,
  mode: ViewMode, overlays: Overlays, positions: Float64Array | undefined, stressLimit: number,
  stress: Float32Array | undefined, loops: ContourLoop[], activeCase: number, resultCase: number,
) {
  const { clientWidth: width, clientHeight: height } = canvas
  const ratio = window.devicePixelRatio || 1
  const backingWidth = Math.round(width * ratio)
  const backingHeight = Math.round(height * ratio)
  if (canvas.width !== backingWidth) canvas.width = backingWidth
  if (canvas.height !== backingHeight) canvas.height = backingHeight
  const ctx = canvas.getContext('2d')
  if (!ctx || !width || !height) return
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, width, height)

  const { grid, passive, supports, loadCases } = problem
  const { nelx, nely } = grid
  const { cell, left, bottom } = canvasLayout(width, height, grid)
  const top = bottom - nely * cell
  const point = (x: number, y: number): Point => [left + x * cell, bottom - y * cell]
  const nodePoint = (node: number, deform = false) => {
    if (deform && positions) return point(positions[2 * node], positions[2 * node + 1])
    return point(node % (nelx + 1), Math.floor(node / (nelx + 1)))
  }
  const palette = stress || mode === 'stress' ? stressStops : densityStops
  const valueAt = (e: number) => {
    if (stress) return Number.isFinite(stress[e]) ? stress[e] / (stressLimit || 1) : 0
    return mode === 'stress' ? 0 : density[e]
  }

  ctx.fillStyle = '#141d25'
  ctx.fillRect(left, top, nelx * cell, nely * cell)

  if (mode === 'cad') {
    ctx.save()
    ctx.beginPath()
    for (const loop of loops) {
      ctx.moveTo(...point(...loop.points[0]))
      for (let i = 1; i < loop.points.length; i++) ctx.lineTo(...point(...loop.points[i]))
      ctx.closePath()
    }
    const metal = ctx.createLinearGradient(left, top, left + nelx * cell * 0.4, bottom)
    metal.addColorStop(0, '#e2edf1')
    metal.addColorStop(0.48, '#a8bbc6')
    metal.addColorStop(1, '#708991')
    ctx.fillStyle = metal
    ctx.shadowColor = '#040c13d9'
    ctx.shadowBlur = 10
    ctx.shadowOffsetY = 4
    ctx.fill('evenodd')
    ctx.shadowColor = 'transparent'
    ctx.lineWidth = 1.2
    ctx.strokeStyle = '#e6f6fc'
    ctx.stroke()
    ctx.restore()
  } else if (positions) {
    for (let y = 0; y < nely; y++) {
      for (let x = 0; x < nelx; x++) {
        const e = y * nelx + x
        if (density[e] < DEFORMED_DENSITY_THRESHOLD) continue
        const [a, b, c, d] = quadNodes(grid, x, y)
        ctx.fillStyle = `rgb(${colorAt(palette, valueAt(e)).join(' ')})`
        ctx.strokeStyle = '#0e3339'
        ctx.lineWidth = 0.65
        ctx.beginPath()
        ctx.moveTo(...nodePoint(a, true))
        ctx.lineTo(...nodePoint(b, true))
        ctx.lineTo(...nodePoint(c, true))
        ctx.lineTo(...nodePoint(d, true))
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
      }
    }
  } else {
    if (raster.width !== nelx) raster.width = nelx
    if (raster.height !== nely) raster.height = nely
    const rasterCtx = raster.getContext('2d')
    if (rasterCtx) {
      const image = rasterCtx.createImageData(nelx, nely)
      for (let y = 0; y < nely; y++) {
        for (let x = 0; x < nelx; x++) {
          const e = y * nelx + x
          if (passive?.void?.[e]) continue
          const offset = 4 * ((nely - 1 - y) * nelx + x)
          image.data.set(colorAt(palette, valueAt(e)), offset)
          image.data[offset + 3] = 255
        }
      }
      rasterCtx.putImageData(image, 0, 0)
      ctx.imageSmoothingEnabled = overlays.smooth
      ctx.drawImage(raster, left, top, nelx * cell, nely * cell)
    }
  }

  ctx.lineWidth = 1
  ctx.strokeStyle = '#607c89'
  if (positions) ctx.setLineDash([4, 4])
  ctx.strokeRect(left, top, nelx * cell, nely * cell)
  ctx.setLineDash([])

  if (overlays.passive) {
    for (const [mask, color] of [[passive?.solid, '#a4f5d8'], [passive?.void, '#a393d3']] as const) {
      if (!mask) continue
      ctx.strokeStyle = color
      ctx.setLineDash([4, 3])
      ctx.beginPath()
      for (let y = 0; y < nely; y++) {
        for (let x = 0; x < nelx; x++) {
          const e = y * nelx + x
          if (!mask[e]) continue
          if (x === 0 || !mask[e - 1]) {
            ctx.moveTo(...point(x, y))
            ctx.lineTo(...point(x, y + 1))
          }
          if (x === nelx - 1 || !mask[e + 1]) {
            ctx.moveTo(...point(x + 1, y))
            ctx.lineTo(...point(x + 1, y + 1))
          }
          if (y === 0 || !mask[e - nelx]) {
            ctx.moveTo(...point(x, y))
            ctx.lineTo(...point(x + 1, y))
          }
          if (y === nely - 1 || !mask[e + nelx]) {
            ctx.moveTo(...point(x, y + 1))
            ctx.lineTo(...point(x + 1, y + 1))
          }
        }
      }
      ctx.stroke()
      ctx.setLineDash([])
    }
  }

  if (overlays.supports) {
    ctx.strokeStyle = '#7ac4fb'
    ctx.lineWidth = 1.3
    for (const support of supports) {
      const { node, fixedX, fixedY } = support
      if (fixedX || fixedY) drawSupport(ctx, nodePoint(node), fixedX, fixedY, supportKind(support) === 'fixed')
    }
  }
  if (overlays.forces) {
    ctx.lineWidth = 1.4
    const visibleCase = mode === 'stress' || mode === 'deformed' ? resultCase : -1
    const casesAtNode = new Map<number, number[]>()
    if (visibleCase < 0 && loadCases.length > 1) {
      loadCases.forEach(({ forces }, index) => {
        for (const { node, fx, fy } of forces) {
          if (fx === 0 && fy === 0) continue
          const cases = casesAtNode.get(node)
          if (!cases) casesAtNode.set(node, [index])
          else if (cases.at(-1) !== index) cases.push(index)
        }
      })
    }
    loadCases.forEach(({ forces }, index) => {
      if (visibleCase >= 0 && index !== visibleCase) return
      ctx.strokeStyle = caseColor(index)
      ctx.globalAlpha = index === activeCase || resultCase === index ? 1 : 0.73
      const peak = forces.reduce((max, { fx, fy }) => isValidForce(fx, fy) ? Math.max(max, Math.hypot(fx, fy)) : max, 1)
      const stride = Math.max(1, Math.ceil(12 / cell))
      for (let i = 0; i < forces.length; i++) {
        if (forces.length > nelx && i % stride !== 0 && i !== forces.length - 1) continue
        const { node, fx, fy } = forces[i]
        const magnitude = Math.hypot(fx, fy)
        if (!magnitude || !isValidForce(fx, fy)) continue
        const point = nodePoint(node, true)
        const cases = casesAtNode.get(node)
        if (cases && cases.length > 1) {
          const shift = (cases.indexOf(index) - (cases.length - 1) / 2) * 4
          point[0] += fy * shift / magnitude
          point[1] += fx * shift / magnitude
        }
        drawForce(ctx, point, fx, fy, 12 + 20 * magnitude / peak)
      }
    })
    ctx.globalAlpha = 1
  }

  ctx.strokeStyle = '#8aa0ad'
  ctx.fillStyle = '#8aa0ad'
  ctx.beginPath()
  ctx.moveTo(23, height - 37)
  ctx.lineTo(23, height - 20)
  ctx.lineTo(40, height - 20)
  ctx.stroke()
  ctx.font = '10px ui-monospace, monospace'
  ctx.fillText('Y', 20, height - 42)
  ctx.fillText('X', 44, height - 17)
}

const tools = {
  inspect: 'Inspect', void: 'Paint void', solid: 'Paint solid', erase: 'Erase mask',
  bolt: 'Bolt hole / ring', supports: 'Supports', loads: 'Loads',
}
type Tool = keyof typeof tools

function canvasLayout(width: number, height: number, { nelx, nely }: Grid) {
  const cell = Math.min(Math.max(10, width - 72) / nelx, Math.max(10, height - 82) / nely)
  return { cell, left: (width - nelx * cell) / 2, bottom: (height + nely * cell) / 2 + 6 }
}

function gridPoint(event: PointerEvent<HTMLCanvasElement>, grid: Grid): Point {
  const rect = event.currentTarget.getBoundingClientRect()
  const { cell, left, bottom } = canvasLayout(rect.width, rect.height, grid)
  return [(event.clientX - rect.left - left) / cell, (bottom - event.clientY + rect.top) / cell]
}

function ForceEditor({ node, problem, activeCase, onChange }: {
  node: number; problem: SimpProblem; activeCase: LoadCase; onChange: (problem: SimpProblem) => void
}) {
  const [invalid, setInvalid] = useState(false)
  const force = activeCase.forces.find(force => force.node === node)
  const width = problem.grid.nelx + 1
  function change(value: { fx: number; fy: number } | null) {
    const next = setForce(activeCase, node, value)
    if (next !== activeCase) onChange({ ...problem, loadCases: problem.loadCases.map(item => item.id === activeCase.id ? next : item) })
  }
  return (
    <form className="force-editor" onChange={() => setInvalid(false)} onSubmit={event => {
      event.preventDefault()
      const data = new FormData(event.currentTarget)
      const fx = Number(data.get('fx')), fy = Number(data.get('fy'))
      if (isValidForce(fx, fy)) change({ fx, fy })
      else setInvalid(true)
    }}>
      <span>Node ({node % width}, {Math.floor(node / width)}) · {activeCase.name}</span>
      <label>Fx (N) <input type="number" className="field-input" required name="fx" step="any" defaultValue={force?.fx ?? 0} /></label>
      <label>Fy (N) <input type="number" className="field-input" required name="fy" step="any" defaultValue={force?.fy ?? -100} /></label>
      <button className="tool-button" type="submit">Apply force</button>
      <button className="tool-button" type="button" disabled={!force} onClick={() => change(null)}>Remove force</button>
      {invalid && <span role="alert">Enter a finite force with magnitude at most {MAX_NODAL_FORCE.toExponential()} N.</span>}
    </form>
  )
}

export function Viewport({
  problem, frame, initialDensity, loops, mode, setMode, activeCase, onChange,
}: {
  problem: SimpProblem
  frame: TimedSnapshot | undefined
  initialDensity: Float32Array
  loops: ContourLoop[]
  mode: ViewMode
  setMode: (mode: ViewMode) => void
  activeCase: LoadCase
  onChange: (problem: SimpProblem) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rasterRef = useRef<HTMLCanvasElement>(null)
  const stroke = useRef<{ problem: SimpProblem; original: SimpProblem; last: Point; nodes: Set<number> } | null>(null)
  const [draft, setDraft] = useState<SimpProblem>()
  const [drawingTool, setTool] = useState<Tool>('inspect')
  const tool = mode === 'density' ? drawingTool : 'inspect'
  const [radius, setRadius] = useState(2)
  const [supportAction, setSupportAction] = useState<SupportAction>('cycle')
  const [selectedNode, setSelectedNode] = useState<number>()
  const [hover, setHover] = useState<Point>()
  const [resultCaseId, setResultCaseId] = useState<string>()
  const [deformationPercent, setDeformationPercent] = useState(50)
  const [overlays, setOverlays] = useState<Overlays>({ supports: true, forces: true, passive: true, smooth: false })
  const [size, setSize] = useState({ width: 0, height: 0 })
  const { grid, params, passive } = problem
  const { nelx, nely } = grid
  const preview = draft ?? problem
  const previewFrame = draft ? undefined : frame
  const previewPassive = preview.passive
  const initialPreview = useMemo(() => previewPassive === passive
    ? initialDensity : initialPhysicalDensity({ grid, params, passive: previewPassive }),
  [previewPassive, passive, initialDensity, grid, params])
  const previewDensity = previewFrame?.density ?? initialPreview
  const caseIndex = loadCaseIndex(problem.loadCases, resultCaseId)
  const activeCaseIndex = loadCaseIndex(problem.loadCases, activeCase.id)
  const stress = caseIndex < 0 ? previewFrame?.vonMises : previewFrame?.caseVonMises[caseIndex]

  const deformation = useMemo(() => {
    if (mode !== 'deformed' || !previewFrame) return undefined
    let controlling = { index: 0, peak: -1 }
    previewFrame.displacements.forEach((u, index) => {
      if (caseIndex >= 0 && index !== caseIndex) return
      let peak = 0
      for (let i = 0; i < u.length; i += 2) peak = Math.max(peak, u[i] * u[i] + u[i + 1] * u[i + 1])
      if (peak > controlling.peak) controlling = { index, peak }
    })
    return controlling
  }, [mode, previewFrame, caseIndex])
  const displacement = deformation ? previewFrame?.displacements[deformation.index] : undefined
  const peak = Math.sqrt(deformation?.peak ?? 0)
  const autoScale = peak > 1e-12 ? 0.15 * Math.max(nelx, nely) * (grid.cellSizeMm ?? 1) / peak : 1
  const magnification = deformationPercent / 100 * autoScale
  const positions = useMemo(() => displacement ? deformedNodes(grid, displacement, magnification) : undefined,
    [grid, displacement, magnification])
  const stressMode = mode === 'stress' || mode === 'deformed'
  const { stressLimit, maxStress } = useMemo(() => {
    if (!stressMode || !stress || !previewFrame) return { stressLimit: 0, maxStress: 0 }
    const sample: number[] = []
    let maxStress = 0
    for (let e = 0; e < stress.length; e++) {
      if (!Number.isFinite(stress[e])) continue
      if (previewFrame.density[e] > 0.2) sample.push(stress[e])
      maxStress = Math.max(maxStress, stress[e])
    }
    sample.sort((a, b) => a - b)
    return { stressLimit: sample[Math.ceil(0.95 * sample.length) - 1] || maxStress, maxStress }
  }, [stress, previewFrame, stressMode])

  useLayoutEffect(() => {
    const canvas = canvasRef.current!
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize({ width, height })
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    if (canvasRef.current && size.width && size.height) {
      rasterRef.current ??= document.createElement('canvas')
      paint(canvasRef.current, rasterRef.current, preview, previewDensity, mode, overlays, positions,
        stressLimit, stressMode ? stress : undefined, loops, activeCaseIndex, caseIndex)
    }
  }, [preview, previewDensity, mode, overlays, positions, stressLimit, size, stressMode, stress, loops, activeCaseIndex, caseIndex])

  const toggle = (key: keyof Overlays) => setOverlays(current => ({ ...current, [key]: !current[key] }))
  const isBrush = tool === 'void' || tool === 'solid' || tool === 'erase' || tool === 'bolt'
  const inside = (point: Point, padding = 0) => point[0] >= -padding && point[0] <= nelx + padding
    && point[1] >= -padding && point[1] <= nely + padding
  const nearest = ([x, y]: Point) => nodeIndex(grid, Math.max(0, Math.min(nelx, Math.round(x))), Math.max(0, Math.min(nely, Math.round(y))))

  function dab(point: Point) {
    const current = stroke.current
    if (!current) return
    if (current.original !== problem) {
      stroke.current = null
      setDraft(undefined)
      return
    }
    let updated = current.problem
    const [lastX, lastY] = current.last
    const dx = point[0] - lastX, dy = point[1] - lastY
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (tool === 'supports' ? 0.45 : Math.max(0.5, radius / 2))))
    for (let i = 1; i <= steps; i++) {
      const x = lastX + dx * i / steps, y = lastY + dy * i / steps
      if (tool === 'supports' && inside([x, y], 0.6)) {
        const node = nearest([x, y])
        if (current.nodes.has(node)) continue
        current.nodes.add(node)
        const supports = editSupport(updated.supports, node, supportAction)
        if (supports !== updated.supports) updated = { ...updated, supports }
      } else if (isBrush && inside([x, y], radius)) {
        const passive = paintMask(grid, updated.passive, tool as MaskTool, x, y, radius)
        if (passive !== updated.passive) updated = { ...updated, passive }
      }
    }
    current.last = point
    current.problem = updated
    if (updated !== problem) setDraft(updated)
  }

  function pointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0 || !event.isPrimary || tool === 'inspect' || mode !== 'density') return
    const point = gridPoint(event, grid)
    if (!inside(point, isBrush ? 0 : 0.6)) return
    if (tool === 'loads') {
      setSelectedNode(nearest(point))
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    stroke.current = { problem, original: problem, last: point, nodes: new Set() }
    dab(point)
  }

  function finish(commit: boolean) {
    const current = stroke.current
    stroke.current = null
    setDraft(undefined)
    if (commit && current?.original === problem && current.problem !== problem) onChange(current.problem)
  }

  let inspectIndex = null
  if (tool === 'inspect' && hover) {
    if (positions) inspectIndex = hitTestDeformedMesh(grid, positions, previewDensity, hover)
    else if (inside(hover)) {
      inspectIndex = Math.min(nelx - 1, Math.floor(hover[0])) + nelx * Math.min(nely - 1, Math.floor(hover[1]))
    }
  }
  const hoverDensity = inspectIndex === null ? undefined : previewDensity[inspectIndex]
  const hoverStress = inspectIndex === null ? undefined : stress?.[inspectIndex]
  const hoverLayout = canvasLayout(size.width, size.height, grid)
  const selectedForce = activeCase.forces.find(force => force.node === selectedNode)

  return (
    <section className="viewport panel" aria-label="Simulation viewport">
      <div className="viewport-tools">
        <div className="segmented" role="group" aria-label="Result view">
          {Object.entries(modes).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={mode === id} onClick={() => {
              setMode(id as ViewMode)
              if (id !== 'density') setTool('inspect')
            }}>{label}</button>
          ))}
        </div>
        <div className="overlay-controls" role="group" aria-label="Viewport overlays">
          {Object.entries({ supports: 'Supports', forces: 'Forces', passive: 'Masks', smooth: 'Interpolate raster' }).map(([key, label]) => (
            <label key={key}>
              <input type="checkbox" checked={overlays[key as keyof Overlays]} disabled={key === 'smooth' && (mode === 'deformed' || mode === 'cad')}
                onChange={() => toggle(key as keyof Overlays)} />{label}
            </label>
          ))}
        </div>
      </div>
      <div className="viewport-tools designer-tools">
        <div className="segmented" role="group" aria-label="Drawing tools">
          {Object.entries(tools).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={tool === id} onClick={() => {
              setTool(id as Tool)
              if (id !== 'inspect') setMode('density')
            }}>{label}</button>
          ))}
        </div>
        {isBrush && <label className="compact-input">Radius
          <input aria-label="Brush radius" type="range" min="1" max="16" step="0.5" value={radius}
            onChange={event => setRadius(event.target.valueAsNumber)} />
          <output>{radius} elem</output>
        </label>}
        {tool === 'supports' && <label className="compact-input">Support
          <select className="field-input" value={supportAction} onChange={event => setSupportAction(event.target.value as SupportAction)}>
            <option value="cycle">Cycle support</option><option value="fixed">Fixed XY</option><option value="pin">Pin XY</option>
            <option value="roller-x">Roller-X · fixes Y</option><option value="roller-y">Roller-Y · fixes X</option>
            <option value="remove">Remove support</option>
          </select>
        </label>}
        {stressMode && <label className="compact-input">Result case
          <select className="field-input" value={caseIndex < 0 ? '' : resultCaseId} onChange={event => setResultCaseId(event.target.value || undefined)}>
            <option value="">Combined stress envelope</option>
            {problem.loadCases.map(load => <option key={load.id} value={load.id}>{load.name}</option>)}
          </select>
        </label>}
        {tool === 'loads' && selectedNode === undefined && <p className="hint">Select a grid node to edit its force.</p>}
        {tool === 'loads' && selectedNode !== undefined && (
          <ForceEditor key={`${activeCase.id}:${selectedNode}:${selectedForce?.fx}:${selectedForce?.fy}`} node={selectedNode}
            problem={problem} activeCase={activeCase} onChange={onChange} />
        )}
      </div>
      <div className="canvas-field">
        <canvas ref={canvasRef} aria-label={`${modes[mode]} field, ${nelx} by ${nely} elements`} role="img" data-tool={tool}
          onPointerDown={pointerDown} onPointerMove={event => {
            const point = gridPoint(event, grid)
            setHover(point)
            if (event.isPrimary && stroke.current && tool !== 'bolt') dab(point)
          }} onPointerLeave={() => setHover(undefined)}
          onPointerUp={event => {
            if (!event.isPrimary) return
            if (stroke.current && tool !== 'bolt') dab(gridPoint(event, grid))
            finish(true)
          }}
          onPointerCancel={() => finish(false)} onLostPointerCapture={() => finish(false)} />
        <div className="field-caption">{nelx} × {nely} ELEMENTS · {Number((nelx * (grid.cellSizeMm ?? 1)).toPrecision(5))} × {Number((nely * (grid.cellSizeMm ?? 1)).toPrecision(5))} mm</div>
        {isBrush && hover && inside(hover) && <div className="brush-cursor" style={{
          left: hoverLayout.left + hover[0] * hoverLayout.cell, top: hoverLayout.bottom - hover[1] * hoverLayout.cell,
          width: radius * hoverLayout.cell * 2, height: radius * hoverLayout.cell * 2,
        }} />}
        {tool === 'loads' && selectedNode !== undefined && <div className="node-cursor" style={{
          left: hoverLayout.left + (selectedNode % (nelx + 1)) * hoverLayout.cell,
          top: hoverLayout.bottom - Math.floor(selectedNode / (nelx + 1)) * hoverLayout.cell,
          borderColor: caseColor(activeCaseIndex),
        }} />}
        {tool === 'inspect' && hoverDensity !== undefined && (
          <div className="inspect-readout">ρ {hoverDensity.toFixed(3)} · σ<sub>VM</sub> {hoverStress !== undefined && Number.isFinite(hoverStress) ? `${hoverStress.toPrecision(4)} MPa` : '—'}</div>
        )}
        {mode === 'deformed' && (
          <div className="magnification">
            <label htmlFor="deformation-percent">Deformation</label>
            <input id="deformation-percent" type="range" min="0" max="200" value={deformationPercent}
              aria-valuetext={`${deformationPercent}% of automatic scale`} onChange={event => setDeformationPercent(event.target.valueAsNumber)} />
            <output>{displacement ? `${Number(magnification.toPrecision(3))}×` : '—'}</output>
            {caseIndex < 0 && deformation && <span>Shape · {problem.loadCases[deformation.index].name}</span>}
          </div>
        )}
        {mode !== 'cad' && <div className="scale" aria-label={stressMode ? 'Stress color scale in MPa' : 'Density color scale from 0 to 1'}>
          <span>{stressMode ? 'MPa' : 'Density'}</span>
          <div className={`scale-ramp ${stressMode ? 'stress-ramp' : 'density-ramp'}`} />
          <div className="scale-labels"><span>0</span><span>{stressMode ? (frame ? stressLimit.toPrecision(3) : '—') : '1'}</span></div>
          {stressMode && frame && <div className="scale-peak">Max {maxStress.toPrecision(4)} MPa</div>}
        </div>}
        {mode === 'cad' && !loops.length && <div className="inspect-readout">No material at the current threshold.</div>}
      </div>
    </section>
  )
}
