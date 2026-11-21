// Actions that involve picking something on disk and linking it to a game.

import { api, AppError } from "@/services/api";
import { pickExecutable, pickFolder, pickImage } from "@/services/dialogs";
import { useApp } from "@/stores/appStore";

const st = () => useApp.getState();

/** Link whatever the user picked (a folder to search, or an .exe). */
export async function linkPath(slug: string, path: string, installDir?: string): Promise<boolean> {
  try {
    const res = await api.linkGame(slug, path, installDir);
    if (res.outcome === "linked" && res.game) {
      st().replaceGame(res.game);
      st().setModal(null);
      st().toast("success", `${res.game.title} linked`, res.game.launchTarget ?? undefined);
      return true;
    }
    st().setModal({ type: "candidates", slug, candidates: res.candidates });
    return false;
  } catch (e) {
    const err = e as AppError;
    st().toast("error", "Couldn't link that location", err.message);
    return false;
  }
}

/** "Locate Installation": native folder or executable picker, then validate + link. */
export async function locateGame(slug: string, kind: "folder" | "exe"): Promise<void> {
  const game = st().games.find((g) => g.slug === slug);
  if (!game) return;
  // The launcher works out the folder (the game's own folder in the library, else the library folder itself); a
  // path that doesn't exist makes Windows fall back to whatever folder it used last.
  const start = (await api.locateStartDir(slug).catch(() => null)) ?? undefined;
  const picked =
    kind === "folder"
      ? await pickFolder(`Select the ${game.title} installation folder`, start)
      : await pickExecutable(`Select the ${game.title} executable`, start);
  if (picked) await linkPath(slug, picked);
}

export async function chooseArtwork(slug: string): Promise<void> {
  try {
    const picked = await pickImage("Choose artwork");
    if (!picked) return;
    st().replaceGame(await api.setArtwork(slug, picked));
    st().toast("success", "Artwork updated");
  } catch (e) {
    st().toast("error", "Couldn't use that image", (e as Error).message);
  }
}

export async function resetArtwork(slug: string): Promise<void> {
  try {
    st().replaceGame(await api.clearArtwork(slug));
    st().toast("info", "Artwork reset to the generated placeholder");
  } catch (e) {
    st().toast("error", "Couldn't reset artwork", (e as Error).message);
  }
}

export async function unlink(slug: string): Promise<void> {
  try {
    st().replaceGame(await api.unlinkGame(slug));
    st().toast("info", "Installation unlinked");
  } catch (e) {
    st().toast("error", "Couldn't unlink", (e as Error).message);
  }
}

export async function reveal(kind: Parameters<typeof api.reveal>[0], slug?: string): Promise<void> {
  try {
    await api.reveal(kind, slug);
  } catch (e) {
    st().toast("error", "Couldn't open that folder", (e as Error).message);
  }
}
