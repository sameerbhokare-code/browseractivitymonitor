const statusElement = document.getElementById("status");
const statusDot = document.getElementById("statusDot");
const descriptionElement = document.getElementById("description");
const toggleButton = document.getElementById("toggleBtn");
const messageElement = document.getElementById("message");
const activityList = document.getElementById("activityList");
const countElement = document.getElementById("count");
const clearButton = document.getElementById("clearBtn");

const WEBSITE_PERMISSIONS = {
  origins: ["http://*/*", "https://*/*"]
};

// Cached from the last render, so the click handler can call
// chrome.permissions.request() immediately. Chrome only allows that call
// during a user gesture, and awaiting anything first loses the gesture.
let sharingEnabled = false;

function showMessage(text) {
  messageElement.textContent = text;
  messageElement.hidden = !text;
}

function renderCloud(data, activity) {
  const cloudLine = document.getElementById("cloudLine");
  const notice = document.getElementById("noticeText");

  if (!data.session) {
    cloudLine.textContent = "Not signed in · records stay in this browser";
  } else if (data.cloudSync !== true) {
    cloudLine.textContent = `${data.deviceName || data.session.user.email} · cloud sync off`;
  } else {
    const pending = activity.filter((a) => a.pending).length;
    cloudLine.textContent = `${data.deviceName || data.session.user.email} · sync on` +
      (data.lastSyncError ? " · sync problem" : pending ? ` · ${pending} waiting` : " · up to date");
  }

  notice.textContent = data.session && data.cloudSync === true
    ? "When enabled, this extension records website domains visited in this browser and uploads them to your account. People you authorize on the Account page can see them. You can pause, revoke or delete at any time."
    : "When enabled, this extension records website domains visited in this browser. Records are stored locally. You can pause sharing or delete your records at any time.";
}

async function render() {
  const data = await chrome.storage.local.get([
    "sharingEnabled", "activity", "session", "cloudSync", "lastSyncError", "deviceName"
  ]);

  sharingEnabled = data.sharingEnabled === true;
  const activity = data.activity || [];

  statusElement.textContent = sharingEnabled ? "Sharing enabled" : "Disabled";
  statusDot.classList.toggle("on", sharingEnabled);

  descriptionElement.textContent = sharingEnabled
    ? "Your browser activity sharing is active."
    : "Activity sharing is currently paused.";

  toggleButton.textContent = sharingEnabled ? "Pause sharing" : "Enable sharing";
  toggleButton.classList.toggle("paused", sharingEnabled);

  renderCloud(data, activity);

  countElement.textContent = activity.length ? `(${activity.length})` : "";
  clearButton.disabled = activity.length === 0;

  activityList.replaceChildren();

  if (activity.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No activity recorded yet.";
    activityList.appendChild(empty);
    return;
  }

  activity.forEach((item) => {
    const card = document.createElement("div");
    card.className = "activity-item";

    const domain = document.createElement("strong");
    domain.textContent = item.domain;

    const time = document.createElement("span");
    time.textContent = new Date(item.timestamp).toLocaleString();

    card.append(domain, time);
    activityList.appendChild(card);
  });
}

function enableSharing() {
  // Must be the first call in the click handler (see note above).
  chrome.permissions.request(WEBSITE_PERMISSIONS)
    .then(async (granted) => {
      if (!granted) {
        showMessage("Website access was not granted. Sharing remains disabled.");
        return;
      }
      // background.js also sets this from permissions.onAdded, in case the
      // popup closed while the prompt was open.
      await chrome.storage.local.set({ sharingEnabled: true });
      showMessage("");
    })
    .catch((error) => {
      console.error(error);
      showMessage("Could not enable sharing: " + error.message);
    });
}

async function pauseSharing() {
  try {
    // Pause recording before releasing website access.
    await chrome.storage.local.set({ sharingEnabled: false });
    await chrome.permissions.remove(WEBSITE_PERMISSIONS);
    showMessage("");
  } catch (error) {
    console.error(error);
    showMessage("Could not pause sharing: " + error.message);
  }
}

toggleButton.addEventListener("click", () => {
  if (sharingEnabled) {
    pauseSharing();
  } else {
    enableSharing();
  }
});

document.getElementById("dashboardBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  window.close();
});

document.getElementById("accountBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("account.html") });
  window.close();
});

// Two-step clear: first click asks, second click within 4 seconds deletes.
let clearTimer = null;
clearButton.addEventListener("click", async () => {
  if (!clearButton.classList.contains("confirm")) {
    clearButton.classList.add("confirm");
    clearButton.textContent = "Click again to delete";
    clearTimer = setTimeout(resetClearButton, 4000);
    return;
  }
  clearTimeout(clearTimer);
  resetClearButton();
  await chrome.storage.local.set({ activity: [] });
});

function resetClearButton() {
  clearButton.classList.remove("confirm");
  clearButton.textContent = "Clear";
}

// Refresh live while the popup is open (new records, permission changes).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.activity || changes.sharingEnabled ||
      changes.session || changes.cloudSync || changes.lastSyncError || changes.deviceName)) {
    render();
  }
});

render();
