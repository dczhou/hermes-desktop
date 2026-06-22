import { spawn, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import { closeSync, existsSync, mkdirSync, openSync } from "fs";
import http from "http";
import https from "https";
import net from "net";
import { homedir } from "os";
import { join } from "path";
import { getConnectionConfig, type ConnectionConfig } from "./config";
import {
  getEnhancedPath,
  hermesCliArgs,
  HERMES_HOME,
  HERMES_PYTHON,
  HERMES_REPO,
} from "./installer";
import { buildLocalDashboardCliArgs } from "./dashboard-launch";
import {
  ensureLocalDashboardCompatibility,
  ensureSshDashboardCompatibility,
} from "./hermes-agent-compat";
import { HIDDEN_SUBPROCESS_OPTIONS } from "./process-options";
import { ensureSshTunnel, getSshTunnelUrl } from "./ssh-tunnel";
import {
  sshGatewayStatus,
  sshReadRemoteApiKey,
  sshStartGateway,
} from "./ssh-remote";
import {
  getActiveProfileNameSync,
  normalizeProfileName,
  profileHome,
} from "./utils";

export interface DashboardConnection {
  baseUrl: string;
  wsUrl: string;
  token: string;
  mode: "local" | "remote" | "ssh";
  profile?: string;
  pid?: number;
  port?: number;
  logPath?: string;
  alreadyRunning?: boolean;
  /** When "basic-auth", requests must carry the session Cookie header
   *  instead of the X-Hermes-Session-Token. */
  authMode?: "token" | "basic-auth";
  /** Session cookies (hermes_session_at=...; hermes_session_rt=...) used
   *  for both REST and ws-ticket requests under basic-auth mode. */
  cookies?: string;
}

export interface DashboardStatus {
  supported: boolean;
  running: boolean;
  connection?: DashboardConnection;
  error?: string;
  logPath?: string;
}

interface ManagedDashboard {
  proc: ChildProcess;
  connection: DashboardConnection;
}

const dashboards = new Map<string, ManagedDashboard>();

function resolveProfile(profile?: string): string | undefined {
  return normalizeProfileName(profile ?? getActiveProfileNameSync());
}

function profileKey(profile?: string): string {
  return resolveProfile(profile) ?? "default";
}

function dashboardWsUrl(baseUrl: string, token: string): string {
  const url = new URL("/api/ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  return url.toString();
}

function normalizeRemoteDashboardBaseUrl(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    if (url.pathname === "/v1" || url.pathname === "/api") {
      url.pathname = "";
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function remoteDashboardConnectionFromConfig(
  config: ConnectionConfig,
  profile?: string,
): DashboardConnection | null {
  if (config.mode !== "remote") return null;
  const baseUrl = normalizeRemoteDashboardBaseUrl(config.remoteUrl);
  if (!baseUrl) return null;

  // ── Basic Auth path ──────────────────────────────────────
  // When username/password are configured the remote Dashboard uses
  // cookie-based session auth. The connection's token is unused for
  // REST requests (we send Cookie instead) but we still need a
  // non-empty value so callers that check `connection.token` don't
  // bail out. The real wsUrl is built lazily after obtaining a
  // ws-ticket (see ensureBasicAuthWsTicket).
  if (config.username && config.password) {
    return {
      baseUrl,
      wsUrl: dashboardWsUrl(baseUrl, "basic-auth"), // placeholder, replaced before connect
      token: "basic-auth",
      mode: "remote",
      profile: resolveProfile(profile),
      authMode: "basic-auth",
    };
  }

  // ── Token path (legacy / API_SERVER_KEY) ─────────────────
  const token = config.apiKey.trim();
  if (!token) return null;
  return {
    baseUrl,
    wsUrl: dashboardWsUrl(baseUrl, token),
    token,
    mode: "remote",
    profile: resolveProfile(profile),
    authMode: "token",
  };
}

// ── Basic Auth helpers (cookie-based Dashboard auth) ──────
// When the remote Dashboard is configured with basic_auth
// (username/password), it rejects Bearer/X-Hermes-Session-Token
// auth and requires:
//   1. POST /auth/password-login → session cookies
//   2. REST requests carry Cookie: hermes_session_at=...
//   3. WebSocket: POST /api/auth/ws-ticket (with cookie) → one-time
//      ticket, then WS URL uses ?ticket=<ticket> instead of ?token=

interface BasicAuthCacheEntry {
  cookies: string;
  expiresAt: number;
}
const basicAuthCookieCache = new Map<string, BasicAuthCacheEntry>();
const BASIC_AUTH_COOKIE_TTL = 11 * 60 * 60 * 1000; // 11h (cookie max-age is 12h)

function basicAuthCacheKey(baseUrl: string, username: string): string {
  return `${baseUrl}|${username}`;
}

/**
 * Log in via Basic Auth and cache the session cookies.
 * The cookies (hermes_session_at / hermes_session_rt) are required for
 * all subsequent REST and ws-ticket requests.
 */
async function loginBasicAuth(
  baseUrl: string,
  username: string,
  password: string,
): Promise<string> {
  const cacheKey = basicAuthCacheKey(baseUrl, username);
  const cached = basicAuthCookieCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cached.cookies;
  }

  const loginUrl = new URL("/auth/password-login", `${baseUrl}/`).toString();
  const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

  return new Promise<string>((resolve, reject) => {
    const parsed = new URL(loginUrl);
    const client = parsed.protocol === "https:" ? https : http;
    const body = JSON.stringify({
      provider: "basic",
      username,
      password,
    });
    const req = client.request(
      parsed,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("error", reject);
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(
              new Error(`Dashboard login failed (${res.statusCode}): ${text || res.statusMessage || "check username/password"}`),
            );
            return;
          }
          const setCookieHeaders = res.headers["set-cookie"];
          if (!setCookieHeaders || setCookieHeaders.length === 0) {
            reject(new Error("Dashboard login succeeded but no session cookies were returned"));
            return;
          }
          // Parse "name=value" from each Set-Cookie header
          const cookies = setCookieHeaders
            .map((c) => c.split(";")[0])
            .join("; ");
          basicAuthCookieCache.set(cacheKey, {
            cookies,
            expiresAt: Date.now() + BASIC_AUTH_COOKIE_TTL,
          });
          resolve(cookies);
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error("Timed out during dashboard login"));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Obtain a one-time WebSocket ticket for Basic Auth mode.
 * The ticket is short-lived (default 30s TTL) so it must be fetched
 * immediately before each WS connect / probe.
 */
async function fetchWsTicket(
  baseUrl: string,
  cookies: string,
): Promise<string> {
  const ticketUrl = new URL("/api/auth/ws-ticket", `${baseUrl}/`).toString();
  return new Promise<string>((resolve, reject) => {
    const parsed = new URL(ticketUrl);
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request(
      parsed,
      {
        method: "POST",
        headers: {
          Cookie: cookies,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("error", reject);
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(
              new Error(`Failed to get WS ticket (${res.statusCode}): ${text || res.statusMessage}`),
            );
            return;
          }
          try {
            const data = JSON.parse(text) as { ticket?: string };
            if (!data.ticket) {
              reject(new Error("WS ticket response did not include a ticket"));
              return;
            }
            resolve(data.ticket);
          } catch {
            reject(new Error(`Invalid JSON from ws-ticket: ${text.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(5_000, () => {
      req.destroy(new Error("Timed out getting WS ticket"));
    });
    req.end();
  });
}

/**
 * Ensure a Basic Auth connection has valid cookies and a fresh
 * wsUrl with a one-time ticket. Called right before the WS probe
 * and before returning the connection to the renderer.
 */
async function ensureBasicAuthReady(
  connection: DashboardConnection,
  config: ConnectionConfig,
): Promise<void> {
  if (connection.authMode !== "basic-auth") return;
  const cookies = await loginBasicAuth(
    connection.baseUrl,
    config.username!,
    config.password!,
  );
  connection.cookies = cookies;
  const ticket = await fetchWsTicket(connection.baseUrl, cookies);
  // Build wsUrl with ?ticket= instead of ?token=
  const url = new URL("/api/ws", connection.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  connection.wsUrl = url.toString();
}

export function sshDashboardConnectionFromTunnel(
  config: ConnectionConfig,
  baseUrl: string | null,
  token: string,
  profile?: string,
): DashboardConnection | null {
  if (config.mode !== "ssh") return null;
  const normalizedBaseUrl = normalizeRemoteDashboardBaseUrl(baseUrl || "");
  const cleanToken = token.trim();
  if (!normalizedBaseUrl || !cleanToken) return null;
  return {
    baseUrl: normalizedBaseUrl,
    wsUrl: dashboardWsUrl(normalizedBaseUrl, cleanToken),
    token: cleanToken,
    mode: "ssh",
    profile: resolveProfile(profile),
  };
}

async function sshDashboardConnectionFromConfig(
  config: ConnectionConfig,
  profile?: string,
): Promise<DashboardConnection | null> {
  if (config.mode !== "ssh" || !config.ssh) return null;

  await ensureSshDashboardCompatibility(config.ssh);

  if (!(await sshGatewayStatus(config.ssh))) {
    await sshStartGateway(config.ssh);
  }

  await ensureSshTunnel(config.ssh);
  return sshDashboardConnectionFromTunnel(
    config,
    getSshTunnelUrl(),
    config.apiKey.trim() || (await sshReadRemoteApiKey(config.ssh)),
    profile,
  );
}

function getManagedDashboard(profile?: string): ManagedDashboard | undefined {
  const key = profileKey(profile);
  const managed = dashboards.get(key);
  if (!managed) return undefined;
  if (managed.proc.exitCode === null && !managed.proc.killed) return managed;
  dashboards.delete(key);
  return undefined;
}

function unsupportedReasonForLocalSpawn(): string | undefined {
  if (!existsSync(HERMES_REPO)) {
    return `Hermes repo not found at ${HERMES_REPO}.`;
  }
  if (!existsSync(HERMES_PYTHON)) {
    return `Hermes Python environment not found at ${HERMES_PYTHON}.`;
  }
  return undefined;
}

function dashboardLogPath(profile: string | undefined): string {
  const dir = profileHome(profile);
  mkdirSync(dir, { recursive: true });
  return join(dir, "dashboard-stderr.log");
}

function dashboardHasPrebuiltWebDist(): boolean {
  return existsSync(join(HERMES_REPO, "hermes_cli", "web_dist", "index.html"));
}

async function getFreePort(): Promise<number> {
  const preferred = Number(process.env.HERMES_DESKTOP_DASHBOARD_PORT);
  if (Number.isInteger(preferred) && preferred > 0 && preferred < 65536) {
    if (await isPortFree(preferred)) return preferred;
  }

  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

function requestJson(
  url: string,
  token: string,
  timeoutMs = 2_000,
  cookies?: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (cookies) {
      headers["Cookie"] = cookies;
    } else {
      headers["X-Hermes-Session-Token"] = token;
    }
    const req = client.request(
      parsed,
      { method: "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("error", reject);
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`${res.statusCode}: ${text || res.statusMessage}`));
            return;
          }
          if (!text) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(
              new Error(
                `Invalid JSON from ${url} (status ${res.statusCode}): ${text.slice(
                  0,
                  200,
                )}`,
              ),
            );
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new Error(`Timed out connecting to Hermes dashboard after ${timeoutMs}ms`),
      );
    });
    req.end();
  });
}

export function probeDashboardWebSocket(
  connection: DashboardConnection,
  timeoutMs = 2_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(connection.wsUrl);
    const client = parsed.protocol === "wss:" ? https : http;
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    const req = client.request(parsed, {
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
      },
    });

    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      req.destroy();
      if (err) reject(err);
      else resolve();
    };

    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      finish();
    });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8").trim();
        finish(
          new Error(
            `Hermes dashboard chat WebSocket is unavailable (${res.statusCode}${
              body ? `: ${body.slice(0, 160)}` : ""
            })`,
          ),
        );
      });
    });
    req.on("error", (err) => finish(err));
    req.setTimeout(timeoutMs, () => {
      finish(
        new Error(
          `Timed out connecting to Hermes dashboard chat WebSocket after ${timeoutMs}ms`,
        ),
      );
    });
    req.end();
  });
}

async function waitForDashboardReady(
  connection: DashboardConnection,
  timeoutMs = 45_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await requestJson(`${connection.baseUrl}/api/status`, connection.token);
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const message =
    lastError instanceof Error ? lastError.message : "dashboard did not respond";
  throw new Error(`Timed out waiting for Hermes dashboard: ${message}`);
}

function dashboardStatusRequiresOAuth(status: unknown): boolean {
  return (
    typeof status === "object" &&
    status !== null &&
    (status as { auth_required?: unknown }).auth_required === true
  );
}

async function getRemoteDashboardStatusForConfig(
  config: ConnectionConfig,
  profile?: string,
): Promise<DashboardStatus> {
  if (config.remoteChatTransport === "legacy") {
    return {
      supported: false,
      running: false,
      error: "Remote dashboard transport is disabled in Settings.",
    };
  }

  const connection = remoteDashboardConnectionFromConfig(config, profile);
  if (!connection) {
    return {
      supported: true,
      running: false,
      error:
        "Remote dashboard transport needs a valid dashboard URL and either an API key or Basic Auth (username/password).",
    };
  }

  try {
    // ── Basic Auth: login first, get session cookies ──
    if (connection.authMode === "basic-auth") {
      await ensureBasicAuthReady(connection, config);
    }

    const status = await requestJson(
      `${connection.baseUrl}/api/status`,
      connection.token,
      2_000,
      connection.cookies,
    );
    if (dashboardStatusRequiresOAuth(status)) {
      return {
        supported: true,
        running: false,
        error:
          "Remote dashboard requires OAuth browser authentication. Token-based remote dashboard is supported now; OAuth ticket flow is not wired in Hermes One yet.",
      };
    }

    // /api/status is intentionally public upstream. Touch an authenticated
    // endpoint as well so a legacy API key or stale token fails before the
    // renderer opens the WebSocket.
    await requestJson(
      `${connection.baseUrl}/api/sessions?limit=1`,
      connection.token,
      2_000,
      connection.cookies,
    );

    // ── Basic Auth: fetch a fresh ws-ticket right before the WS probe ──
    // The ticket expires in ~30s so we must renew it immediately before
    // handing the wsUrl to the renderer.
    if (connection.authMode === "basic-auth") {
      await ensureBasicAuthReady(connection, config);
    }
    await probeDashboardWebSocket(connection);

    // Strip cookies before crossing the IPC boundary — the renderer only
    // needs wsUrl (which carries the one-time ?ticket=) and token.
    return {
      supported: true,
      running: true,
      connection: { ...connection, cookies: undefined },
    };
  } catch (err) {
    return {
      supported: true,
      running: false,
      connection: { ...connection, cookies: undefined },
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function getSshDashboardStatusForConfig(
  config: ConnectionConfig,
  profile?: string,
): Promise<DashboardStatus> {
  if (config.sshChatTransport === "legacy") {
    return {
      supported: false,
      running: false,
      error: "SSH dashboard transport is disabled in Settings.",
    };
  }

  if (!config.ssh?.host || !config.ssh.username) {
    return {
      supported: true,
      running: false,
      error: "SSH dashboard transport needs a configured host and username.",
    };
  }

  let connection: DashboardConnection | null = null;
  try {
    connection = await sshDashboardConnectionFromConfig(config, profile);
  } catch (err) {
    return {
      supported: true,
      running: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!connection) {
    return {
      supported: true,
      running: false,
      error:
        "SSH dashboard transport needs an active tunnel and API_SERVER_KEY on the remote Hermes host.",
    };
  }

  try {
    const status = await requestJson(
      `${connection.baseUrl}/api/status`,
      connection.token,
    );
    if (dashboardStatusRequiresOAuth(status)) {
      return {
        supported: true,
        running: false,
        connection,
        error:
          "SSH dashboard requires OAuth browser authentication. Token-based dashboard over SSH is supported now; OAuth ticket flow is not wired in Hermes One yet.",
      };
    }

    await requestJson(
      `${connection.baseUrl}/api/sessions?limit=1`,
      connection.token,
    );
    await probeDashboardWebSocket(connection);

    return { supported: true, running: true, connection };
  } catch (err) {
    return {
      supported: true,
      running: false,
      connection,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getDashboardStatus(
  profile?: string,
): Promise<DashboardStatus> {
  const config = getConnectionConfig();
  const mode = config.mode === "remote" || config.mode === "ssh" ? config.mode : "local";
  if (mode === "remote") return getRemoteDashboardStatusForConfig(config, profile);
  if (mode === "ssh") return getSshDashboardStatusForConfig(config, profile);

  const managed = getManagedDashboard(profile);
  if (managed) {
    return {
      supported: true,
      running: true,
      connection: { ...managed.connection, alreadyRunning: true },
      logPath: managed.connection.logPath,
    };
  }

  const unsupported = unsupportedReasonForLocalSpawn();
  if (unsupported) {
    return { supported: false, running: false, error: unsupported };
  }

  return {
    supported: true,
    running: false,
    logPath: dashboardLogPath(resolveProfile(profile)),
  };
}

export async function startDashboard(profile?: string): Promise<DashboardStatus> {
  const config = getConnectionConfig();
  const mode = config.mode === "remote" || config.mode === "ssh" ? config.mode : "local";
  if (mode === "remote") return getRemoteDashboardStatusForConfig(config, profile);
  if (mode === "ssh") return getSshDashboardStatusForConfig(config, profile);

  const existing = getManagedDashboard(profile);
  if (existing) {
    return {
      supported: true,
      running: true,
      connection: { ...existing.connection, alreadyRunning: true },
      logPath: existing.connection.logPath,
    };
  }

  const unsupported = unsupportedReasonForLocalSpawn();
  if (unsupported) {
    return { supported: false, running: false, error: unsupported };
  }

  const compat = ensureLocalDashboardCompatibility();
  const compatWarning = compat.ok
    ? ""
    : compat.error
      ? `${compat.detail}: ${compat.error}`
      : compat.detail;

  const resolvedProfile = resolveProfile(profile);
  const key = profileKey(profile);
  const token = randomBytes(24).toString("hex");
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logPath = dashboardLogPath(resolvedProfile);
  const stderrFd = openSync(logPath, "a");
  const hasPrebuiltWebDist = dashboardHasPrebuiltWebDist();
  const cliArgs = buildLocalDashboardCliArgs(resolvedProfile, port, {
    skipBuild: hasPrebuiltWebDist,
  });

  let proc: ChildProcess;
  try {
    proc = spawn(HERMES_PYTHON, hermesCliArgs(cliArgs), {
      cwd: HERMES_REPO,
      env: {
        ...process.env,
        PATH: getEnhancedPath(),
        HOME: process.env.HOME || homedir(),
        HERMES_HOME,
        HERMES_DASHBOARD_SESSION_TOKEN: token,
        HERMES_DESKTOP: "1",
        ...(hasPrebuiltWebDist
          ? { HERMES_WEB_DIST: join(HERMES_REPO, "hermes_cli", "web_dist") }
          : {}),
      },
      stdio: ["ignore", "ignore", stderrFd],
      detached: false,
      ...HIDDEN_SUBPROCESS_OPTIONS,
    });
  } catch (err) {
    closeSync(stderrFd);
    return {
      supported: true,
      running: false,
      logPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  closeSync(stderrFd);

  const connection: DashboardConnection = {
    baseUrl,
    wsUrl: dashboardWsUrl(baseUrl, token),
    token,
    mode: "local",
    profile: resolvedProfile,
    pid: proc.pid,
    port,
    logPath,
  };

  dashboards.set(key, { proc, connection });
  proc.once("exit", () => {
    if (dashboards.get(key)?.proc === proc) dashboards.delete(key);
  });

  try {
    await waitForDashboardReady(
      connection,
      hasPrebuiltWebDist ? 45_000 : 180_000,
    );
    await probeDashboardWebSocket(connection, 5_000);
  } catch (err) {
    dashboards.delete(key);
    try {
      proc.kill();
    } catch {
      // Ignore shutdown errors for a failed probe; the log path is returned.
    }
    return {
      supported: true,
      running: false,
      logPath,
      error: [
        err instanceof Error ? err.message : String(err),
        compatWarning ? `compatibility: ${compatWarning}` : "",
      ]
        .filter(Boolean)
        .join("; "),
    };
  }

  return { supported: true, running: true, connection, logPath };
}

export function stopDashboard(profile?: string): boolean {
  const key = profileKey(profile);
  const managed = dashboards.get(key);
  if (!managed) return true;
  dashboards.delete(key);
  try {
    managed.proc.kill();
  } catch {
    return false;
  }
  return true;
}

export function stopAllDashboards(): void {
  for (const key of [...dashboards.keys()]) {
    stopDashboard(key === "default" ? undefined : key);
  }
}
