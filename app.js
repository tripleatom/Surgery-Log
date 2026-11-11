// Animal Surgery Log — static front end (GitHub Pages) + Supabase backend.
const CFG = window.SURGERY_LOG_CONFIG || {};
const DEMO = !CFG.supabaseUrl || !CFG.supabaseAnonKey;
const BUCKET = CFG.photoBucket || "surgery-photos";

// ---------------------------------------------------------------- schema
const SURGERY_TYPES = ["Probe implant", "Headplate", "Craniotomy / window", "Virus injection",
  "Tracer injection", "Fiber implant", "Other"];
const STATUSES = ["Recovering", "Active (recording)", "Ended", "Perfused / histology", "Euthanized (humane endpoint)"];

const MAIN_FIELDS = [
  { key: "animal_id", label: "Animal ID", section: "Animal", required: true, placeholder: "e.g. XZ-M012" },
  { key: "strain", label: "Strain / genotype", section: "Animal", placeholder: "e.g. C57BL/6J, Thy1-GCaMP6s" },
  { key: "sex", label: "Sex", section: "Animal", type: "select", options: ["", "M", "F"] },
  { key: "dob", label: "Date of birth", section: "Animal", type: "date" },
  { key: "weight_g", label: "Weight at surgery (g)", section: "Animal", type: "number", step: "0.1" },
  { key: "protocol", label: "IACUC protocol #", section: "Animal" },
  { key: "surgery_date", label: "Surgery date", section: "Surgery", type: "date", required: true },
  { key: "surgeon", label: "Surgeon(s)", section: "Surgery" },
  { key: "surgery_type", label: "Surgery type", section: "Surgery", type: "select", options: ["", ...SURGERY_TYPES] },
  { key: "device", label: "Device / probe ID", section: "Surgery", placeholder: "e.g. NET probe 4x32, SN 0412" },
  { key: "anesthesia", label: "Anesthesia", section: "Surgery", placeholder: "e.g. isoflurane 1.5–2%" },
  { key: "analgesia", label: "Analgesia", section: "Surgery", placeholder: "e.g. meloxicam 5 mg/kg SC" },
  { key: "duration_min", label: "Duration (min)", section: "Surgery", type: "number", step: "1" },
  { key: "complications", label: "Complications", section: "Surgery", type: "textarea", full: true },
  { key: "status", label: "Status", section: "Outcome", type: "select", options: ["", ...STATUSES] },
  { key: "outcome", label: "Post-op / outcome", section: "Outcome", type: "textarea", full: true,
    placeholder: "Recovery, weight checks, recording yield, end date…" },
  { key: "notes", label: "Notes", section: "Outcome", type: "textarea", full: true },
];
const TARGET_FIELDS = [
  { key: "region", label: "Region", placeholder: "V1" },
  { key: "hemisphere", label: "Hemi", type: "select", options: ["R", "L", "Midline"] },
  { key: "ap", label: "AP", type: "number", placeholder: "-3.0" },
  { key: "ml", label: "ML", type: "number", placeholder: "2.5" },
  { key: "dv", label: "DV", type: "number", placeholder: "0.8" },
  { key: "ref", label: "AP/ML ref", type: "select", options: ["Bregma", "Lambda"] },
  { key: "dv_ref", label: "DV ref", type: "select", options: ["Brain surface", "Dura", "Skull"] },
  { key: "angle_deg", label: "Angle °", type: "number", placeholder: "0" },
  { key: "payload", label: "Probe / virus", placeholder: "probe shank A / AAV…" },
  { key: "volume_nl", label: "Vol (nL)", type: "number" },
  { key: "histology", label: "Histology-verified", placeholder: "e.g. V1 L2/3–5 ✓" },
];
const COLUMNS = MAIN_FIELDS.map((f) => f.key).concat(["targets", "photos"]);

// ---------------------------------------------------------------- utils
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => (v === "" || v === null || v === undefined || isNaN(+v) ? null : +v);
const fmt = (v, d = 2) => (num(v) === null ? "—" : (+v).toFixed(d).replace("-", "−"));
const slug = (s) => String(s || "animal").replace(/[^a-z0-9_-]+/gi, "_").slice(0, 60);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
const plotX = (t) => {
  const ml = num(t.ml);
  if (ml === null) return null;
  if (t.hemisphere === "L") return -Math.abs(ml);
  if (t.hemisphere === "R") return Math.abs(ml);
  return ml;
};
const targetSummary = (t) =>
  `${t.region || "?"}${t.hemisphere ? " " + t.hemisphere : ""}  ${fmt(t.ap)} / ${fmt(t.ml)} / ${fmt(t.dv)}`;

// ---------------------------------------------------------------- state
const state = { records: [], session: null, isEditor: false, q: "", type: "", photoUrls: new Map() };
let sb = null;

// ---------------------------------------------------------------- backend
async function initBackend() {
  if (DEMO) {
    state.records = loadDemo();
    state.isEditor = true;
    return;
  }
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
  sb = createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
  const { data } = await sb.auth.getSession();
  state.session = data.session;
  sb.auth.onAuthStateChange(async (_evt, session) => {
    state.session = session;
    await refreshEditor();
    await loadRecords();
    render();
  });
  await refreshEditor();
  await loadRecords();
}

async function refreshEditor() {
  if (DEMO) return;
  if (!state.session) { state.isEditor = false; return; }
  const { data, error } = await sb.rpc("is_editor");
  state.isEditor = !error && data === true;
}

async function loadRecords() {
  if (DEMO) return;
  const { data, error } = await sb.from("surgeries").select("*")
    .order("surgery_date", { ascending: false });
  if (error) { showBanner("Could not load records: " + error.message); return; }
  state.records = data || [];
  await resolvePhotoUrls();
}

async function resolvePhotoUrls() {
  const paths = state.records.flatMap((r) => (r.photos || []).map((p) => p.path));
  state.photoUrls = new Map();
  if (DEMO || !paths.length) return;
  if (CFG.privatePhotos) {
    if (!state.session) return; // signed-out visitors never get photo URLs
    const { data } = await sb.storage.from(BUCKET).createSignedUrls(paths, 3600);
    (data || []).forEach((d) => d.signedUrl && state.photoUrls.set(d.path, d.signedUrl));
  } else {
    paths.forEach((p) => state.photoUrls.set(p, sb.storage.from(BUCKET).getPublicUrl(p).data.publicUrl));
  }
}
const photoUrl = (p) => (DEMO ? p.path : state.photoUrls.get(p.path) || "");

async function compressImage(file, maxDim = 2000, quality = 0.85) {
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", quality));
    if (blob) return { blob, ext: "jpg", type: "image/jpeg" };
  } catch (_) { /* e.g. HEIC the browser can't decode → upload original */ }
  const ext = (file.name.split(".").pop() || "bin").toLowerCase();
  return { blob: file, ext, type: file.type || "application/octet-stream" };
}

const blobToDataURL = (blob) => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob);
});

async function saveRecord(rec, newPhotos, removedPaths) {
  // 1. upload new photos
  const uploaded = [];
  for (const { file, caption } of newPhotos) {
    const { blob, ext, type } = await compressImage(file);
    if (DEMO) {
      uploaded.push({ path: await blobToDataURL(blob), caption });
      continue;
    }
    const path = `${slug(rec.animal_id)}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: type, upsert: false });
    if (error) throw new Error("Photo upload failed: " + error.message);
    uploaded.push({ path, caption });
  }
  rec.photos = (rec.photos || []).filter((p) => !removedPaths.includes(p.path)).concat(uploaded);

  // 2. save the row
  if (DEMO) {
    if (rec.id) state.records = state.records.map((r) => (r.id === rec.id ? { ...r, ...rec, updated_at: new Date().toISOString() } : r));
    else state.records.unshift({ ...rec, id: uid(), created_by_email: "demo@example.edu", created_at: new Date().toISOString() });
    sortRecords(); saveDemo();
    return;
  }
  const payload = Object.fromEntries(COLUMNS.map((k) => [k, rec[k] === "" ? null : rec[k] ?? null]));
  const q = rec.id
    ? sb.from("surgeries").update(payload).eq("id", rec.id)
    : sb.from("surgeries").insert(payload);
  const { error } = await q;
  if (error) throw new Error(error.message);

  // 3. clean up removed photos only after the row saved
  if (removedPaths.length) await sb.storage.from(BUCKET).remove(removedPaths);
  await loadRecords();
}

async function deleteRecord(rec) {
  if (DEMO) {
    state.records = state.records.filter((r) => r.id !== rec.id); saveDemo(); return;
  }
  const { error, count } = await sb.from("surgeries").delete({ count: "exact" }).eq("id", rec.id);
  if (error) throw new Error(error.message);
  if (!count) throw new Error("Not deleted — only the person who created a record can delete it.");
  const paths = (rec.photos || []).map((p) => p.path);
  if (paths.length) await sb.storage.from(BUCKET).remove(paths);
  await loadRecords();
}

const canDelete = (r) => DEMO || (state.isEditor && state.session && r.created_by === state.session.user.id);
const sortRecords = () => state.records.sort((a, b) => String(b.surgery_date).localeCompare(String(a.surgery_date)));

// ---------------------------------------------------------------- demo data
function demoPhoto(label, hue) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="hsl(${hue},25%,82%)"/><circle cx="200" cy="150" r="80" fill="hsl(${hue},20%,70%)"/><text x="200" y="158" font-family="sans-serif" font-size="22" text-anchor="middle" fill="#333">${label}</text></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}
function loadDemo() {
  try {
    const saved = localStorage.getItem("surgery-log-demo");
    if (saved) return JSON.parse(saved);
  } catch (_) {}
  const mk = (o) => ({ id: uid(), created_by_email: "demo@example.edu", created_at: o.surgery_date + "T15:00:00Z",
    sex: "M", strain: "C57BL/6J", protocol: "IACUC-2024-001", anesthesia: "Isoflurane 1.5–2%",
    analgesia: "Meloxicam 5 mg/kg SC", photos: [], targets: [], ...o });
  return [
    mk({ animal_id: "M012", surgery_date: "2026-10-28", surgeon: "Demo User", surgery_type: "Probe implant",
      weight_g: 25.4, dob: "2026-06-02", device: "NET probe 4×32, SN 0412", duration_min: 140, status: "Active (recording)",
      outcome: "Recovered well; weight stable. Units on 3/4 shanks at day 7.",
      targets: [{ region: "V1", hemisphere: "R", ap: -3.4, ml: 2.5, dv: 0.9, ref: "Bregma", dv_ref: "Brain surface", angle_deg: 0, payload: "Shank A–D" }],
      photos: [{ path: demoPhoto("Craniotomy", 210), caption: "Craniotomy before insertion" }, { path: demoPhoto("Post-implant", 30), caption: "Sealed with Kwik-Sil" }] }),
    mk({ animal_id: "M013", surgery_date: "2026-10-30", surgeon: "Demo User", surgery_type: "Virus injection",
      sex: "F", weight_g: 21.8, duration_min: 75, status: "Recovering",
      targets: [
        { region: "V1", hemisphere: "L", ap: -3.6, ml: 2.4, dv: 0.4, ref: "Bregma", dv_ref: "Brain surface", payload: "AAV9-syn-GCaMP8m", volume_nl: 300 },
        { region: "LGN", hemisphere: "L", ap: -2.3, ml: 2.2, dv: 2.7, ref: "Bregma", dv_ref: "Brain surface", payload: "AAV9-syn-GCaMP8m", volume_nl: 200 }] }),
    mk({ animal_id: "M009", surgery_date: "2026-09-15", surgeon: "Demo User", surgery_type: "Headplate",
      weight_g: 26.1, duration_min: 50, status: "Perfused / histology", complications: "Minor bleeding at incision, resolved.",
      targets: [{ region: "V1", hemisphere: "R", ap: -3.2, ml: 2.7, dv: 0.8, ref: "Bregma", dv_ref: "Brain surface", histology: "V1 L2/3–L5 confirmed" }] }),
  ];
}
function saveDemo() {
  try { localStorage.setItem("surgery-log-demo", JSON.stringify(state.records)); } catch (_) { /* quota or blocked */ }
}

// ---------------------------------------------------------------- render
function filtered() {
  const q = state.q.trim().toLowerCase();
  return state.records.filter((r) => {
    if (state.type && r.surgery_type !== state.type) return false;
    if (!q) return true;
    const hay = [r.animal_id, r.surgeon, r.strain, r.device, r.notes, r.outcome, r.protocol, r.surgery_type, r.status,
      ...(r.targets || []).flatMap((t) => [t.region, t.payload, t.histology])].join(" ").toLowerCase();
    return hay.includes(q);
  });
}

function render() {
  $("#title").textContent = CFG.title || "Animal Surgery Log";
  document.title = CFG.title || "Animal Surgery Log";
  $("#subtitle").textContent = CFG.labName || "";
  renderAuth();
  $("#newBtn").hidden = !state.isEditor;
  const tf = $("#typeFilter");
  if (!tf.options.length) {
    tf.innerHTML = `<option value="">All surgery types</option>` + SURGERY_TYPES.map((t) => `<option>${esc(t)}</option>`).join("");
  }
  const rows = filtered();
  renderRows(rows);
  renderMap(rows);
  renderStats(rows);
}

function renderAuth() {
  const el = $("#auth");
  if (DEMO) { el.innerHTML = `<span class="pill">Demo mode</span>`; return; }
  if (!state.session) { el.innerHTML = `<button class="btn" id="loginBtn">Sign in</button>`; $("#loginBtn").onclick = openLogin; return; }
  el.innerHTML = `<span>${esc(state.session.user.email)}${state.isEditor ? "" : " · view only"}</span>
    <button class="btn" id="logoutBtn">Sign out</button>`;
  $("#logoutBtn").onclick = () => sb.auth.signOut();
  hideBanner();
}

function renderRows(rows) {
  $("#count").textContent = `${rows.length} of ${state.records.length}`;
  const tb = $("#rows");
  if (!rows.length) { tb.innerHTML = `<tr><td colspan="7" class="empty">No surgeries match.</td></tr>`; return; }
  tb.innerHTML = rows.map((r) => `
    <tr data-id="${esc(r.id)}">
      <td><strong>${esc(r.animal_id)}</strong></td>
      <td>${esc(r.surgery_date)}</td>
      <td>${esc(r.surgery_type || "—")}</td>
      <td class="coords">${(r.targets || []).map((t) => esc(targetSummary(t))).join("<br>") || "—"}</td>
      <td>${esc(r.surgeon || "—")}</td>
      <td>${r.status ? `<span class="pill">${esc(r.status)}</span>` : "—"}</td>
      <td class="num">${(r.photos || []).length || "—"}</td>
    </tr>`).join("");
  tb.querySelectorAll("tr[data-id]").forEach((tr) => (tr.onclick = () => (location.hash = tr.dataset.id)));
}

function renderStats(rows) {
  const animals = new Set(rows.map((r) => r.animal_id)).size;
  const nTargets = rows.reduce((n, r) => n + (r.targets || []).length, 0);
  const byType = {};
  rows.forEach((r) => (byType[r.surgery_type || "Unspecified"] = (byType[r.surgery_type || "Unspecified"] || 0) + 1));
  $("#stats").innerHTML = `
    <div class="stat"><div class="v">${rows.length}</div><div class="l">surgeries</div></div>
    <div class="stat"><div class="v">${animals}</div><div class="l">animals</div></div>
    <div class="stat"><div class="v">${nTargets}</div><div class="l">target sites</div></div>
    <div class="breakdown">${Object.entries(byType).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `<div class="row"><span>${esc(k)}</span><span>${v}</span></div>`).join("")}</div>`;
}

function renderMap(rows) {
  const pts = rows.flatMap((r) => (r.targets || []).map((t) => ({ r, t, x: plotX(t), y: num(t.ap) })))
    .filter((p) => p.x !== null && p.y !== null);
  // domain: mouse-brain-sized default, expanded to fit data
  let [x0, x1, y0, y1] = [-5, 5, -7, 4];
  pts.forEach((p) => { x0 = Math.min(x0, Math.floor(p.x)); x1 = Math.max(x1, Math.ceil(p.x));
    y0 = Math.min(y0, Math.floor(p.y)); y1 = Math.max(y1, Math.ceil(p.y)); });
  const W = 640, H = 400, m = { l: 34, r: 14, t: 18, b: 28 };
  const kx = (W - m.l - m.r) / (x1 - x0), ky = (H - m.t - m.b) / (y1 - y0);
  const k = Math.min(kx, ky); // equal aspect: 1 mm is the same length on both axes
  const ox = m.l + ((W - m.l - m.r) - k * (x1 - x0)) / 2, oy = m.t + ((H - m.t - m.b) - k * (y1 - y0)) / 2;
  const sx = (x) => ox + (x - x0) * k, sy = (y) => oy + (y1 - y) * k;

  let g = "";
  for (let x = x0; x <= x1; x++) g += `<line class="gridline" x1="${sx(x)}" x2="${sx(x)}" y1="${sy(y1)}" y2="${sy(y0)}"/>` +
    (x % 2 === 0 ? `<text class="axis-label" x="${sx(x)}" y="${sy(y0) + 16}" text-anchor="middle">${String(x).replace("-", "−")}</text>` : "");
  for (let y = y0; y <= y1; y++) g += `<line class="gridline" x1="${sx(x0)}" x2="${sx(x1)}" y1="${sy(y)}" y2="${sy(y)}"/>` +
    (y % 2 === 0 ? `<text class="axis-label" x="${sx(x0) - 6}" y="${sy(y) + 4}" text-anchor="end">${String(y).replace("-", "−")}</text>` : "");
  g += `<line class="midline" x1="${sx(0)}" x2="${sx(0)}" y1="${sy(y1)}" y2="${sy(y0)}"/>`;
  g += `<path class="bregma" d="M${sx(0) - 7},${sy(0)}h14M${sx(0)},${sy(0) - 7}v14"/>`;
  g += `<text class="axis-label" x="${sx(0) + 9}" y="${sy(0) - 6}">bregma</text>`;
  g += `<text class="axis-label" x="${sx(x0) + 4}" y="${sy(y1) + 12}">L</text><text class="axis-label" x="${sx(x1) - 4}" y="${sy(y1) + 12}" text-anchor="end">R</text>`;
  g += `<text class="axis-label" x="${sx(0)}" y="${sy(y1) - 6}" text-anchor="middle">anterior ↑</text>`;
  const marks = pts.map((p, i) => `<g data-i="${i}"><circle class="hit" cx="${sx(p.x)}" cy="${sy(p.y)}" r="11"/>
    <circle class="pt" cx="${sx(p.x)}" cy="${sy(p.y)}" r="5"/></g>`).join("");
  $("#map").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Dorsal map of ${pts.length} target sites">${g}${marks}</svg>
    ${pts.length ? "" : `<p class="hint">Targets with AP and ML values appear here.</p>`}`;

  const tip = $("#mapTip"), card = $(".map-card");
  $("#map").querySelectorAll("g[data-i]").forEach((el) => {
    const p = pts[+el.dataset.i];
    el.onmouseenter = (e) => {
      tip.innerHTML = `<b>${esc(p.r.animal_id)} · ${esc(p.t.region || "?")} ${esc(p.t.hemisphere || "")}</b>
        AP ${fmt(p.t.ap)} · ML ${fmt(p.t.ml)} · DV ${fmt(p.t.dv)} mm<br>${esc(p.r.surgery_date)} · ${esc(p.r.surgery_type || "")}
        ${p.t.payload ? "<br>" + esc(p.t.payload) : ""}`;
      tip.hidden = false;
      el.querySelector(".pt").classList.add("hl");
    };
    el.onmousemove = (e) => {
      const b = card.getBoundingClientRect();
      let x = e.clientX - b.left + 14, y = e.clientY - b.top + 14;
      if (x + 260 > b.width) x = e.clientX - b.left - 270;
      tip.style.left = x + "px"; tip.style.top = y + "px";
    };
    el.onmouseleave = () => { tip.hidden = true; el.querySelector(".pt").classList.remove("hl"); };
    el.onclick = () => (location.hash = p.r.id);
  });
}

// ---------------------------------------------------------------- detail
function openDetail(id) {
  const r = state.records.find((x) => x.id === id);
  if (!r) return;
  const dlg = $("#detailDlg");
  const kv = (keys) => `<div class="kv">${MAIN_FIELDS.filter((f) => keys.includes(f.section) && f.type !== "textarea")
    .map((f) => `<div><span>${esc(f.label)}</span><p>${esc(r[f.key] ?? "") || "—"}</p></div>`).join("")}</div>`;
  const texts = MAIN_FIELDS.filter((f) => f.type === "textarea" && r[f.key])
    .map((f) => `<h3>${esc(f.label)}</h3><p class="prose">${esc(r[f.key])}</p>`).join("");
  const tg = (r.targets || []).length ? `<div class="table-wrap"><table><thead><tr>${TARGET_FIELDS.map((f) =>
      `<th${f.type === "number" ? ' class="num"' : ""}>${esc(f.label)}</th>`).join("")}</tr></thead><tbody>${r.targets.map((t) =>
      `<tr>${TARGET_FIELDS.map((f) => `<td${f.type === "number" ? ' class="num coords"' : ""}>${f.type === "number" ? fmt(t[f.key]) : esc(t[f.key] || "—")}</td>`).join("")}</tr>`).join("")}
      </tbody></table></div><p class="hint">AP / ML / DV in mm. ML is the distance from midline; side is given by Hemi.</p>` : `<p class="muted">No targets recorded.</p>`;
  const locked = !DEMO && (r.photos || []).length && r.photos.every((p) => !photoUrl(p));
  const ph = locked ? `<p class="muted">🔒 ${r.photos.length} photo${r.photos.length > 1 ? "s" : ""} — ${state.session
      ? "your account isn't approved to view photos. Ask the log admin to add you."
      : "sign in with an approved email to view."}</p>`
    : (r.photos || []).length ? `<div class="photos">${r.photos.map((p) => `<figure class="photo">
      <a href="${esc(photoUrl(p))}" target="_blank" rel="noopener"><img src="${esc(photoUrl(p))}" alt="${esc(p.caption || "surgery photo")}" loading="lazy"></a>
      ${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ""}</figure>`).join("")}</div>` : `<p class="muted">No photos.</p>`;

  dlg.innerHTML = `
    <div class="dlg-head"><h2>${esc(r.animal_id)} · ${esc(r.surgery_type || "Surgery")} · ${esc(r.surgery_date)}</h2>
      <button class="btn link" data-close>Close</button></div>
    <div class="dlg-body">
      <h3>Animal</h3>${kv(["Animal"])}
      <h3>Surgery</h3>${kv(["Surgery", "Outcome"])}
      <h3>Targets</h3>${tg}
      <h3>Photos</h3>${ph}
      ${texts}
      <p class="meta">Added by ${esc(r.created_by_email || "unknown")} · ${esc((r.created_at || "").slice(0, 10))}
        ${r.updated_at && r.updated_at !== r.created_at ? ` · edited ${esc(r.updated_at.slice(0, 10))}` : ""}</p>
    </div>
    <div class="dlg-foot">
      ${canDelete(r) ? `<button class="btn danger" data-del>Delete</button>` : ""}
      <button class="btn" data-copy>Copy link</button>
      <span class="spacer"></span>
      ${state.isEditor ? `<button class="btn primary" data-edit>Edit</button>` : ""}
    </div>`;
  dlg.querySelector("[data-close]").onclick = () => dlg.close();
  dlg.querySelector("[data-copy]").onclick = async (e) => {
    try { await navigator.clipboard.writeText(location.href); e.target.textContent = "Copied"; } catch (_) { e.target.textContent = location.href; }
  };
  const ed = dlg.querySelector("[data-edit]");
  if (ed) ed.onclick = () => { dlg.close(); openForm(r); };
  const del = dlg.querySelector("[data-del]");
  if (del) del.onclick = async () => {
    if (!confirm(`Delete surgery record for ${r.animal_id} (${r.surgery_date})? Photos are deleted too.`)) return;
    try { await deleteRecord(r); dlg.close(); render(); } catch (err) { alert(err.message); }
  };
  if (!dlg.open) dlg.showModal();
}

// ---------------------------------------------------------------- form
function fieldInput(f, value, prefix = "") {
  const name = prefix + f.key;
  const v = value ?? "";
  if (f.type === "select") return `<select name="${name}">${f.options.map((o) =>
    `<option value="${esc(o)}"${String(o) === String(v) ? " selected" : ""}>${esc(o || "—")}</option>`).join("")}</select>`;
  if (f.type === "textarea") return `<textarea name="${name}" placeholder="${esc(f.placeholder || "")}">${esc(v)}</textarea>`;
  return `<input name="${name}" type="${f.type || "text"}" ${f.type === "number" ? `step="${f.step || "any"}"` : ""}
    value="${esc(v)}" placeholder="${esc(f.placeholder || "")}" ${f.required ? "required" : ""}>`;
}

function targetRow(t = {}) {
  const row = document.createElement("div");
  row.className = "tgt";
  row.innerHTML = TARGET_FIELDS.map((f) => `<label>${esc(f.label)}${fieldInput(f, t[f.key], "t_")}</label>`).join("") +
    `<button type="button" class="btn link danger" title="Remove target">✕</button>`;
  row.querySelector("button").onclick = () => row.remove();
  return row;
}

function openForm(rec = null) {
  const r = rec ? structuredClone(rec) : { surgery_date: new Date().toISOString().slice(0, 10), targets: [{}], photos: [] };
  const removed = new Set();
  const newPhotos = []; // {file, caption, url}
  const dlg = $("#formDlg");
  const sections = ["Animal", "Surgery", "Outcome"];
  dlg.innerHTML = `
    <form method="dialog" id="surgForm">
      <div class="dlg-head"><h2>${rec ? "Edit" : "New"} surgery</h2><button type="button" class="btn link" data-cancel>Cancel</button></div>
      <div class="dlg-body">
        ${sections.filter((s) => s !== "Outcome").map((s) => `<h3>${s}</h3><div class="form-grid">${MAIN_FIELDS.filter((f) => f.section === s)
          .map((f) => `<label class="${f.full ? "full" : ""}"><span class="${f.required ? "req" : ""}">${esc(f.label)}</span>${fieldInput(f, r[f.key])}</label>`).join("")}</div>`).join("")}
        <h3>Targets (coordinates)</h3>
        <p class="hint">AP / ML / DV in mm. AP: + anterior, − posterior. Enter ML as distance from midline and pick the hemisphere. DV is depth from the chosen reference.</p>
        <div id="tgts"></div>
        <button type="button" class="btn link" id="addTgt">+ Add target</button>
        <h3>Photos</h3>
        <div class="photos" id="existingPhotos"></div>
        <div class="photos" id="newPhotos" style="margin-top:10px"></div>
        <p><input type="file" id="photoInput" accept="image/*" multiple></p>
        <p class="hint">Images are resized to ≤2000 px JPEG before upload.</p>
        <h3>Outcome</h3><div class="form-grid">${MAIN_FIELDS.filter((f) => f.section === "Outcome")
          .map((f) => `<label class="${f.full ? "full" : ""}"><span>${esc(f.label)}</span>${fieldInput(f, r[f.key])}</label>`).join("")}</div>
        <p class="err" id="formErr"></p>
      </div>
      <div class="dlg-foot"><span class="spacer"></span>
        <button type="button" class="btn" data-cancel>Cancel</button>
        <button type="submit" class="btn primary" id="saveBtn">Save</button></div>
    </form>`;

  const tg = $("#tgts", dlg);
  (r.targets?.length ? r.targets : [{}]).forEach((t) => tg.appendChild(targetRow(t)));
  $("#addTgt", dlg).onclick = () => tg.appendChild(targetRow());

  const ex = $("#existingPhotos", dlg);
  (r.photos || []).forEach((p, i) => {
    const fig = document.createElement("figure");
    fig.className = "photo";
    fig.innerHTML = `<img src="${esc(photoUrl(p))}" alt=""><button type="button" class="rm" title="Remove">✕</button>
      <input value="${esc(p.caption || "")}" placeholder="Caption">`;
    fig.querySelector("input").oninput = (e) => (r.photos[i].caption = e.target.value);
    fig.querySelector(".rm").onclick = () => {
      if (removed.has(p.path)) removed.delete(p.path); else removed.add(p.path);
      fig.classList.toggle("removed", removed.has(p.path));
    };
    ex.appendChild(fig);
  });

  const np = $("#newPhotos", dlg);
  $("#photoInput", dlg).onchange = (e) => {
    [...e.target.files].forEach((file) => {
      const item = { file, caption: "", url: URL.createObjectURL(file) };
      newPhotos.push(item);
      const fig = document.createElement("figure");
      fig.className = "photo";
      fig.innerHTML = `<img src="${item.url}" alt=""><button type="button" class="rm" title="Remove">✕</button><input placeholder="Caption">`;
      fig.querySelector("input").oninput = (ev) => (item.caption = ev.target.value);
      fig.querySelector(".rm").onclick = () => { newPhotos.splice(newPhotos.indexOf(item), 1); fig.remove(); };
      np.appendChild(fig);
    });
    e.target.value = "";
  };

  dlg.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = () => dlg.close()));
  $("#surgForm", dlg).onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    MAIN_FIELDS.forEach((f) => {
      const v = (fd.get(f.key) ?? "").toString().trim();
      r[f.key] = f.type === "number" ? num(v) : v || null;
    });
    r.targets = [...tg.querySelectorAll(".tgt")].map((row) => {
      const t = {};
      TARGET_FIELDS.forEach((f) => {
        const v = row.querySelector(`[name="t_${f.key}"]`).value.trim();
        t[f.key] = f.type === "number" ? num(v) : v;
      });
      return t;
    }).filter((t) => t.region || t.ap !== null || t.ml !== null || t.dv !== null || t.payload);
    const btn = $("#saveBtn", dlg);
    btn.disabled = true; btn.textContent = newPhotos.length ? "Uploading…" : "Saving…";
    try {
      await saveRecord(r, newPhotos, [...removed]);
      dlg.close();
      render();
      const saved = rec ? r.id : state.records.find((x) => x.animal_id === r.animal_id && x.surgery_date === r.surgery_date)?.id;
      if (saved) { location.hash = saved; openDetail(saved); }
    } catch (err) {
      $("#formErr", dlg).textContent = err.message;
      btn.disabled = false; btn.textContent = "Save";
    }
  };
  dlg.showModal();
}

// ---------------------------------------------------------------- login
function openLogin() {
  const dlg = $("#loginDlg");
  dlg.innerHTML = `<form id="loginForm">
    <div class="dlg-head"><h2>Sign in</h2><button type="button" class="btn link" data-close>Close</button></div>
    <div class="dlg-body"><p class="muted">We'll email you a one-time sign-in link. Approved emails can view photos; editors can also add records.</p>
      <p><input type="email" name="email" required placeholder="you@university.edu" style="width:100%"></p>
      <p class="err" id="loginMsg"></p></div>
    <div class="dlg-foot"><button class="btn primary">Send link</button></div></form>`;
  dlg.querySelector("[data-close]").onclick = () => dlg.close();
  $("#loginForm", dlg).onsubmit = async (e) => {
    e.preventDefault();
    const email = new FormData(e.target).get("email");
    const redirect = location.origin + location.pathname;
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect } });
    const msg = $("#loginMsg", dlg);
    msg.style.color = error ? "" : "var(--text-secondary)";
    msg.textContent = error ? error.message : "Check your inbox for the sign-in link.";
  };
  dlg.showModal();
}

// ---------------------------------------------------------------- CSV (one row per target)
function exportCSV() {
  const mainKeys = MAIN_FIELDS.map((f) => f.key);
  const tKeys = TARGET_FIELDS.map((f) => f.key);
  const header = ["record_id", ...mainKeys, "target_index", ...tKeys.map((k) => "target_" + k), "photos", "created_by_email", "created_at"];
  const cell = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [header.join(",")];
  filtered().forEach((r) => {
    const ts = r.targets?.length ? r.targets : [{}];
    const photos = (r.photos || []).length + " photo(s)"; // no URLs in exports: photo links are private and expire
    ts.forEach((t, i) => lines.push([r.id, ...mainKeys.map((k) => r[k]), r.targets?.length ? i + 1 : "",
      ...tKeys.map((k) => t[k]), photos, r.created_by_email, r.created_at].map(cell).join(",")));
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  a.download = `surgery_log_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// ---------------------------------------------------------------- banner / boot
function showBanner(t) { const b = $("#banner"); b.textContent = t; b.hidden = false; }
function hideBanner() { $("#banner").hidden = true; }

function onHash() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (id) openDetail(id);
}

async function boot() {
  $("#q").oninput = (e) => { state.q = e.target.value; render(); };
  $("#typeFilter").onchange = (e) => { state.type = e.target.value; render(); };
  $("#exportBtn").onclick = exportCSV;
  $("#newBtn").onclick = () => openForm();
  $("#detailDlg").addEventListener("close", () => {
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  });
  window.addEventListener("hashchange", onHash);
  try {
    await initBackend();
  } catch (err) {
    showBanner("Could not connect to the database: " + err.message);
  }
  if (DEMO) showBanner("Demo mode — sample data stored only in this browser. Add your Supabase URL and key in config.js to share a real database.");
  render();
  onHash();
}
boot();
