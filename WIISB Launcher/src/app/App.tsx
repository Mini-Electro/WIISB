import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useApp } from "@/stores/appStore";
import { api } from "@/services/api";
import { useMotionScale, useOsReducedMotion } from "@/hooks/hooks";
import { applyAppearance, rememberBootColour } from "@/utils/theme";
import { installRipples } from "@/utils/ripple";
import { Banners, Sidebar, ToastHost, TopBar } from "@/components/shell";
import { ModalHost } from "@/features/ModalHost";
import { HomePage } from "@/pages/Home";
import { LibraryPage, RecentPage } from "@/pages/Library";
import { StatsPage } from "@/pages/Stats";
import { OtherPage } from "@/pages/Other";
import { SettingsPage } from "@/pages/Settings";
import { GameDetailPage } from "@/pages/GameDetail";
import { Button } from "@/components/ui";
import { Logo } from "@/components/common";
import type { Page } from "@/types";

const SHORTCUT_PAGES: Page[] = ["home", "library", "recent", "favourites", "stats", "settings", "other"];

function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useApp.getState();
      const ctrl = e.ctrlKey || e.metaKey;
      const typing = (e.target as HTMLElement)?.matches?.("input, textarea, select");
      if (ctrl && (e.key.toLowerCase() === "k" || e.key.toLowerCase() === "f")) {
        e.preventDefault();
        window.dispatchEvent(new Event("wiisb:focus-search"));
      } else if (ctrl && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (st.settings) void st.patchSettings({ sidebarCollapsed: !st.settings.sidebarCollapsed });
      } else if (ctrl && e.key === ",") {
        e.preventDefault();
        st.navigate("settings");
      } else if (ctrl && /^[1-6]$/.test(e.key)) {
        e.preventDefault();
        st.navigate(SHORTCUT_PAGES[Number(e.key) - 1]);
      } else if ((e.altKey && e.key === "ArrowLeft") || (e.key === "Escape" && !typing && st.page === "game" && !st.modal)) {
        e.preventDefault();
        st.goBack();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function Pages() {
  const page = useApp((s) => s.page);
  const slug = useApp((s) => s.gameSlug);
  const scale = useMotionScale();
  const key = page === "game" ? `game:${slug}` : page;
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={key}
        initial={{ opacity: 0, y: 10 * scale }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.16 * scale }}
        className="min-h-full"
      >
        {page === "home" && <HomePage />}
        {page === "library" && <LibraryPage variant="library" />}
        {page === "favourites" && <LibraryPage variant="favourites" />}
        {page === "recent" && <RecentPage />}
        {page === "stats" && <StatsPage />}
        {page === "other" && <OtherPage />}
        {page === "settings" && <SettingsPage />}
        {page === "game" && <GameDetailPage />}
      </motion.div>
    </AnimatePresence>
  );
}

export function App() {
  const ready = useApp((s) => s.ready);
  const bootError = useApp((s) => s.bootError);
  const settings = useApp((s) => s.settings);
  const osReduced = useOsReducedMotion();
  useGlobalShortcuts();

  useEffect(() => installRipples(), []);

  useEffect(() => {
    void useApp.getState().init();
  }, []);

  useEffect(() => {
    if (settings) {
      applyAppearance(settings, osReduced);
      rememberBootColour();
    }
  }, [settings, osReduced]);

  // Hide the static boot splash once the first real render is ready.
  useEffect(() => {
    if (!ready) return;
    const boot = document.getElementById("boot");
    if (!boot) return;
    boot.style.opacity = "0";
    const t = window.setTimeout(() => boot.remove(), 400);
    return () => window.clearTimeout(t);
  }, [ready]);

  // When the window regains focus, adopt games that were started outside the launcher.
  useEffect(() => {
    let un: (() => void) | undefined;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) void api.detectRunning().then((list) => useApp.setState({ runtime: Object.fromEntries(list.map((r) => [r.slug, r])) })).catch(() => {});
      })
      .then((u) => (un = u));
    return () => un?.();
  }, []);

  if (bootError) {
    return (
      <div className="grid h-full place-items-center p-8">
        <div className="panel max-w-lg p-8 text-center">
          <Logo size={56} className="mx-auto" />
          <h1 className="display mt-4 text-2xl font-bold">WIISB Launcher couldn't start</h1>
          <p className="mt-2 text-sm text-muted">{bootError}</p>
          <p className="mt-1 text-xs text-muted">Your game files were not touched. Details are in the technical log.</p>
          <Button className="mt-5" variant="primary" onClick={() => window.location.reload()}>Try again</Button>
        </div>
      </div>
    );
  }
  if (!ready || !settings) return null;

  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <Banners />
        <main className="min-h-0 flex-1 overflow-y-auto scroll-smooth">
          <Pages />
        </main>
      </div>
      <ModalHost />
      <ToastHost />
    </div>
  );
}
