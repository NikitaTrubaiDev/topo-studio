import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import type { Diagnostic } from '../solver/diagnostics'
import type { ContourLoop } from '../solver/contour'
import { useTranslation } from '../i18n'
import { buildLabels } from './Controls'
import { OverhangFilter } from '../solver/overhang'
import { brushExtent, editSupport, isValidForce, loadCaseIndex, MAX_NODAL_FORCE, paintMask, setForce, supportKind, type MaskTool, type SupportAction } from '../solver/design'
import { nodeIndex, type Grid, type LoadCase, type PassiveMasks, type SimpProblem } from '../solver/types'
import { DEFORMED_DENSITY_THRESHOLD, deformedNodes, hitTestDeformedMesh, quadNodes } from './deformedMesh'
import { caseColor } from './LoadCases'
import type { TimedSnapshot } from '../workers/protocol'

export type ViewMode = 'density' | 'stress' | 'deformed' | 'cad'
type Overlays = { supports: boolean; forces: boolean; passive: boolean; smooth: boolean }
type Point = [number, number]
type Raster = { canvas: HTMLCanvasElement; image?: ImageData }

const modes = ['density', 'stress', 'deformed', 'cad'] as const
const densityStops = [[20, 32, 41], [32, 95, 104], [131, 233, 219]]
const stressStops = [[24, 40, 64], [18, 123, 168], [60, 195, 156], [244, 213, 104], [248, 107, 96]]

function colorAt(stops: number[][], value: number) {
  const position = (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0) * (stops.length - 1)
  const index = Math.min(stops.length - 2, Math.floor(position))
  return stops[index].map((channel, i) => Math.round(channel + (stops[index + 1][i] - channel) * (position - index)))
}

function makePalette(stops: number[][]) {
  const rgb = new Uint8ClampedArray(256 * 3)
  const css = Array.from({ length: 256 }, (_, i) => {
    const color = colorAt(stops, i / 255)
    rgb.set(color, 3 * i)
    return `rgb(${color.join(' ')})`
  })
  return { rgb, css }
}

const densityPalette = makePalette(densityStops)
const stressPalette = makePalette(stressStops)

function colorIndex(value: number) {
  return Math.round(255 * Math.max(0, Math.min(1, value)))
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
  canvas: HTMLCanvasElement, raster: Raster, problem: SimpProblem, density: Float32Array,
  mode: ViewMode, overlays: Overlays, positions: Float64Array | undefined, stressLimit: number,
  stress: Float32Array | undefined, loops: ContourLoop[], activeCase: number, resultCase: number,
  attachmentIssue?: Extract<Diagnostic, { code: 'detachedNodes' }>, blockedCells?: readonly number[],
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
  const palette = stress || mode === 'stress' ? stressPalette : densityPalette
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
        ctx.fillStyle = palette.css[colorIndex(valueAt(e))]
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
    const { canvas: offscreen } = raster
    const rasterCtx = offscreen.getContext('2d')
    if (rasterCtx) {
      if (offscreen.width !== nelx || offscreen.height !== nely) {
        offscreen.width = nelx
        offscreen.height = nely
        raster.image = undefined
      }
      const image = raster.image ??= rasterCtx.createImageData(nelx, nely)
      const { data } = image
      const colors = palette.rgb
      for (let y = 0; y < nely; y++) {
        for (let x = 0; x < nelx; x++) {
          const e = y * nelx + x
          const offset = 4 * ((nely - 1 - y) * nelx + x)
          if (passive?.void?.[e]) {
            data[offset + 3] = 0
            continue
          }
          const color = 3 * colorIndex(valueAt(e))
          data[offset] = colors[color]
          data[offset + 1] = colors[color + 1]
          data[offset + 2] = colors[color + 2]
          data[offset + 3] = 255
        }
      }
      rasterCtx.putImageData(image, 0, 0)
      ctx.imageSmoothingEnabled = overlays.smooth
      ctx.drawImage(offscreen, left, top, nelx * cell, nely * cell)
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

  if (blockedCells?.length) {
    ctx.fillStyle = '#ff5151ad'
    ctx.strokeStyle = '#ff9b8f'
    ctx.lineWidth = 1.2
    for (const e of blockedCells) {
      const [x, y] = point(e % nelx, Math.floor(e / nelx) + 1)
      ctx.fillRect(x, y, cell, cell)
      ctx.strokeRect(x, y, cell, cell)
    }
  }
  if (attachmentIssue) {
    for (const { x, y } of attachmentIssue.params.nodes) {
      ctx.beginPath()
      ctx.arc(...point(x, y), 8, 0, 2 * Math.PI)
      ctx.strokeStyle = '#141d25'
      ctx.lineWidth = 5
      ctx.stroke()
      ctx.strokeStyle = '#ff7769'
      ctx.lineWidth = 2.5
      ctx.stroke()
    }
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

const tools = ['inspect', 'void', 'solid', 'erase', 'bolt', 'supports', 'loads'] as const
type Tool = typeof tools[number]
const overlaysList = ['supports', 'forces', 'passive', 'smooth'] as const
const arrows = { '+Y': '↑', '-Y': '↓', '+X': '→', '-X': '←' }

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
  const { t, caseName, significant } = useTranslation()
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
      <span>{t('node')} ({node % width}, {Math.floor(node / width)}) · {caseName(activeCase)}</span>
      <label>Fx ({t('N')}) <input type="number" className="field-input" required name="fx" step="any" defaultValue={force?.fx ?? 0} /></label>
      <label>Fy ({t('N')}) <input type="number" className="field-input" required name="fy" step="any" defaultValue={force?.fy ?? -100} /></label>
      <button className="tool-button" type="submit">{t('applyForce')}</button>
      <button className="tool-button" type="button" disabled={!force} onClick={() => change(null)}>{t('removeForce')}</button>
      {invalid && <span role="alert">{t('forceLimit').replace('{limit}', significant(MAX_NODAL_FORCE))}</span>}
    </form>
  )
}

export function Viewport({
  problem, frame, initialDensity, loops, threshold, effectivePassive, attachmentIssue, blockedCells,
  mode, setMode, activeCase, onChange,
}: {
  problem: SimpProblem
  frame: TimedSnapshot | undefined
  initialDensity: Float32Array
  loops: ContourLoop[]
  threshold: number
  effectivePassive?: PassiveMasks
  attachmentIssue?: Extract<Diagnostic, { code: 'detachedNodes' }>
  blockedCells?: readonly number[]
  mode: ViewMode
  setMode: (mode: ViewMode) => void
  activeCase: LoadCase
  onChange: (problem: SimpProblem) => void
}) {
  const { t, caseName, number, significant, fixed } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rasterRef = useRef<Raster | null>(null)
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
  const displayed = useMemo(() => ({ ...problem, passive: effectivePassive }), [problem, effectivePassive])
  const preview = draft ?? displayed
  const previewFrame = draft ? undefined : frame
  const previewPassive = draft?.passive ?? passive
  const initialPreview = useMemo(() => {
    if (previewPassive === passive) return initialDensity
    const density = initialDensity.slice()
    for (let e = 0; e < density.length; e++) {
      if (previewPassive?.void?.[e]) density[e] = 0
      else if (previewPassive?.solid?.[e]) density[e] = 1
      else if (passive?.void?.[e] || passive?.solid?.[e]) density[e] = params.volFrac
    }
    return density
  }, [previewPassive, passive, initialDensity, params.volFrac])
  const previewDensity = previewFrame?.density ?? initialPreview
  const build = params.overhang
  const overhang = useMemo(() => build ? new OverhangFilter(grid, build) : undefined, [grid, build])
  const unsupported = useMemo(() => overhang?.unsupported(previewDensity, threshold) ?? 0, [overhang, previewDensity, threshold])
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
    if (caseIndex < 0) {
      const { maxVonMises: maxStress, p95VonMises } = previewFrame
      return { stressLimit: p95VonMises || maxStress, maxStress }
    }
    const sample: number[] = []
    let maxStress = 0
    for (let e = 0; e < stress.length; e++) {
      if (!Number.isFinite(stress[e])) continue
      if (previewFrame.density[e] > 0.2) sample.push(stress[e])
      maxStress = Math.max(maxStress, stress[e])
    }
    sample.sort((a, b) => a - b)
    return { stressLimit: sample[Math.ceil(0.95 * sample.length) - 1] || maxStress, maxStress }
  }, [stress, previewFrame, stressMode, caseIndex])

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
      rasterRef.current ??= { canvas: document.createElement('canvas') }
      paint(canvasRef.current, rasterRef.current, preview, previewDensity, mode, overlays, positions,
        stressLimit, stressMode ? stress : undefined, loops, activeCaseIndex, caseIndex,
        draft ? undefined : attachmentIssue, draft ? undefined : blockedCells)
    }
  }, [preview, previewDensity, mode, overlays, positions, stressLimit, size, stressMode, stress, loops, activeCaseIndex, caseIndex, draft, attachmentIssue, blockedCells])

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
  const hoverNode = hover && inside(hover, 0.6) && (tool === 'supports' || tool === 'loads') ? nearest(hover) : undefined
  const selectedForce = activeCase.forces.find(force => force.node === selectedNode)

  return (
    <section className="viewport panel" aria-label={t('viewport')}>
      <div className="viewport-tools">
        <div className="segmented" role="group" aria-label={t('resultView')}>
          {modes.map(id => (
            <button key={id} type="button" aria-pressed={mode === id} onClick={() => {
              setMode(id)
              if (id !== 'density') setTool('inspect')
            }}>{t(id)}</button>
          ))}
        </div>
        <div className="overlay-controls" role="group" aria-label={t('overlays')}>
          {overlaysList.map(key => (
            <label key={key}>
              <input type="checkbox" checked={overlays[key]} disabled={key === 'smooth' && (mode === 'deformed' || mode === 'cad')}
                onChange={() => toggle(key)} />{t(key)}
            </label>
          ))}
        </div>
      </div>
      <div className="viewport-tools designer-tools">
        <div className="segmented" role="group" aria-label={t('drawTools')}>
          {tools.map(id => (
            <button key={id} type="button" aria-pressed={tool === id} title={t(`${id}Hint`)} onClick={() => {
              setTool(id)
              if (id !== 'inspect') setMode('density')
            }}>{t(id)}</button>
          ))}
        </div>
        {isBrush && <label className="compact-input">{t('brushRadius')}
          <input aria-label={t('brushRadius')} type="range" min="1" max="16" step="0.5" value={radius}
            onChange={event => setRadius(event.target.valueAsNumber)} />
          <output>{radius} {t('elementShort')}</output>
        </label>}
        {tool === 'supports' && <label className="compact-input">{t('support')}
          <select className="field-input" value={supportAction} onChange={event => setSupportAction(event.target.value as SupportAction)}>
            <option value="cycle">{t('cycle')}</option><option value="fixed">{t('fixed')}</option><option value="pin">{t('pin')}</option>
            <option value="roller-x">{t('rollerX')}</option><option value="roller-y">{t('rollerY')}</option>
            <option value="remove">{t('removeSupport')}</option>
          </select>
        </label>}
        {stressMode && <label className="compact-input">{t('resultCase')}
          <select className="field-input" value={caseIndex < 0 ? '' : resultCaseId} onChange={event => setResultCaseId(event.target.value || undefined)}>
            <option value="">{t('envelope')}</option>
            {problem.loadCases.map(load => <option key={load.id} value={load.id}>{caseName(load)}</option>)}
          </select>
        </label>}
        {tool === 'loads' && selectedNode !== undefined && (
          <ForceEditor key={`${activeCase.id}:${selectedNode}:${selectedForce?.fx}:${selectedForce?.fy}`} node={selectedNode}
            problem={problem} activeCase={activeCase} onChange={onChange} />
        )}
      </div>
      <p className="context-hint" title={t(`${tool}Hint`)}>{t(`${tool}Hint`)}</p>
      <div className="canvas-field">
        {build && <div className="build-indicator" data-direction={build} title={t(buildLabels[build])}>
          <span aria-hidden="true">{arrows[build]}</span> {build} · {t(buildLabels[build])}
        </div>}
        <canvas ref={canvasRef} aria-label={`${t(mode)} · ${nelx} ${t('by')} ${nely} ${t('elements')}`} role="img" data-tool={tool}
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
        <div className="field-caption">{number(nelx)} × {number(nely)} {t('elements')} · {significant(nelx * (grid.cellSizeMm ?? 1), 5)} × {significant(nely * (grid.cellSizeMm ?? 1), 5)} {t('mm')}</div>
        {isBrush && hover && inside(hover) && (tool === 'bolt' ? [brushExtent('bolt', radius), radius] : [radius])
          .map((ring, index) => <div key={index} className={`brush-cursor brush-${tool}`} style={{
            left: hoverLayout.left + hover[0] * hoverLayout.cell, top: hoverLayout.bottom - hover[1] * hoverLayout.cell,
            width: ring * hoverLayout.cell * 2, height: ring * hoverLayout.cell * 2,
          }} />)}
        {hoverNode !== undefined && <div className="node-cursor node-preview" style={{
          left: hoverLayout.left + (hoverNode % (nelx + 1)) * hoverLayout.cell,
          top: hoverLayout.bottom - Math.floor(hoverNode / (nelx + 1)) * hoverLayout.cell,
        }} />}
        {tool === 'loads' && selectedNode !== undefined && <div className="node-cursor" style={{
          left: hoverLayout.left + (selectedNode % (nelx + 1)) * hoverLayout.cell,
          top: hoverLayout.bottom - Math.floor(selectedNode / (nelx + 1)) * hoverLayout.cell,
          borderColor: caseColor(activeCaseIndex),
        }} />}
        {tool === 'inspect' && hoverDensity !== undefined && (
          <div className="inspect-readout">ρ {fixed(hoverDensity, 3)} · σ<sub>VM</sub> {hoverStress !== undefined && Number.isFinite(hoverStress) ? `${significant(hoverStress)} ${t('MPa')}` : '—'}</div>
        )}
        {mode === 'deformed' && (
          <div className="magnification">
            <label htmlFor="deformation-percent">{t('deformation')}</label>
            <input id="deformation-percent" type="range" min="0" max="200" value={deformationPercent}
              aria-valuetext={`${deformationPercent}% ${t('autoScale')}`} onChange={event => setDeformationPercent(event.target.valueAsNumber)} />
            <output>{displacement ? `${significant(magnification, 3)}×` : '—'}</output>
            {caseIndex < 0 && deformation && <span>{t('shape')} · {caseName(problem.loadCases[deformation.index])}</span>}
          </div>
        )}
        {mode !== 'cad' && <div className="scale" aria-label={stressMode ? t('stressScale') : t('densityScale')}>
          <span>{stressMode ? t('MPa') : t('density')}</span>
          <div className={`scale-ramp ${stressMode ? 'stress-ramp' : 'density-ramp'}`} />
          <div className="scale-labels"><span>0</span><span>{stressMode ? (frame ? significant(stressLimit, 3) : '—') : '1'}</span></div>
          {stressMode && frame && <div className="scale-peak">{t('max')} {significant(maxStress)} {t('MPa')}</div>}
        </div>}
        {mode === 'cad' && !loops.length && <div className="inspect-readout">{t('noMaterial')}</div>}
      </div>
      {build && unsupported > 0 && (frame || mode === 'cad') &&
        <p className="am-status">{t('amUnsupported')} · {unsupported}</p>}
    </section>
  )
}
