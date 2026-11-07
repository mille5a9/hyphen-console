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
  const lists = await Promise.all(apps.map((a) => getJson(`/api/apps/${encodeURIComponent(a.id)}/builds`).catch(() => null)));
  const card = (a, list) => {
    const newest = [list?.android[0], list?.ios[0]].filter(Boolean).sort((x, y) => y.mtime.localeCompare(x.mtime))[0];
    const meta = !list ? "Couldn't read its builds folder." : newest ? `Newest build ${esc(newest.version)} · ${when(newest.mtime)}` : "No builds yet.";
    return `<li><a href="/apps/${encodeURIComponent(a.id)}"><span class="name">${esc(a.name)}</span><span class="meta">${meta}</span></a></li>`;
  };
  out.innerHTML = `<h1>Apps</h1><p class="sub">Home network and tailnet only.</p><ul class="apps">${apps.map((a, i) => card(a, lists[i])).join("")}</ul>`;
}

async function showApp(id) {
  let data;
  try {
    data = await getJson(`/api/apps/${encodeURIComponent(id)}/builds`);
  } catch {
    out.innerHTML = '<p class="msg">Couldn\'t read this app\'s builds. Is the NAS mounted, and is the app in config/apps.json?</p>';
    return;
  }
  const { app, android, ios } = data;
  document.title = `${app.name} builds`;
  const intro = `<h1>${esc(app.name)} builds</h1><p class="sub">Tap a build to download it, then open it to install. A release's AAB is the bundle for uploading to Google Play, not for installing.</p>`;
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
