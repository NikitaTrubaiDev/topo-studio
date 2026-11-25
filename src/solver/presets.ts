import { nodeIndex, type Grid, type Material, type NodalForce, type SimpParams, type SimpProblem, type Support } from './types'

// Nominal isotropic inputs for the plane-stress model. Polymers use dry PA12
// (Arkema Rilsamid AESNO MED) and horizontal print coupon data (Prusament PLA and PETG).
export const materials = {
  steel: { name: 'Steel S355', E0: 210_000, Emin: 0.21, nu: 0.30, densityKgM3: 7850, yieldMPa: 355 },
  aluminum: { name: 'Al 6061-T6', E0: 68_900, Emin: 0.0689, nu: 0.33, densityKgM3: 2700, yieldMPa: 276 },
  titanium: { name: 'Titanium Ti-6Al-4V', E0: 114_000, Emin: 0.114, nu: 0.34, densityKgM3: 4430, yieldMPa: 880 },
  pla: { name: 'PLA', E0: 2300, Emin: 0.0023, nu: 0.36, densityKgM3: 1240, yieldMPa: 51 },
  petg: { name: 'PETG', E0: 1500, Emin: 0.0015, nu: 0.38, densityKgM3: 1270, yieldMPa: 47 },
  pa12: { name: 'Nylon PA12', E0: 1500, Emin: 0.0015, nu: 0.39, densityKgM3: 1010, yieldMPa: 50 },
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
  bellcrank: { name: 'Suspension Bellcrank', detail: 'Pinned pivot · Bump and rebound / braking' },
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
  const support = (x: number, y: number, kind: NonNullable<Support['kind']> = 'fixed'): Support =>
    ({ node: node(x, y), kind, fixedX: kind !== 'roller-x', fixedY: kind !== 'roller-y' })
  const leftEdge = Array.from({ length: nely + 1 }, (_, y) => support(0, y))
  const problem = { grid, params, material }
  switch (id) {
    case 'mbb':
      return {
        ...problem,
        supports: [...leftEdge.map((_, y) => support(0, y, 'roller-y')), support(nelx, 0, 'roller-x')],
        loadCases: [{ id, name: 'Top-left load', presetName: 'caseMbb', forces: [force(0, nely)] }],
      }
    case 'cantilever': {
      const lower = Math.floor(nely / 2)
      const upper = Math.ceil(nely / 2)
      const forces = lower === upper ? [force(nelx, lower)] : [force(nelx, lower, -50), force(nelx, upper, -50)]
      return { ...problem, supports: leftEdge, loadCases: [{ id, name: 'Tip load', presetName: 'caseCantilever', forces }] }
    }
    case 'bridge':
      return {
        ...problem,
        supports: [support(0, 0, 'pin'), support(nelx, 0, 'roller-x')],
        loadCases: [{
          id,
          name: 'Deck load', presetName: 'caseBridge',
          forces: Array.from({ length: nelx + 1 }, (_, x) =>
            force(x, nely, -(x === 0 || x === nelx ? 50 : 100) / nelx)),
        }],
      }
    case 'bellcrank': {
      const pivot = [Math.round(nelx * 0.49), Math.round(nely * 0.45)]
      const pushrod = [Math.round(nelx * 0.15), Math.round(nely * 0.24)]
      const damper = [Math.round(nelx * 0.82), Math.round(nely * 0.72)]
      const inner = Math.max(1, nely * 0.11)
      const outer = inner + Math.max(1.3, nely * 0.065)
      const pad = Math.max(1.5, nely * 0.095)
      const solid = new Uint8Array(nelx * nely)
      const voidMask = new Uint8Array(solid.length)
      for (let y = 0; y < nely; y++) {
        for (let x = 0; x < nelx; x++) {
          const e = y * nelx + x
          const radius = Math.hypot(x + 0.5 - pivot[0], y + 0.5 - pivot[1])
          if (radius <= inner) voidMask[e] = 1
          else if (radius <= outer || [pushrod, damper].some(([px, py]) =>
            Math.hypot(x + 0.5 - px, y + 0.5 - py) <= pad)) solid[e] = 1
        }
      }
      const pivotSupports: Support[] = []
      const radius = inner + 0.65
      for (let i = 0; i < 24; i++) {
        const angle = i * Math.PI / 12
        const pin = support(Math.round(pivot[0] + radius * Math.cos(angle)),
          Math.round(pivot[1] + radius * Math.sin(angle)), 'pin')
        if (!pivotSupports.some(item => item.node === pin.node)) pivotSupports.push(pin)
      }
      // Spread each resultant across a physical pad so refinement preserves the load.
      const patch = ([px, py]: number[], fx: number, fy: number) => {
        const nodes: number[] = []
        const reach = Math.floor(pad * 0.55)
        for (let dy = -reach; dy <= reach; dy++) {
          for (let dx = -reach; dx <= reach; dx++) {
            if (Math.hypot(dx, dy) <= reach) nodes.push(node(px + dx, py + dy))
          }
        }
        return nodes.map(node => ({ node, fx: fx / nodes.length, fy: fy / nodes.length }))
      }
      return {
        ...problem,
        supports: pivotSupports,
        passive: { solid, void: voidMask },
        loadCases: [
          { id: 'bump', name: 'Bump', presetName: 'caseBump',
            forces: [...patch(pushrod, 300, 1500), ...patch(damper, -450, -1150)] },
          { id: 'rebound', name: 'Rebound / braking', presetName: 'caseRebound',
            forces: [...patch(pushrod, -650, -550), ...patch(damper, 250, 600)] },
        ],
      }
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
        loadCases: [{ id, name: 'Right tip load', presetName: 'caseBracket', forces: [force(nelx, base)] }],
        passive: { solid, void: voidMask },
      }
    }
  }
}
