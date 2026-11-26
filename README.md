# TopoStudio

TopoStudio is a browser-based mechanical topology optimization workbench. [GitHub Pages](https://nikitatrubaidev.github.io/topo-studio/)

- **2D** offers plane-stress Q4 SIMP optimization, interactive support and load editing, manufacturing constraints, stress and deformation views, JSON projects, and DXF, SVG, and extruded STL export.
- **3D** offers Hex8 and conforming Tet4 SIMP optimization with geometric multigrid, four mechanical presets up to 64 × 32 × 20 brick cells, FEM mesh and wireframe views, smoothed CAD surfaces, von Mises stress, section planes, and watertight binary STL and Wavefront OBJ export in millimetres.
- Both modes report mass, deflection, and safety factors. The interface supports English, German, and Russian.

React, TypeScript, and Vite power the workbench. The 3D worker defaults to a Rust WebAssembly SIMD128 kernel for Hex8 and conforming Tet4 MGCG, adaptive Tet4 PCG, and sparse filtering. SIMD element batches use disjoint node sets to support future parallel sweeps. The **Solver engine** control switches to the TypeScript reference during a run and preserves the current design. Three.js renders the 3D viewport with WebGL 2.

## Local development

Use Node.js 26 and npm.

```sh
npm ci
npm run dev
npm test
npm run build
```

The WASM asset is included in the repository. After changing Rust code, install stable Rust and the `wasm32-unknown-unknown` target, then run `npm run build:wasm`. Cargo builds the dependency-free crate and copies its SIMD128 binary into `src/wasm/`.

Run `npm run bench:solver -- src/solver3d/__tests__/wasmSpeed.bench.ts` to compare the median duration of warm SIMP steps on both engines.

To compare 3D Jacobi PCG and MGCG solves and benchmark warm SIMP iterations, run `npm run bench:solver -- src/solver3d`.

## Siemens NX camera controls

| Action | Input |
| --- | --- |
| Orbit | Drag with the middle mouse button |
| Zoom | Scroll the wheel or drag with Ctrl + middle button |
| Pan | Drag with Shift + left button or Shift + middle button |
| Orient | Select Iso, Front, Top, or Right |
| Fit the domain | Select Fit or press F |

The Standard scheme uses left drag to orbit and right or middle drag to pan.

## Deployment

Set the repository’s Pages source to **GitHub Actions**. The workflow tests and builds each push to `main` and deploys the output to the `/topo-studio/` base path.
