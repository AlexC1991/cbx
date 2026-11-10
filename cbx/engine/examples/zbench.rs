// Single-thread zstd speed on one file, per level: cargo run --release --example zbench -- <file>
fn main() {
    let path = std::env::args().nth(1).expect("file");
    let data = std::fs::read(path).unwrap();
    for level in [1, 3] {
        let t = std::time::Instant::now();
        let z = zstd::bulk::compress(&data, level).unwrap();
        let s = t.elapsed().as_secs_f64();
        println!("level {level}: {:.0} MB/s, {:.1}% of size", data.len() as f64 / 1e6 / s, 100.0 * z.len() as f64 / data.len() as f64);
    }
    let t = std::time::Instant::now();
    let d = cbx_engine::frame::sha256(&data);
    println!("sha256: {:.0} MB/s {}", data.len() as f64 / 1e6 / t.elapsed().as_secs_f64(), d[0]);
}
