import {
  useCallback,
  useEffect,
  useRef,
  useState,
  lazy,
  Suspense,
} from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  sendNotification,
  onAction,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Users,
  Plus,
  Settings as SettingsIcon,
  Search,
  ChevronDown,
  Hash,
  Volume2,
  Lock,
  MessageCircle,
  ChevronRight,
  Radio,
  X,
  LogOut,
  WifiOff,
  PanelRight,
  AtSign,
} from "lucide-react";
import { api, eventBus, realtime } from "./api";
import type {
  Channel,
  Community,
  FriendState,
  Session,
  User,
  Event,
} from "./types";
import { Auth } from "./components/Auth";
import { Friends } from "./components/Friends";
import { Chat, conversationName } from "./components/Chat";
import { Settings } from "./components/Settings";
import { Profile } from "./components/Profile";
import {
  AddServer,
  CommunitySettings,
  GroupDialog,
} from "./components/Community";
import {
  Mark,
  Avatar,
  IconButton,
  Modal,
  Empty,
  Loading,
  errorMessage,
} from "./components/UI";
import { applyTheme, loadTheme } from "./themes";
const emptyFriends: FriendState = {
  friends: [],
  incoming: [],
  outgoing: [],
  blocked: [],
};
const Call = lazy(() =>
  import("./components/Call").then((m) => ({ default: m.Call })),
);
export function App() {
  const [session, setSession] = useState<Session | null>(null),
    [booting, setBooting] = useState(true),
    [initialError, setInitialError] = useState(""),
    [servers, setServers] = useState<Community[]>([]),
    [conversations, setConversations] = useState<Channel[]>([]),
    [friends, setFriends] = useState<FriendState>(emptyFriends),
    [serverId, setServerId] = useState<string | null>(null),
    [community, setCommunity] = useState<Community | null>(null),
    [channelId, setChannelId] = useState<string | null>(null),
    [connection, setConnection] = useState("Connecting"),
    [settings, setSettings] = useState(false),
    [addServer, setAddServer] = useState(false),
    [serverSettings, setServerSettings] = useState(false),
    [group, setGroup] = useState(false),
    [profile, setProfile] = useState<User | null>(null),
    [showMembers, setShowMembers] = useState(true),
    [call, setCall] = useState<Channel | null>(null),
    [quick, setQuick] = useState(false),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [order, setOrder] = useState<string[]>(() => {
      try {
        return JSON.parse(localStorage.getItem("wiisb.serverOrder") || "[]");
      } catch {
        return [];
      }
    });
  const socket = useRef<ReturnType<typeof realtime> | null>(null),
    selection = useRef({ serverId, channelId }),
    refreshGeneration = useRef(0),
    meRef = useRef<User | null>(null);
  selection.current = { serverId, channelId };
  meRef.current = session?.user || null;
  useEffect(() => {
    applyTheme(loadTheme());
    api.onExpired = () => {
      setSession(null);
      setInitialError("Your session has expired. Sign in again.");
    };
    void api
      .restore()
      .then((s) => {
        if (s) setSession(s);
      })
      .catch((e) => setInitialError(errorMessage(e)))
      .finally(() => setBooting(false));
  }, []);
  const refresh = useCallback(async () => {
    if (!api.session) return;
    const n = ++refreshGeneration.current;
    const [s, c, f] = await Promise.all([
      api.get<Community[]>("/v1/servers"),
      api.get<Channel[]>("/v1/conversations"),
      api.get<FriendState>("/v1/friends"),
    ]);
    if (n !== refreshGeneration.current) return;
    setServers(s);
    setConversations(c);
    setFriends(f);
    const current = selection.current;
    if (current.serverId) {
      if (!s.some((server) => server.id === current.serverId)) {
        setServerId(null);
        setCommunity(null);
        setChannelId(null);
      } else {
        const detail = await api.get<Community>(
          "/v1/servers/" + current.serverId,
        );
        if (
          n !== refreshGeneration.current ||
          selection.current.serverId !== detail.id
        )
          return;
        setCommunity(detail);
        if (
          current.channelId &&
          !detail.channels.some((ch) => ch.id === current.channelId)
        )
          setChannelId(null);
      }
    } else if (
      current.channelId &&
      !c.some((ch) => ch.id === current.channelId)
    )
      setChannelId(null);
  }, []);
  const run = useCallback(
    (fn: () => Promise<any>) => {
      setError("");
      void fn()
        .then(() => refresh())
        .catch((e) => setError(errorMessage(e)));
    },
    [refresh],
  );
  const selectChannel = (c: Channel) => {
    setChannelId(c.id);
    setServerId(c.server_id || null);
  };
  async function selectServer(id: string) {
    if (!id) {
      setServerId(null);
      setChannelId(null);
      setCommunity(null);
      return;
    }
    setServerId(id);
    setChannelId(null);
    setCommunity(null);
    setError("");
    try {
      const detail = await api.get<Community>("/v1/servers/" + id);
      if (selection.current.serverId !== id) return;
      setCommunity(detail);
      setChannelId(detail.channels.find((c) => c.kind !== "voice")?.id || null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function dm(user: User) {
    try {
      const channel = await api.post<Channel>("/v1/conversations", {
        users: [user.id],
      });
      await refresh();
      setServerId(null);
      setChannelId(channel.id);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function logout() {
    socket.current?.close();
    setCall(null);
    try {
      if (api.session) await api.post("/v1/auth/logout");
    } catch {}
    await api.clear();
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith("draft:")) sessionStorage.removeItem(key);
    }
    setSession(null);
    setSettings(false);
    setCommunity(null);
    setServerId(null);
    setChannelId(null);
    setFriends(emptyFriends);
    setServers([]);
    setConversations([]);
    setInitialError("");
  }
  useEffect(() => {
    if (!session) return;
    void refresh().catch((e) => setError(errorMessage(e)));
    const onEvent = (e: Event) => {
      eventBus.dispatchEvent(new CustomEvent("event", { detail: e }));
      if (
        [
          "ready",
          "state.changed",
          "friends.changed",
          "presence.changed",
          "read.changed",
          "message.created",
        ].includes(e.type)
      )
        void refresh().catch((err) => setError(errorMessage(err)));
      if (
        e.type === "notification" &&
        meRef.current?.presence !== "dnd" &&
        meRef.current?.settings?.notifications !== false &&
        !(
          selection.current.channelId === e.payload.channelId &&
          document.hasFocus()
        )
      ) {
        setToast(e.payload.text);
        if (isTauri())
          void isPermissionGranted().then((allowed) => {
            if (allowed)
              sendNotification({
                title: "WIISB Chat",
                body: e.payload.text,
                extra: { channelId: e.payload.channelId },
              });
          });
      }
      if (e.type === "call.started" && e.payload.userId !== meRef.current?.id)
        setToast("Someone started a call in a conversation. Open it to join.");
    };
    socket.current = realtime(onEvent, setConnection);
    return () => {
      socket.current?.close();
      socket.current = null;
    };
  }, [session?.user.id]);
  useEffect(() => {
    if (!isTauri() || !session) return;
    let remove: (() => void) | undefined;
    void onAction((event) => {
      const cid = event.notification?.extra?.channelId;
      if (typeof cid === "string") {
        setServerId(null);
        setChannelId(cid);
        void refresh();
        const win = getCurrentWindow();
        void win.show().then(() => win.setFocus());
      }
    }).then((listener) => (remove = () => listener.unregister()));
    return () => remove?.();
  }, [session?.user.id]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setQuick(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setSettings(true);
      }
    };
    window.addEventListener("keydown", handler);
    let unlisten: (() => void) | undefined;
    if (isTauri())
      void listen("open-settings", () => setSettings(true)).then(
        (fn) => (unlisten = fn),
      );
    return () => {
      window.removeEventListener("keydown", handler);
      unlisten?.();
    };
  }, []);
  const channel = (serverId ? community?.channels : conversations)?.find(
    (c) => c.id === channelId,
  );
  const me = session?.user;
  if (booting)
    return (
      <div className="boot">
        <Mark />
        <Loading />
      </div>
    );
  if (!session || !me)
    return (
      <Auth
        onLogin={(s) => {
          setSession(s);
          setInitialError("");
        }}
        initialError={initialError}
      />
    );
  const sortedServers = [...servers].sort((a, b) => {
    const ai = order.indexOf(a.id),
      bi = order.indexOf(b.id);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
  });
  return (
    <main className="app-shell">
      <aside className="server-rail" aria-label="Communities">
        <button
          className={"home-server " + (!serverId ? "selected" : "")}
          title="Friends and messages"
          onClick={() => {
            setServerId(null);
            setChannelId(null);
          }}
        >
          <Mark small />
        </button>
        <span className="rail-divider" />
        {sortedServers.map((s) => (
          <button
            draggable
            onDragStart={(e) =>
              e.dataTransfer.setData("text/wiisb-server", s.id)
            }
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const moved = e.dataTransfer.getData("text/wiisb-server");
              if (!servers.some((x) => x.id === moved) || moved === s.id)
                return;
              const next = sortedServers
                .map((x) => x.id)
                .filter((id) => id !== moved);
              next.splice(next.indexOf(s.id), 0, moved);
              setOrder(next);
              localStorage.setItem("wiisb.serverOrder", JSON.stringify(next));
            }}
            key={s.id}
            title={s.name}
            className={"server-icon " + (serverId === s.id ? "selected" : "")}
            onClick={() => void selectServer(s.id)}
          >
            {s.name.slice(0, 2).toUpperCase()}
          </button>
        ))}
        <button
          className="add-server"
          title="Create or join a community"
          onClick={() => setAddServer(true)}
        >
          <Plus size={24} />
        </button>
        <div className="rail-bottom">
          <span title="All features are free">
            <Radio size={19} />
          </span>
        </div>
      </aside>
      <aside className="channel-sidebar">
        <header>
          <button
            className="workspace-title"
            onClick={() =>
              serverId ? setServerSettings(true) : setQuick(true)
            }
          >
            <span>
              {serverId ? community?.name || "Community" : "Your space"}
            </span>
            {serverId ? <ChevronDown size={17} /> : <Search size={17} />}
          </button>
        </header>
        {serverId ? (
          <div className="channel-navigation">
            <div className="community-card">
              <span className="eyebrow">YOUR CORNER OF WIISB</span>
              <h3>{community?.name || "Loading…"}</h3>
              <p>
                {community?.description || "Good people. Great conversations."}
              </p>
            </div>
            {!community ? (
              <Loading />
            ) : (
              [
                ...new Set(
                  community.channels.map((c) => c.category || "CHANNELS"),
                ),
              ].map((category) => (
                <div className="channel-group" key={category}>
                  <div className="section-label">
                    <ChevronDown size={12} />
                    {category}
                    <button
                      title="Manage channels"
                      aria-label="Manage channels"
                      onClick={() => setServerSettings(true)}
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                  {community.channels
                    .filter((c) => (c.category || "CHANNELS") === category)
                    .map((c) => (
                      <button
                        key={c.id}
                        className={
                          "channel-link " +
                          (channelId === c.id ? "selected" : "")
                        }
                        onClick={() =>
                          c.kind === "voice" ? setCall(c) : setChannelId(c.id)
                        }
                      >
                        {c.kind === "voice" ? (
                          <Volume2 size={18} />
                        ) : c.private ? (
                          <Lock size={16} />
                        ) : (
                          <Hash size={18} />
                        )}
                        <span>{c.name}</span>
                        {c.unread ? <b className="unread">{c.unread}</b> : null}
                        {c.kind === "voice" && call?.id === c.id && (
                          <span className="dot" />
                        )}
                      </button>
                    ))}
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="channel-navigation">
            <button
              className={"friends-link " + (!channelId ? "selected" : "")}
              onClick={() => setChannelId(null)}
            >
              <Users size={20} />
              <span>Friends</span>
              {friends.incoming.length > 0 && (
                <b className="badge">{friends.incoming.length}</b>
              )}
            </button>
            <button className="quick-link" onClick={() => setQuick(true)}>
              <Search size={16} />
              <span>Find a conversation</span>
              <kbd>Ctrl K</kbd>
            </button>
            <div className="section-label">
              DIRECT MESSAGES
              <button
                title="Create group conversation"
                aria-label="Create group conversation"
                onClick={() => setGroup(true)}
              >
                <Plus size={16} />
              </button>
            </div>
            {conversations.map((c) => {
              const person = c.members?.find((u) => u.id !== me.id);
              return (
                <button
                  className={
                    "dm-link " + (channelId === c.id ? "selected" : "")
                  }
                  key={c.id}
                  onClick={() => setChannelId(c.id)}
                >
                  {c.kind === "dm" ? (
                    <Avatar user={person || { display_name: "?" }} size={34} />
                  ) : (
                    <span className="group-avatar">
                      <Users size={18} />
                    </span>
                  )}
                  <span>
                    {conversationName(c, me.id)}
                    <small>
                      {c.kind === "group"
                        ? `${c.members?.length || 0} people`
                        : "Direct message"}
                    </small>
                  </span>
                  {c.unread ? <b className="unread">{c.unread}</b> : null}
                </button>
              );
            })}
            {!conversations.length && (
              <p className="sidebar-empty">
                Your conversations will appear here. Start one from your friends
                list.
              </p>
            )}
          </div>
        )}
        {call && (
          <button
            className="voice-connected"
            onClick={() => setChannelId(call.id)}
          >
            <Radio size={17} />
            <span>
              Call open<small>{call.name}</small>
            </span>
          </button>
        )}
        <div className="account-panel">
          <Avatar user={me} size={35} onClick={() => setSettings(true)} />
          <div>
            <button className="account-name" onClick={() => setSettings(true)}>
              {me.display_name}
            </button>
            <select
              aria-label="Your presence"
              value={me.presence || "online"}
              onChange={(e) =>
                run(async () => {
                  const user = await api.patch<User>("/v1/me", {
                    presence: e.target.value,
                  });
                  setSession({ ...session, user });
                })
              }
            >
              <option value="online">Online</option>
              <option value="idle">Idle</option>
              <option value="dnd">Do not disturb</option>
              <option value="invisible">Invisible</option>
            </select>
          </div>
          <IconButton
            title="User settings (Ctrl+,)"
            onClick={() => setSettings(true)}
          >
            <SettingsIcon size={18} />
          </IconButton>
        </div>
      </aside>
      <div className="main-workspace">
        {error && (
          <div className="global-error" role="alert">
            <WifiOff size={17} />
            <span>{error}</span>
            <button
              onClick={() => {
                setError("");
                void refresh().catch((e) => setError(errorMessage(e)));
              }}
            >
              Retry
            </button>
            <IconButton title="Dismiss error" onClick={() => setError("")}>
              <X size={15} />
            </IconButton>
          </div>
        )}
        {call && (
          <Suspense fallback={<Loading />}>
            <Call key={call.id} channel={call} onClose={() => setCall(null)} />
          </Suspense>
        )}
        <div className="workspace-body">
          {channel ? (
            <Chat
              key={channel.id}
              channel={channel}
              me={me}
              connection={connection}
              onProfile={setProfile}
              onCall={() => setCall(channel)}
              toggleMembers={() => {
                if (channel.kind === "group") setGroup(true);
                else setShowMembers(!showMembers);
              }}
              typingSend={(id, active) =>
                socket.current?.send({ type: "typing", channelId: id, active })
              }
              canManage={
                community?.myPermissions.includes("manage_messages") || false
              }
            />
          ) : serverId ? (
            <Empty icon={<Hash size={38} />} title="Choose a channel.">
              Find a conversation on the left, or join a voice channel.
            </Empty>
          ) : (
            <Friends
              data={friends}
              onDM={(u) => void dm(u)}
              onProfile={setProfile}
              run={run}
            />
          )}
          {serverId && community && showMembers && (
            <aside className="member-sidebar">
              <div className="section-label">
                MEMBERS — {community.members.length}
              </div>
              {community.members.map((user) => (
                <button
                  className="member-link"
                  key={user.id}
                  onClick={() => setProfile(user)}
                >
                  <Avatar user={user} size={34} />
                  <span>
                    {user.display_name}
                    <small>{user.status || user.presence}</small>
                  </span>
                  {user.id === community.owner_id && (
                    <span title="Community owner" className="owner-dot" />
                  )}
                </button>
              ))}
              <div className="community-footer">
                <ShieldNote />
              </div>
            </aside>
          )}
        </div>
      </div>
      {settings && (
        <Settings
          me={me}
          onClose={() => setSettings(false)}
          onUser={(user) => {
            api.session!.user = user;
            setSession({ ...session, user });
          }}
          onLogout={() => void logout()}
        />
      )}{" "}
      {addServer && (
        <AddServer
          onClose={() => setAddServer(false)}
          onJoined={(id) => {
            void refresh().then(() => selectServer(id));
          }}
        />
      )}
      {serverSettings && community && (
        <CommunitySettings
          server={community}
          onClose={() => setServerSettings(false)}
          onChanged={refresh}
          onDeleted={() => {
            setServerId(null);
            setCommunity(null);
            setChannelId(null);
            void refresh();
          }}
        />
      )}
      {profile && (
        <Profile
          key={profile.id}
          user={profile}
          onClose={() => setProfile(null)}
          onDM={(u) => void dm(u)}
        />
      )}{" "}
      {group && (
        <GroupDialog
          friends={friends.friends}
          uid={me.id}
          existing={channel?.kind === "group" ? channel : undefined}
          onClose={() => setGroup(false)}
          onCreated={(c) => {
            void refresh().then(() => {
              setServerId(null);
              setChannelId(c.id);
            });
          }}
        />
      )}
      {quick && (
        <QuickSwitcher
          servers={servers}
          channels={[...conversations, ...(community?.channels || [])]}
          uid={me.id}
          onClose={() => setQuick(false)}
          onServer={(id) => void selectServer(id)}
          onChannel={selectChannel}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <MessageCircle size={18} />
          <span>{toast}</span>
          <IconButton title="Dismiss notification" onClick={() => setToast("")}>
            <X size={15} />
          </IconButton>
        </div>
      )}
    </main>
  );
}
function ShieldNote() {
  return (
    <>
      <span className="dot" /> BUILT FOR YOUR PEOPLE
      <p>No upgrades. Just connection.</p>
    </>
  );
}
function QuickSwitcher({
  servers,
  channels,
  uid,
  onClose,
  onServer,
  onChannel,
}: {
  servers: Community[];
  channels: Channel[];
  uid: string;
  onClose: () => void;
  onServer: (id: string) => void;
  onChannel: (c: Channel) => void;
}) {
  const [query, setQuery] = useState(""),
    [index, setIndex] = useState(0);
  const choices = [
    {
      id: "friends",
      name: "Friends & messages",
      kind: "Your space",
      open: () => {
        onServer("");
      },
    },
    ...servers.map((s) => ({
      id: s.id,
      name: s.name,
      kind: "Community",
      open: () => onServer(s.id),
    })),
    ...channels.map((c) => ({
      id: c.id,
      name: conversationName(c, uid),
      kind: c.kind === "dm" ? "Direct message" : "Channel",
      open: () => onChannel(c),
    })),
  ]
    .filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 20);
  return (
    <Modal title="Where to?" onClose={onClose}>
      <input
        autoFocus
        className="quick-search"
        placeholder="Jump to a community or conversation"
        aria-label="Quick switcher search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setIndex((i) => Math.min(choices.length - 1, i + 1));
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setIndex((i) => Math.max(0, i - 1));
          }
          if (e.key === "Enter" && choices[index]) {
            choices[index].open();
            onClose();
          }
        }}
      />
      <div className="quick-results">
        {choices.map((c, i) => (
          <button
            key={c.id}
            className={index === i ? "selected" : ""}
            onClick={() => {
              c.open();
              onClose();
            }}
          >
            <Hash size={18} />
            <span>
              {c.name}
              <small>{c.kind}</small>
            </span>
            <ChevronRight size={17} />
          </button>
        ))}
      </div>
      <p className="muted">↑ ↓ to navigate · Enter to open · Escape to close</p>
    </Modal>
  );
}
