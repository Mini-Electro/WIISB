import { isTauri, invoke } from "@tauri-apps/api/core";
import type { Session, Event } from "./types";
export class RequestError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}
export function validEndpoint(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Enter a server origin, such as https://chat.example.com.");
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error(
      "Remote servers require HTTPS. HTTP is allowed only for local development.",
    );
  return url.origin;
}
class Client {
  endpoint = localStorage.getItem("wiisb.endpoint") || "http://127.0.0.1:4310";
  session: Session | null = null;
  private refreshing: Promise<void> | null = null;
  onExpired = () => {};
  setEndpoint(value: string) {
    this.endpoint = validEndpoint(value);
    localStorage.setItem("wiisb.endpoint", this.endpoint);
  }
  async save(session: Session) {
    this.session = session;
    if (isTauri())
      await invoke("vault_set", {
        value: JSON.stringify({
          endpoint: this.endpoint,
          refresh: session.refresh,
        }),
      });
  }
  async restore() {
    if (!isTauri()) return null;
    const stored = await invoke<string | null>("vault_get");
    if (!stored) return null;
    const saved = JSON.parse(stored);
    this.setEndpoint(saved.endpoint);
    this.session = { access: "", refresh: saved.refresh, user: null! };
    await this.refresh();
    return this.session;
  }
  async clear() {
    this.session = null;
    if (isTauri()) await invoke("vault_clear");
  }
  async refresh() {
    if (!this.refreshing)
      this.refreshing = (async () => {
        const refresh = this.session?.refresh;
        if (!refresh)
          throw new RequestError("unauthorized", "Sign in again.", 401);
        try {
          const session = await this.request<Session>(
            "/v1/auth/refresh",
            { method: "POST", body: JSON.stringify({ refresh }) },
            false,
          );
          await this.save(session);
        } catch (e) {
          if (e instanceof RequestError && e.status === 401) {
            await this.clear();
            this.onExpired();
          }
          throw e;
        }
      })().finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }
  async request<T = any>(
    path: string,
    init: RequestInit = {},
    auth = true,
    retry = true,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body && !(init.body instanceof FormData))
      headers.set("Content-Type", "application/json");
    if (auth && this.session?.access)
      headers.set("Authorization", "Bearer " + this.session.access);
    let response: Response;
    try {
      response = await fetch(this.endpoint + path, {
        ...init,
        headers,
        signal: init.signal || AbortSignal.timeout(20000),
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      throw new RequestError(
        "offline",
        "Unable to connect to WIISB Chat. Check the server address and connection.",
      );
    }
    if (response.status === 401 && auth && retry && this.session?.refresh) {
      await this.refresh();
      return this.request<T>(path, init, true, false);
    }
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new RequestError(
        error.code || "request_failed",
        error.message || `Request failed (${response.status}).`,
        response.status,
      );
    }
    return response.json();
  }
  get<T = any>(path: string) {
    return this.request<T>(path);
  }
  post<T = any>(path: string, data: any = {}) {
    return this.request<T>(path, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }
  patch<T = any>(path: string, data: any) {
    return this.request<T>(path, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }
  delete(path: string, data?: any) {
    return this.request(path, {
      method: "DELETE",
      body: data ? JSON.stringify(data) : undefined,
    });
  }
  async asset(aid: string, thumbnail = false) {
    const load = () =>
      fetch(
        this.endpoint +
          `/v1/attachments/${aid}${thumbnail ? "?thumbnail=true" : ""}`,
        {
          headers: { Authorization: "Bearer " + this.session?.access },
          signal: AbortSignal.timeout(30000),
        },
      );
    let response = await load();
    if (response.status === 401) {
      await this.refresh();
      response = await load();
    }
    if (!response.ok) throw new Error("Media is unavailable.");
    return URL.createObjectURL(await response.blob());
  }
  upload(
    path: string,
    file: File,
    onProgress: (p: number) => void,
    signal: AbortSignal,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("POST", this.endpoint + path);
      request.timeout = 180000;
      request.setRequestHeader(
        "Authorization",
        "Bearer " + this.session?.access,
      );
      const abort = () => request.abort();
      signal.addEventListener("abort", abort, { once: true });
      request.upload.onprogress = (e) => {
        if (e.lengthComputable)
          onProgress(Math.round((e.loaded / e.total) * 100));
      };
      const finish = () => signal.removeEventListener("abort", abort);
      request.onload = () => {
        finish();
        let data: any;
        try {
          data = JSON.parse(request.responseText);
        } catch {
          reject(new Error("Invalid upload response."));
          return;
        }
        if (request.status >= 200 && request.status < 300) resolve(data);
        else
          reject(
            new RequestError(
              data.code,
              data.message || "Upload failed.",
              request.status,
            ),
          );
      };
      request.onerror = request.ontimeout = () => {
        finish();
        reject(new Error("Upload failed. Check your connection."));
      };
      request.onabort = () => {
        finish();
        reject(new Error("Upload cancelled."));
      };
      const form = new FormData();
      form.append("file", file);
      if (signal.aborted) {
        finish();
        reject(new Error("Upload cancelled."));
        return;
      }
      request.send(form);
    });
  }
}
export const api = new Client();
export const eventBus = new EventTarget();
export function realtime(
  onEvent: (e: Event) => void,
  onStatus: (s: string) => void,
) {
  let closed = false,
    socket: WebSocket | undefined,
    timer: ReturnType<typeof setTimeout>,
    heartbeat: ReturnType<typeof setInterval>,
    attempt = 0,
    lastPong = 0;
  async function connect() {
    if (closed) return;
    onStatus(attempt ? "Reconnecting" : "Connecting");
    try {
      const { ticket } = await api.post("/v1/realtime-ticket");
      if (closed) return;
      const url = new URL(api.endpoint.replace(/^http/, "ws") + "/v1/events");
      url.searchParams.set("ticket", ticket);
      socket = new WebSocket(url);
      socket.onopen = () => {
        attempt = 0;
        lastPong = Date.now();
        onStatus("Connected");
        heartbeat = setInterval(() => {
          if (Date.now() - lastPong > 45000) socket?.close();
          else socket?.send(JSON.stringify({ type: "ping" }));
        }, 15000);
      };
      socket.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          if (event.type === "pong") lastPong = Date.now();
          else onEvent(event);
        } catch {}
      };
      socket.onclose = () => {
        clearInterval(heartbeat);
        schedule();
      };
      socket.onerror = () => socket?.close();
    } catch {
      schedule();
    }
  }
  function schedule() {
    if (closed) return;
    onStatus("Offline");
    timer = setTimeout(
      () => void connect(),
      Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)) + Math.random() * 500,
    );
  }
  void connect();
  return {
    send: (event: any) => {
      if (socket?.readyState === 1) socket.send(JSON.stringify(event));
    },
    close: () => {
      closed = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      socket?.close();
    },
  };
}
