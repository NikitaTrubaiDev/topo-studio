import { expect, test } from 'vitest'
import { makePreset3D, presetGrid3D, resolutions3D } from '../presets3d'
import { Simp3D } from '../simp3d'

test.each(resolutions3D.slice(0, 2).map(resolution => ({ resolution })))(
  'warm 3D SIMP iterations on $resolution', { timeout: 90_000 }, ({ resolution }) => {
    const solver = new Simp3D(makePreset3D('cantilever3d', presetGrid3D(resolution)))
    solver.step()
    const times: number[] = []
    for (let i = 0; i < 5; i++) {
      const start = performance.now()
      expect(solver.step().compliance).toBeGreaterThan(0)
      times.push(performance.now() - start)
    }
    const mean = times.reduce((sum, time) => sum + time) / times.length
    console.info(`${resolution.join('×')}: ${mean.toFixed(1)} ms/iteration (mean of iterations 2–6)`)
  },
)
