//! `tmap kit img`: shrink, crop, grid and diff images before an agent reads them.

use super::util::die;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder};
use image::imageops::FilterType;
use image::{ColorType, DynamicImage, ImageDecoder, ImageFormat, ImageReader, Rgb, RgbImage};
use std::path::Path;

const HELP: &str = "Image one-liners. Shrink before you Read: every image stays in context all session.

  tmap kit img info FILE...                    size, mode, bytes, format
  tmap kit img fit FILE [MAXPX=1280] [OUT]     downscale to fit MAXPX, save JPEG q80 (or PNG if alpha); prints OUT
  tmap kit img crop FILE x,y,w,h [OUT]         crop region (pixels or 0-1 fractions); prints OUT
  tmap kit img grid FILE [N=4]                 copy with an N x N labeled grid, to pick a crop region; prints OUT
  tmap kit img diff A B [OUT]                  pixel diff: changed %, bbox, and a highlight image
  tmap kit img convert FILE OUT                format from OUT's extension

OUT defaults to $TMPDIR/img-<name>-<op>.<ext>.
";

fn fail(m: String) -> ! {
    die("img", &m, 2)
}

fn reader(f: &str) -> ImageReader<std::io::BufReader<std::fs::File>> {
    ImageReader::open(f).and_then(|r| r.with_guessed_format()).unwrap_or_else(|e| die("img", &format!("{f}: {e}"), 1))
}

/// Tokens Claude spends on an image: long edge scaled to at most 1568 px, then about w*h/750.
pub fn image_tokens(w: u32, h: u32) -> u64 {
    let s = (1568.0 / w.max(h).max(1) as f64).min(1.0);
    ((w as f64 * s) * (h as f64 * s) / 750.0).ceil() as u64
}

fn open(f: &str) -> DynamicImage {
    let im = reader(f).decode().unwrap_or_else(|e| die("img", &format!("{f}: {e}"), 1));
    super::util::note_raw_tokens(image_tokens(im.width(), im.height()));
    im
}

fn kb(p: &str) -> u64 {
    std::fs::metadata(p).map(|m| m.len() / 1024).unwrap_or(0)
}

/// `$TMPDIR/img-<stem>-<op><ext>`; `ext` None keeps the input's extension.
fn outpath(f: &str, op: &str, ext: Option<&str>, given: Option<&String>) -> String {
    if let Some(g) = given {
        return g.clone();
    }
    let p = Path::new(f);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let e = ext.map(str::to_string).unwrap_or_else(|| p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default());
    std::env::temp_dir().join(format!("img-{stem}-{op}{e}")).to_string_lossy().into_owned()
}

/// JPEG q80 (RGB or L), PNG at best compression, anything else by extension.
fn save(im: &DynamicImage, out: &str) {
    // The model reads the saved image next.
    super::util::note_out_tokens(image_tokens(im.width(), im.height()));
    let lo = out.to_lowercase();
    let jpeg = lo.ends_with(".jpg") || lo.ends_with(".jpeg");
    let im = if jpeg && !matches!(im.color(), ColorType::Rgb8 | ColorType::L8) {
        DynamicImage::ImageRgb8(im.to_rgb8())
    } else if lo.ends_with(".png") && matches!(im.color(), ColorType::Rgb32F | ColorType::Rgba32F) {
        DynamicImage::ImageRgba8(im.to_rgba8())
    } else {
        im.clone()
    };
    let res = (|| -> image::ImageResult<()> {
        if jpeg {
            im.write_with_encoder(JpegEncoder::new_with_quality(std::fs::File::create(out)?, 80))
        } else if lo.ends_with(".png") {
            im.write_with_encoder(PngEncoder::new_with_quality(std::fs::File::create(out)?, CompressionType::Best, PngFilter::Adaptive))
        } else {
            im.save(out)
        }
    })();
    if let Err(e) = res {
        die("img", &format!("{out}: {e}"), 1);
    }
    println!("{out}  {}x{}  {}KB", im.width(), im.height(), kb(out));
}

/// PIL `thumbnail` size: fit inside mx x mx, keep aspect, never enlarge.
fn thumb_size(w: u32, h: u32, mx: u32) -> (u32, u32) {
    let (mut x, mut y) = (mx.min(w) as f64, mx.min(h) as f64);
    let aspect = w as f64 / h as f64;
    let round = |n: f64, key: &dyn Fn(f64) -> f64| {
        let (a, b) = (n.floor(), n.ceil());
        (if key(b) < key(a) { b } else { a }).max(1.0)
    };
    if x / y >= aspect {
        x = round(y * aspect, &|n| (aspect - n / y).abs());
    } else {
        y = round(x / aspect, &|n| if n == 0.0 { 0.0 } else { (aspect - x / n).abs() });
    }
    (x as u32, y as u32)
}

fn thumbnail(im: DynamicImage, mx: u32) -> DynamicImage {
    let (w, h) = thumb_size(im.width(), im.height(), mx);
    if w >= im.width() && h >= im.height() { im } else { im.resize_exact(w, h, FilterType::CatmullRom) }
}

/// PIL-style crop: the box may leave the image; outside pixels are zero.
fn crop(im: &DynamicImage, x0: i64, y0: i64, x1: i64, y1: i64) -> DynamicImage {
    let (w, h) = ((x1 - x0).max(0) as u32, (y1 - y0).max(0) as u32);
    let mut out = DynamicImage::new(w, h, im.color());
    let (sx, sy) = (x0.max(0), y0.max(0));
    let (ex, ey) = (x1.min(im.width() as i64), y1.min(im.height() as i64));
    if ex > sx && ey > sy {
        let part = im.crop_imm(sx as u32, sy as u32, (ex - sx) as u32, (ey - sy) as u32);
        image::imageops::replace(&mut out, &part, sx - x0, sy - y0);
    }
    out
}

/// 3x5 glyphs for grid labels (PIL uses its default font; this is a tiny built-in one).
fn glyph(c: char) -> [u8; 5] {
    match c {
        '0' => [7, 5, 5, 5, 7],
        '1' => [2, 6, 2, 2, 7],
        '2' => [7, 1, 7, 4, 7],
        '3' => [7, 1, 7, 1, 7],
        '4' => [5, 5, 7, 1, 1],
        '5' => [7, 4, 7, 1, 7],
        '6' => [7, 4, 7, 5, 7],
        '7' => [7, 1, 1, 1, 1],
        '8' => [7, 5, 7, 5, 7],
        '9' => [7, 5, 7, 1, 7],
        '.' => [0, 0, 0, 0, 2],
        ',' => [0, 0, 0, 2, 4],
        _ => [0; 5],
    }
}

const MAGENTA: Rgb<u8> = Rgb([255, 0, 255]);

fn put(im: &mut RgbImage, x: i64, y: i64, c: Rgb<u8>) {
    if x >= 0 && y >= 0 && (x as u32) < im.width() && (y as u32) < im.height() {
        im.put_pixel(x as u32, y as u32, c);
    }
}

/// Draw `s` at (x, y) with d x d-pixel dots, 4d px per character.
fn text(im: &mut RgbImage, x: i64, y: i64, s: &str, d: i64) {
    for (i, ch) in s.chars().enumerate() {
        for (r, bits) in glyph(ch).iter().enumerate() {
            for col in 0..3 {
                if bits >> (2 - col) & 1 == 1 {
                    for (dx, dy) in (0..d).flat_map(|dx| (0..d).map(move |dy| (dx, dy))) {
                        put(im, x + (i as i64 * 4 + col) * d + dx, y + r as i64 * d + dy, MAGENTA);
                    }
                }
            }
        }
    }
}

/// Magenta grid lines and a "col,row" fraction label per cell, both scaled so they survive the 1280 px thumbnail.
fn grid(im: &DynamicImage, n: u32) -> RgbImage {
    let mut im = im.to_rgb8();
    let (w, h) = (im.width() as i64, im.height() as i64);
    let (n, k) = (n.max(1) as i64, ((w.max(h) + 1279) / 1280).max(1));
    for i in 1..n {
        let (x, y) = (w * i / n, h * i / n);
        for d in -k..k {
            (0..h).for_each(|yy| put(&mut im, x + d, yy, MAGENTA));
            (0..w).for_each(|xx| put(&mut im, xx, y + d, MAGENTA));
        }
    }
    for r in 0..n {
        for c in 0..n {
            let label = format!("{:.2},{:.2}", c as f64 / n as f64, r as f64 / n as f64);
            text(&mut im, w * c / n + 4 * k, h * r / n + 4 * k, &label, 2 * k);
        }
    }
    im
}

type BBox = Option<(u32, u32, u32, u32)>;

/// Changed % (PIL luma of the abs difference > 16), bbox of any difference, and the highlight image.
fn diff(a: &RgbImage, b: &RgbImage) -> (f64, BBox, RgbImage) {
    let mut hl = a.clone();
    let (mut changed, mut bb): (u64, BBox) = (0, None);
    for (x, y, pa) in a.enumerate_pixels() {
        let pb = b.get_pixel(x, y);
        let d: [u32; 3] = std::array::from_fn(|i| pa[i].abs_diff(pb[i]) as u32);
        if d.iter().any(|&v| v > 0) {
            bb = Some(match bb {
                None => (x, y, x + 1, y + 1),
                Some((l, t, r, btm)) => (l.min(x), t.min(y), r.max(x + 1), btm.max(y + 1)),
            });
        }
        if (d[0] * 19595 + d[1] * 38470 + d[2] * 7471 + 0x8000) >> 16 > 16 {
            changed += 1;
            hl.put_pixel(x, y, Rgb([255, 0, 0]));
        }
    }
    (100.0 * changed as f64 / (a.width() as f64 * a.height() as f64).max(1.0), bb, hl)
}

/// PIL mode names (palette images are decoded to RGB/RGBA, so "P" never shows).
fn mode(c: ColorType) -> String {
    match c {
        ColorType::L8 => "L".into(),
        ColorType::La8 => "LA".into(),
        ColorType::Rgb8 => "RGB".into(),
        ColorType::Rgba8 => "RGBA".into(),
        ColorType::L16 => "I;16".into(),
        ColorType::La16 => "LA;16".into(),
        ColorType::Rgb16 => "RGB;16".into(),
        ColorType::Rgba16 => "RGBA;16".into(),
        ColorType::Rgb32F => "RGBF".into(),
        ColorType::Rgba32F => "RGBAF".into(),
        c => format!("{c:?}"),
    }
}

/// Header-only read: no full decode.
fn info(f: &str) -> String {
    let r = reader(f);
    let fmt = match r.format() {
        Some(ImageFormat::Jpeg) => "JPEG".to_string(),
        Some(x) => format!("{x:?}").to_uppercase(),
        None => "?".to_string(),
    };
    let d = r.into_decoder().unwrap_or_else(|e| die("img", &format!("{f}: {e}"), 1));
    let (w, h) = d.dimensions();
    format!("{f}  {w}x{h}  {}  {fmt}  {}KB", mode(d.color_type()), kb(f))
}

fn num(s: Option<&String>, def: u32) -> u32 {
    s.map(|v| v.parse().unwrap_or_else(|_| fail(format!("not a number: {v}")))).unwrap_or(def)
}

pub fn main(a: Vec<String>) -> i32 {
    let help = a.first().is_some_and(|x| x == "-h" || x == "--help");
    if a.len() < 2 || help {
        println!("{HELP}");
        return if help { 0 } else { 2 };
    }
    let f = &a[1];
    match a[0].as_str() {
        "info" => a[1..].iter().for_each(|f| println!("{}", info(f))),
        "fit" => {
            let im = open(f);
            let ext = if im.color().has_alpha() { ".png" } else { ".jpg" };
            save(&thumbnail(im, num(a.get(2), 1280)), &outpath(f, "fit", Some(ext), a.get(3)));
        }
        "crop" => {
            let im = open(f);
            let v: Vec<f64> = a.get(2).and_then(|s| s.split(',').map(|x| x.trim().parse().ok()).collect()).unwrap_or_default();
            if v.len() != 4 {
                fail("crop needs x,y,w,h".into());
            }
            let (mut x, mut y, mut w, mut h) = (v[0], v[1], v[2], v[3]);
            if v.iter().all(|&n| n <= 1.0) {
                let (iw, ih) = (im.width() as f64, im.height() as f64);
                (x, y, w, h) = (x * iw, y * ih, w * iw, h * ih);
            }
            save(&crop(&im, x as i64, y as i64, (x + w) as i64, (y + h) as i64), &outpath(f, "crop", None, a.get(3)));
        }
        "grid" => {
            let g = DynamicImage::ImageRgb8(grid(&open(f), num(a.get(2), 4)));
            save(&thumbnail(g, 1280), &outpath(f, "grid", Some(".jpg"), None));
        }
        "diff" => {
            if a.len() < 3 {
                fail("diff needs A B".into());
            }
            let (ia, ib) = (open(&a[1]).to_rgb8(), open(&a[2]).to_rgb8());
            if ia.dimensions() != ib.dimensions() {
                fail(format!("sizes differ: {:?} vs {:?}", ia.dimensions(), ib.dimensions()));
            }
            let (pct, bb, hl) = diff(&ia, &ib);
            let bs = bb.map(|(l, t, r, b)| format!("({l}, {t}, {r}, {b})")).unwrap_or_else(|| "None".into());
            println!("changed {pct:.2}%  bbox {bs}");
            if bb.is_some() {
                save(&thumbnail(DynamicImage::ImageRgb8(hl), 1280), &outpath(&a[1], "diff", Some(".jpg"), a.get(3)));
            }
        }
        "convert" => {
            if a.len() < 3 {
                fail("convert needs FILE OUT".into());
            }
            save(&open(f), &a[2]);
        }
        c => fail(format!("unknown command {c}")),
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thumb_sizes_match_pil() {
        assert_eq!(thumb_size(4000, 3000, 1280), (1280, 960));
        assert_eq!(thumb_size(3000, 4000, 1280), (960, 1280));
        assert_eq!(thumb_size(100, 50, 1280), (100, 50));
        assert_eq!(thumb_size(1999, 1000, 1280), (1280, 640));
    }

    #[test]
    fn crop_pads_outside() {
        let im = DynamicImage::ImageRgb8(RgbImage::from_pixel(10, 10, Rgb([9, 9, 9])));
        let c = crop(&im, 5, 5, 15, 12).to_rgb8();
        assert_eq!(c.dimensions(), (10, 7));
        assert_eq!(c.get_pixel(0, 0), &Rgb([9, 9, 9]));
        assert_eq!(c.get_pixel(9, 6), &Rgb([0, 0, 0]));
    }

    #[test]
    fn diff_and_grid() {
        let a = RgbImage::from_pixel(20, 10, Rgb([0, 0, 0]));
        let mut b = a.clone();
        b.put_pixel(3, 4, Rgb([255, 255, 255]));
        b.put_pixel(7, 2, Rgb([5, 0, 0]));
        let (pct, bb, hl) = diff(&a, &b);
        assert_eq!(bb, Some((3, 2, 8, 5)));
        assert!((pct - 0.5).abs() < 1e-9);
        assert_eq!(hl.get_pixel(3, 4), &Rgb([255, 0, 0]));
        assert_eq!(hl.get_pixel(7, 2), &Rgb([0, 0, 0]));
        let g = grid(&DynamicImage::ImageRgb8(RgbImage::new(100, 100)), 4);
        assert_eq!(g.get_pixel(25, 50), &MAGENTA);
        assert_eq!(g.get_pixel(24, 90), &MAGENTA);
        assert_eq!(g.get_pixel(10, 90), &Rgb([0, 0, 0]));
        assert_eq!(g.get_pixel(4, 4), &MAGENTA); // first stroke of the "0.00,0.00" label
    }

    #[test]
    fn fit_saves_png_with_alpha() {
        let src = std::env::temp_dir().join("tforge-img-test-a.png").to_string_lossy().into_owned();
        DynamicImage::ImageRgba8(image::RgbaImage::new(3000, 1500)).save(&src).unwrap();
        assert!(info(&src).contains("3000x1500  RGBA  PNG"));
        let out = outpath(&src, "fit", Some(".png"), None);
        save(&thumbnail(open(&src), 1280), &out);
        assert_eq!(image::image_dimensions(&out).unwrap(), (1280, 640));
        assert!(outpath("/x/shot.png", "crop", None, None).ends_with("img-shot-crop.png"));
    }
}
