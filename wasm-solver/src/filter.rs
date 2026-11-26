use std::slice;

#[unsafe(no_mangle)]
unsafe extern "C" fn filter_csr(
    rows: usize, count: usize, starts: *const u32, columns: *const u32, weights: *const f64,
    input: *const f64, output: *mut f64, transpose: u32,
) {
    unsafe {
        let starts = slice::from_raw_parts(starts, rows + 1);
        let length = starts[rows] as usize;
        let columns = slice::from_raw_parts(columns, length);
        let weights = slice::from_raw_parts(weights, length);
        let input = slice::from_raw_parts(input, count);
        let output = slice::from_raw_parts_mut(output, count);
        output.fill(0.);
        for (row, limits) in starts.windows(2).enumerate() {
            let range = limits[0] as usize..limits[1] as usize;
            let entries = columns[range.clone()].iter().zip(&weights[range]);
            if transpose == 0 {
                output[row] = entries.map(|(&j, &w)| w * input[j as usize]).sum();
            } else {
                let value = input[row];
                for (&j, &w) in entries { output[j as usize] += w * value; }
            }
        }
    }
}

// Structured CSR rows share the same relative column offsets inside each
// parity family. This preserves sparse filtering without materializing
// millions of repeated entries for large meshes or cone radii.
#[unsafe(no_mangle)]
unsafe extern "C" fn filter_stencil(
    nx: usize, ny: usize, nz: usize, per_cell: usize,
    starts: *const u32, offsets: *const i32, weights: *const f64,
    inverse: *const f64, input: *const f64, output: *mut f64, transpose: u32,
) {
    unsafe {
        let count = nx * ny * nz * per_cell;
        let starts = slice::from_raw_parts(starts, 2 * per_cell + 1);
        let length = starts[2 * per_cell] as usize;
        let offsets = slice::from_raw_parts(offsets.cast::<[i32; 4]>(), length);
        let weights = slice::from_raw_parts(weights, length);
        let inverse = slice::from_raw_parts(inverse, count);
        let input = slice::from_raw_parts(input, count);
        let output = slice::from_raw_parts_mut(output, count);
        output.fill(0.);
        let mut base = 0;
        for z in 0..nz {
            for y in 0..ny {
                for x in 0..nx {
                    let parity = (x + y + z) & 1;
                    for t in 0..per_cell {
                        let e = base + t;
                        if inverse[e] == 0. { continue; }
                        let row = parity * per_cell + t;
                        let range = starts[row] as usize..starts[row + 1] as usize;
                        let mut sum = 0.;
                        let value = input[e] * inverse[e];
                        for (&[dx, dy, dz, delta], &w) in offsets[range.clone()].iter().zip(&weights[range]) {
                            if (x as i32 + dx) as usize >= nx || (y as i32 + dy) as usize >= ny
                                || (z as i32 + dz) as usize >= nz { continue; }
                            let j = (base as i32 + delta) as usize;
                            if inverse[j] == 0. { continue; }
                            if transpose == 0 { sum += w * input[j]; }
                            else { output[j] += w * value; }
                        }
                        if transpose == 0 { output[e] = sum * inverse[e]; }
                    }
                    base += per_cell;
                }
            }
        }
    }
}
