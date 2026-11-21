import { useState } from "react";
import {
  Users,
  UserPlus,
  MessageCircle,
  Check,
  X,
  UserMinus,
  ShieldOff,
} from "lucide-react";
import type { FriendState, User } from "../types";
import { api } from "../api";
import {
  Avatar,
  IconButton,
  Modal,
  Field,
  ErrorText,
  Empty,
  useTask,
} from "./UI";
export function Friends({
  data,
  onDM,
  onProfile,
  run,
}: {
  data: FriendState;
  onDM: (u: User) => void;
  onProfile: (u: User) => void;
  run: (fn: () => Promise<any>) => void;
}) {
  const [tab, setTab] = useState("Online"),
    [add, setAdd] = useState(false),
    [query, setQuery] = useState("");
  const friends = (
    tab === "Pending"
      ? [...data.incoming, ...data.outgoing]
      : tab === "Blocked"
        ? data.blocked
        : tab === "Online"
          ? data.friends.filter((f) => f.presence !== "offline")
          : data.friends
  ).filter((f) =>
    (f.display_name + " " + f.username)
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <section className="friends-page">
      <header className="content-header">
        <Users size={22} />
        <h2>Friends</h2>
        <span className="divider" />
        {["Online", "All", "Pending", "Blocked"].map((t) => (
          <button
            key={t}
            className={"tab " + (t === tab ? "selected" : "")}
            onClick={() => setTab(t)}
          >
            {t}
            {t === "Pending" && data.incoming.length > 0 && (
              <b className="badge">{data.incoming.length}</b>
            )}
          </button>
        ))}
        <button className="primary small" onClick={() => setAdd(true)}>
          <UserPlus size={16} /> Add friend
        </button>
      </header>
      <div className="friends-body">
        <div className="welcome-banner">
          <span className="eyebrow">A LITTLE CLOSER, EVEN FROM HERE</span>
          <h1>
            Your favourite people,
            <br />
            <span>one message away.</span>
          </h1>
          <div className="banner-orb">
            <Users size={74} />
          </div>
        </div>
        <input
          className="search-input"
          type="search"
          aria-label="Search friends"
          placeholder="Find someone in your crew"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="section-label">
          {tab.toUpperCase()} — {friends.length}
        </div>
        {!friends.length ? (
          <Empty
            icon={<Users size={38} />}
            title={
              tab === "Pending"
                ? "All caught up."
                : tab === "Blocked"
                  ? "No blocked users."
                  : "A good conversation starts here."
            }
          >
            {tab === "Blocked"
              ? "People you block will appear here."
              : tab === "Online"
                ? "Your online friends will appear here. Add someone to get started."
                : "Send a friend request using their username."}
          </Empty>
        ) : (
          friends.map((user) => (
            <div className="friend-row" key={user.id}>
              <Avatar user={user} size={44} onClick={() => onProfile(user)} />
              <button
                className="friend-identity"
                onClick={() => onProfile(user)}
              >
                <b>{user.display_name}</b>
                <span>
                  @{user.username} ·{" "}
                  {tab === "Pending"
                    ? data.incoming.some((f) => f.id === user.id)
                      ? "Incoming request"
                      : "Outgoing request"
                    : user.status || user.presence || "Blocked"}
                </span>
              </button>
              <div className="row-actions">
                {tab === "Pending" ? (
                  <>
                    {data.incoming.some((f) => f.id === user.id) && (
                      <IconButton
                        title="Accept friend request"
                        onClick={() =>
                          run(() => api.post(`/v1/friends/${user.id}/accept`))
                        }
                      >
                        <Check size={20} />
                      </IconButton>
                    )}
                    <IconButton
                      title="Dismiss request"
                      onClick={() =>
                        run(() => api.delete(`/v1/friends/${user.id}`))
                      }
                    >
                      <X size={20} />
                    </IconButton>
                  </>
                ) : tab === "Blocked" ? (
                  <IconButton
                    title="Unblock user"
                    onClick={() =>
                      run(() => api.delete(`/v1/blocks/${user.id}`))
                    }
                  >
                    <ShieldOff size={20} />
                  </IconButton>
                ) : (
                  <>
                    <IconButton title="Send message" onClick={() => onDM(user)}>
                      <MessageCircle size={19} />
                    </IconButton>
                    <IconButton
                      title="Remove friend"
                      onClick={() =>
                        run(() => api.delete(`/v1/friends/${user.id}`))
                      }
                    >
                      <UserMinus size={18} />
                    </IconButton>
                  </>
                )}
              </div>
            </div>
          ))
        )}
        <div className="friends-note">
          <ShieldOff size={16} />
          <span>
            Make yourself at home. Every profile, theme, and feature is free.
          </span>
        </div>
      </div>
      {add && <AddFriend onClose={() => setAdd(false)} />}
    </section>
  );
}
function AddFriend({ onClose }: { onClose: () => void }) {
  const [username, setUsername] = useState(""),
    [success, setSuccess] = useState(false);
  const task = useTask();
  return (
    <Modal title="Find your people" onClose={onClose}>
      <p className="muted">Send a request using their exact username.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void task.run(async () => {
            await api.post("/v1/friends", { username });
            setSuccess(true);
          });
        }}
      >
        <Field label="Username">
          <input
            required
            autoFocus
            placeholder="e.g. player_one"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setSuccess(false);
            }}
          />
        </Field>
        <ErrorText error={task.error} />
        {success && (
          <p className="success" role="status">
            Friend request sent.
          </p>
        )}
        <button className="primary full" disabled={task.busy}>
          <UserPlus size={18} />
          Send friend request
        </button>
      </form>
    </Modal>
  );
}
