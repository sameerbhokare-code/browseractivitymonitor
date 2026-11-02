import {
  isConfigured, getSession, signIn, signUp, signOut, rest, rpc
} from "./supabase-lite.js";

const $ = (id) => document.getElementById(id);
let mode = "signin";
let pendingCode = null;

/* ---------- Helpers ---------- */

function show(id, visible) {
  $(id).hidden = !visible;
}

function message(id, text, ok = false) {
  const el = $(id);
  el.textContent = text || "";
  el.hidden = !text;
  el.classList.toggle("ok", ok);
}

async function busy(button, task) {
  button.disabled = true;
  try {
    return await task();
  } finally {
    button.disabled = false;
  }
}

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  return new Date(ts).toLocaleString();
}

async function detectBrowser() {
  try {
    if (navigator.brave && await navigator.brave.isBrave()) return "Brave";
  } catch { /* not Brave */ }
  const brands = navigator.userAgentData?.brands?.map((b) => b.brand) || [];
  if (brands.includes("Microsoft Edge")) return "Edge";
  return "Chrome";
}

function platformName() {
  const p = navigator.userAgentData?.platform || navigator.platform || "";
  if (/win/i.test(p)) return "Windows";
  if (/mac/i.test(p)) return "Mac";
  if (/android/i.test(p)) return "Android";
  if (/linux/i.test(p)) return "Linux";
  return "computer";
}

// Make sure this browser exists as a device under the signed-in account.
async function ensureDevice() {
  const { deviceId } = await chrome.storage.local.get("deviceId");
  if (deviceId) {
    const rows = await rest(`devices?id=eq.${deviceId}&select=id,name`);
    if (rows.length) {
      await chrome.storage.local.set({ deviceName: rows[0].name });
      return;
    }
  }
  const browser = await detectBrowser();
  const name = `${browser} on ${platformName()}`;
  const rows = await rest("devices?select=id,name", {
    method: "POST",
    body: { name, browser },
    prefer: "return=representation"
  });
  await chrome.storage.local.set({ deviceId: rows[0].id, deviceName: rows[0].name });
}

/* ---------- Rendering ---------- */

async function render() {
  if (!isConfigured()) {
    show("notConfigured", true);
    show("signedOut", false);
    show("signedIn", false);
    return;
  }
  show("notConfigured", false);

  const session = await getSession();
  show("signedOut", !session);
  show("signedIn", !!session);
  if (!session) return;

  $("accountName").textContent = session.user.display_name || session.user.email.split("@")[0];
  $("accountEmail").textContent = session.user.email;

  try {
    await ensureDevice();
  } catch (error) {
    message("pageMessage", "Could not register this browser: " + error.message);
  }

  await renderSync();
  await renderGrants();
}

async function renderSync() {
  const data = await chrome.storage.local.get([
    "deviceName", "cloudSync", "lastSyncAt", "lastSyncError", "activity", "sharingEnabled"
  ]);
  const nameInput = $("deviceNameInput");
  if (document.activeElement !== nameInput) nameInput.value = data.deviceName || "";
  nameInput.disabled = !data.deviceName;
  $("deviceSaveBtn").disabled = !data.deviceName;
  $("cloudToggle").checked = data.cloudSync === true;
  $("cloudToggle").disabled = !data.deviceName;

  // Sync is on but the laptop still has its automatic name: ask for one.
  if (data.cloudSync === true && isAutoName(data.deviceName) && $("nameBox").hidden) {
    openNameBox(false);
  }

  const pending = (data.activity || []).filter((a) => a.pending).length;
  let status;
  if (data.cloudSync !== true) {
    status = "Cloud sync is off. Nothing is uploaded.";
  } else if (data.lastSyncError) {
    status = `Sync problem: ${data.lastSyncError}`;
  } else {
    if (data.lastSyncAt) {
      status = `Last synced ${timeAgo(data.lastSyncAt)}`;
      status += pending ? ` · ${pending} waiting to upload` : " · all uploaded";
    } else {
      status = pending ? `${pending} waiting to upload` : "Nothing to upload yet";
    }
    if (data.sharingEnabled !== true) status += " · recording is paused in the popup";
  }
  $("syncStatus").textContent = status;
  $("syncNowBtn").disabled = data.cloudSync !== true;
}

function personRow(grant, buttonLabel) {
  const li = document.createElement("li");
  const who = document.createElement("div");
  who.className = "who";
  const name = document.createElement("strong");
  name.textContent = grant.other_name;
  const detail = document.createElement("span");
  detail.textContent = `${grant.other_email} · since ${new Date(grant.created_at).toLocaleDateString()}`;
  who.append(name, detail);

  const button = document.createElement("button");
  button.className = "btn danger";
  button.type = "button";
  button.textContent = buttonLabel;
  button.addEventListener("click", () => busy(button, async () => {
    if (!button.classList.contains("confirm")) {
      button.classList.add("confirm");
      button.textContent = "Click again to confirm";
      setTimeout(() => {
        button.classList.remove("confirm");
        button.textContent = buttonLabel;
      }, 4000);
      return;
    }
    try {
      await rpc("revoke_grant", { p_grant_id: grant.id });
      message("pageMessage", `${grant.other_name} no longer has access.`, true);
      await renderGrants();
    } catch (error) {
      message("pageMessage", error.message);
    }
  }));

  li.append(who, button);
  return li;
}

function emptyRow(text) {
  const li = document.createElement("li");
  li.className = "empty-row";
  li.textContent = text;
  return li;
}

async function renderGrants() {
  try {
    const grants = await rpc("my_grants");
    const outgoing = grants.filter((g) => g.direction === "outgoing");
    const incoming = grants.filter((g) => g.direction === "incoming");
    $("outgoingList").replaceChildren(...(outgoing.length
      ? outgoing.map((g) => personRow(g, "Revoke"))
      : [emptyRow("Nobody can see your activity.")]));
    $("incomingList").replaceChildren(...(incoming.length
      ? incoming.map((g) => personRow(g, "Remove"))
      : [emptyRow("Nobody is sharing with you yet.")]));
  } catch (error) {
    message("pageMessage", "Could not load sharing list: " + error.message);
  }
}

/* ---------- Sign in / sign up ---------- */

function setMode(next) {
  mode = next;
  $("tabSignIn").classList.toggle("active", mode === "signin");
  $("tabSignUp").classList.toggle("active", mode === "signup");
  show("nameField", mode === "signup");
  $("nameInput").required = mode === "signup";
  $("passwordInput").autocomplete = mode === "signup" ? "new-password" : "current-password";
  $("authSubmit").textContent = mode === "signup" ? "Create account" : "Sign in";
  message("authMessage", "");
}

$("tabSignIn").addEventListener("click", () => setMode("signin"));
$("tabSignUp").addEventListener("click", () => setMode("signup"));

$("authForm").addEventListener("submit", (event) => {
  event.preventDefault();
  busy($("authSubmit"), async () => {
    const email = $("emailInput").value.trim();
    const password = $("passwordInput").value;
    try {
      if (mode === "signup") {
        const result = await signUp(email, password, $("nameInput").value.trim());
        if (result.needsConfirmation) {
          message("authMessage",
            "Account created. Open the confirmation email from Supabase, click the link, then sign in here.", true);
          setMode("signin");
          return;
        }
      } else {
        await signIn(email, password);
      }
      $("passwordInput").value = "";
      await render();
    } catch (error) {
      message("authMessage", error.message);
    }
  });
});

$("signOutBtn").addEventListener("click", () => busy($("signOutBtn"), async () => {
  await signOut();
  message("pageMessage", "");
  await render();
}));

/* ---------- Laptop name ---------- */

// Names the extension picks by itself, e.g. "Brave on Windows".
function isAutoName(name) {
  return !name || /^(Chrome|Brave|Edge) on (Windows|Mac|Linux|Android|computer)$/.test(name);
}

async function renameDevice(name) {
  const { deviceId } = await chrome.storage.local.get("deviceId");
  await rest(`devices?id=eq.${deviceId}`, {
    method: "PATCH",
    body: { name },
    prefer: "return=minimal"
  });
  await chrome.storage.local.set({ deviceName: name });
}

$("deviceForm").addEventListener("submit", (event) => {
  event.preventDefault();
  busy($("deviceSaveBtn"), async () => {
    const name = $("deviceNameInput").value.trim().slice(0, 60);
    if (!name) return;
    try {
      await renameDevice(name);
      $("deviceNameInput").blur();
      if (!isAutoName(name)) show("nameBox", false);
      message("pageMessage", `This laptop is now called "${name}".`, true);
    } catch (error) {
      message("pageMessage", "Could not rename: " + error.message);
    }
  });
});

/* ---------- Cloud sync (asks for a name first) ---------- */

let nameBoxEnablesSync = true;

function openNameBox(enablesSync) {
  nameBoxEnablesSync = enablesSync;
  $("nameBoxSave").textContent = enablesSync ? "Save and turn on sync" : "Save name";
  $("nameBoxCancel").hidden = !enablesSync;
  $("nameBoxInput").value = "";
  show("nameBox", true);
  $("nameBoxInput").focus();
}

$("cloudToggle").addEventListener("change", async (event) => {
  const turningOn = event.target.checked;
  if (turningOn) {
    const { deviceName } = await chrome.storage.local.get("deviceName");
    if (isAutoName(deviceName)) {
      event.target.checked = false;
      openNameBox(true);
      return;
    }
  }
  show("nameBox", false);
  await chrome.storage.local.set({ cloudSync: turningOn, lastSyncError: null });
  await renderSync();
});

$("nameBoxForm").addEventListener("submit", (event) => {
  event.preventDefault();
  busy($("nameBoxSave"), async () => {
    const name = $("nameBoxInput").value.trim().slice(0, 60);
    if (!name) return;
    try {
      await renameDevice(name);
      show("nameBox", false);
      if (nameBoxEnablesSync) {
        await chrome.storage.local.set({ cloudSync: true, lastSyncError: null });
        message("pageMessage", `Cloud sync is on. This laptop appears as "${name}" in the web app.`, true);
      } else {
        message("pageMessage", `This laptop now appears as "${name}" in the web app.`, true);
      }
      await renderSync();
    } catch (error) {
      message("pageMessage", "Could not save the name: " + error.message);
    }
  });
});

$("nameBoxCancel").addEventListener("click", () => show("nameBox", false));

$("syncNowBtn").addEventListener("click", () => busy($("syncNowBtn"), async () => {
  const result = await chrome.runtime.sendMessage({ type: "syncNow" });
  if (result && result.error) {
    message("pageMessage", "Sync failed: " + result.error);
  } else {
    message("pageMessage", `Synced. ${result?.uploaded || 0} new visit(s) uploaded.`, true);
  }
  await renderSync();
}));

let deleteArmed = false;
$("deleteCloudBtn").addEventListener("click", () => busy($("deleteCloudBtn"), async () => {
  const button = $("deleteCloudBtn");
  if (!deleteArmed) {
    deleteArmed = true;
    button.classList.add("confirm");
    button.textContent = "Click again to delete everything uploaded";
    setTimeout(() => {
      deleteArmed = false;
      button.classList.remove("confirm");
      button.textContent = "Delete my cloud activity";
    }, 4000);
    return;
  }
  deleteArmed = false;
  button.classList.remove("confirm");
  button.textContent = "Delete my cloud activity";
  try {
    const session = await getSession();
    await rest(`activity?owner_id=eq.${session.user.id}`, { method: "DELETE", prefer: "return=minimal" });
    message("pageMessage", "All your uploaded activity was deleted from the cloud. Local records are unchanged.", true);
  } catch (error) {
    message("pageMessage", "Could not delete: " + error.message);
  }
}));

/* ---------- Authorizing a viewer (sharer side) ---------- */

$("codeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = $("codeInput").value.replace(/[\s-]/g, "").toUpperCase();
  if (!code) return;
  try {
    const rows = await rpc("preview_invite", { p_code: code });
    if (!rows.length) throw new Error("This invite code is invalid or has expired.");
    pendingCode = code;
    $("consentName").textContent = rows[0].viewer_name;
    $("consentEmail").textContent = rows[0].viewer_email;
    show("consentBox", true);
    message("pageMessage", "");
  } catch (error) {
    show("consentBox", false);
    message("pageMessage", error.message);
  }
});

$("authorizeBtn").addEventListener("click", () => busy($("authorizeBtn"), async () => {
  if (!pendingCode) return;
  try {
    await rpc("accept_invite", { p_code: pendingCode });
    const name = $("consentName").textContent;
    pendingCode = null;
    $("codeInput").value = "";
    show("consentBox", false);
    const { cloudSync } = await chrome.storage.local.get("cloudSync");
    message("pageMessage", cloudSync
      ? `${name} can now see your activity from this point on.`
      : `${name} is authorized. Switch on Cloud sync above, otherwise nothing is uploaded for them to see.`, true);
    await renderGrants();
  } catch (error) {
    message("pageMessage", error.message);
  }
}));

$("cancelConsentBtn").addEventListener("click", () => {
  pendingCode = null;
  show("consentBox", false);
});

/* ---------- Inviting someone (viewer side) ---------- */

$("createInviteBtn").addEventListener("click", () => busy($("createInviteBtn"), async () => {
  try {
    const rows = await rpc("create_invite");
    const invite = rows[0];
    $("inviteCode").textContent = invite.code.replace(/(.{4})/, "$1-");
    $("inviteExpiry").textContent = `valid until ${new Date(invite.expires_at).toLocaleString()}, single use`;
    show("inviteBox", true);
  } catch (error) {
    message("pageMessage", error.message);
  }
}));

$("copyInviteBtn").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("inviteCode").textContent.replace("-", ""));
  $("copyInviteBtn").textContent = "Copied";
  setTimeout(() => { $("copyInviteBtn").textContent = "Copy"; }, 1500);
});

/* ---------- Live refresh ---------- */

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.session && !changes.session.newValue) {
    render();
  } else if (changes.activity || changes.lastSyncAt || changes.lastSyncError || changes.cloudSync) {
    renderSync();
  }
});

setInterval(renderSync, 30000);

render();
