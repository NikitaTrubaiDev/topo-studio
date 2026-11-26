use crate::elements::{CORNERS, Elements, Grid};
use core::arch::wasm32::*;

// Structured levels use geometric neighbor blocks for GS smoothing only.
// Adaptive Tet4 uses the same layout with sparse, mesh-derived adjacency.
pub struct NodalBlocks {
    starts: Vec<usize>,
    columns: Vec<usize>,
    blocks: Vec<[f64; 9]>,
    slots: Vec<usize>,
    diagonal: Vec<usize>,
    inverse: Vec<f64>,
    active: Vec<[f64; 3]>,
}

impl NodalBlocks {
    fn new(grid: Grid, elements: &Elements, fixed: &[u8]) -> Self {
        let [nx, ny, nz] = grid.0;
        let mut starts = Vec::with_capacity(grid.nodes() + 1);
        let mut columns = Vec::new();
        let mut diagonal = Vec::with_capacity(grid.nodes());
        let mut lookup = vec![[0; 27]; grid.nodes()];
        for z in 0..=nz {
            for y in 0..=ny {
                for x in 0..=nx {
                    let i = grid.node(x, y, z);
                    starts.push(columns.len());
                    for (l, k) in (z.saturating_sub(1)..=(z + 1).min(nz)).enumerate() {
                        for (m, j) in (y.saturating_sub(1)..=(y + 1).min(ny)).enumerate() {
                            for (n, h) in (x.saturating_sub(1)..=(x + 1).min(nx)).enumerate() {
                                let slot = (l + usize::from(z == 0)) * 9
                                    + (m + usize::from(y == 0)) * 3 + n + usize::from(x == 0);
                                if elements.per_brick == 5 && [0, 2, 6, 8, 18, 20, 24, 26].contains(&slot) {
                                    continue;
                                }
                                lookup[i][slot] = columns.len();
                                if slot == 13 {
                                    diagonal.push(columns.len());
                                }
                                columns.push(3 * grid.node(h, j, k));
                            }
                        }
                    }
                }
            }
        }
        starts.push(columns.len());
        let sy = (nx + 1) as isize;
        let sz = sy * (ny + 1) as isize;
        let mut slots = Vec::with_capacity(elements.nodes.len() * elements.width / 3);
        let mut slot_by_delta = vec![0; (2 * (sz + sy) + 3) as usize];
        for z in -1..=1 {
            for y in -1..=1 {
                for x in -1..=1 {
                    slot_by_delta[(sz * (1 + z) + sy * (1 + y) + 1 + x) as usize] =
                        ((z + 1) * 9 + (y + 1) * 3 + x + 1) as usize;
                }
            }
        }
        for nodes in elements.nodes.chunks_exact(elements.width / 3) {
            for &i in nodes {
                slots.extend(nodes.iter().map(|&j| {
                    let delta = (j as isize - i as isize + sz + sy + 1) as usize;
                    lookup[i as usize][slot_by_delta[delta]]
                }));
            }
        }
        Self::from_rows(starts, columns, slots, diagonal, fixed)
    }

    pub fn adaptive(elements: &Elements, fixed: &[u8]) -> Self {
        let nodes = fixed.len() / 3;
        let mut neighbors: Vec<Vec<_>> = (0..nodes).map(|n| vec![n as u32]).collect();
        for tet in elements.nodes.chunks_exact(4) {
            for &i in tet {
                for &j in tet {
                    let row = &mut neighbors[i as usize];
                    if !row.contains(&j) { row.push(j); }
                }
            }
        }
        let mut starts = Vec::with_capacity(nodes + 1);
        let mut columns = Vec::new();
        let mut diagonal = Vec::with_capacity(nodes);
        for (i, row) in neighbors.iter_mut().enumerate() {
            row.sort_unstable();
            starts.push(columns.len());
            diagonal.push(columns.len() + row.binary_search(&(i as u32)).unwrap());
            columns.extend(row.iter().map(|&j| 3 * j as usize));
        }
        starts.push(columns.len());
        let mut slots = Vec::with_capacity(4 * elements.nodes.len());
        for tet in elements.nodes.chunks_exact(4) {
            for &i in tet {
                let i = i as usize;
                slots.extend(tet.iter().map(|j| starts[i] + neighbors[i].binary_search(j).unwrap()));
            }
        }
        Self::from_rows(starts, columns, slots, diagonal, fixed)
    }

    fn from_rows(starts: Vec<usize>, columns: Vec<usize>, slots: Vec<usize>, diagonal: Vec<usize>, fixed: &[u8]) -> Self {
        let active = fixed.chunks_exact(3)
            .map(|f| [f64::from(f[0] == 0), f64::from(f[1] == 0), f64::from(f[2] == 0)])
            .collect();
        Self {
            starts, blocks: vec![[0.; 9]; columns.len()], columns, slots, diagonal, active,
            inverse: vec![0.; fixed.len()],
        }
    }

    fn prepare(&mut self, elements: &Elements, modulus: &[f64], shift: f64) {
        self.blocks.fill([0.; 9]);
        for batch in elements.coloring.batches() {
            for &item in batch {
                let first = item as usize * elements.per_brick;
                for e in first..first + elements.per_brick {
                    self.assemble(e, elements.connectivity(e), elements.matrix(e), modulus[e]);
                }
            }
        }
        self.finish_diagonal(shift);
    }

    pub fn prepare_adaptive(&mut self, elements: &Elements, modulus: &[f64], inverse: &mut [f64]) {
        self.blocks.fill([0.; 9]);
        let mut ke = [0.; 144];
        for batch in elements.coloring.batches() {
            for &e in batch {
                let e = e as usize;
                elements.expand_adaptive_matrix(e, &mut ke);
                self.assemble(e, elements.connectivity(e), &ke, modulus[e]);
            }
        }
        self.finish_diagonal(0.);
        inverse.copy_from_slice(&self.inverse);
    }

    fn assemble(&mut self, e: usize, nodes: &[u32], ke: &[f64], scale: f64) {
        let w = nodes.len() * 3;
        let mut slot = e * nodes.len() * nodes.len();
        for (i, &node) in nodes.iter().enumerate() {
            let [x, y, z] = self.active[node as usize].map(|v| v * scale);
            for (j, &other) in nodes.iter().enumerate() {
                let [a, b, c] = self.active[other as usize];
                let k = 3 * (i * w + j);
                let block = &mut self.blocks[self.slots[slot]];
                block[0] += x * ke[k] * a;
                block[1] += y * ke[k + w] * a;
                block[2] += x * ke[k + 1] * b;
                block[3] += y * ke[k + w + 1] * b;
                block[4] += x * ke[k + 2] * c;
                block[5] += y * ke[k + w + 2] * c;
                block[6] += z * ke[k + 2 * w] * a;
                block[7] += z * ke[k + 2 * w + 1] * b;
                block[8] += z * ke[k + 2 * w + 2] * c;
                slot += 1;
            }
        }
    }

    fn finish_diagonal(&mut self, shift: f64) {
        for (node, &index) in self.diagonal.iter().enumerate() {
            for (axis, d) in [0, 3, 8].into_iter().enumerate() {
                let entry = &mut self.blocks[index][d];
                *entry *= 1. + shift;
                self.inverse[3 * node + axis] = if self.active[node][axis] == 0. { 0. } else { entry.recip() };
            }
        }
    }

    pub fn apply(&self, input: &[f64], output: &mut [f64]) {
        for (node, value) in output.chunks_exact_mut(3).enumerate() {
            value.copy_from_slice(&self.row(node, input));
        }
    }

    #[inline]
    fn row(&self, node: usize, input: &[f64]) -> [f64; 3] {
        let mut xy = f64x2_splat(0.);
        let mut z = 0.;
        let range = self.starts[node]..self.starts[node + 1];
        for (&col, b) in self.columns[range.clone()].iter().zip(&self.blocks[range]) {
            // Column indices always identify a complete three-component node.
            let [a, c, d] = <[f64; 3]>::try_from(&input[col..col + 3]).unwrap();
            let lanes = unsafe {
                let p = b.as_ptr();
                f64x2_add(f64x2_add(f64x2_mul(v128_load(p.cast()), f64x2_splat(a)),
                    f64x2_mul(v128_load(p.add(2).cast()), f64x2_splat(c))),
                    f64x2_mul(v128_load(p.add(4).cast()), f64x2_splat(d)))
            };
            xy = f64x2_add(xy, lanes);
            z += b[6] * a + b[7] * c + b[8] * d;
        }
        [f64x2_extract_lane::<0>(xy), f64x2_extract_lane::<1>(xy), z]
    }

    fn relax<const FORWARD: bool>(&self, solution: &mut [f64], rhs: &[f64]) {
        let n = self.diagonal.len();
        for i in 0..n {
            let i = if FORWARD { i } else { n - i - 1 };
            let [a, b, c] = self.row(i, solution);
            let d = 3 * i;
            let k = &self.blocks[self.diagonal[i]];
            // Match the reference damped GS update (unit relaxation weight).
            let inv = &self.inverse[d..d + 3];
            if FORWARD {
                let dx = (rhs[d] - a) * inv[0];
                let dy = (rhs[d + 1] - b - k[1] * dx) * inv[1];
                solution[d] += dx;
                solution[d + 1] += dy;
                solution[d + 2] += (rhs[d + 2] - c - k[6] * dx - k[7] * dy) * inv[2];
            } else {
                let dz = (rhs[d + 2] - c) * inv[2];
                let dy = (rhs[d + 1] - b - k[5] * dz) * inv[1];
                solution[d + 2] += dz;
                solution[d + 1] += dy;
                solution[d] += (rhs[d] - a - k[2] * dy - k[4] * dz) * inv[0];
            }
        }
    }
}

struct Transfer {
    nodes: Vec<[usize; 8]>,
    weights: Vec<[f64; 8]>,
}

impl Transfer {
    fn new(fine: Grid, coarse: Grid, fine_fixed: &[u8], fixed: &mut [u8]) -> Self {
        let mut nodes = Vec::with_capacity(fine.nodes());
        let mut weights = Vec::with_capacity(fine.nodes());
        let [nx, ny, nz] = fine.0;
        for z in 0..=nz {
            for y in 0..=ny {
                for x in 0..=nx {
                    let p: [f64; 3] = std::array::from_fn(|d| {
                        ([x, y, z][d] * coarse.0[d]) as f64 / fine.0[d] as f64
                    });
                    let [i, j, k] = std::array::from_fn(|d| (p[d].floor() as usize).min(coarse.0[d] - 1));
                    let t = [p[0] - i as f64, p[1] - j as f64, p[2] - k as f64];
                    let [a, b, c] = p.map(|v| v.round() as usize);
                    let nearest = 3 * coarse.node(a, b, c);
                    let dof = 3 * nodes.len();
                    for d in 0..3 {
                        fixed[nearest + d] |= fine_fixed[dof + d];
                    }
                    nodes.push(CORNERS.map(|[a, b, c]| 3 * coarse.node(i + a, j + b, k + c)));
                    let w = t.map(|v| [1. - v, v]);
                    weights.push(CORNERS.map(|[a, b, c]| w[0][a] * w[1][b] * w[2][c]));
                }
            }
        }
        Self { nodes, weights }
    }

    fn restrict(&self, residual: &[f64], fixed: &[u8], output: &mut [f64]) {
        output.fill(0.);
        for (i, (nodes, weights)) in self.nodes.iter().zip(&self.weights).enumerate() {
            for (&j, &w) in nodes.iter().zip(weights) {
                for d in 0..3 {
                    output[j + d] += w * residual[3 * i + d];
                }
            }
        }
        for (value, &clamped) in output.iter_mut().zip(fixed) {
            if clamped != 0 { *value = 0.; }
        }
    }

    fn prolong(&self, coarse: &[f64], fine_fixed: &[u8], output: &mut [f64]) {
        for (i, (nodes, weights)) in self.nodes.iter().zip(&self.weights).enumerate() {
            let mut update = [0.; 3];
            for (&j, &w) in nodes.iter().zip(weights) {
                for d in 0..3 {
                    update[d] += w * coarse[j + d];
                }
            }
            for (d, value) in update.into_iter().enumerate() {
                let j = 3 * i + d;
                if fine_fixed[j] == 0 { output[j] += value; }
            }
        }
    }
}

struct Aggregation {
    starts: Vec<usize>,
    cells: Vec<(usize, f64)>,
}

impl Aggregation {
    fn new(fine: Grid, coarse: Grid) -> Self {
        let overlaps = |d: usize| {
            let ratio = fine.0[d] as f64 / coarse.0[d] as f64;
            (0..coarse.0[d]).map(|i| {
                let lo = i as f64 * ratio;
                let hi = (i + 1) as f64 * ratio;
                (lo.floor() as usize..(hi.ceil() as usize).min(fine.0[d])).map(|cell| {
                    (cell, (hi.min((cell + 1) as f64) - lo.max(cell as f64)) / ratio)
                }).collect::<Vec<_>>()
            }).collect::<Vec<_>>()
        };
        let [xs, ys, zs] = std::array::from_fn(overlaps);
        let [nx, ny, _] = fine.0;
        let mut starts = Vec::with_capacity(coarse.cells() + 1);
        let mut cells = Vec::new();
        for z in &zs {
            for y in &ys {
                for x in &xs {
                    starts.push(cells.len());
                    for &(k, wz) in z {
                        for &(j, wy) in y {
                            for &(i, wx) in x {
                                cells.push(((k * ny + j) * nx + i, wx * wy * wz));
                            }
                        }
                    }
                }
            }
        }
        starts.push(cells.len());
        Self { starts, cells }
    }

    fn apply(&self, fine: &[f64], coarse: &mut [f64]) {
        for (row, value) in self.starts.windows(2).zip(coarse) {
            *value = self.cells[row[0]..row[1]].iter().map(|&(e, w)| w * fine[e]).sum();
        }
    }
}

struct Level {
    transfer: Transfer,
    aggregation: Aggregation,
    fixed: Vec<u8>,
    elements: Elements,
    smoother: NodalBlocks,
    modulus: Vec<f64>,
    rhs: Vec<f64>,
    solution: Vec<f64>,
}

pub struct Multigrid {
    fine: NodalBlocks,
    brick_modulus: Vec<f64>,
    levels: Vec<Level>,
}

impl Multigrid {
    pub fn new(mut grid: Grid, elements: &Elements, fixed: &[u8], coarse_ke: &[f64]) -> Self {
        let fine = NodalBlocks::new(grid, elements, fixed);
        let brick_modulus = if elements.per_brick == 5 { vec![0.; grid.cells()] } else { Vec::new() };
        let mut levels = Vec::<Level>::new();
        for ke in coarse_ke.chunks_exact(576) {
            let coarse = grid.coarse().unwrap();
            let n = coarse.nodes() * 3;
            let mut clamped = vec![0; n];
            let transfer = Transfer::new(grid, coarse, levels.last().map_or(fixed, |l| &l.fixed), &mut clamped);
            let aggregation = Aggregation::new(grid, coarse);
            let elements = Elements::structured(coarse, ke, &[]);
            let smoother = NodalBlocks::new(coarse, &elements, &clamped);
            levels.push(Level {
                transfer, aggregation, fixed: clamped, elements, smoother,
                modulus: vec![0.; coarse.cells()], rhs: vec![0.; n], solution: vec![0.; n],
            });
            grid = coarse;
        }
        Self { fine, brick_modulus, levels }
    }

    pub fn prepare(&mut self, elements: &Elements, modulus: &[f64]) {
        self.fine.prepare(elements, modulus, 0.);
        let mut modulus = if !self.brick_modulus.is_empty() {
            for (value, tets) in self.brick_modulus.iter_mut().zip(modulus.chunks_exact(5)) {
                *value = tets[0] / 3. + tets[1] / 6. + tets[2] / 6. + tets[3] / 6. + tets[4] / 6.;
            }
            &self.brick_modulus[..]
        } else {
            modulus
        };
        for level in &mut self.levels {
            level.aggregation.apply(modulus, &mut level.modulus);
            level.smoother.prepare(&level.elements, &level.modulus, 1e-8);
            modulus = &level.modulus;
        }
    }

    pub fn apply(&mut self, fixed: &[u8], rhs: &[f64], output: &mut [f64], scratch: &mut [f64]) {
        Self::cycle(&mut self.levels, &self.fine, fixed, rhs, output, scratch);
    }

    fn cycle(levels: &mut [Level], smoother: &NodalBlocks, fixed: &[u8], rhs: &[f64], output: &mut [f64], scratch: &mut [f64]) {
        output.fill(0.);
        if let Some((coarse, rest)) = levels.split_first_mut() {
            smoother.relax::<true>(output, rhs);
            let residual = &mut scratch[..rhs.len()];
            for (i, (r, force)) in residual.chunks_exact_mut(3).zip(rhs.chunks_exact(3)).enumerate() {
                let product = smoother.row(i, output);
                for d in 0..3 { r[d] = force[d] - product[d]; }
            }
            coarse.transfer.restrict(residual, &coarse.fixed, &mut coarse.rhs);
            Self::cycle(rest, &coarse.smoother, &coarse.fixed, &coarse.rhs, &mut coarse.solution, scratch);
            coarse.transfer.prolong(&coarse.solution, fixed, output);
            smoother.relax::<false>(output, rhs);
        } else {
            for _ in 0..8 {
                smoother.relax::<true>(output, rhs);
                smoother.relax::<false>(output, rhs);
            }
        }
    }
}
