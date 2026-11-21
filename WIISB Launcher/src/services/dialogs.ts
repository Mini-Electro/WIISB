// Native Windows file / folder pickers (via the Tauri dialog plugin).

import { open, save } from "@tauri-apps/plugin-dialog";

export async function pickFolder(title: string, defaultPath?: string): Promise<string | null> {
  const r = await open({ directory: true, multiple: false, title, defaultPath });
  return typeof r === "string" ? r : null;
}

export async function pickExecutable(title = "Select the game's executable", defaultPath?: string): Promise<string | null> {
  const r = await open({
    multiple: false,
    title,
    defaultPath,
    filters: [{ name: "Windows programs", extensions: ["exe"] }],
  });
  return typeof r === "string" ? r : null;
}

export async function pickShortcut(title = "Select a Windows shortcut"): Promise<string | null> {
  const r = await open({ multiple: false, title, filters: [{ name: "Shortcuts", extensions: ["lnk"] }] });
  return typeof r === "string" ? r : null;
}

export async function pickImage(title = "Choose artwork"): Promise<string | null> {
  const r = await open({
    multiple: false,
    title,
    filters: [{ name: "Images (PNG, JPG, WebP)", extensions: ["png", "jpg", "jpeg", "webp"] }],
  });
  return typeof r === "string" ? r : null;
}

export async function pickCsvDestination(): Promise<string | null> {
  return save({
    title: "Export session history",
    defaultPath: "wiisb-launcher-sessions.csv",
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
}
