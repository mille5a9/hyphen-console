// The page: the list of apps at /, and an app's builds at /apps/<id>. Plain JS, no build step.
const out = document.getElementById("out");

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
const when = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const getJson = async (url) => {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
};

const label = (b) => {
  const tag = b.release ? '<span class="tag release">release</span>' : `<span class="tag">${esc(b.extra)}</span>`;
  return `${esc(b.version)}${tag}`;
};

const pct = (x) => (x === null ? "–" : `${(Math.floor(x * 1000) / 10).toFixed(1)}%`);
const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const dot = (c) => `<span class="dot ${c.up === null ? "unknown" : c.up ? (c.last?.ok ? "up" : "warn") : "down"}"></span>`;
const checkLine = (c) => {
  if (c.up === null) return `${dot(c)}${esc(c.name)}: not checked yet`;
  if (!c.up) return `${dot(c)}${esc(c.name)} down since ${when(c.since)}`;
  return `${dot(c)}${esc(c.name)} up · ${pct(c.uptime7d)} over 7 days`;
};

const row = (b) => {
  const aab = b.aab ? `<a class="side" href="${esc(b.aab.url)}"><b>AAB</b>${mb(b.aab.size)}</a>` : "";
  return `<li><a href="${esc(b.url)}"><span class="name">${label(b)}</span><span class="meta">${when(b.mtime)}<br>${mb(b.size)}</span></a>${aab}</li>`;
};

async function showHome() {
  document.title = "Hyphen Console";
  const apps = await getJson("/api/apps");
  if (!apps.length) {
    out.innerHTML = '<h1>Apps</h1><p class="msg">No apps yet. Add one to config/apps.json and restart.</p>';
    return;
  }
  const [lists, status] = await Promise.all([
    Promise.all(apps.map((a) => getJson(`/api/apps/${encodeURIComponent(a.id)}/builds`).catch(() => null))),
    getJson("/api/status").catch(() => []),
  ]);
  const card = (a, list) => {
    const checks = status.filter((c) => c.appId === a.id).map((c) => `<span class="meta check">${checkLine(c)}</span>`).join("");
    const newest = [list?.android[0], list?.ios[0]].filter(Boolean).sort((x, y) => y.mtime.localeCompare(x.mtime))[0];
    const meta = !list ? "Couldn't read its builds folder." : newest ? `Newest build ${esc(newest.version)} · ${when(newest.mtime)}` : "No builds yet.";
    return `<li><a href="/apps/${encodeURIComponent(a.id)}"><span class="name">${esc(a.name)}</span><span class="meta">${meta}</span>${checks}</a></li>`;
  };
  out.innerHTML = `<h1>Apps</h1><p class="sub">Home network and tailnet only.</p><ul class="apps">${apps.map((a, i) => card(a, lists[i])).join("")}</ul>`;
}

async function showApp(id) {
  let data;
  let status = [];
  try {
    [data, status] = await Promise.all([getJson(`/api/apps/${encodeURIComponent(id)}/builds`), getJson("/api/status").catch(() => [])]);
  } catch {
    out.innerHTML = '<p class="msg">Couldn\'t read this app\'s builds. Is the NAS mounted, and is the app in config/apps.json?</p>';
    return;
  }
  const { app, android, ios } = data;
  document.title = `${app.name} builds`;
  const checks = status.filter((c) => c.appId === id);
  const checkRow = (c) => {
    const detail = !c.last ? "Not checked yet" : c.last.ok ? `${c.last.status} in ${c.last.ms} ms` : esc(c.last.error ?? "failed");
    const state = c.up === null ? "" : c.up ? " up" : ` down since ${when(c.since)}`;
    const when_ = c.last ? `${ago(c.last.at)}<br>` : "";
    return `<li><div class="box"><span class="name">${dot(c)}${esc(c.name)}${state}<br><span class="detail">${detail}</span></span><span class="meta">${when_}24 h ${pct(c.uptime24h)} · 7 d ${pct(c.uptime7d)}</span></div></li>`;
  };
  const health = checks.length ? `<section class="status"><h2>Status</h2><ul>${checks.map(checkRow).join("")}</ul></section>` : "";
  const intro = `<h1>${esc(app.name)}</h1>${health}<h2>Builds</h2><p class="sub">Tap a build to download it, then open it to install. A release's AAB is the bundle for uploading to Google Play, not for installing.</p>`;
  if (!android.length && !ios.length) {
    out.innerHTML = `${intro}<p class="msg">No builds yet.</p>`;
    return;
  }
  const [top] = android;
  out.innerHTML =
    intro +
    (top ? `<a class="newest" href="${esc(top.url)}"><b>Newest: ${label(top)}</b><span>${when(top.mtime)} · ${mb(top.size)}</span></a>` : "") +
    // An iPhone can't install an IPA from a page, so this section sits above the long Android list rather than below it.
    (ios.length ? `<section><h2>iPhone</h2><p>For uploading to App Store Connect. On an iPhone, install through TestFlight.</p><ul>${ios.map(row).join("")}</ul></section>` : "") +
    (top ? `<section><h2>All Android builds</h2><ul>${android.map(row).join("")}</ul></section>` : "");
}

const m = /^\/apps\/([a-z0-9-]+)\/?$/.exec(location.pathname);
(m ? showApp(m[1]) : showHome()).catch(() => {
  out.innerHTML = '<p class="msg">Couldn\'t reach the console.</p>';
});
