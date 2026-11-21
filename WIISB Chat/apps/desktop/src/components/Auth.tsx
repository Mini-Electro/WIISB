import { useState } from "react";
import {
  ArrowRight,
  Radio,
  ShieldCheck,
  SlidersHorizontal,
  Server,
} from "lucide-react";
import { api } from "../api";
import type { Session } from "../types";
import { Mark, Field, ErrorText, useTask } from "./UI";
import { Recover } from "./Recover";
export function Auth({
  onLogin,
  initialError = "",
}: {
  onLogin: (s: Session) => void;
  initialError?: string;
}) {
  const [register, setRegister] = useState(false),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [displayName, setDisplayName] = useState(""),
    [endpoint, setEndpoint] = useState(api.endpoint),
    [connection, setConnection] = useState(false),
    [recovering, setRecovering] = useState(false),
    [notice, setNotice] = useState("");
  const task = useTask();
  return (
    <main className="auth">
      <section className="auth-story">
        <div className="wordmark">
          <Mark />
          <span>
            WIISB<span className="text-accent"> CHAT</span>
          </span>
        </div>
        <div className="story-content">
          <div className="eyebrow">
            <span className="dot" /> YOUR PEOPLE. YOUR SPACE.
          </div>
          <h1>
            Good company.
            <br />
            <span>Zero limits on you.</span>
          </h1>
          <p>
            A place for late nights, big ideas, and the people who get you. Make
            it yours.
          </p>
          <div className="orbit">
            <div className="orbit-circle one" />
            <div className="orbit-circle two" />
            <div className="orbit-core">
              <Mark />
            </div>
            <span className="orbit-label l1">
              <Radio size={18} /> Keep the conversation going
            </span>
            <span className="orbit-label l2">
              <SlidersHorizontal size={18} /> Your look. Your rules.
            </span>
            <span className="orbit-label l3">
              <ShieldCheck size={18} /> Free features. Always.
            </span>
          </div>
        </div>
        <footer>
          INDEPENDENT BY DESIGN <span>BUILT FOR CONNECTION</span>
        </footer>
      </section>
      <section className="auth-form">
        <div className="auth-card">
          <span className="eyebrow">WELCOME TO YOUR NEXT HANGOUT</span>
          {recovering ? (
            <Recover
              endpoint={endpoint}
              onCancel={() => setRecovering(false)}
              onDone={(message) => {
                setRecovering(false);
                setRegister(false);
                setPassword("");
                setNotice(message);
              }}
            />
          ) : (
            <>
              <h2>{register ? "Find your people." : "Welcome back."}</h2>
              <p>
                {register
                  ? "Create your account on this WIISB Chat server."
                  : "Pick up right where you left off."}
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void task.run(async () => {
                    api.setEndpoint(endpoint);
                    const info = await api.request("/v1/info", {}, false);
                    if (info.protocol !== 1)
                      throw new Error(
                        "This server uses an unsupported protocol.",
                      );
                    const s = await api.request<Session>(
                      "/v1/auth/" + (register ? "register" : "login"),
                      {
                        method: "POST",
                        body: JSON.stringify({
                          username,
                          password,
                          ...(register ? { displayName } : {}),
                        }),
                      },
                      false,
                    );
                    await api.save(s);
                    onLogin(s);
                  });
                }}
              >
                <Field label="Username">
                  <input
                    autoComplete="username"
                    pattern="[a-z0-9_]{3,32}"
                    required
                    minLength={3}
                    maxLength={32}
                    placeholder="Your unique handle"
                    value={username}
                    onChange={(e) => setUsername(e.target.value.toLowerCase())}
                  />
                </Field>
                {register && (
                  <Field label="Display name">
                    <input
                      autoComplete="nickname"
                      required
                      maxLength={80}
                      placeholder="What should we call you?"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                    />
                  </Field>
                )}
                <Field
                  label="Password"
                  hint={
                    register
                      ? "At least 10 characters. No payment details, ever."
                      : undefined
                  }
                >
                  <input
                    autoComplete={
                      register ? "new-password" : "current-password"
                    }
                    required
                    type="password"
                    minLength={10}
                    maxLength={128}
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
                {!register && (
                  <p className="auth-switch">
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        task.setError("");
                        setNotice("");
                        setRecovering(true);
                      }}
                    >
                      Forgot password?
                    </button>
                  </p>
                )}
                {notice && (
                  <p role="status" className="success">
                    {notice}
                  </p>
                )}
                <ErrorText error={task.error || initialError} />
                <button className="primary full" disabled={task.busy}>
                  {task.busy
                    ? "Connecting…"
                    : register
                      ? "Create account"
                      : "Let’s go"}
                  <ArrowRight size={18} />
                </button>
              </form>
              <p className="auth-switch">
                {register ? "Already part of the crew?" : "New around here?"}{" "}
                <button
                  className="text-button"
                  onClick={() => {
                    setRegister(!register);
                    task.setError("");
                  }}
                >
                  {register ? "Sign in" : "Create an account"}
                </button>
              </p>
            </>
          )}
          <div className="connection-card">
            <button onClick={() => setConnection(!connection)}>
              <Server size={17} />
              <span>
                <b>Connected server</b>
                <small>{endpoint}</small>
              </span>
              <SlidersHorizontal size={16} />
            </button>
            {connection && (
              <Field
                label="Server address"
                hint="Use your host’s HTTPS address. Local development uses 127.0.0.1:4310."
              >
                <input
                  type="url"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                />
              </Field>
            )}
          </div>
          <small className="muted">
            Accounts belong to the server you choose. Link an email in Settings
            → Account to be able to reset a forgotten password.
          </small>
        </div>
      </section>
    </main>
  );
}
