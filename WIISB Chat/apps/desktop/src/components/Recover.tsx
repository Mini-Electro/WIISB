import { useState } from "react";
import { ArrowLeft, ArrowRight, MailCheck } from "lucide-react";
import { api } from "../api";
import { Field, ErrorText, useTask } from "./UI";

/** "Forgot password?": ask for a code by email, then choose a new password with it. */
export function Recover({
  endpoint,
  onDone,
  onCancel,
}: {
  endpoint: string;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<"ask" | "code">("ask"),
    [email, setEmail] = useState(""),
    [code, setCode] = useState(""),
    [password, setPassword] = useState(""),
    [again, setAgain] = useState(""),
    [resent, setResent] = useState(false);
  const task = useTask();
  async function requestCode() {
    api.setEndpoint(endpoint);
    const info = await api.request("/v1/info", {}, false);
    if (info.emailRecovery === false)
      throw new Error(
        "This server hasn't set up email recovery. Ask its administrator to reset your password.",
      );
    await api.request(
      "/v1/auth/forgot",
      { method: "POST", body: JSON.stringify({ email: email.trim() }) },
      false,
    );
  }
  return (
    <>
      <h2>Forgot your password?</h2>
      {step === "ask" ? (
        <>
          <p>
            Enter the email linked to your account and we’ll send you a code to
            choose a new password.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void task.run(async () => {
                await requestCode();
                setStep("code");
              });
            }}
          >
            <Field
              label="Email"
              hint="Only works if you linked an email in Settings → Account."
            >
              <input
                type="email"
                required
                autoComplete="email"
                maxLength={254}
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <ErrorText error={task.error} />
            <button className="primary full" disabled={task.busy}>
              {task.busy ? "Sending…" : "Email me a code"}
              <ArrowRight size={18} />
            </button>
          </form>
        </>
      ) : (
        <>
          <p>
            <MailCheck size={16} aria-hidden /> If <b>{email.trim()}</b> is
            linked to an account, a code is on its way. It works for 15 minutes.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (password !== again) {
                task.setError("The two passwords don’t match.");
                return;
              }
              void task.run(async () => {
                await api.request(
                  "/v1/auth/reset",
                  {
                    method: "POST",
                    body: JSON.stringify({
                      email: email.trim(),
                      code,
                      password,
                    }),
                  },
                  false,
                );
                onDone("Password changed. Sign in with your new password.");
              });
            }}
          >
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
            <Field label="New password" hint="At least 10 characters.">
              <input
                required
                type="password"
                autoComplete="new-password"
                minLength={10}
                maxLength={128}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Field label="New password again">
              <input
                required
                type="password"
                autoComplete="new-password"
                minLength={10}
                maxLength={128}
                value={again}
                onChange={(e) => setAgain(e.target.value)}
              />
            </Field>
            <ErrorText error={task.error} />
            {resent && !task.error && (
              <p role="status" className="success">
                Sent again, if that email is linked. Use the newest code.
              </p>
            )}
            <button className="primary full" disabled={task.busy}>
              {task.busy ? "Resetting…" : "Reset password"}
              <ArrowRight size={18} />
            </button>
          </form>
          <p className="auth-switch">
            No email yet?{" "}
            <button
              type="button"
              className="text-button"
              disabled={task.busy}
              onClick={() =>
                void task.run(async () => {
                  await requestCode();
                  setResent(true);
                })
              }
            >
              Send another code
            </button>
          </p>
        </>
      )}
      <p className="auth-switch">
        <button type="button" className="text-button" onClick={onCancel}>
          <ArrowLeft size={14} aria-hidden /> Back to sign in
        </button>
      </p>
    </>
  );
}
