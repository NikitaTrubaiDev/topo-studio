import type { ReactNode } from 'react'
import { useTranslation } from '../i18n'
import { Tooltip } from './Tooltip'
import { materials, presets, type PresetId } from '../solver/presets'
import { partBounds, resolutions, type MaterialId, type Settings } from '../solver/project'
import type { BuildDirection, SimpParams, Symmetry } from '../solver/types'

export const buildLabels = { '+Y': 'up', '-Y': 'down', '+X': 'right', '-X': 'left' } as const
const mirrorLabels = { none: 'none', x: 'mirrorX', y: 'mirrorY', xy: 'mirrorXY' } as const

export function Controls({ settings, setSettings, children, hidden }: {
  settings: Settings; setSettings: (value: Settings) => void; children: ReactNode; hidden: boolean
}) {
  const { t, language } = useTranslation()
  const { preset, resolution, material, params, widthMm } = settings
  const grid = resolutions[resolution]
  const format = new Intl.NumberFormat(language, { maximumFractionDigits: 2 })
  const patch = (value: Partial<Settings>) => setSettings({ ...settings, ...value })
  const parameter = (value: Partial<SimpParams>) => patch({ params: { ...params, ...value } })
  const dimension = (key: 'widthMm' | 'thicknessMm', label: string) => (
    <>
      <Tooltip message={key === 'widthMm' ? 'tipWidth' : 'tipThickness'} info={label}>
        <label htmlFor={key}>{label} ({t('mm')})</label>
      </Tooltip>
      <input id={key} key={settings[key]} className="field-input" type="number" step="any"
        min={partBounds.min} max={partBounds.max} defaultValue={settings[key]}
        onBlur={event => {
          const { valueAsNumber: value } = event.currentTarget
          if (value >= partBounds.min && value <= partBounds.max && value !== settings[key]) patch({ [key]: value })
          else event.currentTarget.value = String(settings[key])
        }}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
    </>
  )

  return (
    <aside id="simulation-setup" className="controls panel" aria-label={t('setup')} hidden={hidden}>
      <h2>{t('setup')}</h2>
      <section>
        <label htmlFor="preset">{t('preset')}</label>
        <select id="preset" value={preset} onChange={event => patch({ preset: event.target.value as PresetId })}>
          {(Object.keys(presets) as PresetId[]).map(id => <option key={id} value={id}>{t(id)}</option>)}
        </select>
        <p className="hint">{t(`${preset}Detail`)}</p>
        <Tooltip message="tipResolution" info={t('resolution')}><label htmlFor="resolution">{t('resolution')}</label></Tooltip>
        <select id="resolution" value={resolution} onChange={event => patch({ resolution: event.target.value })}>
          {Object.keys(resolutions).map(option => <option key={option}>{option}</option>)}
        </select>
      </section>
      <section>
        <h3>{t('geometry')}</h3>
        {dimension('widthMm', t('width'))}
        <p className="hint">{t('height')} · {format.format(widthMm * grid.nely / grid.nelx)} {t('mm')}</p>
        {dimension('thicknessMm', t('thickness'))}
      </section>
      <section>
        <h3>{t('optimization')}</h3>
        <div className="parameter-label">
          <Tooltip message="tipVolumeFraction" info={t('volumeFraction')}><label htmlFor="volume">{t('volumeFraction')}</label></Tooltip>
          <output>{Math.round(params.volFrac * 100)}%</output>
        </div>
        <input id="volume" type="range" min={0} max={1} step={0.01} value={params.volFrac}
          onChange={event => parameter({ volFrac: event.target.valueAsNumber })} />
        <div className="parameter-label">
          <Tooltip message="tipRadius" info={t('radius')}><label htmlFor="radius">{t('radius')}</label></Tooltip>
          <output>{format.format(params.rmin)} {t('elementShort')} · {format.format(params.rmin * widthMm / grid.nelx)} {t('mm')}</output>
        </div>
        <input id="radius" type="range" min={1} max={4} step={0.1} value={params.rmin}
          onChange={event => parameter({ rmin: event.target.valueAsNumber })} />
        <div className="parameter-label">
          <Tooltip message="tipSimpPenalty" info={t('simpPenalty')}><label htmlFor="penal">{t('simpPenalty')}</label></Tooltip>
          <output>{format.format(params.penal)}</output>
        </div>
        <input id="penal" type="range" min={1} max={5} step={0.1} value={params.penal}
          onChange={event => parameter({ penal: event.target.valueAsNumber })} />
      </section>
      <details className="settings-details">
        <summary>{t('manufacturing')}</summary>
        <div className="settings-fields">
          <Tooltip message="tipHeaviside" info={t('heaviside')}>
            <label className="check-field"><input type="checkbox" checked={!!params.heaviside}
              onChange={event => parameter({ heaviside: event.target.checked })} />{t('heaviside')}</label>
          </Tooltip>
          <Tooltip message="tipSymmetry" info={t('symmetry')}><label htmlFor="symmetry">{t('symmetry')}</label></Tooltip>
          <select id="symmetry" value={params.symmetry ?? 'none'} onChange={event => parameter({ symmetry: event.target.value as Symmetry })}>
            {(Object.keys(mirrorLabels) as Symmetry[]).map(value => <option key={value} value={value}>{t(mirrorLabels[value])}</option>)}
          </select>
          <Tooltip message="tipOverhang" info={t('overhang')}>
            <label className="check-field"><input type="checkbox" checked={!!params.overhang}
              onChange={event => parameter({ overhang: event.target.checked ? '+Y' : undefined })} />{t('overhang')}</label>
          </Tooltip>
          {params.overhang && <>
            <Tooltip message="tipDirection" info={t('direction')}><label htmlFor="build-direction">{t('direction')}</label></Tooltip>
            <select id="build-direction" value={params.overhang} onChange={event => parameter({ overhang: event.target.value as BuildDirection })}>
              {(Object.keys(buildLabels) as BuildDirection[]).map(value => <option key={value} value={value}>{t(buildLabels[value])} ({value})</option>)}
            </select>
          </>}
        </div>
      </details>
      <section>
        <Tooltip message="tipMaterial" info={t('material')}><label htmlFor="material">{t('material')}</label></Tooltip>
        <select id="material" value={material} onChange={event => patch({ material: event.target.value as MaterialId })}>
          {(Object.keys(materials) as MaterialId[]).map(id => <option key={id} value={id}>{t(id)}</option>)}
        </select>
        <dl className="material-properties">
          <div><dt>{t('young')}</dt><dd>{format.format(materials[material].E0 / 1000)} {t('GPa')}</dd></div>
          <div><dt>{t('poisson')}</dt><dd>{format.format(materials[material].nu)}</dd></div>
        </dl>
      </section>
      {children}
    </aside>
  )
}
