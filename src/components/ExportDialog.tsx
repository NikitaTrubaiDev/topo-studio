import { useTranslation } from '../i18n'
import { useLayoutEffect, useMemo, useRef } from 'react'
import { getDiagnostic } from '../solver/diagnostics'
import { DEFAULT_STL_THICKNESS_MM, exportDxf, exportStl, exportSvg } from '../solver/export'
import type { ContourLoop } from '../solver/contour'
import type { Grid } from '../solver/types'

export interface ContourSettings {
  threshold: number
  smoothing: number
  thicknessOverride?: number
}

export function download(data: BlobPart, extension: string, mime: string, name = 'topostudio-contour') {
  const url = URL.createObjectURL(new Blob([data], { type: mime }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${name}.${extension}`
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
  const { t, diagnostic, fixed, number } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    dialog.current?.showModal()
  }, [])
  const { threshold, smoothing, thicknessOverride } = settings
  const thickness = thicknessOverride ?? grid.thicknessMm ?? DEFAULT_STL_THICKNESS_MM
  const { mesh, error } = useMemo(() => {
    if (!loops.length) return {}
    try {
      return { mesh: exportStl(loops, grid, thickness) }
    } catch (cause) {
      return { error: getDiagnostic(cause) }
    }
  }, [loops, grid, thickness])
  const holes = loops.filter(loop => loop.hole).length
  return (
    <dialog ref={dialog} className="export-dialog panel" onClose={onClose} aria-labelledby="export-title">
      <form method="dialog" className="export-header">
        <h2 id="export-title">{t('exportTitle')}</h2>
        <button className="tool-button" autoFocus>{t('close')}</button>
      </form>
      <label htmlFor="contour-threshold">{t('threshold')} <output>{fixed(threshold, 2)}</output></label>
      <input id="contour-threshold" type="range" min="0.01" max="0.99" step="0.01" value={threshold}
        onChange={event => setSettings({ ...settings, threshold: event.target.valueAsNumber })} />
      <label htmlFor="contour-smoothing">{t('smoothing')} <output>{number(smoothing)}</output></label>
      <input id="contour-smoothing" type="range" min="0" max="12" step="1" value={smoothing}
        onChange={event => setSettings({ ...settings, smoothing: event.target.valueAsNumber })} />
      <label htmlFor="stl-thickness">{t('extrusion')}
        {thicknessOverride !== undefined && <small className="hint">{t('thicknessOverride')}</small>}
      </label>
      <input id="stl-thickness" className="field-input" type="number" min="0.01" step="any"
        value={Number.isNaN(thickness) ? '' : thickness}
        onChange={event => setSettings({ ...settings, thicknessOverride: event.target.valueAsNumber })} />
      {thicknessOverride !== undefined && <button type="button" className="tool-button" onClick={() =>
        setSettings({ ...settings, thicknessOverride: undefined })}>{t('resetThickness')}</button>}
      <p className="contour-summary" aria-live="polite">
        {t('contourSummary').replace('{loops}', number(loops.length)).replace('{holes}', number(holes))
          .replace('{triangles}', number(mesh?.triangleCount))}
      </p>
      {!loops.length && <p className="hint">{t('noMaterial')} {t('helpThreshold')}</p>}
      {error && <p className="error" role="alert">{diagnostic(error)}</p>}
      <div className="action-row export-actions">
        <button className="tool-button" disabled={!loops.length} onClick={() => download(exportSvg(loops, grid), 'svg', 'image/svg+xml')}>{t('download').replace('{format}', 'SVG')}</button>
        <button className="tool-button" disabled={!loops.length} onClick={() => download(exportDxf(loops, grid), 'dxf', 'application/dxf')}>{t('download').replace('{format}', 'DXF')}</button>
        <button className="tool-button" disabled={!mesh} onClick={() => mesh && download(mesh.data, 'stl', 'model/stl')}>{t('download').replace('{format}', 'STL')}</button>
      </div>
    </dialog>
  )
}
