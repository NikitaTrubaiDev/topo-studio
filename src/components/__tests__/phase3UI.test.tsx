import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { formatSignificant, LanguageContext, translateDiagnostic } from '../../i18n'
import { languages } from '../../i18n/dictionaries'
import { makePreset } from '../../solver/presets'
import { Simp2D } from '../../solver/simp2d'
import { Engineering } from '../Engineering'
import { ExportDialog, type ContourSettings } from '../ExportDialog'

it('renders the peak yield failure in red and displays the P95 factor separately', () => {
  const problem = makePreset('cantilever', { nelx: 12, nely: 4 })
  const frame = { ...new Simp2D(problem).step(), maxVonMises: 390.5, p95VonMises: 170 }
  const html = renderToStaticMarkup(<Engineering problem={problem} density={frame.density} frame={frame} />)
  expect(html).toContain('<dd class="fail">0.9091</dd>')
  expect(html).toContain('P95 safety factor · 2.088')
})

it('uses the latest part thickness in the dialog unless an explicit override is present', () => {
  const settings: ContourSettings = { threshold: 0.5, smoothing: 3 }
  const render = (thicknessMm: number, thicknessOverride?: number) => renderToStaticMarkup(
    <ExportDialog loops={[]} grid={{ nelx: 12, nely: 4, thicknessMm }}
      settings={{ ...settings, thicknessOverride }} setSettings={() => {}} onClose={() => {}} />,
  )
  expect(render(10)).toMatch(/id="stl-thickness"[^>]*value="10"/)
  expect(render(17)).toMatch(/id="stl-thickness"[^>]*value="17"/)
  const overridden = render(17, 4)
  expect(overridden).toMatch(/id="stl-thickness"[^>]*value="4"/)
  expect(overridden).toContain('Override')
  expect(overridden).toContain('Reset to part thickness')
  expect(render(17)).not.toContain('Override')
})

it.each(languages)('formats telemetry and interpolates diagnostic parameters in %s', language => {
  expect(formatSignificant(language, 390.5)).toBe(language === 'en' ? '390.5' : '390,5')
  const issue = { code: 'volumeError' as const, params: { target: 0.125, min: 0.243, max: 0.872 } }
  const warning = translateDiagnostic(language, issue)
  const format = new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 4 })
  for (const value of Object.values(issue.params)) expect(warning).toContain(format.format(value))
  expect(warning).not.toMatch(/[{}]/)

  const detached = translateDiagnostic(language, { code: 'detachedNodes', params: { nodes: [
    { x: 12, y: 2, kind: 'load' }, { x: 0, y: 3, kind: 'support' },
  ] } })
  expect(detached).toContain('(12, 2)')
  expect(detached).toContain('(0, 3)')

  const dialog = renderToStaticMarkup(<LanguageContext.Provider value={language}>
    <ExportDialog loops={[]} grid={{ nelx: 12, nely: 4 }}
      settings={{ threshold: 0.5, smoothing: 3 }} setSettings={() => {}} onClose={() => {}} />
  </LanguageContext.Provider>)
  expect(dialog).toContain(language === 'en' ? '0.50</output>' : '0,50</output>')
})
