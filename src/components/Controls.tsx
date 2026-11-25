import type { ReactNode } from 'react'
import { materials, presets, type PresetId } from '../solver/presets'
import type { Grid, SimpParams } from '../solver/types'

export type MaterialId = keyof typeof materials

export const resolutions: Record<string, Grid> = Object.fromEntries(
  [30, 48, 60, 72, 96, 120, 150, 180].map(nelx => [`${nelx} × ${nelx / 3}`, {
    nelx, nely: nelx / 3, cellSizeMm: 120 / nelx,
  }]),
)

export interface Settings {
  preset: PresetId
  resolution: string
  material: MaterialId
  params: SimpParams
}

export function Controls({ settings, setSettings, children }: {
  settings: Settings; setSettings: (value: Settings) => void; children: ReactNode
}) {
  const { preset, resolution, material, params } = settings
  const patch = (value: Partial<Settings>) => setSettings({ ...settings, ...value })
  const parameter = (key: keyof SimpParams, value: number) => patch({ params: { ...params, [key]: value } })

  return (
    <aside className="controls panel" aria-label="Simulation setup">
      <h2>Simulation setup</h2>
      <section>
        <label htmlFor="preset">Load case preset</label>
        <select id="preset" value={preset} onChange={event => patch({ preset: event.target.value as PresetId })}>
          {Object.entries(presets).map(([id, option]) => <option key={id} value={id}>{option.name}</option>)}
        </select>
        <p className="hint">{presets[preset].detail}</p>
        <label htmlFor="resolution">Grid resolution</label>
        <select id="resolution" value={resolution} onChange={event => patch({ resolution: event.target.value })}>
          {Object.keys(resolutions).map(option => <option key={option}>{option}</option>)}
        </select>
      </section>
      <section>
        <h3>Optimization</h3>
        <label htmlFor="volume">Volume fraction <output>{Math.round(params.volFrac * 100)}%</output></label>
        <input id="volume" type="range" min={0.2} max={0.6} step={0.01} value={params.volFrac}
          onChange={event => parameter('volFrac', event.target.valueAsNumber)} />
        <label htmlFor="radius">Filter radius <output>{params.rmin.toFixed(1)} elem</output></label>
        <input id="radius" type="range" min={1} max={4} step={0.1} value={params.rmin}
          onChange={event => parameter('rmin', event.target.valueAsNumber)} />
        <label htmlFor="penal">SIMP penalty <output>{params.penal.toFixed(1)}</output></label>
        <input id="penal" type="range" min={1} max={5} step={0.1} value={params.penal}
          onChange={event => parameter('penal', event.target.valueAsNumber)} />
      </section>
      <section>
        <label htmlFor="material">Material</label>
        <select id="material" value={material} onChange={event => patch({ material: event.target.value as MaterialId })}>
          {Object.entries(materials).map(([id, option]) => <option key={id} value={id}>{option.name}</option>)}
        </select>
        <dl className="material-properties">
          <div><dt>Young’s modulus</dt><dd>{materials[material].E0 / 1000} GPa</dd></div>
          <div><dt>Poisson’s ratio</dt><dd>{materials[material].nu.toFixed(2)}</dd></div>
        </dl>
      </section>
      {children}
    </aside>
  )
}
