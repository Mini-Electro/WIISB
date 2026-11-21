import { useEffect, useState } from "react";
import { MessageCircle, UserPlus, ShieldBan, Flag } from "lucide-react";
import type { User } from "../types";
import { api } from "../api";
import {
  Modal,
  Avatar,
  ProfileBanner,
  Field,
  ErrorText,
  useTask,
  Loading,
} from "./UI";
export function Profile({
  user,
  onClose,
  onDM,
}: {
  user: User;
  onClose: () => void;
  onDM: (u: User) => void;
}) {
  const [profile, setProfile] = useState<User | null>(null),
    [report, setReport] = useState(false),
    [reason, setReason] = useState("");
  const task = useTask();
  useEffect(() => {
    void task.run(async () =>
      setProfile(await api.get("/v1/users/" + user.id)),
    );
  }, [user.id]);
  return (
    <Modal title="Profile" onClose={onClose}>
      <ErrorText error={task.error} />
      {!profile ? (
        <Loading />
      ) : (
        <>
          <ProfileBanner user={profile} />
          <div className="profile-identity">
            <Avatar user={profile} size={78} />
            <h2>{profile.display_name}</h2>
            <p>
              @{profile.username} {profile.pronouns && "· " + profile.pronouns}
            </p>
            {profile.status && (
              <span className="status-pill">{profile.status}</span>
            )}
          </div>
          <p className="bio">
            {profile.bio || "A little mystery. A lot of potential."}
          </p>
          <div className="button-row">
            <button
              className="primary"
              onClick={() => {
                onDM(profile);
                onClose();
              }}
            >
              <MessageCircle size={17} /> Message
            </button>
            <button
              className="secondary"
              onClick={() =>
                void task.run(async () => {
                  await api.post("/v1/friends", { username: profile.username });
                  onClose();
                })
              }
            >
              <UserPlus size={17} /> Add friend
            </button>
          </div>
          <div className="button-row">
            <button
              className="text-button danger"
              onClick={() =>
                void task.run(async () => {
                  await api.post("/v1/blocks/" + profile.id);
                  onClose();
                })
              }
            >
              <ShieldBan size={15} /> Block
            </button>
            <button
              className="text-button muted"
              onClick={() => setReport(!report)}
            >
              <Flag size={15} /> Report
            </button>
          </div>
          {report && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void task.run(async () => {
                  await api.post("/v1/reports", {
                    targetId: profile.id,
                    reason,
                  });
                  onClose();
                });
              }}
            >
              <Field label="Report reason">
                <textarea
                  required
                  minLength={3}
                  maxLength={2000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
              <button className="secondary">Submit report to the host</button>
            </form>
          )}
        </>
      )}
    </Modal>
  );
}
