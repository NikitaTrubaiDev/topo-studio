// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LanguageContext } from '../../i18n'
import { dictionaries, languages } from '../../i18n/dictionaries'
import { marchingCubes } from '../../solver3d/marchingCubes'
import { makePreset3D, presetGrid3D } from '../../solver3d/presets3d'
import { Simp3D } from '../../solver3d/simp3d'
import { Tooltip } from '../Tooltip'
import { surfaceMesh } from '../Viewport3D'
import Workbench3D from '../Workbench3D'

let mount: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mount = document.body.appendChild(document.createElement('div'))
  root = createRoot(mount)
})

afterEach(() => {
  act(() => root.unmount())
  mount.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function choose(select: HTMLSelectElement, value: string) {
  act(() => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

it.each(languages)('disables incompatible L-bracket symmetry, resets YZ, and explains the restriction in %s', language => {
  act(() => root.render(<LanguageContext.Provider value={language}>
    <Workbench3D active={false} header={transport => transport} />
  </LanguageContext.Provider>))
  const preset = mount.querySelector<HTMLSelectElement>('#preset-3d')!
  const symmetry = mount.querySelector<HTMLSelectElement>('#symmetry-3d')!
  choose(symmetry, 'yz')
  expect(symmetry.value).toBe('yz')
  choose(preset, 'lBracket3d')
  expect(symmetry.value).toBe('none')
  expect(Array.from(symmetry.options).filter(option => option.disabled).map(option => option.value)).toEqual(['y', 'yz'])
  const note = document.getElementById(symmetry.getAttribute('aria-describedby')!)
  expect(note?.textContent).toBe(dictionaries[language].lBracketSymmetry3d)
  expect(mount.querySelector('.engineering small:last-child')?.textContent).toBe(dictionaries[language].simpSafetyEstimate3d)
  choose(preset, 'cantilever3d')
  expect(Array.from(symmetry.options).every(option => !option.disabled)).toBe(true)
  choose(symmetry, 'z')
  choose(preset, 'lBracket3d')
  expect(symmetry.value).toBe('z')
})

it('shows the physical filter radius and blocks Play and Step for stretched cells', () => {
  act(() => root.render(<Workbench3D active={false} header={transport => transport} />))
  const width = mount.querySelector<HTMLInputElement>('#widthMm-3d')!
  const play = mount.querySelector<HTMLButtonElement>('button.play')!
  const step = Array.from(mount.querySelectorAll<HTMLButtonElement>('.transport button')).find(button => button.textContent?.includes('Step'))!
  expect(mount.querySelector('#rmin-3d')?.getAttribute('aria-valuetext')).toBe('9 mm')
  expect(document.getElementById(width.getAttribute('aria-describedby')!)?.textContent).toContain('4:1')
  expect(play.disabled || step.disabled).toBe(false)
  act(() => {
    width.value = '10000'
    width.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
  expect(mount.querySelector('[role="alert"]')?.textContent).toContain('more than 4 times')
  expect(width.getAttribute('aria-invalid')).toBe('true')
  expect(play.disabled && step.disabled).toBe(true)
})

it('portals tooltips into the nearest open dialog or the body', () => {
  vi.useFakeTimers()
  act(() => root.render(<>
    <dialog open><dialog open id="inner">
      <Tooltip message="hint3dThreshold" info="Threshold"><label>Threshold</label></Tooltip>
    </dialog></dialog>
    <dialog><Tooltip message="hint3dDimensions" info="Dimensions"><span>Dimensions</span></Tooltip></dialog>
  </>))
  function show(id: string) {
    const button = mount.querySelector<HTMLButtonElement>(`button[aria-label="Help for ${id}"]`)!
    act(() => { button.click(); vi.runAllTimers() })
    return document.getElementById(button.getAttribute('aria-describedby')!)!
  }
  expect(show('Threshold').parentElement).toBe(document.getElementById('inner'))
  expect(show('Dimensions').parentElement).toBe(document.body)
})

it('renders finite clamped colors with non-finite stress, density, or scale inputs', () => {
  const grid = presetGrid3D([4, 2, 2])
  const problem = makePreset3D('cantilever3d', grid)
  const frame = { ...new Simp3D(problem).step(), iterMs: 1 }
  const surface = marchingCubes(new Float64Array(frame.density.length).fill(1), grid)
  frame.vonMises.fill(3)
  frame.vonMises[0] = NaN
  frame.vonMises[1] = Infinity
  frame.vonMises[2] = -10
  frame.density[3] = Infinity
  frame.p95VonMises = NaN
  frame.maxVonMises = Infinity
  const mesh = surfaceMesh(problem, surface, [], frame)
  const colors = mesh.geometry.getAttribute('color').array
  expect(colors.length).toBe(surface.vertices.length)
  expect(colors.every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true)
  expect(new Set(colors).size).toBeGreaterThan(3)
  mesh.geometry.dispose()
  mesh.material.dispose()
})

it.each(languages)('shows both element modes, the high resolution, and mesh controls in %s', language => {
  act(() => root.render(<LanguageContext.Provider value={language}>
    <Workbench3D active={false} header={transport => transport} />
  </LanguageContext.Provider>))
  const dictionary = dictionaries[language]
  const type = mount.querySelector<HTMLSelectElement>('#element-type-3d')!
  const resolution = mount.querySelector<HTMLSelectElement>('#resolution-3d')!
  expect(Array.from(type.options, option => option.textContent)).toEqual([dictionary.hex8Elements3d, dictionary.tet4Elements3d])
  expect(Array.from(resolution.options, option => option.textContent)).toContain('64 × 32 × 20')
  choose(resolution, '3')
  const count = () => mount.querySelector('.telemetry dd')?.textContent?.replace(/[^\d]/g, '')
  expect(count()).toBe('40960')
  choose(type, 'tet4')
  expect(count()).toBe('204800')
  const labels = Array.from(mount.querySelectorAll('label, button'), element => element.textContent)
  expect(labels).toContain(dictionary.meshWireframe3d)
  expect(labels).toContain(dictionary.femMesh3d)
  for (const key of ['hint3dElementType', 'hint3dMeshWireframe', 'hint3dMeshThreshold', 'hint3dFemMesh', 'hint3dElementCount'] as const) {
    expect(dictionary[key].length).toBeGreaterThan(20)
    if (language !== 'en') expect(dictionary[key]).not.toBe(dictionaries.en[key])
  }
})
