import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SimpProblem } from '../solver/types'
import type { TimedSnapshot } from '../workers/protocol'

type ViewMode = 'density' | 'stress' | 'deformed'
type Overlays = { supports: boolean; forces: boolean; passive: boolean; smooth: boolean }
type Point = [number, number]

const modes: Record<ViewMode, string> = { density: 'Density', stress: 'Von Mises', deformed: 'Deformed mesh' }
const densityStops = [[20, 32, 41], [32, 95, 104], [131, 233, 219]]
const stressStops = [[24, 40, 64], [18, 123, 168], [60, 195, 156], [244, 213, 104], [248, 107, 96]]

function colorAt(stops: number[][], value: number) {
  const position = Math.max(0, Math.min(1, value)) * (stops.length - 1)
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
  canvas: HTMLCanvasElement, raster: HTMLCanvasElement, problem: SimpProblem, frame: TimedSnapshot | undefined,
  mode: ViewMode, overlays: Overlays, magnification: number, stressLimit: number,
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

  const { grid: { nelx, nely }, params, passive, supports, loadCases } = problem
  const cell = Math.max(1, Math.min((width - 72) / nelx, (height - 82) / nely))
  const left = (width - nelx * cell) / 2
  const bottom = (height + nely * cell) / 2 + 6
  const top = bottom - nely * cell
  const displacement = mode === 'deformed' ? frame?.displacements[0] : undefined
  const point = (x: number, y: number, deform = false): Point => {
    const dof = 2 * (y * (nelx + 1) + x)
    const dx = deform && displacement ? displacement[dof] * magnification : 0
    const dy = deform && displacement ? displacement[dof + 1] * magnification : 0
    return [left + (x + dx) * cell, bottom - (y + dy) * cell]
  }
  const density = (e: number) => frame?.density[e] ?? (passive?.void?.[e] ? 0 : passive?.solid?.[e] ? 1 : params.volFrac)
  const palette = mode === 'stress' ? stressStops : densityStops
  const valueAt = (e: number) => mode === 'stress'
    ? (frame?.vonMises[e] ?? 0) / (stressLimit || 1)
    : density(e)

  ctx.fillStyle = '#141d25'
  ctx.fillRect(left, top, nelx * cell, nely * cell)

  if (displacement) {
    for (let y = 0; y < nely; y++) {
      for (let x = 0; x < nelx; x++) {
        const e = y * nelx + x
        if (density(e) < 0.05) continue
        ctx.fillStyle = `rgb(${colorAt(palette, valueAt(e)).join(' ')})`
        ctx.strokeStyle = '#0e3339'
        ctx.lineWidth = 0.65
        ctx.beginPath()
        ctx.moveTo(...point(x, y, true))
        ctx.lineTo(...point(x + 1, y, true))
        ctx.lineTo(...point(x + 1, y + 1, true))
        ctx.lineTo(...point(x, y + 1, true))
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
  if (displacement) ctx.setLineDash([4, 4])
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

  const nodePoint = (node: number, deform = false) => point(node % (nelx + 1), Math.floor(node / (nelx + 1)), deform)
  if (overlays.supports) {
    ctx.strokeStyle = '#7ac4fb'
    ctx.lineWidth = 1.3
    const full = supports.filter(support => support.fixedX && support.fixedY).length
    for (const { node, fixedX, fixedY } of supports) {
      if (fixedX || fixedY) drawSupport(ctx, nodePoint(node), fixedX, fixedY, full > 1 && fixedX && fixedY)
    }
  }
  if (overlays.forces) {
    ctx.strokeStyle = '#fbb980'
    ctx.lineWidth = 1.4
    const forces = displacement ? loadCases[0].forces : loadCases.flatMap(load => load.forces)
    const peak = Math.max(1, ...forces.map(force => Math.hypot(force.fx, force.fy)))
    const stride = Math.max(1, Math.ceil(12 / cell))
    for (let i = 0; i < forces.length; i++) {
      if (forces.length > nelx && i % stride !== 0 && i !== forces.length - 1) continue
      const { node, fx, fy } = forces[i]
      const magnitude = Math.hypot(fx, fy)
      if (magnitude) drawForce(ctx, nodePoint(node, true), fx, fy, 12 + 20 * magnitude / peak)
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

export function Viewport({ problem, frame }: { problem: SimpProblem; frame: TimedSnapshot | undefined }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rasterRef = useRef<HTMLCanvasElement>(null)
  const [mode, setMode] = useState<ViewMode>('density')
  const [deformationPercent, setDeformationPercent] = useState(50)
  const [overlays, setOverlays] = useState<Overlays>({ supports: true, forces: true, passive: true, smooth: false })
  const [size, setSize] = useState({ width: 0, height: 0 })
  const { nelx, nely } = problem.grid
  const displacement = mode === 'deformed' ? frame?.displacements[0] : undefined
  const stressFrame = mode === 'stress' ? frame : undefined
  const autoScale = useMemo(() => {
    let maxU = 0
    if (displacement) {
      for (const component of displacement) maxU = Math.max(maxU, Math.abs(component))
    }
    return maxU > 1e-12 ? 0.15 * Math.max(nelx, nely) / maxU : 1
  }, [displacement, nelx, nely])
  const magnification = deformationPercent / 100 * autoScale
  const stressLimit = useMemo(() => {
    if (!stressFrame) return 0
    const { density, vonMises, maxVonMises } = stressFrame
    const sample: number[] = []
    for (let e = 0; e < vonMises.length; e++) {
      if (density[e] > 0.2) sample.push(vonMises[e])
    }
    sample.sort((a, b) => a - b)
    return sample[Math.ceil(0.95 * sample.length) - 1] || maxVonMises
  }, [stressFrame])

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
      paint(canvasRef.current, rasterRef.current, problem, frame, mode, overlays, magnification, stressLimit)
    }
  }, [problem, frame, mode, overlays, magnification, stressLimit, size])

  const toggle = (key: keyof Overlays) => setOverlays(current => ({ ...current, [key]: !current[key] }))
  return (
    <section className="viewport panel" aria-label="Simulation viewport">
      <div className="viewport-tools">
        <div className="segmented" role="group" aria-label="Result view">
          {Object.entries(modes).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={mode === id} onClick={() => setMode(id as ViewMode)}>{label}</button>
          ))}
        </div>
        <div className="overlay-controls" role="group" aria-label="Viewport overlays">
          {Object.entries({ supports: 'Supports', forces: 'Forces', passive: 'Masks', smooth: 'Smooth' }).map(([key, label]) => (
            <label key={key}>
              <input type="checkbox" checked={overlays[key as keyof Overlays]} disabled={key === 'smooth' && mode === 'deformed'}
                onChange={() => toggle(key as keyof Overlays)} />{label}
            </label>
          ))}
        </div>
      </div>
      <div className="canvas-field">
        <canvas ref={canvasRef} aria-label={`${modes[mode]} field, ${problem.grid.nelx} by ${problem.grid.nely} elements`} role="img" />
        <div className="field-caption">{problem.grid.nelx} × {problem.grid.nely} ELEMENTS</div>
        {mode === 'deformed' && (
          <div className="magnification">
            <label htmlFor="deformation-percent">Deformation</label>
            <input id="deformation-percent" type="range" min="0" max="200" value={deformationPercent}
              aria-valuetext={`${deformationPercent}% of automatic scale`}
              onChange={event => setDeformationPercent(event.target.valueAsNumber)} />
            <output htmlFor="deformation-percent">
              {deformationPercent}% · {displacement ? `${Number(magnification.toPrecision(3))}×` : '—'}
            </output>
          </div>
        )}
        <div className="scale" aria-label={mode === 'stress' ? 'Stress color scale in MPa' : 'Density color scale from 0 to 1'}>
          <span>{mode === 'stress' ? 'MPa' : 'Density'}</span>
          <div className={`scale-ramp ${mode === 'stress' ? 'stress-ramp' : 'density-ramp'}`} />
          <div className="scale-labels">
            <span>0</span><span>{mode === 'stress' ? (frame ? stressLimit.toPrecision(3) : '—') : '1'}</span>
          </div>
          {mode === 'stress' && frame && <div className="scale-peak">Max {frame.maxVonMises.toPrecision(4)} MPa</div>}
        </div>
      </div>
    </section>
  )
}
