use core::arch::wasm32::*;

pub const CORNERS: [[usize; 3]; 8] = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
    [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];

#[derive(Clone, Copy)]
pub struct Grid(pub [usize; 3]);

impl Grid {
    pub fn node(self, x: usize, y: usize, z: usize) -> usize {
        let [nx, ny, _] = self.0;
        (z * (ny + 1) + y) * (nx + 1) + x
    }

    pub fn nodes(self) -> usize {
        self.0.iter().map(|&n| n + 1).product()
    }

    pub fn cells(self) -> usize {
        self.0.iter().product()
    }

    pub fn coarse(self) -> Option<Self> {
        (self.0.iter().all(|&n| n >= 4)).then(|| Self(self.0.map(|n| n / 2)))
    }
}

pub struct Coloring {
    pub starts: Vec<u32>,
    pub order: Vec<u32>,
}

impl Coloring {
    fn from_colors(count: usize, colors: &[usize]) -> Self {
        let mut starts = vec![0; count + 1];
        for &color in colors {
            starts[color + 1] += 1;
        }
        for i in 0..count {
            starts[i + 1] += starts[i];
        }
        let mut cursor = starts[..count].to_vec();
        let mut order = vec![0; colors.len()];
        for (e, &color) in colors.iter().enumerate() {
            order[cursor[color] as usize] = e as u32;
            cursor[color] += 1;
        }
        Self { starts, order }
    }

    fn bricks(grid: Grid) -> Self {
        let [nx, ny, _] = grid.0;
        let colors: Vec<_> = (0..grid.cells()).map(|e| {
            (e % nx & 1) | ((e / nx % ny & 1) << 1) | ((e / (nx * ny) & 1) << 2)
        }).collect();
        Self::from_colors(8, &colors)
    }

    fn tetrahedra(nodes: &[u32], count: usize) -> Self {
        // Grow the per-node sets in 32-color slabs for highly incident vertices.
        let mut slabs = vec![vec![0u32; count]];
        let mut colors = Vec::with_capacity(nodes.len() / 4);
        let mut color_count = 0;
        for tet in nodes.chunks_exact(4) {
            for slab in 0.. {
                if slab == slabs.len() {
                    slabs.push(vec![0; count]);
                }
                let bits = &mut slabs[slab];
                let used = tet.iter().fold(0, |mask, &n| mask | bits[n as usize]);
                if used != u32::MAX {
                    let bit = (!used).trailing_zeros() as usize;
                    let color = slab * 32 + bit;
                    for &n in tet {
                        bits[n as usize] |= 1 << bit;
                    }
                    colors.push(color);
                    color_count = color_count.max(color + 1);
                    break;
                }
            }
        }
        Self::from_colors(color_count, &colors)
    }

    pub fn batches(&self) -> impl Iterator<Item = &[u32]> {
        self.starts.windows(2).map(|s| &self.order[s[0] as usize..s[1] as usize])
    }
}

pub struct Elements {
    pub nodes: Vec<u32>,
    pub templates: Vec<u32>,
    pub coloring: Coloring,
    pub per_brick: usize,
    pub width: usize,
    matrices: Vec<f64>,
    compact: Vec<[[f64; 4]; 21]>,
}

impl Elements {
    pub fn structured(grid: Grid, matrices: &[f64], tet_corners: &[u8]) -> Self {
        let tet = !tet_corners.is_empty();
        let per_brick = if tet { 5 } else { 1 };
        let width = if tet { 12 } else { 24 };
        let mut nodes = Vec::with_capacity(grid.cells() * per_brick * width / 3);
        let mut templates = Vec::with_capacity(grid.cells() * per_brick);
        let [nx, ny, nz] = grid.0;
        for z in 0..nz {
            for y in 0..ny {
                for x in 0..nx {
                    let brick = CORNERS.map(|[dx, dy, dz]| grid.node(x + dx, y + dy, z + dz) as u32);
                    if tet {
                        let first = 5 * ((x + y + z) & 1);
                        for t in first..first + 5 {
                            templates.push(t as u32);
                            nodes.extend(tet_corners[4 * t..4 * t + 4].iter().map(|&i| brick[i as usize]));
                        }
                    } else {
                        templates.push(0);
                        nodes.extend(brick);
                    }
                }
            }
        }
        Self {
            nodes, templates, coloring: Coloring::bricks(grid), per_brick, width,
            matrices: matrices.to_vec(), compact: Vec::new(),
        }
    }

    pub fn adaptive(nodes: &[u32], templates: &[u32], fixed: &[u8], packed: &[f64]) -> Self {
        // Repack the 78 unique entries into triangular SIMD blocks. Only the
        // off-diagonal entry of each diagonal block is duplicated.
        let compact = packed.chunks_exact(78).map(|ke| {
            let coeff = |a: usize, b: usize| {
                let (i, j) = (a.min(b), a.max(b));
                ke[i * (25 - i) / 2 + j - i]
            };
            let mut blocks = [[0.; 4]; 21];
            let mut k = 0;
            for i in (0..12).step_by(2) {
                for j in (i..12).step_by(2) {
                    blocks[k] = [coeff(i, j), coeff(i + 1, j), coeff(i, j + 1), coeff(i + 1, j + 1)];
                    k += 1;
                }
            }
            blocks
        }).collect();
        Self {
            nodes: nodes.to_vec(), templates: templates.to_vec(),
            coloring: Coloring::tetrahedra(nodes, fixed.len() / 3),
            per_brick: 1, width: 12, matrices: Vec::new(), compact,
        }
    }

    pub fn matrix(&self, e: usize) -> &[f64] {
        let width = self.width * self.width;
        let start = self.templates[e] as usize * width;
        &self.matrices[start..start + width]
    }

    pub fn expand_adaptive_matrix(&self, e: usize, matrix: &mut [f64; 144]) {
        let ke = &self.compact[self.templates[e] as usize];
        let mut k = 0;
        for i in (0..12).step_by(2) {
            for j in (i..12).step_by(2) {
                let [a, b, c, d] = ke[k];
                matrix[12 * i + j] = a;
                matrix[12 * j + i] = a;
                matrix[12 * (i + 1) + j] = b;
                matrix[12 * j + i + 1] = b;
                matrix[12 * i + j + 1] = c;
                matrix[12 * (j + 1) + i] = c;
                matrix[12 * (i + 1) + j + 1] = d;
                matrix[12 * (j + 1) + i + 1] = d;
                k += 1;
            }
        }
    }

    pub fn connectivity(&self, e: usize) -> &[u32] {
        let n = self.width / 3;
        &self.nodes[e * n..(e + 1) * n]
    }

    pub fn inverse_diagonal(&self, fixed: &[u8], modulus: &[f64], diagonal: &mut [f64]) {
        diagonal.fill(0.);
        for batch in self.coloring.batches() {
            for &item in batch {
                let first = item as usize * self.per_brick;
                for e in first..first + self.per_brick {
                    let ke = self.matrix(e);
                    let scale = modulus[e];
                    for (i, &node) in self.connectivity(e).iter().enumerate() {
                        for axis in 0..3 {
                            let local = 3 * i + axis;
                            diagonal[node as usize * 3 + axis] += scale * ke[local * (self.width + 1)];
                        }
                    }
                }
            }
        }
        for (d, value) in diagonal.iter_mut().enumerate() {
            *value = if fixed[d] == 0 { value.recip() } else { 0. };
        }
    }

    pub fn apply(&self, input: &[f64], output: &mut [f64], fixed: &[u8], modulus: &[f64]) {
        output.fill(0.);
        self.dispatch::<false>(input, output, modulus);
        for (value, &clamped) in output.iter_mut().zip(fixed) {
            if clamped != 0 {
                *value = 0.;
            }
        }
    }

    pub fn energy(&self, input: &[f64], energy: &mut [f64]) {
        self.dispatch::<true>(input, energy, &[]);
    }

    fn dispatch<const ENERGY: bool>(&self, input: &[f64], output: &mut [f64], modulus: &[f64]) {
        if ENERGY && !self.compact.is_empty() {
            self.sweep::<12, 4, true, ENERGY>(input, output, modulus);
        } else if self.width == 12 {
            self.sweep::<12, 4, false, ENERGY>(input, output, modulus);
        } else {
            self.sweep::<24, 8, false, ENERGY>(input, output, modulus);
        }
    }

    fn sweep<const W: usize, const N: usize, const COMPACT: bool, const ENERGY: bool>(
        &self, input: &[f64], output: &mut [f64], modulus: &[f64],
    ) {
        for batch in self.coloring.batches() {
            // In a single work item the five tets of one brick run in order.
            for &item in batch {
                let first = item as usize * self.per_brick;
                for e in first..first + self.per_brick {
                    let nodes: &[u32; N] = self.connectivity(e).try_into().unwrap();
                    let q: [f64; W] = std::array::from_fn(|i| input[3 * nodes[i / 3] as usize + i % 3]);
                    let mut product = [0.; W];
                    if COMPACT {
                        compact_product(&self.compact[self.templates[e] as usize], &q, &mut product);
                    } else {
                        for (row, out) in self.matrix(e).chunks_exact(W).zip(&mut product) {
                            *out = row_dot::<W>(row, &q);
                        }
                    }
                    if ENERGY {
                        output[e] = row_dot::<W>(&product, &q);
                    } else {
                        let scale = modulus[e];
                        for (i, &node) in nodes.iter().enumerate() {
                            let d = 3 * node as usize;
                            let j = 3 * i;
                            output[d] += scale * product[j];
                            output[d + 1] += scale * product[j + 1];
                            output[d + 2] += scale * product[j + 2];
                        }
                    }
                }
            }
        }
    }
}

#[inline(always)]
fn row_dot<const W: usize>(a: &[f64], b: &[f64; W]) -> f64 {
    // Both inputs hold W values and all supported widths are divisible by four.
    unsafe {
        let mut x = f64x2_splat(0.);
        let mut y = x;
        for i in (0..W).step_by(4) {
            let left = a.as_ptr().add(i);
            let right = b.as_ptr().add(i);
            x = f64x2_add(x, f64x2_mul(v128_load(left.cast()), v128_load(right.cast())));
            y = f64x2_add(y, f64x2_mul(v128_load(left.add(2).cast()), v128_load(right.add(2).cast())));
        }
        let sum = f64x2_add(x, y);
        f64x2_extract_lane::<0>(sum) + f64x2_extract_lane::<1>(sum)
    }
}

#[inline]
fn compact_product(ke: &[[f64; 4]; 21], q: &[f64], out: &mut [f64]) {
    let mut sums = [f64x2_splat(0.); 6];
    let mut k = 0;
    for i in 0..6 {
        for j in i..6 {
            let [a, b, c, d] = ke[k];
            let direct = f64x2_add(f64x2_mul(f64x2(a, b), f64x2_splat(q[2 * j])),
                f64x2_mul(f64x2(c, d), f64x2_splat(q[2 * j + 1])));
            sums[i] = f64x2_add(sums[i], direct);
            if i != j {
                let transposed = f64x2_add(
                    f64x2_mul(f64x2(a, c), f64x2_splat(q[2 * i])),
                    f64x2_mul(f64x2(b, d), f64x2_splat(q[2 * i + 1])),
                );
                sums[j] = f64x2_add(sums[j], transposed);
            }
            k += 1;
        }
    }
    for (pair, value) in out.chunks_exact_mut(2).zip(sums) {
        pair[0] = f64x2_extract_lane::<0>(value);
        pair[1] = f64x2_extract_lane::<1>(value);
    }
}
