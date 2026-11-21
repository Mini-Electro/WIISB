import { useEffect, useRef, useState } from "react";
import {
  Hash,
  Phone,
  Search,
  Users,
  Pin,
  Plus,
  Smile,
  Send,
  Reply,
  MoreHorizontal,
  Check,
  X,
  Download,
  File,
  ArrowUp,
  Trash2,
  Pencil,
  Copy,
  Flag,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, eventBus } from "../api";
import type { Attachment, Channel, Message, User, Event } from "../types";
import {
  Avatar,
  IconButton,
  ErrorText,
  Empty,
  Loading,
  Modal,
  errorMessage,
} from "./UI";
export function conversationName(channel: Channel, uid: string) {
  return channel.kind === "dm"
    ? channel.members?.find((m) => m.id !== uid)?.display_name ||
        "Direct message"
    : channel.name;
}
const emoji = [
  "😀",
  "😂",
  "🥹",
  "😎",
  "🥳",
  "😭",
  "💜",
  "❤️",
  "🔥",
  "✨",
  "🎮",
  "👀",
  "👍",
  "👎",
  "✅",
  "🎉",
  "💯",
  "🙏",
  "🚀",
  "🤔",
  "🫡",
  "👋",
  "😴",
  "💀",
];
type Pending = {
  nonce: string;
  content: string;
  attachments: Attachment[];
  replyId?: string;
  error?: string;
};
export function Chat({
  channel,
  me,
  connection,
  onProfile,
  onCall,
  toggleMembers,
  typingSend,
  canManage = false,
}: {
  channel: Channel;
  me: User;
  connection: string;
  onProfile: (u: User) => void;
  onCall: () => void;
  toggleMembers: () => void;
  typingSend: (id: string, active: boolean) => void;
  canManage?: boolean;
}) {
  const [messages, setMessages] = useState<Message[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [hasMore, setMore] = useState(false),
    [content, setContent] = useState(""),
    [reply, setReply] = useState<Message | null>(null),
    [pending, setPending] = useState<Pending[]>([]),
    [attachments, setAttachments] = useState<Attachment[]>([]),
    [upload, setUpload] = useState<{ name: string; progress: number } | null>(
      null,
    ),
    [emojiOpen, setEmojiOpen] = useState(false),
    [searchOpen, setSearchOpen] = useState(false),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<Message[] | null>(null),
    [pins, setPins] = useState(false),
    [typers, setTypers] = useState<Record<string, number>>({}),
    [nearBottom, setNearBottom] = useState(true),
    [sending, setSending] = useState(false),
    [enterSends, setEnterSends] = useState(
      localStorage.getItem("wiisb.enterSends") !== "false",
    );
  const list = useRef<HTMLDivElement>(null),
    file = useRef<HTMLInputElement>(null),
    textarea = useRef<HTMLTextAreaElement>(null),
    abortUpload = useRef<AbortController | null>(null),
    aliveChannel = useRef(channel.id),
    lastTyping = useRef(0),
    bottom = useRef(true),
    pendingRef = useRef(pending);
  aliveChannel.current = channel.id;
  pendingRef.current = pending;
  const title = conversationName(channel, me.id);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "f") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const jumpBottom = () =>
    requestAnimationFrame(() => {
      list.current?.scrollTo({
        top: list.current.scrollHeight,
        behavior: "instant",
      });
      bottom.current = true;
      setNearBottom(true);
    });
  async function load(older = false) {
    const cid = channel.id;
    setError("");
    try {
      const result = await api.get<{ messages: Message[]; hasMore: boolean }>(
        `/v1/channels/${cid}/messages${older && messages[0] ? "?before=" + messages[0].id : ""}`,
      );
      if (aliveChannel.current !== cid) return;
      const previousHeight = list.current?.scrollHeight || 0;
      setMessages((old) =>
        older ? [...result.messages, ...old] : result.messages,
      );
      setMore(result.hasMore);
      if (older)
        requestAnimationFrame(() => {
          if (list.current)
            list.current.scrollTop = list.current.scrollHeight - previousHeight;
        });
      else if (bottom.current) jumpBottom();
    } catch (e) {
      if (aliveChannel.current === cid) setError(errorMessage(e));
    } finally {
      if (aliveChannel.current === cid) setLoading(false);
    }
  }
  useEffect(() => {
    setMessages([]);
    setLoading(true);
    setPending([]);
    setContent(sessionStorage.getItem("draft:" + channel.id) || "");
    setAttachments([]);
    setReply(null);
    setResults(null);
    setPins(false);
    setTypers({});
    bottom.current = true;
    void load();
    return () => {
      abortUpload.current?.abort();
      typingSend(channel.id, false);
    };
  }, [channel.id]);
  useEffect(() => {
    if (connection === "Connected") void load();
  }, [connection]);
  useEffect(() => {
    const listener = (raw: globalThis.Event) => {
      const e = (raw as CustomEvent<Event>).detail;
      if (e.resourceId !== channel.id) return;
      if (e.type === "message.created") {
        setMessages((old) =>
          old.some((m) => m.id === e.payload.id) ? old : [...old, e.payload],
        );
        setPending((old) => old.filter((p) => p.nonce !== e.payload.nonce));
        if (bottom.current) jumpBottom();
      } else if (e.type === "message.updated")
        setMessages((old) =>
          old.map((m) => (m.id === e.payload.id ? e.payload : m)),
        );
      else if (e.type === "message.deleted")
        setMessages((old) => old.filter((m) => m.id !== e.payload.id));
      else if (e.type === "typing" && e.payload.userId !== me.id)
        setTypers((old) => ({
          ...old,
          [e.payload.userId]: e.payload.active ? Date.now() : 0,
        }));
    };
    eventBus.addEventListener("event", listener);
    const timer = setInterval(
      () =>
        setTypers((old) =>
          Object.fromEntries(
            Object.entries(old).filter(([, at]) => Date.now() - at < 6000),
          ),
        ),
      2000,
    );
    return () => {
      eventBus.removeEventListener("event", listener);
      clearInterval(timer);
    };
  }, [channel.id, me.id]);
  useEffect(() => {
    if (nearBottom && messages.length && document.hasFocus())
      void api.post(`/v1/channels/${channel.id}/read`).catch(() => {});
  }, [messages.at(-1)?.id, nearBottom, channel.id]);
  const updateContent = (value: string) => {
    setContent(value);
    sessionStorage.setItem("draft:" + channel.id, value);
    if (Date.now() - lastTyping.current > 1800) {
      typingSend(channel.id, !!value);
      lastTyping.current = Date.now();
    }
  };
  async function deliver(item: Pending) {
    const cid = channel.id;
    setSending(true);
    try {
      const m = await api.post<Message>(`/v1/channels/${cid}/messages`, {
        content: item.content,
        nonce: item.nonce,
        replyId: item.replyId,
        attachments: item.attachments.map((a) => a.id),
      });
      if (aliveChannel.current !== cid) return;
      setMessages((old) =>
        old.some((msg) => msg.id === m.id) ? old : [...old, m],
      );
      setPending((old) => old.filter((p) => p.nonce !== item.nonce));
      jumpBottom();
    } catch (e) {
      if (aliveChannel.current === cid)
        setPending((old) =>
          old.map((p) =>
            p.nonce === item.nonce ? { ...p, error: errorMessage(e) } : p,
          ),
        );
    } finally {
      setSending(false);
    }
  }
  function send() {
    if ((!content.trim() && !attachments.length) || sending || upload) return;
    const item = {
      nonce: crypto.randomUUID(),
      content,
      replyId: reply?.id,
      attachments,
    };
    setPending((old) => [...old, item]);
    setContent("");
    sessionStorage.removeItem("draft:" + channel.id);
    setAttachments([]);
    setReply(null);
    setEmojiOpen(false);
    typingSend(channel.id, false);
    void deliver(item);
    jumpBottom();
  }
  async function uploadFiles(files: FileList | File[]) {
    const cid = channel.id;
    setError("");
    if (upload) return;
    for (const selected of Array.from(files).slice(
      0,
      10 - attachments.length,
    )) {
      const controller = new AbortController();
      abortUpload.current = controller;
      setUpload({ name: selected.name, progress: 0 });
      try {
        if (api.session) await api.refresh();
        const asset = await api.upload(
          `/v1/channels/${cid}/attachments`,
          selected,
          (progress) => setUpload({ name: selected.name, progress }),
          controller.signal,
        );
        if (aliveChannel.current === cid)
          setAttachments((old) => [...old, asset]);
      } catch (e) {
        if (aliveChannel.current === cid) setError(errorMessage(e));
        break;
      } finally {
        if (aliveChannel.current === cid) setUpload(null);
      }
    }
  }
  const action = async (fn: () => Promise<any>) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  async function search() {
    await action(async () => {
      setPins(false);
      setResults(
        await api.get(
          `/v1/search?channelId=${channel.id}&q=${encodeURIComponent(query)}`,
        ),
      );
    });
  }
  return (
    <section
      className="chat"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files);
      }}
    >
      <header className="content-header">
        <Hash size={23} className="muted" />
        <div className="chat-heading">
          <h2>{title}</h2>
          {channel.topic && <span>{channel.topic}</span>}
        </div>
        <div className="header-actions">
          {!channel.server_id && (
            <IconButton title="Start voice or video call" onClick={onCall}>
              <Phone size={19} />
            </IconButton>
          )}
          <IconButton
            title="Pinned messages"
            active={pins}
            onClick={() =>
              void action(async () => {
                setPins(true);
                setResults(
                  (
                    await api.get(
                      `/v1/channels/${channel.id}/messages?pinned=true`,
                    )
                  ).messages,
                );
              })
            }
          >
            <Pin size={19} />
          </IconButton>
          <IconButton
            title="Search conversation (Ctrl+F)"
            active={searchOpen}
            onClick={() => setSearchOpen(!searchOpen)}
          >
            <Search size={19} />
          </IconButton>
          <IconButton title="Toggle members" onClick={toggleMembers}>
            <Users size={19} />
          </IconButton>
        </div>
      </header>
      {connection !== "Connected" && (
        <div className="connection-banner" role="status">
          {connection} · Messages stay on your server. Failed sends can be
          retried.
        </div>
      )}
      {searchOpen && (
        <form
          className="search-bar"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <Search size={17} />
          <input
            autoFocus
            aria-label="Search message history"
            required
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search this conversation"
          />
          <button className="secondary small">Search</button>
          <IconButton
            title="Close search"
            onClick={() => {
              setSearchOpen(false);
              setResults(null);
            }}
          >
            <X size={16} />
          </IconButton>
        </form>
      )}
      <ErrorText error={error} />
      {results && (
        <div className="search-results">
          <header>
            <b>
              {pins ? "Pinned messages" : `Search results · ${results.length}`}
            </b>
            <IconButton
              title="Close results"
              onClick={() => {
                setResults(null);
                setPins(false);
              }}
            >
              <X size={16} />
            </IconButton>
          </header>
          {!results.length ? (
            <p className="muted">No messages found.</p>
          ) : (
            results.map((m) => (
              <article key={m.id}>
                <b>{m.display_name}</b>
                <p>{m.content}</p>
                <small className="muted">
                  {new Date(m.created_at).toLocaleString()}
                </small>
              </article>
            ))
          )}
        </div>
      )}
      <div
        className="message-list"
        ref={list}
        onScroll={() => {
          const el = list.current!;
          bottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 110;
          setNearBottom(bottom.current);
        }}
        aria-label={`Messages in ${title}`}
        role="log"
        aria-live="polite"
      >
        {loading ? (
          <Loading />
        ) : (
          <>
            {hasMore && (
              <button className="load-older" onClick={() => void load(true)}>
                <ArrowUp size={15} /> Load earlier messages
              </button>
            )}
            <div className="conversation-start">
              <span className="conversation-symbol">
                <Hash size={36} />
              </span>
              <h1>
                {messages.length
                  ? "You’re in the right place."
                  : `Welcome to ${title}.`}
              </h1>
              <p>
                {channel.topic ||
                  "This is your space to talk, share, and stay connected."}
              </p>
            </div>
            {messages.map((m, index) => (
              <div key={m.id}>
                {(!index ||
                  new Date(m.created_at).toDateString() !==
                    new Date(
                      messages[index - 1].created_at,
                    ).toDateString()) && (
                  <div className="date-divider">
                    <span>
                      {new Date(m.created_at).toLocaleDateString(undefined, {
                        weekday: "long",
                        month: "long",
                        day: "numeric",
                      })}
                    </span>
                  </div>
                )}
                <MessageRow
                  message={m}
                  me={me}
                  canManage={canManage}
                  onProfile={onProfile}
                  onReply={() => {
                    setReply(m);
                    textarea.current?.focus();
                  }}
                  action={action}
                />
              </div>
            ))}
            {pending.map((p) => (
              <div className="pending-message" key={p.nonce}>
                <Avatar user={me} />
                <div>
                  <b>{me.display_name}</b>
                  <p>
                    {p.content || p.attachments.map((a) => a.name).join(", ")}
                  </p>
                  {p.error ? (
                    <span className="danger">
                      {p.error}{" "}
                      <button
                        className="text-button"
                        onClick={() => void deliver(p)}
                      >
                        Retry
                      </button>
                      <button
                        className="text-button"
                        onClick={() =>
                          setPending((old) =>
                            old.filter((x) => x.nonce !== p.nonce),
                          )
                        }
                      >
                        Dismiss
                      </button>
                    </span>
                  ) : (
                    <small className="muted">Sending…</small>
                  )}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
      {!nearBottom && (
        <button className="jump-latest" onClick={jumpBottom}>
          Jump to latest ↓
        </button>
      )}
      <div className="composer-area">
        <div className="typing" aria-live="polite">
          {Object.values(typers).filter((at) => Date.now() - at < 6000).length >
          0
            ? "Someone is typing…"
            : " "}
        </div>
        {reply && (
          <div className="reply-bar">
            <Reply size={15} /> Replying to <b>{reply.display_name}</b>
            <span>{reply.content.slice(0, 70)}</span>
            <IconButton title="Cancel reply" onClick={() => setReply(null)}>
              <X size={15} />
            </IconButton>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="attachment-tray">
            {attachments.map((a) => (
              <span key={a.id}>
                <File size={15} />
                {a.name}
                <IconButton
                  title="Remove attachment"
                  onClick={() =>
                    setAttachments((old) => old.filter((x) => x.id !== a.id))
                  }
                >
                  <X size={13} />
                </IconButton>
              </span>
            ))}
          </div>
        )}
        {upload && (
          <div className="upload-progress">
            <span>
              {upload.name} · {upload.progress}%
            </span>
            <progress value={upload.progress} max={100} />
            <button
              className="text-button"
              onClick={() => abortUpload.current?.abort()}
            >
              Cancel
            </button>
          </div>
        )}
        {emojiOpen && (
          <div className="emoji-picker" role="group" aria-label="Emoji picker">
            {emoji.map((e) => (
              <button
                key={e}
                aria-label={`Insert ${e}`}
                onClick={() => {
                  updateContent(content + e);
                  textarea.current?.focus();
                }}
              >
                {e}
              </button>
            ))}
          </div>
        )}
        <div className="composer">
          <IconButton
            title="Attach files"
            onClick={() => file.current?.click()}
            disabled={!!upload}
          >
            <Plus size={23} />
          </IconButton>
          <input
            ref={file}
            hidden
            multiple
            type="file"
            onChange={(e) => {
              if (e.target.files) void uploadFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <textarea
            ref={textarea}
            rows={1}
            maxLength={8000}
            value={content}
            aria-label="Message"
            placeholder={`Message ${channel.server_id ? "# " : ""}${title}`}
            onChange={(e) => updateContent(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                enterSends &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                send();
              }
            }}
            onPaste={(e) => {
              const images = Array.from(e.clipboardData.files);
              if (images.length) {
                e.preventDefault();
                void uploadFiles(images);
              }
            }}
          />
          <IconButton
            title="Choose emoji"
            active={emojiOpen}
            onClick={() => setEmojiOpen(!emojiOpen)}
          >
            <Smile size={22} />
          </IconButton>
          <button
            className="send-button"
            aria-label="Send message"
            disabled={
              (!content.trim() && !attachments.length) || sending || !!upload
            }
            onClick={send}
          >
            <Send size={19} />
          </button>
        </div>
        <div className="composer-hint">
          <span>
            <b>Shift + Enter</b> for a new line · Markdown supported
          </span>
          <label>
            <input
              type="checkbox"
              checked={enterSends}
              onChange={(e) => {
                setEnterSends(e.target.checked);
                localStorage.setItem(
                  "wiisb.enterSends",
                  String(e.target.checked),
                );
              }}
            />{" "}
            Enter to send
          </label>
        </div>
      </div>
    </section>
  );
}
function MessageRow({
  message: m,
  me,
  onProfile,
  onReply,
  action,
  canManage,
}: {
  message: Message;
  me: User;
  onProfile: (u: User) => void;
  onReply: () => void;
  action: (fn: () => Promise<any>) => Promise<void>;
  canManage: boolean;
}) {
  const [menu, setMenu] = useState(false),
    [editing, setEditing] = useState(false),
    [edit, setEdit] = useState(m.content),
    [confirmDelete, setConfirmDelete] = useState(false),
    [reactionOpen, setReactionOpen] = useState(false);
  const user = {
    id: m.author_id,
    display_name: m.display_name || "Deleted account",
    username: m.username || "",
    avatar_id: m.avatar_id,
    avatar_zoom: m.avatar_zoom,
    avatar_x: m.avatar_x,
    avatar_y: m.avatar_y,
  };
  return (
    <article
      className={"message-row " + (m.pinned ? "pinned" : "")}
      id={"message-" + m.id}
    >
      <Avatar
        user={user}
        size={40}
        onClick={m.author_id ? () => onProfile(user) : undefined}
      />
      <div className="message-content">
        {m.reply && (
          <button
            className="message-reply"
            onClick={() =>
              document
                .getElementById("message-" + m.reply!.id)
                ?.scrollIntoView({ block: "center", behavior: "smooth" })
            }
          >
            <Reply size={13} />
            <b>{m.reply.display_name}</b> {m.reply.content.slice(0, 100)}
          </button>
        )}
        <div className="message-meta">
          <button onClick={() => m.author_id && onProfile(user)}>
            {user.display_name}
          </button>
          <time title={new Date(m.created_at).toLocaleString()}>
            {new Date(m.created_at).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
          {m.pinned && <Pin size={12} />}
        </div>
        {editing ? (
          <div className="edit-box">
            <textarea
              autoFocus
              value={edit}
              onChange={(e) => setEdit(e.target.value)}
              maxLength={8000}
            />
            <button
              className="primary small"
              onClick={() =>
                void action(async () => {
                  await api.patch("/v1/messages/" + m.id, { content: edit });
                  setEditing(false);
                })
              }
            >
              <Check size={15} />
              Save
            </button>
            <button
              className="secondary small"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="markdown">
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {children}
                  </a>
                ),
                img: ({ alt }) => (
                  <span className="muted">
                    [External image: {alt || "image"}]
                  </span>
                ),
              }}
            >
              {m.content}
            </Markdown>
            {m.edited_at && <small className="edited">(edited)</small>}
          </div>
        )}
        {m.attachments?.map((a) => (
          <Media key={a.id} attachment={a} />
        ))}
        {m.reactions?.length > 0 && (
          <div className="reactions">
            {m.reactions.map((r) => (
              <button
                key={r.emoji}
                className={r.users.includes(me.id) ? "selected" : ""}
                onClick={() =>
                  void action(() =>
                    api.request("/v1/messages/" + m.id + "/reactions", {
                      method: "PUT",
                      body: JSON.stringify({
                        emoji: r.emoji,
                        active: !r.users.includes(me.id),
                      }),
                    }),
                  )
                }
              >
                {r.emoji}
                <span>{r.users.length}</span>
              </button>
            ))}
          </div>
        )}
        {reactionOpen && (
          <div className="reaction-picker">
            {emoji.slice(0, 18).map((e) => (
              <button
                key={e}
                onClick={() =>
                  void action(async () => {
                    await api.request("/v1/messages/" + m.id + "/reactions", {
                      method: "PUT",
                      body: JSON.stringify({ emoji: e, active: true }),
                    });
                    setReactionOpen(false);
                  })
                }
              >
                {e}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="message-actions">
        <IconButton
          title="Add reaction"
          onClick={() => setReactionOpen(!reactionOpen)}
        >
          <Smile size={16} />
        </IconButton>
        <IconButton title="Reply" onClick={onReply}>
          <Reply size={16} />
        </IconButton>
        <IconButton
          title="Message actions"
          active={menu}
          onClick={() => setMenu(!menu)}
        >
          <MoreHorizontal size={17} />
        </IconButton>
      </div>
      {menu && (
        <div className="message-menu">
          <button
            onClick={() => {
              void navigator.clipboard.writeText(m.content);
              setMenu(false);
            }}
          >
            <Copy size={15} /> Copy text
          </button>
          {m.author_id === me.id && (
            <button
              onClick={() => {
                setEdit(m.content);
                setEditing(true);
                setMenu(false);
              }}
            >
              <Pencil size={15} />
              Edit message
            </button>
          )}
          {(canManage || !m.channel_id || m.author_id === me.id) && (
            <button
              onClick={() =>
                void action(async () => {
                  await api.patch("/v1/messages/" + m.id, {
                    pinned: !m.pinned,
                  });
                  setMenu(false);
                })
              }
            >
              <Pin size={15} />
              {m.pinned ? "Unpin" : "Pin"} message
            </button>
          )}
          {(m.author_id === me.id || canManage) && (
            <button
              className="danger"
              onClick={() => {
                setConfirmDelete(true);
                setMenu(false);
              }}
            >
              <Trash2 size={15} /> Delete message
            </button>
          )}
          <button
            onClick={() =>
              void action(async () => {
                await api.post("/v1/reports", {
                  targetId: m.id,
                  reason:
                    "Message reported by a participant for moderator review.",
                });
                setMenu(false);
              })
            }
          >
            <Flag size={15} />
            Report message
          </button>
          <button onClick={() => setMenu(false)}>
            <X size={15} /> Close menu
          </button>
        </div>
      )}
      {confirmDelete && (
        <Modal title="Delete message?" onClose={() => setConfirmDelete(false)}>
          <p>
            This removes the message and access to its attachments for everyone.
          </p>
          <div className="button-row">
            <button
              className="secondary"
              onClick={() => setConfirmDelete(false)}
            >
              Keep it
            </button>
            <button
              className="danger-button"
              onClick={() =>
                void action(async () => {
                  await api.delete("/v1/messages/" + m.id);
                  setConfirmDelete(false);
                })
              }
            >
              Delete message
            </button>
          </div>
        </Modal>
      )}
    </article>
  );
}
export function Media({ attachment: a }: { attachment: Attachment }) {
  const [url, setUrl] = useState(""),
    [full, setFull] = useState(false),
    [fullUrl, setFullUrl] = useState(""),
    [error, setError] = useState(false);
  useEffect(() => {
    let active = true,
      asset = "";
    void api
      .asset(
        a.id,
        a.mime.startsWith("image/") &&
          a.thumbnail &&
          (a.mime !== "image/gif" ||
            document.documentElement.dataset.motion === "reduced" ||
            window.matchMedia("(prefers-reduced-motion: reduce)").matches),
      )
      .then((u) => {
        asset = u;
        if (active) setUrl(u);
        else URL.revokeObjectURL(u);
      })
      .catch(() => setError(true));
    return () => {
      active = false;
      if (asset) URL.revokeObjectURL(asset);
    };
  }, [a.id]);
  useEffect(() => {
    if (!full) return;
    let active = true,
      asset = "";
    void api
      .asset(a.id)
      .then((value) => {
        asset = value;
        if (active) setFullUrl(value);
        else URL.revokeObjectURL(value);
      })
      .catch(() => setError(true));
    return () => {
      active = false;
      setFullUrl("");
      if (asset) URL.revokeObjectURL(asset);
    };
  }, [full, a.id]);
  async function download() {
    const u = await api.asset(a.id);
    const link = document.createElement("a");
    link.href = u;
    link.download = a.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
  }
  return (
    <div className="media">
      {error ? (
        <span className="muted">Media is unavailable.</span>
      ) : !url ? (
        <span className="muted">Loading attachment…</span>
      ) : a.mime.startsWith("image/") ? (
        <button className="image-preview" onClick={() => setFull(true)}>
          <img src={url} alt={a.name} loading="lazy" />
        </button>
      ) : a.mime.startsWith("video/") ? (
        <video controls preload="metadata" src={url} />
      ) : a.mime.startsWith("audio/") ? (
        <audio controls preload="metadata" src={url} />
      ) : (
        <div className="file-preview">
          <File size={24} />
          <span>
            <b>{a.name}</b>
            <small>{(a.size / 1024).toFixed(1)} KB</small>
          </span>
        </div>
      )}
      <div className="media-caption">
        <span>{a.name}</span>
        <IconButton
          title="Download attachment"
          onClick={() => void download().catch(() => setError(true))}
        >
          <Download size={15} />
        </IconButton>
      </div>
      {full && (
        <Modal title={a.name} wide onClose={() => setFull(false)}>
          <img className="lightbox" src={fullUrl || url} alt={a.name} />
          <button className="secondary" onClick={() => void download()}>
            <Download size={16} />
            Download original
          </button>
        </Modal>
      )}
    </div>
  );
}
