// Browser Activity Monitor, live dashboard.
// Two kinds of source:
//  * "This browser (local)": the records in chrome.storage, updated instantly.
//  * Cloud: your devices and people who authorized you, read from Supabase
//    (security rules decide what you can see) and refreshed every 15 s.

import { isConfigured, getSession, rest, rpc } from "./supabase-lite.js";

const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";
const WEBSITE_PERMISSIONS = { origins: ["http://*/*", "https://*/*"] };
const MAX_TABLE_ROWS = 100;
const CLOUD_POLL_MS = 15000;
const CLOUD_PAGE = 1000;
const CLOUD_MAX_ROWS = 20000;
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

const state = {
  activity: [],          // local records
  sharingEnabled: false,
  range: "7d",
  search: "",
  source: "local",       // local | cloud:me | everyone | person:<id> | device:<id>
  lastUpdated: null,
  newestSeen: 0,
  cloud: {
    signedIn: false,
    me: null,
    people: [],          // [{ id, name, email }] who share with me
    devices: [],         // [{ id, name, ownerId, lastSeen }]
    rows: [],            // [{ id, domain, timestamp, created, deviceId, ownerId }]
    ids: new Set(),
    maxCreated: 0,
    loadedRange: null,
    loading: false,
    error: null,
    needsSchemaUpdate: false
  }
};

try {
  state.range = localStorage.getItem("bam-range") || "7d";
  state.source = localStorage.getItem("bam-source") || "local";
} catch { /* storage unavailable, use defaults */ }

const isCloud = () => state.source !== "local";

/* ---------- Helpers ---------- */

function startOfDay(time) {
  const d = new Date(time);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function countBy(list, keyFn) {
  const map = new Map();
  list.forEach((item) => {
    const key = keyFn(item);
    map.set(key, (map.get(key) || 0) + 1);
  });
  return map;
}

const fmtNum = (n) => n.toLocaleString();
const plural = (n, word) => `${fmtNum(n)} ${word}${n === 1 ? "" : "s"}`;

function hourLabel(h) {
  const suffix = h < 12 ? "AM" : "PM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr} ${suffix}`;
}

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/* ---------- Which records are on screen ---------- */

function sourceRecords() {
  if (!isCloud()) return state.activity;
  const c = state.cloud;
  const [kind, id] = state.source.split(":");
  if (kind === "cloud") return c.rows.filter((r) => r.ownerId === c.me?.id);
  if (kind === "everyone") return c.rows;
  if (kind === "person") return c.rows.filter((r) => r.ownerId === id);
  if (kind === "device") return c.rows.filter((r) => r.deviceId === id);
  return [];
}

function rangeStart() {
  const today = startOfDay(Date.now());
  if (state.range === "today") return today;
  if (state.range === "7d") return addDays(today, -6);
  if (state.range === "30d") return addDays(today, -29);
  const records = sourceRecords();
  const oldest = records[records.length - 1];
  return oldest ? startOfDay(oldest.timestamp) : today;
}

function inRange() {
  const start = rangeStart().getTime();
  return sourceRecords().filter((a) => a.timestamp >= start);
}

function personName(ownerId) {
  const c = state.cloud;
  if (ownerId === c.me?.id) return "You";
  return c.people.find((p) => p.id === ownerId)?.name || "Unknown";
}

function deviceLabel(deviceId) {
  const c = state.cloud;
  const d = c.devices.find((x) => x.id === deviceId);
  if (!d) return "Unknown device";
  return d.ownerId === c.me?.id ? d.name : `${personName(d.ownerId)} · ${d.name}`;
}

function sourceLabel() {
  const select = $("sourceSelect");
  const option = select.options[select.selectedIndex];
  return option ? option.textContent.trim() : "";
}

/* ---------- Cloud data ---------- */

const SELECT = "select=id,domain,visited_at,created_at,device_id,owner_id";

function mapRow(r) {
  return {
    id: r.id,
    domain: r.domain,
    timestamp: Date.parse(r.visited_at),
    created: Date.parse(r.created_at),
    deviceId: r.device_id,
    ownerId: r.owner_id
  };
}

async function initCloud() {
  const c = state.cloud;
  c.signedIn = false;
  if (!isConfigured()) return;
  const session = await getSession();
  if (!session) return;
  c.signedIn = true;
  c.me = { id: session.user.id, name: session.user.display_name || "You" };
  try {
    await loadPeopleAndDevices();
  } catch (error) {
    c.error = error.message;
  }
}

async function loadPeopleAndDevices() {
  const c = state.cloud;
  const [grants, devices] = await Promise.all([
    rpc("my_grants"),
    rest("devices?select=id,name,owner_id,last_seen_at&order=created_at")
  ]);
  const incoming = grants.filter((g) => g.direction === "incoming");
  c.needsSchemaUpdate = incoming.some((g) => !g.other_id);
  c.people = incoming
    .filter((g) => g.other_id)
    .map((g) => ({ id: g.other_id, name: g.other_name, email: g.other_email }));
  c.devices = devices.map((d) => ({
    id: d.id, name: d.name, ownerId: d.owner_id, lastSeen: Date.parse(d.last_seen_at)
  }));
}

async function loadCloudRows() {
  const c = state.cloud;
  const start = state.range === "all" ? null : rangeStart().toISOString();
  const filter = start ? `&visited_at=gte.${encodeURIComponent(start)}` : "";
  const rows = [];
  for (let offset = 0; offset < CLOUD_MAX_ROWS; offset += CLOUD_PAGE) {
    const page = await rest(
      `activity?${SELECT}${filter}&order=visited_at.desc&limit=${CLOUD_PAGE}&offset=${offset}`
    );
    rows.push(...page.map(mapRow));
    if (page.length < CLOUD_PAGE) break;
  }
  c.rows = rows;
  c.ids = new Set(rows.map((r) => r.id));
  c.maxCreated = rows.reduce((m, r) => Math.max(m, r.created), 0);
  c.loadedRange = state.range;
}

// Fetch only rows uploaded since the last check. Uses upload time, not visit
// time, because a laptop that was offline uploads older visits later.
async function pollCloudRows() {
  const c = state.cloud;
  const since = new Date(c.maxCreated || 0).toISOString();
  const page = await rest(
    `activity?${SELECT}&created_at=gte.${encodeURIComponent(since)}&order=created_at.asc&limit=${CLOUD_PAGE}`
  );
  const start = state.range === "all" ? 0 : rangeStart().getTime();
  const fresh = page.map(mapRow).filter((r) => !c.ids.has(r.id));
  fresh.forEach((r) => {
    c.ids.add(r.id);
    c.maxCreated = Math.max(c.maxCreated, r.created);
  });
  const inWindow = fresh.filter((r) => r.timestamp >= start);
  if (inWindow.length) {
    c.rows = [...inWindow, ...c.rows].sort((a, b) => b.timestamp - a.timestamp);
  }
}

let cloudBusy = false;
async function cloudTick(full = false) {
  const c = state.cloud;
  if (!isCloud() || !c.signedIn || cloudBusy) return;
  cloudBusy = true;
  if (full) {
    c.loading = true;
    renderAll();
  }
  try {
    await loadPeopleAndDevices();
    if (full || c.loadedRange !== state.range) {
      await loadCloudRows();
    } else {
      await pollCloudRows();
    }
    // Drop rows from anyone who has since revoked access.
    const allowed = new Set([c.me.id, ...c.people.map((p) => p.id)]);
    c.rows = c.rows.filter((r) => allowed.has(r.ownerId));
    c.error = null;
    state.lastUpdated = Date.now();
  } catch (error) {
    c.error = error.message;
  } finally {
    c.loading = false;
    cloudBusy = false;
  }
  buildSourceOptions();
  renderAll();
}

let pollTimer = null;
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (!document.hidden) cloudTick(false);
  }, CLOUD_POLL_MS);
}
function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && isCloud()) cloudTick(false);
});

/* ---------- Source picker ---------- */

function buildSourceOptions() {
  const select = $("sourceSelect");
  const c = state.cloud;
  select.replaceChildren();

  const add = (parent, value, label, disabled = false) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.disabled = disabled;
    parent.append(option);
  };
  const group = (label) => {
    const g = document.createElement("optgroup");
    g.label = label;
    select.append(g);
    return g;
  };

  add(select, "local", "This browser (local)");

  if (!isConfigured()) {
    add(select, "x", "Cloud: not set up", true);
  } else if (!c.signedIn) {
    add(select, "x", "Cloud: sign in on the Account page", true);
  } else {
    const mine = group("My devices (cloud)");
    add(mine, "cloud:me", "All my devices");
    c.devices.filter((d) => d.ownerId === c.me.id)
      .forEach((d) => add(mine, `device:${d.id}`, d.name));

    if (c.people.length) {
      const shared = group("Shared with me");
      add(shared, "everyone", "Everyone (me + shared)");
      c.people.forEach((p) => {
        add(shared, `person:${p.id}`, `${p.name} (all devices)`);
        c.devices.filter((d) => d.ownerId === p.id)
          .forEach((d) => add(shared, `device:${d.id}`, `${p.name} · ${d.name}`));
      });
    }
  }

  const valid = [...select.options].filter((o) => !o.disabled).map((o) => o.value);
  if (!valid.includes(state.source)) {
    state.source = isCloud() && c.signedIn ? "cloud:me" : "local";
  }
  select.value = state.source;
}

/* ---------- Tooltip ---------- */

const tooltip = $("tooltip");

function showTip(value, label, x, y) {
  $("tipValue").textContent = value;
  $("tipLabel").textContent = label;
  tooltip.hidden = false;
  const rect = tooltip.getBoundingClientRect();
  let left = x + 14;
  let top = y - rect.height - 10;
  if (left + rect.width > window.innerWidth - 8) left = x - rect.width - 14;
  if (top < 8) top = y + 16;
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${top}px`;
}

function hideTip() {
  tooltip.hidden = true;
}

function attachTip(element, value, label) {
  element.addEventListener("pointermove", (e) => showTip(value, label, e.clientX, e.clientY));
  element.addEventListener("pointerleave", hideTip);
  element.addEventListener("focus", () => {
    const r = element.getBoundingClientRect();
    showTip(value, label, r.left + r.width / 2, r.top);
  });
  element.addEventListener("blur", hideTip);
}

/* ---------- Charts ---------- */

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

function niceScale(max) {
  if (max <= 0) return { max: 4, step: 1 };
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  const step = Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow);
  return { max: Math.ceil(max / step) * step, step };
}

// Column with a 4px rounded top, flat on the baseline.
function columnPath(x, y, w, h, r = 4) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}` +
         `H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function emptyState(container, text) {
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = text;
  container.replaceChildren(p);
}

function emptyText() {
  if (isCloud() && state.cloud.loading) return "Loading from the cloud…";
  return "No visits in this range yet.";
}

// buckets: [{ tick, value, tipLabel }]
function columnChart(container, buckets, { height = 220, unit = "visit" } = {}) {
  const total = buckets.reduce((s, b) => s + b.value, 0);
  if (total === 0) {
    emptyState(container, emptyText());
    return;
  }

  const width = Math.max(container.clientWidth, 260);
  const m = { top: 10, right: 6, bottom: 26, left: 34 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const { max, step } = niceScale(Math.max(...buckets.map((b) => b.value)));
  const yOf = (v) => m.top + plotH - (v / max) * plotH;

  const svg = svgEl("svg", { width, height, role: "img" });

  for (let v = 0; v <= max; v += step) {
    const y = yOf(v);
    svg.append(svgEl("line", { class: "gridline", x1: m.left, x2: width - m.right, y1: y, y2: y }));
    const t = svgEl("text", { class: "axis-text", x: m.left - 8, y: y + 4, "text-anchor": "end" });
    t.textContent = fmtNum(v);
    svg.append(t);
  }

  const slot = plotW / buckets.length;
  const gap = Math.max(2, slot * 0.28);
  const barW = Math.max(1, slot - gap);
  const labelEvery = Math.ceil(buckets.length / Math.max(1, Math.floor(plotW / 52)));

  buckets.forEach((b, i) => {
    const x = m.left + i * slot + gap / 2;

    // Hit area covers the whole column slot, larger than the bar itself.
    const hit = svgEl("rect", {
      class: "hit", x: m.left + i * slot, y: m.top, width: slot, height: plotH, tabindex: 0,
      "aria-label": `${b.tipLabel}: ${plural(b.value, unit)}`
    });
    attachTip(hit, plural(b.value, unit), b.tipLabel);

    const h = (b.value / max) * plotH;
    const bar = svgEl("path", { class: "bar", d: h > 0 ? columnPath(x, yOf(b.value), barW, h) : "" });
    // Hit area goes on top of the bar so hovering the bar itself works.
    svg.append(bar, hit);

    if (i % labelEvery === 0) {
      const t = svgEl("text", {
        class: "axis-text", x: x + barW / 2, y: height - 8, "text-anchor": "middle"
      });
      t.textContent = b.tick;
      svg.append(t);
    }
  });

  container.replaceChildren(svg);
}

function renderTrend(list) {
  const title = $("trendTitle");
  const buckets = [];

  if (state.range === "today") {
    title.textContent = "Visits per hour today";
    const counts = countBy(list, (a) => new Date(a.timestamp).getHours());
    for (let h = 0; h < 24; h++) {
      buckets.push({
        tick: hourLabel(h),
        value: counts.get(h) || 0,
        tipLabel: `${hourLabel(h)} to ${hourLabel((h + 1) % 24)}`
      });
    }
  } else {
    title.textContent = "Visits per day";
    const counts = countBy(list, (a) => startOfDay(a.timestamp).getTime());
    const today = startOfDay(Date.now());
    for (let d = rangeStart(); d <= today; d = addDays(d, 1)) {
      buckets.push({
        tick: d.toLocaleDateString(undefined, { day: "numeric", month: "short" }),
        value: counts.get(d.getTime()) || 0,
        tipLabel: d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })
      });
    }
  }

  columnChart($("trendChart"), buckets);
}

function renderHours(list) {
  const card = $("hourCard");
  // On "Today" the trend chart already shows hours, so this would repeat it.
  card.hidden = state.range === "today";
  $("topCard").classList.toggle("wide", card.hidden);
  if (card.hidden) return;

  const counts = countBy(list, (a) => new Date(a.timestamp).getHours());
  const buckets = [];
  for (let h = 0; h < 24; h++) {
    buckets.push({
      tick: h % 6 === 0 ? hourLabel(h) : "",
      value: counts.get(h) || 0,
      tipLabel: `${hourLabel(h)} to ${hourLabel((h + 1) % 24)}`
    });
  }
  columnChart($("hourChart"), buckets);
}

function renderTopSites(list) {
  const container = $("topList");
  const counts = [...countBy(list, (a) => a.domain).entries()]
    .sort((a, b) => b[1] - a[1]);

  if (counts.length === 0) {
    emptyState(container, isCloud() && state.cloud.loading ? emptyText() : "No websites in this range yet.");
    return;
  }

  const top = counts.slice(0, 10);
  const max = top[0][1];
  const total = list.length;
  const rows = top.map(([domain, count]) => {
    const row = document.createElement("div");
    row.className = "bar-row";
    row.tabIndex = 0;

    const name = document.createElement("span");
    name.className = "bar-name";
    name.textContent = domain;
    name.title = domain;

    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = `${(count / max) * 100}%`;
    track.append(fill);

    const value = document.createElement("span");
    value.className = "bar-value";
    value.textContent = fmtNum(count);

    row.append(name, track, value);
    const share = Math.round((count / total) * 100);
    attachTip(row, plural(count, "visit"), `${domain} · ${share}% of visits`);
    return row;
  });

  if (counts.length > 10) {
    const others = counts.slice(10).reduce((s, [, c]) => s + c, 0);
    const note = document.createElement("p");
    note.className = "table-note";
    note.textContent = `+ ${plural(counts.length - 10, "other website")} (${plural(others, "visit")})`;
    rows.push(note);
  }

  container.replaceChildren(...rows);
}

/* ---------- Devices (cloud) ---------- */

function renderDevices(list) {
  const card = $("devicesCard");
  card.hidden = !isCloud() || !state.cloud.signedIn;
  if (card.hidden) return;

  const c = state.cloud;
  const [kind, id] = state.source.split(":");
  let devices = c.devices;
  if (kind === "cloud") devices = devices.filter((d) => d.ownerId === c.me.id);
  if (kind === "person") devices = devices.filter((d) => d.ownerId === id);
  if (kind === "device") devices = devices.filter((d) => d.id === id);

  const counts = countBy(list, (a) => a.deviceId);

  if (devices.length === 0) {
    const li = document.createElement("li");
    li.className = "device-meta";
    li.textContent = "No devices yet.";
    $("deviceList").replaceChildren(li);
    return;
  }

  const items = devices
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map((d) => {
      const li = document.createElement("li");
      const active = Date.now() - d.lastSeen < ACTIVE_WINDOW_MS;

      const name = document.createElement("div");
      name.className = "device-name";
      const dot = document.createElement("i");
      dot.className = "device-dot" + (active ? " on" : "");
      const label = document.createElement("span");
      label.textContent = d.name;
      label.title = d.name;
      name.append(dot, label);

      const owner = document.createElement("div");
      owner.className = "device-meta";
      owner.textContent = personName(d.ownerId);

      const seen = document.createElement("div");
      seen.className = "device-meta";
      seen.textContent = active ? "Active now" : `Last active ${timeAgo(d.lastSeen)}`;

      const count = document.createElement("div");
      count.className = "device-count";
      count.textContent = plural(counts.get(d.id) || 0, "visit");

      li.append(name, owner, seen, count);
      return li;
    });

  $("deviceList").replaceChildren(...items);
}

/* ---------- Tiles, table, header ---------- */

function renderTiles(list) {
  $("statVisits").textContent = fmtNum(list.length);
  const rangeNames = { today: "today", "7d": "in the last 7 days", "30d": "in the last 30 days", all: "all time" };
  $("statVisitsNote").textContent = rangeNames[state.range];

  const domains = countBy(list, (a) => a.domain);
  $("statUnique").textContent = fmtNum(domains.size);

  const top = [...domains.entries()].sort((a, b) => b[1] - a[1])[0];
  $("statTop").textContent = top ? top[0] : "–";
  $("statTop").title = top ? top[0] : "";
  $("statTopNote").textContent = top ? plural(top[1], "visit") : "";

  const hours = [...countBy(list, (a) => new Date(a.timestamp).getHours()).entries()]
    .sort((a, b) => b[1] - a[1])[0];
  $("statHour").textContent = hours ? `${hourLabel(hours[0])} to ${hourLabel((hours[0] + 1) % 24)}` : "–";
  $("statHourNote").textContent = hours ? plural(hours[1], "visit") : "";
}

function renderTable(list) {
  const cloud = isCloud();
  const query = state.search.trim().toLowerCase();
  const rows = query
    ? list.filter((a) => a.domain.includes(query) ||
        (cloud && deviceLabel(a.deviceId).toLowerCase().includes(query)))
    : list;

  $("deviceCol").hidden = !cloud;
  $("search").placeholder = cloud ? "Filter by domain or device" : "Filter by domain";

  const trs = rows.slice(0, MAX_TABLE_ROWS).map((item) => {
    const tr = document.createElement("tr");
    if (item.timestamp > state.newestSeen && state.newestSeen !== 0) tr.className = "new";

    const domain = document.createElement("td");
    domain.textContent = item.domain;
    const time = document.createElement("td");
    time.textContent = new Date(item.timestamp).toLocaleString();
    const ago = document.createElement("td");
    ago.className = "right";
    ago.textContent = timeAgo(item.timestamp);

    if (cloud) {
      const device = document.createElement("td");
      device.textContent = deviceLabel(item.deviceId);
      tr.append(domain, device, time, ago);
    } else {
      tr.append(domain, time, ago);
    }
    return tr;
  });
  $("visitRows").replaceChildren(...trs);

  const note = $("tableNote");
  if (rows.length === 0) {
    note.textContent = query ? "No visits match this filter." : emptyText();
  } else if (rows.length > MAX_TABLE_ROWS) {
    note.textContent = `Showing the latest ${MAX_TABLE_ROWS} of ${fmtNum(rows.length)} visits. Export CSV for all of them.`;
  } else {
    note.textContent = plural(rows.length, "visit");
  }

  const newest = sourceRecords()[0];
  if (newest) state.newestSeen = Math.max(state.newestSeen, newest.timestamp);
  if (state.newestSeen === 0) state.newestSeen = 1;

  $("clearBtn").hidden = cloud;
  $("clearBtn").disabled = state.activity.length === 0;
  $("exportBtn").disabled = list.length === 0;
}

function renderHeader() {
  const cloud = isCloud();
  const badge = $("liveBadge");

  if (cloud) {
    const ok = !state.cloud.error;
    badge.classList.toggle("on", ok);
    $("liveText").textContent = ok ? "Cloud · live" : "Cloud · offline";
    $("subtitle").textContent = `Cloud view: ${sourceLabel()}`;
  } else {
    badge.classList.toggle("on", state.sharingEnabled);
    $("liveText").textContent = state.sharingEnabled ? "Live · recording" : "Paused";
    $("subtitle").textContent = "Activity dashboard for this browser";
  }

  $("footerNote").textContent = cloud
    ? "Cloud view: shows only your own devices and people who authorized you, for visits after they did. Only domains and times are stored."
    : "Records are stored only in this browser. Only domains and times are kept, never full URLs or page content.";

  const btn = $("toggleBtn");
  btn.hidden = cloud;
  btn.textContent = state.sharingEnabled ? "Pause sharing" : "Enable sharing";
  btn.classList.toggle("paused", state.sharingEnabled);

  document.querySelectorAll(".segmented button").forEach((b) => {
    b.classList.toggle("active", b.dataset.range === state.range);
  });

  if (cloud && state.cloud.error) {
    showMessage("Could not reach the cloud: " + state.cloud.error);
  } else if (cloud && state.cloud.needsSchemaUpdate) {
    showMessage("Run the updated supabase/schema.sql in the Supabase SQL Editor to see people who share with you.");
  } else {
    showMessage("");
  }

  renderUpdated();
}

function renderUpdated() {
  const last = sourceRecords()[0];
  const parts = [];
  if (state.lastUpdated) parts.push(`Updated ${new Date(state.lastUpdated).toLocaleTimeString()}`);
  if (last) parts.push(`last visit ${timeAgo(last.timestamp)}`);
  if (isCloud()) parts.push(`refreshes every ${CLOUD_POLL_MS / 1000} s`);
  $("updated").textContent = parts.join(" · ");
}

function renderCharts() {
  const list = inRange();
  renderTrend(list);
  renderHours(list);
}

function renderAll() {
  const list = inRange();
  renderHeader();
  renderTiles(list);
  renderTopSites(list);
  renderDevices(list);
  renderTable(list);
  renderCharts();
}

/* ---------- Actions ---------- */

function showMessage(text) {
  $("message").textContent = text;
  $("message").hidden = !text;
}

$("toggleBtn").addEventListener("click", () => {
  if (state.sharingEnabled) {
    chrome.storage.local.set({ sharingEnabled: false })
      .then(() => chrome.permissions.remove(WEBSITE_PERMISSIONS))
      .catch((e) => showMessage("Could not pause sharing: " + e.message));
  } else {
    // Called first so Chrome treats it as part of the click.
    chrome.permissions.request(WEBSITE_PERMISSIONS)
      .then(async (granted) => {
        if (!granted) {
          showMessage("Website access was not granted. Sharing remains disabled.");
          return;
        }
        await chrome.storage.local.set({ sharingEnabled: true });
      })
      .catch((e) => showMessage("Could not enable sharing: " + e.message));
  }
});

$("sourceSelect").addEventListener("change", (event) => {
  state.source = event.target.value;
  state.newestSeen = 0;
  try { localStorage.setItem("bam-source", state.source); } catch { /* ignore */ }
  if (isCloud()) {
    // All cloud rows are loaded together, so switching person/device is instant.
    if (state.cloud.loadedRange !== state.range) cloudTick(true);
    else renderAll();
    startPolling();
  } else {
    stopPolling();
    renderAll();
  }
});

document.querySelectorAll(".segmented button").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.range = btn.dataset.range;
    try { localStorage.setItem("bam-range", state.range); } catch { /* ignore */ }
    if (isCloud()) cloudTick(true);
    else renderAll();
  });
});

$("search").addEventListener("input", (e) => {
  state.search = e.target.value;
  renderTable(inRange());
});

function csvCell(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

$("exportBtn").addEventListener("click", () => {
  const cloud = isCloud();
  const header = cloud ? "domain,device,person,timestamp_iso,local_time" : "domain,timestamp_iso,local_time";
  const lines = [header];
  inRange().forEach((a) => {
    const cells = [csvCell(a.domain)];
    if (cloud) cells.push(csvCell(state.cloud.devices.find((d) => d.id === a.deviceId)?.name || ""),
      csvCell(personName(a.ownerId)));
    cells.push(new Date(a.timestamp).toISOString(), csvCell(new Date(a.timestamp).toLocaleString()));
    lines.push(cells.join(","));
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `browser-activity-${cloud ? "cloud" : "local"}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

let clearTimer = null;
$("clearBtn").addEventListener("click", async () => {
  const btn = $("clearBtn");
  if (!btn.classList.contains("confirm")) {
    btn.classList.add("confirm");
    btn.textContent = "Click again to delete all";
    clearTimer = setTimeout(() => {
      btn.classList.remove("confirm");
      btn.textContent = "Clear";
    }, 4000);
    return;
  }
  clearTimeout(clearTimer);
  btn.classList.remove("confirm");
  btn.textContent = "Clear";
  await chrome.storage.local.set({ activity: [] });
});

/* ---------- Live updates ---------- */

// Local records and sharing changes arrive instantly.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  if (changes.activity) state.activity = changes.activity.newValue || [];
  if (changes.sharingEnabled) state.sharingEnabled = changes.sharingEnabled.newValue === true;

  if (changes.session) {
    // Signed in or out on the Account page.
    await initCloud();
    buildSourceOptions();
    if (isCloud()) cloudTick(true);
    else stopPolling();
    renderAll();
    return;
  }

  if (!isCloud() && (changes.activity || changes.sharingEnabled)) {
    state.lastUpdated = Date.now();
    renderAll();
  }
});

// Keep "x min ago" fresh and roll over to a new day at midnight.
let currentDay = startOfDay(Date.now()).getTime();
setInterval(() => {
  const today = startOfDay(Date.now()).getTime();
  if (today !== currentDay) {
    currentDay = today;
    if (isCloud()) cloudTick(true);
    else renderAll();
  } else {
    renderTable(inRange());
    renderDevices(inRange());
    renderUpdated();
  }
}, 30000);

// Redraw charts when the window is resized.
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderCharts, 150);
});

/* ---------- Start ---------- */

async function load() {
  const data = await chrome.storage.local.get(["activity", "sharingEnabled"]);
  state.activity = data.activity || [];
  state.sharingEnabled = data.sharingEnabled === true;
  state.lastUpdated = Date.now();

  await initCloud();
  buildSourceOptions();
  renderAll();

  if (isCloud()) {
    await cloudTick(true);
    startPolling();
  }
}

load();
