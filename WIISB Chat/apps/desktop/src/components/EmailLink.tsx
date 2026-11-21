import { useEffect, useState } from "react";
import { api } from "../api";
import { Field, ErrorText, useTask } from "./UI";

type EmailState = {
  available: boolean;
  email: string | null;
  pending: string | null;
};

/** Settings → Account: link an email (so a forgotten password can be reset), confirm it with a code, or unlink it. */
export function EmailLink() {
  const [state, setState] = useState<EmailState | null>(null),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [code, setCode] = useState(""),
    [editing, setEditing] = useState(false),
    [message, setMessage] = useState("");
  const task = useTask();
  const load = async () =>
    setState(await api.get<EmailState>("/v1/account/email"));
  useEffect(() => {
    void task.run(load);
  }, []);
  if (!state)
    return (
      <>
        <h3>Email &amp; password reset</h3>
        <ErrorText error={task.error} />
      </>
    );
  const waitingForCode = !!state.pending && editing === false;
  return (
    <>
      <h3>Email &amp; password reset</h3>
      {!state.available ? (
        <p className="muted">
          This server hasn’t set up email, so a forgotten password can only be
          reset by its administrator.
        </p>
      ) : (
        <p className="muted">
          Link an email so you can reset your password yourself if you ever
          forget it. It’s used for nothing else, and other people can’t see it.
        </p>
      )}
      {message && (
        <p role="status" className="success">
          {message}
        </p>
      )}
      <ErrorText error={task.error} />

      {state.available && state.email && !editing && !state.pending && (
        <>
          <p>
            Linked email: <b>{state.email}</b>
          </p>
          <Field
            label="Your password"
            hint="Needed to change or remove the email."
          >
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <button
            className="secondary"
            disabled={task.busy || !password}
            onClick={() => setEditing(true)}
          >
            Change email
          </button>{" "}
          <button
            className="danger-button"
            disabled={task.busy || !password}
            onClick={() =>
              void task.run(async () => {
                await api.delete("/v1/account/email", { password });
                setPassword("");
                setMessage(
                  "Email removed. Password reset by email is now off.",
                );
                await load();
              })
            }
          >
            Remove email
          </button>
        </>
      )}

      {state.available && waitingForCode && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void task.run(async () => {
              await api.post("/v1/account/email/verify", { code });
              setCode("");
              setPassword("");
              setMessage(
                "Email linked. You can now reset your password by email.",
              );
              await load();
            });
          }}
        >
          <p>
            We sent a code to <b>{state.pending}</b>. It works for 15 minutes.
          </p>
          <Field label="Code from the email">
            <input
              required
              autoComplete="one-time-code"
              maxLength={12}
              placeholder="ABCD-EFGH"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
          </Field>
          <button className="primary" disabled={task.busy}>
            Confirm email
          </button>{" "}
          <button
            type="button"
            className="secondary"
            onClick={() => setState({ ...state, pending: null })}
          >
            Use a different email
          </button>
        </form>
      )}

      {state.available && ((!state.email && !state.pending) || editing) && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void task.run(async () => {
              await api.post("/v1/account/email", {
                email: email.trim(),
                password,
              });
              setPassword("");
              setEmail("");
              setEditing(false);
              setMessage("");
              await load();
            });
          }}
        >
          <Field label="Email">
            <input
              required
              type="email"
              autoComplete="email"
              maxLength={254}
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Your password" hint="To make sure it’s really you.">
            <input
              required
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <button className="primary" disabled={task.busy}>
            {task.busy ? "Sending…" : "Send me a code"}
          </button>
          {editing && (
            <>
              {" "}
              <button
                type="button"
                className="secondary"
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
            </>
          )}
        </form>
      )}
    </>
  );
}
