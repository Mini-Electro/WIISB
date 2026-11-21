import { useEffect, useRef, useState } from "react";
import { isTauri, invoke } from "@tauri-apps/api/core";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { requestPermission } from "@tauri-apps/plugin-notification";
import {
  Save,
  Upload,
  Download,
  LogOut,
  Trash2,
  Shield,
  Palette,
  SlidersHorizontal,
  UserCircle,
  KeyRound,
  Server,
  Monitor,
} from "lucide-react";
import { api } from "../api";
import type { User } from "../types";
import {
  themes,
  loadTheme,
  applyTheme,
  themeSchema,
  savedThemes,
  type Theme,
} from "../themes";
import {
  Modal,
  Field,
  Avatar,
  ProfileBanner,
  ErrorText,
  useTask,
} from "./UI";
import { EmailLink } from "./EmailLink";

type SliderRow = [label: string, value: number, min: number, max: number, step: number, key: string];
/** A group of range sliders (zoom, position, height) for one picture, with a reset button. */
function FramingSliders({
  title,
  values,
  disabled,
  onChange,
  onReset,
}: {
  title: string;
  values: SliderRow[];
  disabled: boolean;
  onChange: (key: string, value: number) => void;
  onReset: () => void;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend>{title}</legend>
      {disabled && <p className="muted">Upload a picture first.</p>}
      {values.map(([label, value, min, max, step, key]) => (
        <label key={key} className="slider-row">
          <span>{label}</span>
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => onChange(key, Number(e.target.value))}
          />
          <output>{key.endsWith("zoom") ? value.toFixed(2) + "×" : key.endsWith("height") ? value + " px" : Math.round(value) + "%"}</output>
        </label>
      ))}
      <button type="button" className="text-button muted" onClick={onReset}>
        Reset {title.toLowerCase()}
      </button>
    </fieldset>
  );
}
export function Settings({
  me,
  onClose,
  onUser,
  onLogout,
}: {
  me: User;
  onClose: () => void;
  onUser: (u: User) => void;
  onLogout: () => void;
}) {
  const [tab, setTab] = useState("Profile"),
    [profile, setProfile] = useState(me),
    [theme, setTheme] = useState<Theme>(loadTheme),
    [custom, setCustom] = useState(savedThemes),
    [sessions, setSessions] = useState<any>(null),
    [currentPassword, setCurrentPassword] = useState(""),
    [password, setPassword] = useState(""),
    [deletePassword, setDeletePassword] = useState(""),
    [deleteConfirm, setDeleteConfirm] = useState(false),
    [autostart, setAutostart] = useState(false),
    [autoUpdate, setAutoUpdate] = useState(true),
    [updateNote, setUpdateNote] = useState(""),
    [saved, setSaved] = useState("");
  const task = useTask(),
    importFile = useRef<HTMLInputElement>(null),
    avatar = useRef<HTMLInputElement>(null),
    banner = useRef<HTMLInputElement>(null);
  const tabs = [
    { name: "Profile", icon: UserCircle },
    { name: "Account", icon: KeyRound },
    { name: "Appearance", icon: Palette },
    { name: "Privacy", icon: Shield },
    { name: "Sessions", icon: Monitor },
    { name: "Connection", icon: Server },
  ];
  useEffect(() => {
    if (tab === "Sessions")
      void task.run(async () => setSessions(await api.get("/v1/sessions")));
  }, [tab]);
  useEffect(() => {
    if (isTauri()) {
      void isEnabled()
        .then(setAutostart)
        .catch(() => {});
      void invoke<boolean>("get_auto_update")
        .then(setAutoUpdate)
        .catch(() => {});
    }
  }, []);
  const saveProfile = () =>
    void task.run(async () => {
      const user = await api.patch("/v1/me", {
        display_name: profile.display_name,
        username: profile.username,
        bio: profile.bio || "",
        pronouns: profile.pronouns || "",
        status: profile.status || "",
        accent: profile.accent || "#8b5cf6",
        avatar_zoom: profile.avatar_zoom ?? 1,
        avatar_x: profile.avatar_x ?? 50,
        avatar_y: profile.avatar_y ?? 50,
        banner_zoom: profile.banner_zoom ?? 1,
        banner_x: profile.banner_x ?? 50,
        banner_y: profile.banner_y ?? 50,
        banner_height: profile.banner_height ?? 100,
      });
      onUser(user);
      setSaved("Profile saved.");
    });
  function changeTheme(t: Theme) {
    setTheme(t);
    applyTheme(t);
  }
  async function upload(file: File, kind: string) {
    await task.run(async () => {
      const c = new AbortController();
      await api.upload("/v1/profile-assets/" + kind, file, () => {}, c.signal);
      const user = await api.get<User>("/v1/me");
      setProfile(user);
      onUser(user);
      setSaved("Image updated.");
    });
  }
  return (
    <Modal title="Make yourself at home" wide onClose={onClose}>
      <div className="settings-layout">
        <nav aria-label="Settings categories">
          {tabs.map(({ name, icon: Icon }) => (
            <button
              key={name}
              className={tab === name ? "selected" : ""}
              onClick={() => {
                setTab(name);
                setSaved("");
                task.setError("");
              }}
            >
              <Icon size={17} />
              {name}
            </button>
          ))}
          <button className="danger" onClick={onLogout}>
            <LogOut size={17} />
            Sign out
          </button>
          <small>
            WIISB CHAT 0.1.0
            <br />
            All features. Every account.
          </small>
        </nav>
        <div className="settings-content">
          <ErrorText error={task.error} />
          {saved && (
            <p role="status" className="success">
              {saved}
            </p>
          )}
          {tab === "Profile" && (
            <>
              <div className="settings-profile">
                <Avatar user={profile} size={74} />
                <div>
                  <h2>Your profile, your personality.</h2>
                  <p className="muted">
                    Animated avatars and banners are welcome.
                  </p>
                </div>
              </div>
              <div className="button-row">
                <button
                  className="secondary"
                  onClick={() => avatar.current?.click()}
                >
                  <Upload size={16} />
                  Change avatar
                </button>
                <button
                  className="secondary"
                  onClick={() => banner.current?.click()}
                >
                  <Upload size={16} />
                  Change banner
                </button>
                <input
                  hidden
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
                  ref={avatar}
                  onChange={(e) =>
                    e.target.files?.[0] &&
                    void upload(e.target.files[0], "avatar")
                  }
                />
                <input
                  hidden
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
                  ref={banner}
                  onChange={(e) =>
                    e.target.files?.[0] &&
                    void upload(e.target.files[0], "banner")
                  }
                />
              </div>
              <section className="framing" aria-label="Resize your pictures">
                <h3>Resize &amp; reposition</h3>
                <p className="muted">
                  Zoom in, slide the picture around, and pick how tall your
                  banner is. Everything updates live; press Save profile to
                  keep it.
                </p>
                <ProfileBanner user={profile} />
                <div className="framing-avatar">
                  <Avatar user={profile} size={88} />
                </div>
                <div className="framing-grid">
                  <FramingSliders
                    title="Avatar"
                    disabled={!profile.avatar_id}
                    values={[
                      ["Zoom", profile.avatar_zoom ?? 1, 1, 4, 0.05, "avatar_zoom"],
                      ["Left / right", profile.avatar_x ?? 50, 0, 100, 1, "avatar_x"],
                      ["Up / down", profile.avatar_y ?? 50, 0, 100, 1, "avatar_y"],
                    ]}
                    onChange={(k, v) => setProfile({ ...profile, [k]: v })}
                    onReset={() =>
                      setProfile({
                        ...profile,
                        avatar_zoom: 1,
                        avatar_x: 50,
                        avatar_y: 50,
                      })
                    }
                  />
                  <FramingSliders
                    title="Banner"
                    disabled={!profile.banner_id}
                    values={[
                      ["Zoom", profile.banner_zoom ?? 1, 1, 4, 0.05, "banner_zoom"],
                      ["Left / right", profile.banner_x ?? 50, 0, 100, 1, "banner_x"],
                      ["Up / down", profile.banner_y ?? 50, 0, 100, 1, "banner_y"],
                      ["Height", profile.banner_height ?? 100, 60, 220, 2, "banner_height"],
                    ]}
                    onChange={(k, v) => setProfile({ ...profile, [k]: v })}
                    onReset={() =>
                      setProfile({
                        ...profile,
                        banner_zoom: 1,
                        banner_x: 50,
                        banner_y: 50,
                        banner_height: 100,
                      })
                    }
                  />
                </div>
              </section>
              <div className="field-grid">
                <Field label="Display name">
                  <input
                    value={profile.display_name}
                    maxLength={80}
                    onChange={(e) =>
                      setProfile({ ...profile, display_name: e.target.value })
                    }
                  />
                </Field>
                <Field label="Pronouns">
                  <input
                    maxLength={40}
                    value={profile.pronouns || ""}
                    onChange={(e) =>
                      setProfile({ ...profile, pronouns: e.target.value })
                    }
                  />
                </Field>
              </div>
              <Field label="About you">
                <textarea
                  maxLength={1000}
                  rows={4}
                  placeholder="Tell your people a little about you."
                  value={profile.bio || ""}
                  onChange={(e) =>
                    setProfile({ ...profile, bio: e.target.value })
                  }
                />
              </Field>
              <Field label="Custom status">
                <input
                  maxLength={140}
                  placeholder="What’s on your mind?"
                  value={profile.status || ""}
                  onChange={(e) =>
                    setProfile({ ...profile, status: e.target.value })
                  }
                />
              </Field>
              <Field label="Profile accent">
                <input
                  type="color"
                  value={profile.accent || "#8b5cf6"}
                  onChange={(e) =>
                    setProfile({ ...profile, accent: e.target.value })
                  }
                />
              </Field>
              <button
                className="primary"
                disabled={task.busy}
                onClick={saveProfile}
              >
                <Save size={16} />
                Save profile
              </button>
            </>
          )}
          {tab === "Account" && (
            <>
              <h2>Account & security</h2>
              <Field
                label="Username"
                hint="3–32 lowercase letters, numbers, and underscores."
              >
                <input
                  maxLength={32}
                  value={profile.username}
                  onChange={(e) =>
                    setProfile({
                      ...profile,
                      username: e.target.value.toLowerCase(),
                    })
                  }
                />
              </Field>
              <button className="secondary" onClick={saveProfile}>
                Update username
              </button>
              <hr />
              <EmailLink />
              <hr />
              <h3>Change password</h3>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void task.run(async () => {
                    await api.post("/v1/auth/password", {
                      current: currentPassword,
                      password,
                    });
                    setPassword("");
                    setCurrentPassword("");
                    setSaved(
                      "Password changed. Other sessions have been revoked.",
                    );
                  });
                }}
              >
                <Field label="Current password">
                  <input
                    required
                    type="password"
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                  />
                </Field>
                <Field label="New password">
                  <input
                    required
                    minLength={10}
                    maxLength={128}
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
                <button className="primary" disabled={task.busy}>
                  Change password
                </button>
              </form>
              <hr />
              <h3>Delete your account</h3>
              <p className="muted">
                Transfer or delete communities you own first. Messages retain a
                deleted-account attribution. Profile assets become inaccessible.
              </p>
              <button
                className="danger-button"
                onClick={() => setDeleteConfirm(true)}
              >
                Delete account…
              </button>
              {deleteConfirm && (
                <div className="danger-zone">
                  <Field label="Enter your password to confirm">
                    <input
                      required
                      type="password"
                      autoComplete="current-password"
                      value={deletePassword}
                      onChange={(e) => setDeletePassword(e.target.value)}
                    />
                  </Field>
                  <button
                    className="danger-button"
                    onClick={() =>
                      void task.run(async () => {
                        await api.delete("/v1/account", {
                          password: deletePassword,
                        });
                        await api.clear();
                        onLogout();
                      })
                    }
                  >
                    Permanently delete my account
                  </button>
                </div>
              )}
            </>
          )}
          {tab === "Appearance" && (
            <>
              <h2>A space that feels like you.</h2>
              <p className="muted">
                Every theme is yours. Changes preview instantly.
              </p>
              <div className="theme-grid">
                {[...themes, ...custom].map((t, index) => (
                  <button
                    key={t.name + index}
                    className={
                      "theme-option " +
                      (theme.name === t.name ? "selected" : "")
                    }
                    onClick={() => changeTheme(t)}
                  >
                    <div style={{ background: t.background }}>
                      <i style={{ background: t.panel }} />
                      <b style={{ background: t.accent }} />
                    </div>
                    <span>{t.name}</span>
                  </button>
                ))}
              </div>
              <div className="field-grid">
                {(
                  [
                    "accent",
                    "background",
                    "panel",
                    "surface",
                    "text",
                    "muted",
                  ] as const
                ).map((key) => (
                  <Field key={key} label={key[0].toUpperCase() + key.slice(1)}>
                    <input
                      type="color"
                      value={theme[key]}
                      onChange={(e) =>
                        changeTheme({
                          ...theme,
                          name: "Custom",
                          [key]: e.target.value,
                        })
                      }
                    />
                  </Field>
                ))}
                <Field label={`Text size · ${theme.fontSize}px`}>
                  <input
                    type="range"
                    min={12}
                    max={20}
                    value={theme.fontSize}
                    onChange={(e) =>
                      changeTheme({
                        ...theme,
                        fontSize: Number(e.target.value),
                      })
                    }
                  />
                </Field>
                <Field label="Corners">
                  <input
                    type="range"
                    min={0}
                    max={24}
                    value={theme.radius}
                    onChange={(e) =>
                      changeTheme({ ...theme, radius: Number(e.target.value) })
                    }
                  />
                </Field>
                <Field label="Density">
                  <select
                    value={theme.density}
                    onChange={(e) =>
                      changeTheme({
                        ...theme,
                        density: e.target.value as Theme["density"],
                      })
                    }
                  >
                    <option value="comfortable">Comfortable</option>
                    <option value="compact">Compact</option>
                  </select>
                </Field>
              </div>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={theme.reducedMotion}
                  onChange={(e) =>
                    changeTheme({ ...theme, reducedMotion: e.target.checked })
                  }
                />
                Reduce animations
              </label>
              <Field label="Preset name">
                <input
                  maxLength={50}
                  value={theme.name}
                  onChange={(e) => setTheme({ ...theme, name: e.target.value })}
                />
              </Field>
              <div className="button-row">
                <button
                  className="primary"
                  onClick={() =>
                    void task.run(async () => {
                      const t = themeSchema.parse(theme),
                        next = [
                          ...custom.filter((p) => p.name !== t.name),
                          t,
                        ].slice(-30);
                      setCustom(next);
                      localStorage.setItem(
                        "wiisb.themes",
                        JSON.stringify(next),
                      );
                      changeTheme(t);
                      setSaved("Preset saved.");
                    })
                  }
                >
                  <Save size={15} /> Save preset
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    const next = custom.filter((p) => p.name !== theme.name);
                    setCustom(next);
                    localStorage.setItem("wiisb.themes", JSON.stringify(next));
                  }}
                >
                  Delete preset
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    const url = URL.createObjectURL(
                      new Blob([JSON.stringify(theme, null, 2)], {
                        type: "application/json",
                      }),
                    );
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "wiisb-theme.json";
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  }}
                >
                  <Download size={15} />
                  Export
                </button>
                <button
                  className="secondary"
                  onClick={() => importFile.current?.click()}
                >
                  <Upload size={15} />
                  Import
                </button>
                <input
                  hidden
                  type="file"
                  accept="application/json,.json"
                  ref={importFile}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file)
                      void task.run(async () => {
                        if (file.size > 16384)
                          throw new Error("Theme files must be under 16 KB.");
                        changeTheme(
                          themeSchema.parse(JSON.parse(await file.text())),
                        );
                      });
                    e.target.value = "";
                  }}
                />
              </div>
            </>
          )}
          {tab === "Privacy" && (
            <>
              <h2>You decide who gets in.</h2>
              <Field label="Who can start a conversation with you?">
                <select
                  value={me.settings?.dmPolicy || "friends"}
                  onChange={(e) =>
                    void task.run(async () =>
                      onUser(
                        await api.patch("/v1/me", {
                          settings: {
                            ...me.settings,
                            dmPolicy: e.target.value,
                          },
                        }),
                      ),
                    )
                  }
                >
                  <option value="friends">Friends only</option>
                  <option value="everyone">Everyone</option>
                  <option value="none">Nobody</option>
                </select>
              </Field>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={me.settings?.friendRequests !== false}
                  onChange={(e) =>
                    void task.run(async () =>
                      onUser(
                        await api.patch("/v1/me", {
                          settings: {
                            ...me.settings,
                            friendRequests: e.target.checked,
                          },
                        }),
                      ),
                    )
                  }
                />
                Allow friend requests
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={me.settings?.notifications !== false}
                  onChange={(e) =>
                    void task.run(async () =>
                      onUser(
                        await api.patch("/v1/me", {
                          settings: {
                            ...me.settings,
                            notifications: e.target.checked,
                          },
                        }),
                      ),
                    )
                  }
                />
                Notify me about new messages
              </label>
              <div className="button-row">
                {isTauri() && (
                  <button
                    className="secondary"
                    onClick={() =>
                      void task.run(async () => {
                        const permission = await requestPermission();
                        setSaved(
                          permission === "granted"
                            ? "Windows notifications enabled."
                            : "Windows notification permission was not granted.",
                        );
                      })
                    }
                  >
                    Enable Windows notifications
                  </button>
                )}
              </div>
              <p className="muted">
                Message content is stored by your server host. WIISB Chat does
                not currently provide end-to-end encryption. Presence never
                reads your running applications.
              </p>
            </>
          )}
          {tab === "Sessions" && (
            <>
              <h2>Your signed-in devices</h2>
              <p className="muted">
                Revoke a session to sign that device out immediately.
              </p>
              {sessions?.sessions.map((s: any) => (
                <div className="session-row" key={s.id}>
                  <Monitor size={23} />
                  <span>
                    <b>
                      {s.label}
                      {s.id === sessions.current ? " · This device" : ""}
                    </b>
                    <small>
                      Created {new Date(s.created_at).toLocaleString()}
                    </small>
                  </span>
                  <button
                    className="secondary small"
                    onClick={() =>
                      void task.run(async () => {
                        await api.delete("/v1/sessions/" + s.id);
                        if (s.id === sessions.current) onLogout();
                        else setSessions(await api.get("/v1/sessions"));
                      })
                    }
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </>
          )}
          {tab === "Connection" && (
            <>
              <h2>Your connection</h2>
              <div className="endpoint-display">
                <Server size={21} />
                {api.endpoint}
              </div>
              <p className="muted">
                To connect to another host, sign out and choose its server
                address. Your account and communities belong to the current
                host.
              </p>
              <h3>Windows</h3>
              {isTauri() ? (
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={autostart}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      void task.run(async () => {
                        await (checked ? enable() : disable());
                        setAutostart(checked);
                      });
                    }}
                  />
                  Start WIISB Chat when I sign in to Windows
                </label>
              ) : (
                <p className="muted">
                  Windows integration is available in the packaged desktop app.
                </p>
              )}
              <p className="muted">
                Closing the window keeps Chat in the system tray. Choose Quit in
                the tray menu to exit.
              </p>
              {isTauri() && (
                <>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={autoUpdate}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        void task.run(async () => {
                          await invoke("set_auto_update", { enabled: checked });
                          setAutoUpdate(checked);
                        });
                      }}
                    />
                    Update WIISB Chat automatically
                  </label>
                  <p className="muted">
                    New versions download quietly in the background. Nothing
                    restarts until you choose “Restart to update”.
                  </p>
                  <button
                    className="secondary"
                    disabled={task.busy}
                    onClick={() => {
                      setUpdateNote("Checking…");
                      void task.run(async () => {
                        const r = await invoke<{ message: string }>(
                          "check_for_updates",
                        );
                        setUpdateNote(r.message);
                      });
                    }}
                  >
                    Check for updates
                  </button>
                  {updateNote && <p className="muted">{updateNote}</p>}
                </>
              )}
              <h3>Keyboard shortcuts</h3>
              <dl className="shortcuts">
                <dt>Ctrl + K</dt>
                <dd>Quick switcher</dd>
                <dt>Ctrl + ,</dt>
                <dd>Settings</dd>
                <dt>Shift + Enter</dt>
                <dd>New line</dd>
                <dt>V (in push-to-talk mode)</dt>
                <dd>Talk while the app is focused</dd>
                <dt>Escape</dt>
                <dd>Close dialog</dd>
              </dl>
              <h3>Voice & video</h3>
              <p className="muted">
                Microphone, speaker, camera, screen quality, and push-to-talk
                controls appear in the active call. A self-hosted LiveKit server
                must be configured by your host.
              </p>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
