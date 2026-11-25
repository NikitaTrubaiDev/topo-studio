import { nodeIndex, type Grid, type Material, type NodalForce, type SimpParams, type SimpProblem } from './types'

export const materials = {
  steel: { name: 'Steel', E0: 200_000, Emin: 0.2, nu: 0.30, densityKgM3: 7850, yieldMPa: 250 },
  aluminum: { name: 'Al 6061-T6', E0: 68_900, Emin: 0.0689, nu: 0.33, densityKgM3: 2700, yieldMPa: 276 },
  titanium: { name: 'Titanium', E0: 114_000, Emin: 0.114, nu: 0.34, densityKgM3: 4430, yieldMPa: 880 },
  pla: { name: 'PLA', E0: 3200, Emin: 0.0032, nu: 0.36, densityKgM3: 1240, yieldMPa: 50 },
} satisfies Record<string, Material>

export const defaultParams: SimpParams = {
  penal: 3,
  rmin: 1.8,
  volFrac: 0.45,
  moveLimit: 0.2,
  maxIter: 160,
  changeTol: 0.008,
}

export const presets = {
  mbb: { name: 'MBB Beam', detail: 'Half-symmetry · 100 N point load' },
  cantilever: { name: 'Cantilever Beam', detail: 'Fixed left edge · 100 N tip load' },
  bridge: { name: 'Arch Bridge', detail: 'Pin and roller · 100 N distributed deck load' },
  bracket: { name: 'L-Bracket', detail: 'Fixed upper edge · 100 N tip load' },
}

export type PresetId = keyof typeof presets

export function makePreset(
  id: PresetId,
  grid: Grid,
  params: SimpParams = defaultParams,
  material: Material = materials.steel,
): SimpProblem {
  const { nelx, nely } = grid
  const node = (x: number, y: number) => nodeIndex(grid, x, y)
  const force = (x: number, y: number, fy = -100): NodalForce => ({ node: node(x, y), fx: 0, fy })
  const support = (x: number, y: number, fixedX = true, fixedY = true) => ({ node: node(x, y), fixedX, fixedY })
  const leftEdge = Array.from({ length: nely + 1 }, (_, y) => support(0, y))
  const problem = { grid, params, material }
  switch (id) {
    case 'mbb':
      return {
        ...problem,
        supports: [...leftEdge.map(s => ({ ...s, fixedY: false })), support(nelx, 0, false)],
        loadCases: [{ name: 'Top-left load', forces: [force(0, nely)] }],
      }
    case 'cantilever': {
      const lower = Math.floor(nely / 2)
      const upper = Math.ceil(nely / 2)
      const forces = lower === upper ? [force(nelx, lower)] : [force(nelx, lower, -50), force(nelx, upper, -50)]
      return { ...problem, supports: leftEdge, loadCases: [{ name: 'Tip load', forces }] }
    }
    case 'bridge':
      return {
        ...problem,
        supports: [support(0, 0), support(nelx, 0, false)],
        loadCases: [{
          name: 'Deck load',
          forces: Array.from({ length: nelx + 1 }, (_, x) =>
            force(x, nely, -(x === 0 || x === nelx ? 50 : 100) / nelx)),
        }],
      }
    case 'bracket': {
      const left = Math.max(1, Math.round(nelx * 0.42))
      const base = Math.max(1, Math.round(nely * 0.46))
      const solid = new Uint8Array(nelx * nely)
      const voidMask = new Uint8Array(solid.length)
      for (let y = 0; y < nely; y++) {
        for (let x = 0; x < nelx; x++) {
          const e = y * nelx + x
          if (x >= left && y >= base) voidMask[e] = 1
          else if ((y === nely - 1 && x < left) || (x === nelx - 1 && y === base - 1)) solid[e] = 1
        }
      }
      return {
        ...problem,
        supports: Array.from({ length: left + 1 }, (_, x) => support(x, nely)),
        loadCases: [{ name: 'Right tip load', forces: [force(nelx, base)] }],
        passive: { solid, void: voidMask },
      }
    }
  }
}
