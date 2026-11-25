# TopoStudio Roadmap

## Phase 1 — 2D SIMP Core + Tests + Live Interactive MVP
- Vite + React + TypeScript + Tailwind CSS + Vitest scaffold.
- 2D plane-stress Q4 SIMP solver (`src/solver/`) with Matrix-Free PCG, warm-start, cone filter, Optimality Criteria, passive solid/void masks, multi-load cases, and element von Mises stress.
- WebWorker runner (`src/workers/`) with Start / Pause / Step / Reset.
- Dark CAD/CAE UI with Canvas 2D (Density / Von Mises Stress / Deformed Mesh), classic engineering presets (MBB Beam, Cantilever, Arch Bridge, L-Bracket), parameter controls, and live compliance convergence chart.
- Unit tests verifying Q4 stiffness matrix properties, PCG accuracy, MBB compliance reduction, volume convergence, and symmetry.

## Phase 2 — Interactive 2D Designer + Multi-Load + CAD/3D-Print Export
- Interactive canvas brush/tools: paint Void (keep-out), Solid (keep-in around bolt holes), Supports (pin/fixed/roller), and Force vectors (including multi-load cases).
- Smooth contour extraction (Marching Squares + smoothing) with export to **DXF**, **SVG**, and extruded **STL**.

## Phase 3 — Manufacturing Constraints & Engineering Analysis
- Heaviside projection (crisp black-and-white boundaries).
- Symmetry constraints (X / Y) and 45-degree overhang filter for support-free 3D printing.
- Real engineering material presets (Steel, Al 6061-T6, Titanium, PLA, PETG, PA12), mass in grams, max deflection in mm, approximate safety factor, JSON save/load, and extra mechanical presets (suspension wishbone/upright).

## Phase 4 — 3D Topology Optimization + Acceleration
- 3D voxel H8 SIMP solver + Matrix-Free PCG (with optional Rust -> WASM / WebGPU acceleration).
- Three.js 3D viewport with orbit controls, clipping planes, Marching Cubes + Taubin smoothing, and watertight **STL / OBJ** export.
