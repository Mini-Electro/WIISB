import { useState } from "react";
import {
  Plus,
  Link,
  Copy,
  Trash2,
  Shield,
  Hash,
  Users,
  ArrowRight,
  Check,
} from "lucide-react";
import { api } from "../api";
import type { Channel, Community, User } from "../types";
import { Modal, Field, ErrorText, useTask, Avatar } from "./UI";
const allPermissions = [
  "view",
  "send",
  "attach",
  "react",
  "connect",
  "speak",
  "video",
  "stream",
  "manage_channels",
  "manage_server",
  "manage_roles",
  "manage_messages",
  "invite",
  "kick",
  "ban",
  "audit",
];
export function AddServer({
  onClose,
  onJoined,
}: {
  onClose: () => void;
  onJoined: (id: string) => void;
}) {
  const [mode, setMode] = useState("create"),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [token, setToken] = useState(""),
    [preview, setPreview] = useState<any>(null);
  const task = useTask();
  return (
    <Modal title="A new place to belong" onClose={onClose}>
      <div className="tabs">
        <button
          className={mode === "create" ? "selected" : ""}
          onClick={() => setMode("create")}
        >
          Create a community
        </button>
        <button
          className={mode === "join" ? "selected" : ""}
          onClick={() => setMode("join")}
        >
          Join with an invite
        </button>
      </div>
      {mode === "create" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void task.run(async () => {
              const server = await api.post("/v1/servers", {
                name,
                description,
              });
              onJoined(server.id);
              onClose();
            });
          }}
        >
          <p className="muted">
            For your team, your friends, or your next big thing.
          </p>
          <Field label="Community name">
            <input
              autoFocus
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Description">
            <textarea
              maxLength={1000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <ErrorText error={task.error} />
          <button className="primary full" disabled={task.busy}>
            <Plus size={17} />
            Create community
          </button>
        </form>
      ) : (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void task.run(async () =>
                setPreview(
                  await api.get(
                    "/v1/invites/" + encodeURIComponent(token.trim()),
                  ),
                ),
              );
            }}
          >
            <Field label="Invitation code">
              <input
                required
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  setPreview(null);
                }}
                placeholder="Paste the code your friend sent you"
              />
            </Field>
            <ErrorText error={task.error} />
            <button className="secondary full" disabled={task.busy}>
              Preview invitation
            </button>
          </form>
          {preview && (
            <div className="invite-preview">
              <Shield size={32} />
              <h2>{preview.name}</h2>
              <p>{preview.description || "A new community is waiting."}</p>
              <button
                className="primary full"
                onClick={() =>
                  void task.run(async () => {
                    const { serverId } = await api.post(
                      "/v1/invites/" +
                        encodeURIComponent(token.trim()) +
                        "/join",
                    );
                    onJoined(serverId);
                    onClose();
                  })
                }
              >
                Join community
                <ArrowRight size={17} />
              </button>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
export function GroupDialog({
  friends,
  onClose,
  onCreated,
  existing,
  uid,
}: {
  friends: User[];
  onClose: () => void;
  onCreated: (channel: Channel) => void;
  existing?: Channel;
  uid: string;
}) {
  const [name, setName] = useState(existing?.name || ""),
    [selected, setSelected] = useState<string[]>([]);
  const task = useTask();
  return (
    <Modal
      title={existing ? "Group conversation" : "Bring the crew together"}
      onClose={onClose}
    >
      <Field label="Group name">
        <input
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      {!existing && (
        <p className="muted">
          Choose friends to add. Groups support up to 20 people.
        </p>
      )}
      {(existing ? existing.members || [] : friends).map((u) => (
        <label className="group-option" key={u.id}>
          <Avatar user={u} />
          <span>{u.display_name}</span>
          {!existing ? (
            <input
              type="checkbox"
              checked={selected.includes(u.id)}
              onChange={(e) =>
                setSelected((old) =>
                  e.target.checked
                    ? [...old, u.id]
                    : old.filter((id) => id !== u.id),
                )
              }
            />
          ) : existing.owner_id === uid && u.id !== uid ? (
            <button
              className="text-button danger"
              onClick={() =>
                void task.run(async () => {
                  await api.patch("/v1/conversations/" + existing.id, {
                    remove: u.id,
                  });
                  onClose();
                })
              }
            >
              Remove
            </button>
          ) : null}
        </label>
      ))}
      {existing && existing.owner_id === uid && (
        <Field label="Add a friend">
          <select
            defaultValue=""
            onChange={(e) => {
              if (e.target.value)
                void task.run(async () => {
                  await api.patch("/v1/conversations/" + existing.id, {
                    add: e.target.value,
                  });
                  onClose();
                });
            }}
          >
            <option value="">Choose a friend…</option>
            {friends
              .filter((f) => !existing.members?.some((m) => m.id === f.id))
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.display_name}
                </option>
              ))}
          </select>
        </Field>
      )}
      <ErrorText error={task.error} />
      <div className="button-row">
        {(!existing || existing.owner_id === uid) && (
          <button
            className="primary"
            disabled={
              task.busy || !name.trim() || (!existing && !selected.length)
            }
            onClick={() =>
              void task.run(async () => {
                if (existing) {
                  await api.patch("/v1/conversations/" + existing.id, { name });
                  onClose();
                } else {
                  const channel = await api.post("/v1/conversations", {
                    users: selected,
                    name,
                  });
                  onCreated(channel);
                  onClose();
                }
              })
            }
          >
            {existing ? "Save name" : "Create group"}
          </button>
        )}
        {existing && (
          <button
            className="danger-button"
            onClick={() =>
              void task.run(async () => {
                await api.post("/v1/conversations/" + existing.id + "/leave");
                onClose();
              })
            }
          >
            Leave group
          </button>
        )}
      </div>
    </Modal>
  );
}
export function CommunitySettings({
  server,
  onClose,
  onChanged,
  onDeleted,
}: {
  server: Community;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onDeleted: () => void;
}) {
  const [tab, setTab] = useState("Overview"),
    [name, setName] = useState(server.name),
    [description, setDescription] = useState(server.description),
    [channelName, setChannelName] = useState(""),
    [kind, setKind] = useState("text"),
    [category, setCategory] = useState("CHANNELS"),
    [topic, setTopic] = useState(""),
    [slowMode, setSlowMode] = useState(0),
    [privateChannel, setPrivateChannel] = useState(false),
    [allowed, setAllowed] = useState<string[]>([]),
    [editingChannel, setEditingChannel] = useState<string | null>(null),
    [roleName, setRoleName] = useState(""),
    [roleColor, setRoleColor] = useState("#a78bfa"),
    [rolePosition, setRolePosition] = useState(10),
    [rolePerms, setRolePerms] = useState([
      "view",
      "send",
      "attach",
      "react",
      "connect",
      "speak",
      "video",
      "stream",
    ]),
    [invite, setInvite] = useState(""),
    [invites, setInvites] = useState<any[]>([]),
    [audit, setAudit] = useState<any[]>([]),
    [reason, setReason] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [notice, setNotice] = useState(""),
    [deleteChannel, setDeleteChannel] = useState("");
  const task = useTask();
  const can = (p: string) => server.myPermissions.includes(p);
  const action = (fn: () => Promise<any>) =>
    void task.run(async () => {
      await fn();
      await onChanged();
      setNotice("Changes saved.");
    });
  const editChannel = (c: Channel) => {
    setEditingChannel(c.id);
    setChannelName(c.name);
    setKind(c.kind);
    setCategory(c.category || "CHANNELS");
    setTopic(c.topic || "");
    setSlowMode(c.slow_mode || 0);
    setPrivateChannel(!!c.private);
    setAllowed(c.allowed_roles || []);
  };
  return (
    <Modal title={server.name + " · Community settings"} wide onClose={onClose}>
      <div className="tabs">
        {["Overview", "Channels", "Roles", "Members", "Invites", "Audit"].map(
          (t) => (
            <button
              key={t}
              className={tab === t ? "selected" : ""}
              onClick={() => {
                setTab(t);
                if (t === "Audit")
                  void task.run(async () =>
                    setAudit(
                      await api.get("/v1/servers/" + server.id + "/audit"),
                    ),
                  );
                if (t === "Invites" && can("manage_server"))
                  void task.run(async () =>
                    setInvites(
                      await api.get("/v1/servers/" + server.id + "/invites"),
                    ),
                  );
              }}
            >
              {t}
            </button>
          ),
        )}
      </div>
      <ErrorText error={task.error} />
      {notice && (
        <p className="success" role="status">
          {notice}
        </p>
      )}
      {tab === "Overview" && (
        <>
          <Field label="Community name">
            <input
              maxLength={80}
              value={name}
              disabled={!can("manage_server")}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Description">
            <textarea
              maxLength={1000}
              value={description}
              disabled={!can("manage_server")}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          {can("manage_server") && (
            <button
              className="primary"
              onClick={() =>
                action(() =>
                  api.patch("/v1/servers/" + server.id, { name, description }),
                )
              }
            >
              Save community
            </button>
          )}
          <hr />
          {server.owner ? (
            <>
              <h3>Ownership</h3>
              <Field label="Transfer ownership to a member">
                <select
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value)
                      action(() =>
                        api.post("/v1/servers/" + server.id + "/transfer", {
                          userId: e.target.value,
                        }),
                      );
                  }}
                >
                  <option value="">Choose the new owner…</option>
                  {server.members
                    .filter((m) => m.id !== server.owner_id)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.display_name}
                      </option>
                    ))}
                </select>
              </Field>
              <div className="danger-zone">
                <h3>Delete community</h3>
                <p>All channels, messages and memberships will be removed.</p>
                <Field label={`Type “${server.name}” to confirm`}>
                  <input
                    value={confirmation}
                    onChange={(e) => setConfirmation(e.target.value)}
                  />
                </Field>
                <button
                  className="danger-button"
                  disabled={confirmation !== server.name}
                  onClick={() =>
                    void task.run(async () => {
                      await api.delete("/v1/servers/" + server.id, {
                        confirmation,
                      });
                      onDeleted();
                      onClose();
                    })
                  }
                >
                  Delete community
                </button>
              </div>
            </>
          ) : (
            <button
              className="danger-button"
              onClick={() =>
                void task.run(async () => {
                  await api.post("/v1/servers/" + server.id + "/leave");
                  onDeleted();
                  onClose();
                })
              }
            >
              Leave community
            </button>
          )}
        </>
      )}
      {tab === "Channels" && (
        <>
          <div className="settings-list">
            {server.channels.map((c) => (
              <div key={c.id}>
                <Hash size={16} />
                <span>
                  {c.name}
                  <small>
                    {c.kind} · {c.category} {c.private ? "· Private" : ""}
                  </small>
                </span>
                {can("manage_channels") && (
                  <>
                    <button
                      className="secondary small"
                      onClick={() => editChannel(c)}
                    >
                      Edit
                    </button>
                    <button
                      className="text-button danger"
                      onClick={() => {
                        if (deleteChannel === c.id)
                          action(() => api.delete("/v1/channels/" + c.id));
                        else setDeleteChannel(c.id);
                      }}
                    >
                      {deleteChannel === c.id ? "Confirm delete" : "Delete"}
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
          {can("manage_channels") && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                action(async () => {
                  const data = {
                    name: channelName,
                    kind,
                    category,
                    topic,
                    slow_mode: slowMode,
                    private: privateChannel,
                    allowed_roles: allowed,
                  };
                  if (editingChannel)
                    await api.patch("/v1/channels/" + editingChannel, data);
                  else
                    await api.post(
                      "/v1/servers/" + server.id + "/channels",
                      data,
                    );
                  setChannelName("");
                  setEditingChannel(null);
                });
              }}
            >
              <h3>{editingChannel ? "Edit channel" : "Create a channel"}</h3>
              <div className="field-grid">
                <Field label="Name">
                  <input
                    required
                    maxLength={80}
                    value={channelName}
                    onChange={(e) => setChannelName(e.target.value)}
                  />
                </Field>
                <Field label="Type">
                  <select
                    value={kind}
                    onChange={(e) => setKind(e.target.value)}
                  >
                    {["text", "voice", "announcement", "media"].map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Category">
                  <input
                    maxLength={50}
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                  />
                </Field>
                <Field label="Slow mode (seconds)">
                  <input
                    type="number"
                    min={0}
                    max={21600}
                    value={slowMode}
                    onChange={(e) => setSlowMode(Number(e.target.value))}
                  />
                </Field>
              </div>
              <Field label="Topic">
                <input
                  maxLength={500}
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                />
              </Field>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={privateChannel}
                  onChange={(e) => setPrivateChannel(e.target.checked)}
                />
                Private channel
              </label>
              {privateChannel && (
                <div className="permission-grid">
                  {server.roles.map((r) => (
                    <label key={r.id}>
                      <input
                        type="checkbox"
                        checked={allowed.includes(r.id)}
                        onChange={(e) =>
                          setAllowed((old) =>
                            e.target.checked
                              ? [...old, r.id]
                              : old.filter((id) => id !== r.id),
                          )
                        }
                      />
                      {r.name}
                    </label>
                  ))}
                </div>
              )}
              <button className="primary" disabled={task.busy}>
                {editingChannel ? "Save channel" : "Create channel"}
              </button>
              {editingChannel && (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => {
                    setEditingChannel(null);
                    setChannelName("");
                  }}
                >
                  Cancel edit
                </button>
              )}
            </form>
          )}
        </>
      )}
      {tab === "Roles" && (
        <>
          <p className="muted">
            The owner has full access. Other members inherit the default role
            plus their assigned roles. Higher roles can manage lower roles.
          </p>
          <div className="settings-list">
            {server.roles.map((r) => (
              <div key={r.id}>
                <Shield size={16} color={r.color} />
                <span>
                  {r.name}
                  <small>
                    Rank {r.position} · {r.permissions.join(", ")}
                  </small>
                </span>
                {can("manage_roles") && !r.is_default && (
                  <button
                    className="text-button danger"
                    onClick={() =>
                      action(() =>
                        api.delete(`/v1/servers/${server.id}/roles/${r.id}`),
                      )
                    }
                  >
                    Delete
                  </button>
                )}
              </div>
            ))}
          </div>
          {can("manage_roles") && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                action(async () => {
                  await api.post("/v1/servers/" + server.id + "/roles", {
                    name: roleName,
                    color: roleColor,
                    position: rolePosition,
                    permissions: rolePerms,
                  });
                  setRoleName("");
                });
              }}
            >
              <h3>Create a role</h3>
              <div className="field-grid">
                <Field label="Name">
                  <input
                    required
                    maxLength={80}
                    value={roleName}
                    onChange={(e) => setRoleName(e.target.value)}
                  />
                </Field>
                <Field label="Colour">
                  <input
                    type="color"
                    value={roleColor}
                    onChange={(e) => setRoleColor(e.target.value)}
                  />
                </Field>
                <Field label="Rank">
                  <input
                    type="number"
                    value={rolePosition}
                    min={1}
                    max={1000}
                    onChange={(e) => setRolePosition(Number(e.target.value))}
                  />
                </Field>
              </div>
              <div className="permission-grid">
                {allPermissions.map((p) => (
                  <label key={p}>
                    <input
                      type="checkbox"
                      checked={rolePerms.includes(p)}
                      onChange={(e) =>
                        setRolePerms((old) =>
                          e.target.checked
                            ? [...old, p]
                            : old.filter((x) => x !== p),
                        )
                      }
                    />
                    {p.replaceAll("_", " ")}
                  </label>
                ))}
              </div>
              <button className="primary" disabled={task.busy}>
                Create role
              </button>
            </form>
          )}
        </>
      )}
      {tab === "Members" && (
        <>
          <Field label="Moderation reason">
            <input
              value={reason}
              maxLength={1000}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Provide context for the audit log"
            />
          </Field>
          {server.members.map((m) => (
            <div className="member-manage" key={m.id}>
              <div className="member-heading">
                <Avatar user={m} size={32} />
                <span>
                  <b>{m.display_name}</b>
                  <small>
                    @{m.username}
                    {m.id === server.owner_id ? " · Owner" : ""}
                  </small>
                </span>
                {m.id !== server.owner_id && (can("kick") || can("ban")) && (
                  <select
                    value=""
                    aria-label={"Moderate " + m.display_name}
                    onChange={(e) => {
                      if (e.target.value)
                        action(() =>
                          api.post("/v1/servers/" + server.id + "/moderation", {
                            action: e.target.value,
                            userId: m.id,
                            reason,
                            minutes: 60,
                          }),
                        );
                    }}
                  >
                    <option value="">Moderate…</option>
                    {can("kick") && (
                      <>
                        <option value="timeout">Timeout 1 hour</option>
                        <option value="kick">Kick</option>
                      </>
                    )}
                    {can("ban") && <option value="ban">Ban</option>}
                  </select>
                )}
              </div>
              {can("manage_roles") && m.id !== server.owner_id && (
                <div className="member-roles">
                  {server.roles
                    .filter((r) => !r.is_default)
                    .map((r) => (
                      <label key={r.id}>
                        <input
                          type="checkbox"
                          checked={m.roles.includes(r.id)}
                          onChange={(e) =>
                            action(() =>
                              api.request(
                                `/v1/servers/${server.id}/members/${m.id}/roles`,
                                {
                                  method: "PUT",
                                  body: JSON.stringify({
                                    roles: e.target.checked
                                      ? [...m.roles, r.id]
                                      : m.roles.filter((id) => id !== r.id),
                                  }),
                                },
                              ),
                            )
                          }
                        />
                        {r.name}
                      </label>
                    ))}
                </div>
              )}
            </div>
          ))}
        </>
      )}
      {tab === "Invites" && (
        <>
          <p className="muted">
            Invitation codes expire in 24 hours and allow up to 25 joins by
            default.
          </p>
          {can("invite") && (
            <button
              className="primary"
              onClick={() =>
                void task.run(async () =>
                  setInvite(
                    (await api.post("/v1/servers/" + server.id + "/invites"))
                      .token,
                  ),
                )
              }
            >
              <Link size={17} />
              Create invitation
            </button>
          )}
          {invite && (
            <div className="invite-code">
              <code>{invite}</code>
              <button
                className="secondary small"
                onClick={() => void navigator.clipboard.writeText(invite)}
              >
                <Copy size={15} />
                Copy
              </button>
            </div>
          )}
          {invites.map((i) => (
            <div className="session-row" key={i.token}>
              <span>
                <b>{i.token.slice(0, 12)}…</b>
                <small>
                  {i.uses}/{i.max_uses} uses · Expires{" "}
                  {new Date(i.expires_at).toLocaleString()}
                </small>
              </span>
              <button
                className="text-button danger"
                onClick={() =>
                  void task.run(async () => {
                    await api.delete("/v1/invites/" + i.token);
                    setInvites(
                      await api.get("/v1/servers/" + server.id + "/invites"),
                    );
                  })
                }
              >
                Revoke
              </button>
            </div>
          ))}
        </>
      )}
      {tab === "Audit" && (
        <>
          {!audit.length && (
            <p className="muted">No audit entries to display.</p>
          )}
          {audit.map((a) => (
            <div className="audit-entry" key={a.id}>
              <Shield size={16} />
              <span>
                <b>{a.action}</b>
                <p>{a.reason}</p>
                <small>
                  {new Date(a.created_at).toLocaleString()} · Actor {a.actor_id}
                </small>
              </span>
            </div>
          ))}
        </>
      )}
    </Modal>
  );
}
