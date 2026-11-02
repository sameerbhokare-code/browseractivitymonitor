// Small Supabase client using fetch only (no external library, so it works
// inside an MV3 service worker). Covers email/password auth, table access
// through PostgREST, and database functions (RPC).

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config.js";

const BASE = SUPABASE_URL.replace(/\/+$/, "");

export function isConfigured() {
  return /^https:\/\/[^/]+$/.test(BASE) &&
    !BASE.includes("YOUR-PROJECT") &&
    typeof SUPABASE_ANON_KEY === "string" &&
    SUPABASE_ANON_KEY.length > 20 &&
    !SUPABASE_ANON_KEY.startsWith("YOUR");
}

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function parse(response) {
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const message = (data && (data.msg || data.message || data.error_description || data.error)) ||
      `Request failed (${response.status})`;
    throw new ApiError(message, response.status, data && (data.code || data.error_code));
  }
  return data;
}

async function call(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new ApiError("Cannot reach Supabase. Check your internet connection.", 0, "network");
  }
  return parse(response);
}

/* ---------- Session ---------- */

async function saveSession(data) {
  const session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    user: {
      id: data.user.id,
      email: data.user.email,
      display_name: data.user.user_metadata?.display_name || ""
    }
  };
  await chrome.storage.local.set({ session });
  return session;
}

export async function getSession() {
  const { session } = await chrome.storage.local.get("session");
  return session || null;
}

let refreshing = null;

async function refreshSession(session) {
  if (!refreshing) {
    refreshing = call(`${BASE}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    })
      .then(saveSession)
      .catch(async (error) => {
        if (error.status >= 400 && error.status < 500) {
          // Refresh token no longer valid: user must sign in again.
          await chrome.storage.local.remove("session");
          throw new ApiError("Your session expired. Please sign in again.", 401, "session_expired");
        }
        throw error;
      })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function getAccessToken({ forceRefresh = false } = {}) {
  let session = await getSession();
  if (!session) throw new ApiError("Not signed in.", 401, "not_signed_in");
  const expiresSoon = session.expires_at - 60 < Date.now() / 1000;
  if (forceRefresh || expiresSoon) session = await refreshSession(session);
  return session.access_token;
}

/* ---------- Auth ---------- */

export async function signUp(email, password, displayName) {
  const data = await call(`${BASE}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, data: { display_name: displayName } })
  });
  if (data && data.access_token) {
    return { session: await saveSession(data) };
  }
  // Email confirmation is switched on in Supabase.
  return { needsConfirmation: true };
}

export async function signIn(email, password) {
  const data = await call(`${BASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  return saveSession(data);
}

export async function signOut() {
  const session = await getSession();
  if (session) {
    fetch(`${BASE}/auth/v1/logout`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` }
    }).catch(() => {});
  }
  await chrome.storage.local.remove(["session", "deviceId", "deviceName", "lastSyncAt", "lastSyncError"]);
  await chrome.storage.local.set({ cloudSync: false });
}

/* ---------- Database ---------- */

// path examples: "devices", "activity?select=id&limit=1", "rpc/my_grants"
export async function rest(path, { method = "GET", body, prefer } = {}) {
  const send = async (token) => {
    const headers = {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    };
    if (prefer) headers.Prefer = prefer;
    return call(`${BASE}/rest/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  };

  try {
    return await send(await getAccessToken());
  } catch (error) {
    // Token expired between the check and the request: refresh once, retry.
    if (error.status === 401 && error.code !== "session_expired" && error.code !== "not_signed_in") {
      return send(await getAccessToken({ forceRefresh: true }));
    }
    throw error;
  }
}

export function rpc(fn, args = {}) {
  return rest(`rpc/${fn}`, { method: "POST", body: args });
}
