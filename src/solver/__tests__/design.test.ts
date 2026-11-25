import { expect, it } from 'vitest'
import { addLoadCase, editSupport, hasFreeLoad, loadCaseIndex, paintMask, setForce, supportError } from '../design'
import { makePreset } from '../presets'
import { Simp2D } from '../simp2d'
import { nodeIndex } from '../types'

for (const nelx of [120, 180]) {
  for (const preset of ['mbb', 'cantilever', 'bridge', 'bracket'] as const) {
    it(`solves ${preset} at ${nelx} × ${nelx / 3} with the same total load`, () => {
      const grid = { nelx, nely: nelx / 3, cellSizeMm: 120 / nelx }
      const problem = makePreset(preset, grid)
      expect(supportError(grid, problem.supports)).toBeUndefined()
      expect(hasFreeLoad(problem)).toBe(true)
      expect(problem.loadCases[0].forces.reduce((sum, load) => sum + load.fy, 0)).toBeCloseTo(-100, 10)
      const result = new Simp2D(problem).step()
      expect(Number.isFinite(result.compliance) && result.compliance > 0).toBe(true)
      expect(result.volFrac).toBeCloseTo(problem.params.volFrac, 6)
      expect(result.displacements[0].every(Number.isFinite)).toBe(true)
    }, 15_000)
  }
}

it('cycles support kinds and reports a rigid-body mode after the roller is removed', () => {
  const grid = { nelx: 20, nely: 10 }
  const { supports } = makePreset('bridge', grid)
  const pinAlone = editSupport(supports, supports[1].node, 'remove')
  expect(supportError(grid, pinAlone)).toMatch(/rotation/)
  const node = nodeIndex(grid, 20, 0)
  const fixed = editSupport(pinAlone, node, 'cycle')
  expect(fixed.at(-1)).toMatchObject({ kind: 'fixed', fixedX: true, fixedY: true })
  const pin = editSupport(fixed, node, 'cycle')
  expect(pin.at(-1)).toMatchObject({ kind: 'pin', fixedX: true, fixedY: true })
  const rollerX = editSupport(pin, node, 'cycle')
  expect(rollerX.at(-1)).toMatchObject({ kind: 'roller-x', fixedX: false, fixedY: true })
  expect(supportError(grid, rollerX)).toBeUndefined()
  const rollerY = editSupport(rollerX, node, 'cycle')
  expect(rollerY.at(-1)).toMatchObject({ kind: 'roller-y', fixedX: true, fixedY: false })
  expect(editSupport(rollerY, node, 'cycle')).toEqual(pinAlone)
})

it('paints a bolt ring, replaces a mask with the opposite type, and erases it', () => {
  const grid = { nelx: 20, nely: 10 }
  const bore = 5 * grid.nelx + 5
  const ring = 5 * grid.nelx + 7
  const stamp = paintMask(grid, undefined, 'bolt', 5.5, 5.5, 1.5)!
  expect(stamp.void![bore]).toBe(1)
  expect(stamp.solid![ring]).toBe(1)
  const solid = paintMask(grid, stamp, 'solid', 5.5, 5.5, 1)!
  expect(solid.solid![bore]).toBe(1)
  expect(solid.void![bore]).toBe(0)
  const erased = paintMask(grid, solid, 'erase', 5.5, 5.5, 1)!
  expect(erased.solid![bore]).toBe(0)
  expect(erased.void![bore]).toBe(0)
  expect(stamp.void![bore]).toBe(1)
})

it('edits a second load case, preserves the first, and solves the exact stress envelope', () => {
  const grid = { nelx: 30, nely: 10 }
  const problem = makePreset('cantilever', grid)
  const [first, second] = addLoadCase(problem.loadCases)
  const node = nodeIndex(grid, 30, 7)
  const edited = setForce(second, node, { fx: 170, fy: 25 })
  expect(edited.name).toBe('Case 2')
  expect(setForce(edited, node, null).forces).toHaveLength(0)
  expect(setForce(edited, node, { fx: 5, fy: 10 }).forces).toEqual([{ node, fx: 5, fy: 10 }])
  expect(first).toBe(problem.loadCases[0])
  const solver = new Simp2D({ ...problem, loadCases: [first, edited] })
  for (let i = 0; i < 4; i++) {
    const { density, vonMises, caseVonMises, displacements } = solver.step()
    expect(density.every(rho => Number.isFinite(rho) && rho >= 0 && rho <= 1)).toBe(true)
    expect(displacements).toHaveLength(2)
    expect(caseVonMises[0].some((stress, e) => stress !== caseVonMises[1][e])).toBe(true)
    expect(vonMises.every((stress, e) => Number.isFinite(stress) && stress === Math.max(caseVonMises[0][e], caseVonMises[1][e]))).toBe(true)
  }
})

it('looks up the same case across deletion, undo, and redo by ID', () => {
  const problem = makePreset('cantilever', { nelx: 30, nely: 10 })
  const before = addLoadCase(addLoadCase(problem.loadCases))
  const [first, second, selected] = before
  const after = [{ ...second, name: selected.name }, selected]

  expect(loadCaseIndex(before, selected.id)).toBe(2)
  expect(loadCaseIndex(after, selected.id)).toBe(1)
  expect(loadCaseIndex(before, selected.id)).toBe(2) // Undo
  expect(loadCaseIndex(after, selected.id)).toBe(1) // Redo
  expect(loadCaseIndex(after, first.id)).toBe(-1)

  const replacement = addLoadCase([first, second]).at(-1)!
  expect(replacement.name).toBe(selected.name)
  expect(replacement.id).not.toBe(selected.id)
  expect(loadCaseIndex([first, second, replacement], selected.id)).toBe(-1)
})
