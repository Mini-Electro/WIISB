//! Thin, safe wrappers over the few Windows APIs the launcher needs.

use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::path::Path;

use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetFileVersionInfoSizeW, GetFileVersionInfoW, GetLogicalDrives, VerQueryValueW};
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::System::Threading::{GetCurrentThread, OpenProcess, SetThreadPriority, TerminateProcess};
use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};

const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

/// Symlinks, junctions and other reparse points are never followed by the scanner.
pub fn is_reparse_point(meta: &std::fs::Metadata) -> bool {
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

/// Does the drive/root of this path exist? Used to tell "drive unplugged" from "folder missing".
pub fn drive_available(path: &Path) -> bool {
    match path.components().next() {
        Some(std::path::Component::Prefix(p)) => {
            let mut root = p.as_os_str().to_os_string();
            root.push("\\");
            Path::new(&root).exists()
        }
        _ => true,
    }
}

#[derive(Debug, Default, Clone)]
pub struct VersionInfo {
    pub product_name: Option<String>,
    pub file_description: Option<String>,
}

fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
    s.encode_wide().chain(std::iter::once(0)).collect()
}

fn wide_str(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Reads the PE version resource. This maps the file as *data* — nothing is executed.
pub fn read_version_info(path: &Path) -> VersionInfo {
    let path_w = wide(path.as_os_str());
    unsafe {
        let size = GetFileVersionInfoSizeW(path_w.as_ptr(), std::ptr::null_mut());
        if size == 0 || size > 4 * 1024 * 1024 {
            return VersionInfo::default();
        }
        let mut buf = vec![0u8; size as usize];
        if GetFileVersionInfoW(path_w.as_ptr(), 0, size, buf.as_mut_ptr() as *mut c_void) == 0 {
            return VersionInfo::default();
        }

        // Find the first language/codepage pair, falling back to US English.
        let mut lang_cp = String::from("040904B0");
        let mut ptr: *mut c_void = std::ptr::null_mut();
        let mut len: u32 = 0;
        let q = wide_str("\\VarFileInfo\\Translation");
        if VerQueryValueW(buf.as_ptr() as *const c_void, q.as_ptr(), &mut ptr, &mut len) != 0 && len >= 4 && !ptr.is_null() {
            let words = std::slice::from_raw_parts(ptr as *const u16, 2);
            lang_cp = format!("{:04X}{:04X}", words[0], words[1]);
        }

        let query = |name: &str| -> Option<String> {
            let sub = wide_str(&format!("\\StringFileInfo\\{lang_cp}\\{name}"));
            let mut p: *mut c_void = std::ptr::null_mut();
            let mut l: u32 = 0;
            if VerQueryValueW(buf.as_ptr() as *const c_void, sub.as_ptr(), &mut p, &mut l) == 0 || l == 0 || p.is_null() {
                return None;
            }
            let s = std::slice::from_raw_parts(p as *const u16, l as usize);
            let end = s.iter().position(|&c| c == 0).unwrap_or(s.len());
            let text = String::from_utf16_lossy(&s[..end]).trim().to_string();
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        };

        VersionInfo { product_name: query("ProductName"), file_description: query("FileDescription") }
    }
}

/// Strip the `\\?\` prefix Windows sometimes adds, so paths compare and display cleanly.
pub fn clean_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

/// Local disks a whole-PC scan may read: fixed and removable drives (never network or optical drives).
pub fn local_drives() -> Vec<std::path::PathBuf> {
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    let mask = unsafe { GetLogicalDrives() };
    (0..26u32)
        .filter(|i| mask & (1 << i) != 0)
        .filter_map(|i| {
            let root = format!("{}:\\", (b'A' + i as u8) as char);
            let w = wide_str(&root);
            let kind = unsafe { GetDriveTypeW(w.as_ptr()) };
            ((kind == DRIVE_FIXED || kind == DRIVE_REMOVABLE) && Path::new(&root).is_dir()).then(|| std::path::PathBuf::from(root))
        })
        .collect()
}

/// Puts the *calling thread* in background mode: lower CPU **and disk** priority, so a long scan
/// never competes with a game or anything else you are doing.
pub fn enter_background_mode() {
    const THREAD_MODE_BACKGROUND_BEGIN: i32 = 0x0001_0000;
    unsafe {
        SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN);
    }
}

/// Ends a process immediately (the "force stop"). Returns false if Windows refuses, e.g. for a program
/// running as administrator. The caller only ever passes PIDs of the game's own processes.
pub fn terminate_process(pid: u32) -> bool {
    const PROCESS_TERMINATE: u32 = 0x0001;
    unsafe {
        let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if h.is_null() {
            return false;
        }
        let ok = TerminateProcess(h, 1) != 0;
        CloseHandle(h);
        ok
    }
}

/// Reads a string value from `HKEY_CURRENT_USER` (read-only).
pub fn read_registry_string(subkey: &str, value: &str) -> Option<String> {
    let sk = wide_str(subkey);
    let v = wide_str(value);
    unsafe {
        let mut len: u32 = 0;
        if RegGetValueW(HKEY_CURRENT_USER, sk.as_ptr(), v.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), std::ptr::null_mut(), &mut len) != 0 || len == 0 {
            return None;
        }
        let mut buf = vec![0u16; len as usize / 2 + 2];
        let mut len2 = (buf.len() * 2) as u32;
        if RegGetValueW(HKEY_CURRENT_USER, sk.as_ptr(), v.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr() as *mut c_void, &mut len2) != 0 {
            return None;
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let s = String::from_utf16_lossy(&buf[..end]);
        (!s.is_empty()).then_some(s)
    }
}
