//! Fixed WIISB Chat integration. Never executes a shell or accepts an arbitrary command.
use std::path::{Path,PathBuf};
use crate::error::{AppError,AppResult};

fn candidates() -> Vec<PathBuf> {
 let mut paths=Vec::new();
 if let Some(local)=std::env::var_os("LOCALAPPDATA") { paths.push(PathBuf::from(local).join("WIISB Chat").join("WIISB Chat.exe")); }
 if let Ok(exe)=std::env::current_exe() { if let Some(parent)=exe.parent() {paths.push(parent.join("WIISB Chat").join("WIISB Chat.exe"));} }
 // The independent development build remains launchable without installing it first.
 if let Some(workspace)=Path::new(env!("CARGO_MANIFEST_DIR")).parent().and_then(Path::parent) {
  paths.push(workspace.join("WIISB Chat").join("release").join("WIISB Chat.exe"));
  paths.push(workspace.join("WIISB Chat").join("apps").join("desktop").join("src-tauri").join("target").join("release").join("WIISB Chat.exe"));
 }
 #[cfg(windows)] {
  for root in [windows_sys::Win32::System::Registry::HKEY_CURRENT_USER,windows_sys::Win32::System::Registry::HKEY_LOCAL_MACHINE] {
   if let Some(folder)=install_location(root) {paths.insert(0,PathBuf::from(folder).join("WIISB Chat.exe"));}
  }
 }
 paths
}
#[cfg(windows)]
fn install_location(root:windows_sys::Win32::System::Registry::HKEY)->Option<String> {
 use windows_sys::Win32::System::Registry::{RegGetValueW,RRF_RT_REG_SZ};
 let key:Vec<u16>="Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WIISB Chat\0".encode_utf16().collect();
 let value:Vec<u16>="InstallLocation\0".encode_utf16().collect();
 let mut buf=vec![0u16;32768];let mut bytes=(buf.len()*2) as u32;
 let status=unsafe{RegGetValueW(root,key.as_ptr(),value.as_ptr(),RRF_RT_REG_SZ,std::ptr::null_mut(),buf.as_mut_ptr().cast(),&mut bytes)};
 if status!=0{return None;}let end=buf.iter().position(|c|*c==0).unwrap_or(buf.len());Some(String::from_utf16_lossy(&buf[..end]))
}
#[tauri::command]
pub fn chat_installation()->Option<String> {candidates().into_iter().find(|p|p.is_file()).map(|p|p.to_string_lossy().into_owned())}
#[tauri::command]
pub fn launch_wiisb_chat()->AppResult<()> {
 let path=candidates().into_iter().find(|p|p.is_file()).ok_or_else(||AppError::NotFound("WIISB Chat is not installed. Run the WIISB Chat installer, then try again.".into()))?;
 let mut command=std::process::Command::new(&path);if let Some(parent)=path.parent(){command.current_dir(parent);}
 #[cfg(windows)] {use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
 command.spawn().map_err(|e|AppError::LaunchFailed(format!("WIISB Chat could not start: {}",crate::error::friendly_io(&e))))?;Ok(())
}
