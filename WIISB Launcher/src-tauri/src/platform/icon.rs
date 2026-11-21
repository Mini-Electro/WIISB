//! Extracts a program's icon as PNG. The executable is only read as a resource container
//! (`PrivateExtractIconsW`), never run.

use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows_sys::Win32::Graphics::Gdi::{
    DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, PrivateExtractIconsW, HICON, ICONINFO};

/// Reads `bitmap` as top-down 32-bit BGRA. Returns (width, height, pixels).
unsafe fn read_bgra(bitmap: windows_sys::Win32::Graphics::Gdi::HBITMAP) -> Option<(u32, u32, Vec<u8>)> {
    let mut bm: BITMAP = std::mem::zeroed();
    if GetObjectW(bitmap, std::mem::size_of::<BITMAP>() as i32, &mut bm as *mut _ as *mut _) == 0 {
        return None;
    }
    let (w, h) = (bm.bmWidth, bm.bmHeight);
    if w <= 0 || h <= 0 || w > 1024 || h > 1024 {
        return None;
    }
    let mut info: BITMAPINFO = std::mem::zeroed();
    info.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w,
        biHeight: -h, // top-down
        biPlanes: 1,
        biBitCount: 32,
        biCompression: 0, // BI_RGB
        biSizeImage: 0,
        biXPelsPerMeter: 0,
        biYPelsPerMeter: 0,
        biClrUsed: 0,
        biClrImportant: 0,
    };
    let mut pixels = vec![0u8; (w * h * 4) as usize];
    let dc = GetDC(std::ptr::null_mut());
    let lines = GetDIBits(dc, bitmap, 0, h as u32, pixels.as_mut_ptr() as *mut _, &mut info, DIB_RGB_COLORS);
    ReleaseDC(std::ptr::null_mut(), dc);
    (lines != 0).then_some((w as u32, h as u32, pixels))
}

pub fn extract_icon_png(exe: &Path, size: i32) -> Option<Vec<u8>> {
    let wide: Vec<u16> = exe.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    unsafe {
        let mut hicon: HICON = std::ptr::null_mut();
        let mut id: u32 = 0;
        let n = PrivateExtractIconsW(wide.as_ptr(), 0, size, size, &mut hicon, &mut id, 1, 0);
        if n == 0 || n == u32::MAX || hicon.is_null() {
            return None;
        }
        let mut info: ICONINFO = std::mem::zeroed();
        let ok = GetIconInfo(hicon, &mut info) != 0;
        let result = if ok && !info.hbmColor.is_null() {
            read_bgra(info.hbmColor).and_then(|(w, h, mut px)| {
                // Old-style icons carry no alpha channel: use the 1-bit mask instead.
                if px.chunks_exact(4).all(|p| p[3] == 0) {
                    let mask = if info.hbmMask.is_null() { None } else { read_bgra(info.hbmMask) };
                    for (i, p) in px.chunks_exact_mut(4).enumerate() {
                        let opaque = mask.as_ref().map(|(_, _, m)| m[i * 4] == 0).unwrap_or(true);
                        p[3] = if opaque { 255 } else { 0 };
                    }
                }
                for p in px.chunks_exact_mut(4) {
                    p.swap(0, 2); // BGRA -> RGBA
                }
                let mut out = Vec::new();
                let mut enc = png::Encoder::new(&mut out, w, h);
                enc.set_color(png::ColorType::Rgba);
                enc.set_depth(png::BitDepth::Eight);
                let mut writer = enc.write_header().ok()?;
                writer.write_image_data(&px).ok()?;
                writer.finish().ok()?;
                Some(out)
            })
        } else {
            None
        };
        if ok {
            if !info.hbmColor.is_null() {
                DeleteObject(info.hbmColor);
            }
            if !info.hbmMask.is_null() {
                DeleteObject(info.hbmMask);
            }
        }
        DestroyIcon(hicon);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_a_real_icon_as_png_without_running_the_program() {
        let system = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let png = extract_icon_png(&Path::new(&system).join("System32").join("cmd.exe"), 256).expect("cmd.exe has an icon");
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        assert!(png.len() > 300);
        let dec = png::Decoder::new(std::io::Cursor::new(&png));
        let reader = dec.read_info().unwrap();
        let info = reader.info();
        assert!(info.width >= 16 && info.height >= 16);
    }

    #[test]
    fn files_without_icons_or_missing_files_give_none() {
        let d = tempfile::tempdir().unwrap();
        let fake = d.path().join("x.exe");
        std::fs::write(&fake, b"MZ not really").unwrap();
        assert!(extract_icon_png(&fake, 64).is_none());
        assert!(extract_icon_png(&d.path().join("nope.exe"), 64).is_none());
    }
}
