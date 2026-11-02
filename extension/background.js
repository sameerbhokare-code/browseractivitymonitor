// Browser Activity Monitor, background service worker (Phase 2).
// Records only the domain of top-level navigations, and only while the user
// has enabled sharing AND granted website access. When the user is signed in
// and has switched on cloud sync, new records are uploaded to their own
// Supabase account.

import { isConfigured, rest } from "./js/supabase-lite.js";

// Enough history for the dashboard; each record is only ~100 bytes.
const MAX_RECORDS = 5000;
const DUPLICATE_WINDOW_MS = 3000;
const SYNC_BATCH = 500;
const SYNC_DELAY_MS = 5000;
const SYNC_ALARM = "bam-sync";
const WEBSITE_PERMISSIONS = { origins: ["http://*/*", "https://*/*"] };
const IGNORED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Storage writes are queued one after another. Without this, two quick
// navigations can both read the old list and one record gets overwritten.
let writeQueue = Promise.resolve();
function enqueue(task) {
  const run = writeQueue.then(task);
  writeQueue = run.catch((error) => {
    console.error("Activity storage error:", error);
  });
  return run;
}

async function hasWebsiteAccess() {
  return chrome.permissions.contains(WEBSITE_PERMISSIONS);
}

/* ---------- Consent state ---------- */

// Sharing state follows the website permission. The popup can close while
// the browser's permission prompt is open, so the background worker is the
// reliable place to react to the user's answer. Removing access from
// chrome://extensions also pauses sharing.
chrome.permissions.onAdded.addListener(async () => {
  if (await hasWebsiteAccess()) {
    await chrome.storage.local.set({ sharingEnabled: true });
  }
});

chrome.permissions.onRemoved.addListener(async () => {
  await chrome.storage.local.set({ sharingEnabled: false });
});

// On install or update, never start in an enabled state without access.
chrome.runtime.onInstalled.addListener(async () => {
  const { sharingEnabled } = await chrome.storage.local.get("sharingEnabled");
  const access = await hasWebsiteAccess();
  await chrome.storage.local.set({ sharingEnabled: sharingEnabled === true && access });
  await ensureAlarm();
});

chrome.runtime.onStartup.addListener(ensureAlarm);

/* ---------- Recording ---------- */

chrome.webNavigation.onCommitted.addListener((details) => {
  // Only the main page of a tab, not iframes or ads inside it.
  if (details.frameId !== 0) return;

  let url;
  try {
    url = new URL(details.url);
  } catch {
    return;
  }

  // Only normal websites.
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  const domain = url.hostname.replace(/^www\./, "");
  if (!domain || IGNORED_HOSTS.has(domain)) return;

  enqueue(async () => {
    const data = await chrome.storage.local.get([
      "sharingEnabled", "activity", "cloudSync", "session", "deviceId"
    ]);
    const activity = data.activity || [];

    if (data.sharingEnabled !== true) return;
    if (!(await hasWebsiteAccess())) return;

    // Skip repeat events for the same domain within a few seconds
    // (redirects, reloads, single page app route changes).
    const last = activity[0];
    if (last && last.domain === domain &&
        Date.now() - last.timestamp < DUPLICATE_WINDOW_MS) {
      return;
    }

    // Store the domain only: never the full URL, search query or page content.
    // "pending" marks records made while cloud sync was on; only those are
    // ever uploaded. Records made before sync was switched on stay local.
    const cloudOn = data.cloudSync === true && !!data.session && !!data.deviceId;
    const record = { id: crypto.randomUUID(), domain, timestamp: Date.now() };
    if (cloudOn) record.pending = true;

    await chrome.storage.local.set({
      activity: [record, ...activity].slice(0, MAX_RECORDS)
    });

    if (cloudOn) scheduleSync();
  }).catch(() => { /* already logged by enqueue */ });
});

/* ---------- Cloud sync ---------- */

async function ensureAlarm() {
  const existing = await chrome.alarms.get(SYNC_ALARM);
  if (!existing) chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
}
ensureAlarm();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) syncNow();
});

let syncTimer = null;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, SYNC_DELAY_MS);
}

let syncing = null;
function syncNow() {
  if (!syncing) {
    syncing = doSync().finally(() => { syncing = null; });
  }
  return syncing;
}

async function doSync() {
  if (!isConfigured()) return { uploaded: 0, skipped: "not configured" };

  const { cloudSync, session, deviceId, activity = [] } =
    await chrome.storage.local.get(["cloudSync", "session", "deviceId", "activity"]);
  if (cloudSync !== true || !session || !deviceId) return { uploaded: 0, skipped: "sync off" };

  let uploaded = 0;
  let batch = activity.filter((a) => a.pending).slice(0, SYNC_BATCH);

  while (batch.length > 0) {
    const rows = batch.map((a) => ({
      device_id: deviceId,
      client_id: a.id,
      domain: a.domain,
      visited_at: new Date(a.timestamp).toISOString()
    }));

    try {
      await rest("activity?on_conflict=device_id,client_id", {
        method: "POST",
        body: rows,
        prefer: "resolution=ignore-duplicates,return=minimal"
      });
    } catch (error) {
      // 23503: this device was deleted from the database. Ask to re-register.
      if (error.code === "23503") {
        await chrome.storage.local.remove(["deviceId", "deviceName"]);
        await chrome.storage.local.set({ cloudSync: false });
      }
      await chrome.storage.local.set({ lastSyncError: error.message });
      return { uploaded, error: error.message };
    }

    const done = new Set(batch.map((a) => a.id));
    uploaded += batch.length;

    const remaining = await enqueue(async () => {
      const current = (await chrome.storage.local.get("activity")).activity || [];
      const updated = current.map((a) => (done.has(a.id) ? { ...a, pending: false } : a));
      await chrome.storage.local.set({
        activity: updated,
        lastSyncAt: Date.now(),
        lastSyncError: null
      });
      return updated.filter((a) => a.pending).slice(0, SYNC_BATCH);
    });

    batch = remaining || [];
  }

  if (uploaded === 0) {
    await chrome.storage.local.set({ lastSyncAt: Date.now(), lastSyncError: null });
  }

  // Heartbeat: lets the dashboard show this browser as "active now".
  // Sent after uploads, otherwise at most every 2 minutes.
  const { lastHeartbeatAt = 0 } = await chrome.storage.local.get("lastHeartbeatAt");
  if (uploaded > 0 || Date.now() - lastHeartbeatAt > 2 * 60 * 1000) {
    await chrome.storage.local.set({ lastHeartbeatAt: Date.now() });
    rest(`devices?id=eq.${deviceId}`, {
      method: "PATCH",
      body: { last_seen_at: new Date().toISOString() },
      prefer: "return=minimal"
    }).catch(() => {});
  }

  return { uploaded };
}

/* ---------- Messages from the popup and account page ---------- */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "syncNow") {
    syncNow()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: error.message }));
    return true; // keep the channel open for the async reply
  }
  return false;
});
