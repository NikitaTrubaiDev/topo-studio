import { useLayoutEffect, useMemo, useRef } from 'react'
import { exportDxf, exportStl, exportSvg } from '../solver/export'
import type { ContourLoop } from '../solver/contour'
import type { Grid } from '../solver/types'

export interface ContourSettings {
  threshold: number
  smoothing: number
  thickness: number
}

function download(data: BlobPart, extension: string, mime: string) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }))
  const link = document.createElement('a')
  link.href = url
  link.download = `topostudio-contour.${extension}`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function ExportDialog({ loops, grid, settings, setSettings, onClose }: {
  loops: ContourLoop[]
  grid: Grid
  settings: ContourSettings
  setSettings: (settings: ContourSettings) => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    dialog.current?.showModal()
  }, [])
  const { threshold, smoothing, thickness } = settings
  const { mesh, error } = useMemo(() => {
    if (!loops.length) return {}
    try {
      return { mesh: exportStl(loops, grid, thickness) }
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause) }
    }
  }, [loops, grid, thickness])
  const holes = loops.filter(loop => loop.hole).length
  return (
    <dialog ref={dialog} className="export-dialog panel" onClose={onClose} aria-labelledby="export-title">
      <form method="dialog" className="export-header">
        <h2 id="export-title">Export CAD geometry</h2>
        <button className="tool-button" autoFocus>Close</button>
      </form>
      <label htmlFor="contour-threshold">Density threshold <output>{threshold.toFixed(2)}</output></label>
      <input id="contour-threshold" type="range" min="0.01" max="0.99" step="0.01" value={threshold}
        onChange={event => setSettings({ ...settings, threshold: event.target.valueAsNumber })} />
      <label htmlFor="contour-smoothing">Taubin smoothing passes <output>{smoothing}</output></label>
      <input id="contour-smoothing" type="range" min="0" max="12" step="1" value={smoothing}
        onChange={event => setSettings({ ...settings, smoothing: event.target.valueAsNumber })} />
      <label htmlFor="stl-thickness">Extrusion thickness (mm)</label>
      <input id="stl-thickness" className="field-input" type="number" min="0.01" step="any"
        value={Number.isNaN(thickness) ? '' : thickness}
        onChange={event => setSettings({ ...settings, thickness: event.target.valueAsNumber })} />
      <p className="contour-summary" aria-live="polite">
        {loops.length} loops · {holes} holes · {mesh?.triangleCount ?? '—'} STL triangles
      </p>
      {!loops.length && <p className="hint">No material at this threshold. Lower the threshold or run the optimizer.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="action-row export-actions">
        <button className="tool-button" disabled={!loops.length} onClick={() => download(exportSvg(loops, grid), 'svg', 'image/svg+xml')}>Download SVG</button>
        <button className="tool-button" disabled={!loops.length} onClick={() => download(exportDxf(loops, grid), 'dxf', 'application/dxf')}>Download DXF</button>
        <button className="tool-button" disabled={!mesh} onClick={() => mesh && download(mesh.data, 'stl', 'model/stl')}>Download STL</button>
      </div>
    </dialog>
  )
}
