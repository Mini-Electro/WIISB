#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod updates;
use tauri::{Emitter, Manager, menu::{Menu,MenuItem}, tray::TrayIconBuilder};
fn entry()->Result<keyring::Entry,String> { keyring::Entry::new("WIISB Chat", "session").map_err(|e|e.to_string()) }
#[tauri::command]
fn vault_set(value:String)->Result<(),String> {
 if value.len()>2000 { return Err("Session data is too large".into()); }
 entry()?.set_password(&value).map_err(|e|e.to_string())
}
#[tauri::command]
fn vault_get()->Result<Option<String>,String> {
 match entry()?.get_password() { Ok(value)=>Ok(Some(value)),Err(keyring::Error::NoEntry)=>Ok(None),Err(e)=>Err(e.to_string()) }
}
#[tauri::command]
fn vault_clear()->Result<(),String> {
 match entry()?.delete_credential() { Ok(())|Err(keyring::Error::NoEntry)=>Ok(()),Err(e)=>Err(e.to_string()) }
}
/// "Update automatically" is on unless this marker file exists in the app's data folder (the updater asks before every check).
fn auto_update_marker(app:&tauri::AppHandle)->Option<std::path::PathBuf> {app.path().app_local_data_dir().ok().map(|d|d.join("auto-update-off"))}
fn auto_update_on(app:&tauri::AppHandle)->bool {auto_update_marker(app).map_or(true,|p|!p.exists())}
#[tauri::command]
fn get_auto_update(app:tauri::AppHandle)->bool {auto_update_on(&app)}
#[tauri::command]
fn set_auto_update(app:tauri::AppHandle,enabled:bool)->Result<(),String> {
 let marker=auto_update_marker(&app).ok_or("No data folder")?;
 if enabled {match std::fs::remove_file(&marker) {Ok(())=>Ok(()),Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(()),Err(e)=>Err(e.to_string())}}
 else {if let Some(dir)=marker.parent() {std::fs::create_dir_all(dir).map_err(|e|e.to_string())?;} std::fs::write(&marker,"off").map_err(|e|e.to_string())}
}
/// Makes the window behave like a desktop app rather than a web page: no browser right-click menu, no developer
/// tools, no browser shortcuts (F5/Ctrl+R reload, Ctrl+P print, F12, Ctrl+Shift+I, Ctrl+U …), no zoom, no
/// status bar, no swipe/back navigation and no autofill pop-ups. Copy/paste keyboard shortcuts keep working and
/// the app draws its own small text-editing menu.
#[cfg(windows)]
fn lock_down(win:&tauri::WebviewWindow) {
 use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Settings3,ICoreWebView2Settings4,ICoreWebView2Settings6};
 use windows::core::Interface;
 let _=win.with_webview(|w| unsafe {
  let Ok(core)=w.controller().CoreWebView2() else {return};
  let Ok(s)=core.Settings() else {return};
  let _=s.SetAreDefaultContextMenusEnabled(false);
  let _=s.SetAreDevToolsEnabled(false);
  let _=s.SetIsStatusBarEnabled(false);
  let _=s.SetIsZoomControlEnabled(false);
  if let Ok(s3)=s.cast::<ICoreWebView2Settings3>() {let _=s3.SetAreBrowserAcceleratorKeysEnabled(false);}
  if let Ok(s4)=s.cast::<ICoreWebView2Settings4>() {let _=s4.SetIsGeneralAutofillEnabled(false);let _=s4.SetIsPasswordAutosaveEnabled(false);}
  if let Ok(s6)=s.cast::<ICoreWebView2Settings6>() {let _=s6.SetIsSwipeNavigationEnabled(false);}
 });
}
fn show(app:&tauri::AppHandle) {if let Some(win)=app.get_webview_window("main") {let _=win.show();let _=win.unminimize();let _=win.set_focus();}}
fn main() {
 tauri::Builder::default()
  .plugin(tauri_plugin_single_instance::init(|app,_,_|show(app)))
  .plugin(tauri_plugin_notification::init())
  .plugin(tauri_plugin_autostart::Builder::new().build())
  .plugin(tauri_plugin_updater::Builder::new().build())
  .setup(|app| {
   updates::start(app.handle(),auto_update_on);
   let open=MenuItem::with_id(app,"open","Open WIISB Chat",true,None::<&str>)?;
   let settings=MenuItem::with_id(app,"settings","Settings",true,None::<&str>)?;
   let quit=MenuItem::with_id(app,"quit","Quit",true,None::<&str>)?;
   let menu=Menu::with_items(app,&[&open,&settings,&quit])?;
   TrayIconBuilder::new().icon(app.default_window_icon().unwrap().clone()).tooltip("WIISB Chat").menu(&menu).on_menu_event(|app,event|match event.id.as_ref(){
    "open"=>show(app),"settings"=>{show(app);let _=app.emit("open-settings",());},"quit"=>app.exit(0),_=>{}
   }).build(app)?;
   #[cfg(windows)]
   if let Some(win)=app.get_webview_window("main") {lock_down(&win);}
   Ok(())
  })
  .on_window_event(|win,event|{if let tauri::WindowEvent::CloseRequested{api,..}=event {api.prevent_close();let _=win.hide();}})
  .invoke_handler(tauri::generate_handler![vault_get,vault_set,vault_clear,updates::pending_update,updates::install_update,updates::check_for_updates,get_auto_update,set_auto_update])
  .run(tauri::generate_context!()).expect("Unable to run WIISB Chat");
}

#[cfg(test)]
mod tests {
 #[test]
 fn rejects_oversized_vault_payload_without_touching_credentials() {
  assert!(super::vault_set("x".repeat(2001)).is_err());
 }
 #[test]
 #[cfg(windows)]
 fn windows_credential_manager_roundtrip() {
  let unique=format!("test-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
  let entry=keyring::Entry::new("WIISB Chat integration tests",&unique).unwrap();
  entry.set_password("nonsecret-integration-test-value").unwrap();
  let reopened=keyring::Entry::new("WIISB Chat integration tests",&unique).unwrap();
  let actual=reopened.get_password();
  let cleanup=entry.delete_credential();
  assert_eq!(actual.unwrap(),"nonsecret-integration-test-value");cleanup.unwrap();
 }
}
