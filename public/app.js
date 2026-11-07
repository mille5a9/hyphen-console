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

const stars = (n) => `<span class="stars" title="${n} of 5">${"★".repeat(n)}<span class="off">${"★".repeat(Math.max(0, 5 - n))}</span></span>`;
const storeName = (s) => (s === "apple" ? "App Store" : "Google Play");
const summaryLine = (summary) =>
  summary
    .map((x) => `${storeName(x.store)} ${x.average.toFixed(1)}★ (${x.count})${x.recent ? ` · ${x.recent} new this week` : ""}`)
    .join("<br>");

const pct2 = (v) => (v === null || v === undefined ? "–" : `${(v * 100).toFixed(2)}%`);
const shortDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** A small line chart of daily values, with an optional dashed limit line. Presentation attributes only (CSP). */
function spark(values, { limit = null, label = "" } = {}) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v !== null && v !== undefined);
  if (pts.length < 2) return "";
  const w = 240, h = 44, pad = 3;
  const max = Math.max(...pts.map(([, v]) => v), limit ?? 0) || 1;
  const x = (i) => pad + (i / (values.length - 1)) * (w - 2 * pad);
  const y = (v) => h - pad - (v / max) * (h - 2 * pad);
  const line = pts.map(([i, v], k) => `${k ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const lim = limit !== null ? `<line x1="${pad}" x2="${w - pad}" y1="${y(limit).toFixed(1)}" y2="${y(limit).toFixed(1)}" class="limit"/>` : "";
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">${lim}<path d="${line}"/></svg>`;
}

function vitalsSection({ google, apple }) {
  const parts = [];
  const err = (name, sync) => (sync?.lastError ? `<p class="warn">${name}: couldn't fetch (${esc(sync.lastError)}). Trying again later.</p>` : "");
  if (google) {
    const l = google.latest;
    const gauge = (label, v, limit) => {
      const over = v !== null && v >= limit;
      return `<div class="gauge${over ? " over" : ""}"><span class="big">${pct2(v)}</span><span class="meta">${label}<br>limit ${pct2(limit)}</span></div>`;
    };
    const body = l
      ? `<div class="gauges">${gauge("crash rate, 28 days", l.crash28d, google.thresholds.crash)}${gauge("ANR rate, 28 days", l.anr28d, google.thresholds.anr)}</div>` +
        spark(google.series.map((r) => r.crash), { limit: google.thresholds.crash, label: "Daily user-perceived crash rate" }) +
        `<span class="meta">Daily crash rate, last 30 days · ${l.users ? `about ${l.users} users a day · ` : ""}data through ${shortDate(l.date)}</span>`
      : `<p class="msg">${google.sync ? "No data from Play yet." : "First fetch pending."}</p>`;
    parts.push(`<li><div class="box vitals"><b>Google Play</b>${err("Google Play", google.sync)}${body}</div></li>`);
  }
  if (apple) {
    const w = apple.last7;
    const since = apple.requestedAt ? ` (requested ${when(new Date(apple.requestedAt).toISOString())})` : "";
    const body = w
      ? `<div class="gauges"><div class="gauge"><span class="big">${w.per1k === null ? "–" : w.per1k.toFixed(1)}</span><span class="meta">crashes per 1,000 sessions<br>last 7 days</span></div>` +
        `<div class="gauge"><span class="big">${w.crashes}</span><span class="meta">crashes in<br>${w.sessions} sessions</span></div></div>` +
        spark(apple.series.map((r) => r.crashes), { label: "Daily crashes" }) +
        `<span class="meta">Daily crashes, last 30 days · data through ${shortDate(w.through)} · only from people who share analytics with developers</span>`
      : `<p class="msg">Apple makes the first reports 1–2 days after they're requested${since}.</p>`;
    parts.push(`<li><div class="box vitals"><b>App Store</b>${err("App Store", apple.sync)}${body}</div></li>`);
  }
  return parts.length ? `<section class="vitals-section"><h2>Vitals</h2><ul>${parts.join("")}</ul></section>` : "";
}

const vitalsLine = (v) => {
  const bits = [];
  if (v?.google?.latest) {
    const l = v.google.latest;
    const bad = (l.crash28d ?? 0) >= v.google.thresholds.crash || (l.anr28d ?? 0) >= v.google.thresholds.anr;
    bits.push(`<span class="dot ${bad ? "down" : "up"}"></span>Play crashes ${pct2(l.crash28d)} · ANRs ${pct2(l.anr28d)}`);
  }
  if (v?.apple?.last7?.per1k !== null && v?.apple?.last7) bits.push(`iOS ${v.apple.last7.per1k.toFixed(1)} crashes / 1k sessions`);
  return bits.length ? `<span class="meta check">${bits.join(" · ")}</span>` : "";
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
  const [lists, status, revs, vits] = await Promise.all([
    Promise.all(apps.map((a) => getJson(`/api/apps/${encodeURIComponent(a.id)}/builds`).catch(() => null))),
    getJson("/api/status").catch(() => []),
    Promise.all(apps.map((a) => getJson(`/api/apps/${encodeURIComponent(a.id)}/reviews`).catch(() => null))),
    Promise.all(apps.map((a) => getJson(`/api/apps/${encodeURIComponent(a.id)}/vitals`).catch(() => null))),
  ]);
  const card = (a, list, rev, vit) => {
    const ratings = rev?.summary.length ? `<span class="meta check">${summaryLine(rev.summary)}</span>` : "";
    const checks = status.filter((c) => c.appId === a.id).map((c) => `<span class="meta check">${checkLine(c)}</span>`).join("");
    const newest = [list?.android[0], list?.ios[0]].filter(Boolean).sort((x, y) => y.mtime.localeCompare(x.mtime))[0];
    const meta = !list ? "Couldn't read its builds folder." : newest ? `Newest build ${esc(newest.version)} · ${when(newest.mtime)}` : "No builds yet.";
    return `<li><a href="/apps/${encodeURIComponent(a.id)}"><span class="name">${esc(a.name)}</span><span class="meta">${meta}</span>${checks}${vitalsLine(vit)}${ratings}</a></li>`;
  };
  out.innerHTML = `<h1>Apps</h1><p class="sub">Home network and tailnet only.</p><ul class="apps">${apps.map((a, i) => card(a, lists[i], revs[i], vits[i])).join("")}</ul>`;
}

async function showApp(id) {
  let data;
  let status = [];
  let revs = null;
  let vits = null;
  try {
    [data, status, revs, vits] = await Promise.all([
      getJson(`/api/apps/${encodeURIComponent(id)}/builds`),
      getJson("/api/status").catch(() => []),
      getJson(`/api/apps/${encodeURIComponent(id)}/reviews`).catch(() => null),
      getJson(`/api/apps/${encodeURIComponent(id)}/vitals`).catch(() => null),
    ]);
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
  const reviews = revs ? reviewsSection(revs) : "";
  const vitals = vits ? vitalsSection(vits) : "";
  const intro = `<h1>${esc(app.name)}</h1>${health}${vitals}${reviews}<h2>Builds</h2><p class="sub">Tap a build to download it, then open it to install. A release's AAB is the bundle for uploading to Google Play, not for installing.</p>`;
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

function reviewsSection({ summary, sync, reviews }) {
  const syncs = Object.entries(sync).filter(([, v]) => v !== undefined);
  if (!syncs.length && !reviews.length) return "";
  const problems = syncs
    .filter(([, v]) => v?.lastError)
    .map(([k, v]) => `<p class="warn">${storeName(k)}: couldn't fetch reviews (${esc(v.lastError)}). Trying again each hour.</p>`)
    .join("");
  const pending = syncs.filter(([, v]) => v === null).map(([k]) => storeName(k));
  const head = summary.length ? `<p>${summaryLine(summary)}</p>` : `<p>No reviews yet${pending.length ? "" : "."}${pending.length ? ` (first fetch from ${pending.join(" and ")} pending).` : ""}</p>`;
  const item = (r) => {
    const meta = [storeName(r.store), r.author, r.locale, r.appVersion && `v${esc(r.appVersion)}`, when(new Date(r.updatedAt).toISOString())].filter(Boolean).map(esc).join(" · ");
    const reply = r.reply ? `<div class="reply"><b>Your reply</b> ${esc(r.reply.text)}</div>` : "";
    return `<li><div class="box review">${stars(r.rating)}${r.title ? `<b class="rtitle">${esc(r.title)}</b>` : ""}<p>${esc(r.body)}</p><span class="meta">${meta}</span>${reply}</div></li>`;
  };
  return `<section class="reviews"><h2>Reviews</h2>${problems}${head}${reviews.length ? `<ul>${reviews.slice(0, 20).map(item).join("")}</ul>` : ""}</section>`;
}

const m = /^\/apps\/([a-z0-9-]+)\/?$/.exec(location.pathname);
(m ? showApp(m[1]) : showHome()).catch(() => {
  out.innerHTML = '<p class="msg">Couldn\'t reach the console.</p>';
});
