// Durum sayfası (kamuya açık + ekip görünümü): bileşen durumları, erişilebilirlik, p95 ve trafik grafikleri, olaylar.
// Tek dosya HTML, dış bağımlılık yok; canlı modda 5 sn'de bir kendini yeniler.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const COMP = { api: "API ve giriş", exam: "Sınav sistemi", live: "Canlı dersler", db: "Veritabanı" };
const ICON = { "çalışıyor": "✓", "yavaşlama": "!", "kesinti": "✕" };
const CLS = { "çalışıyor": "good", "yavaşlama": "warn", "kesinti": "crit" };
const fmtTime = (t) => new Date(t).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtDur = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s} sn` : `${Math.floor(s / 60)} dk ${s % 60} sn`; };

/** Tek seriden çizgi grafik (SVG). points: [{t, v}] ; threshold: yatay çizgi */
export function lineChart(points, { width = 560, height = 150, threshold, unit = "", max, label, color = "var(--s1)", xFormat = fmtTime, marks = [] } = {}) {
  const pad = { l: 44, r: 10, t: 10, b: 22 }; const W = width - pad.l - pad.r, H = height - pad.t - pad.b;
  const vals = points.filter((p) => p.v != null); if (!points.length) return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}: veri yok"></svg>`;
  const t0 = points[0].t, t1 = points.at(-1).t || t0 + 1; const top = max ?? Math.max(threshold ?? 0, ...vals.map((p) => p.v), 1) * 1.1;
  const X = (t) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * W, Y = (v) => pad.t + H - (Math.min(v, top) / top) * H;
  let d = "", pen = false; for (const p of points) { if (p.v == null) { pen = false; continue; } d += `${pen ? "L" : "M"}${X(p.t).toFixed(1)} ${Y(p.v).toFixed(1)} `; pen = true; }
  const ticks = [0, top / 2, top].map((v) => `<line x1="${pad.l}" x2="${width - pad.r}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${pad.l - 6}" y="${Y(v) + 4}" text-anchor="end" class="tick">${Math.round(v)}${unit}</text>`).join("");
  const thr = threshold != null && threshold < top ? `<line x1="${pad.l}" x2="${width - pad.r}" y1="${Y(threshold)}" y2="${Y(threshold)}" class="thr"/><text x="${width - pad.r}" y="${Y(threshold) - 4}" text-anchor="end" class="tick thr-l">eşik ${threshold}${unit}</text>` : "";
  const gaps = points.filter((p) => p.down).map((p) => `<rect x="${X(p.t) - 2}" y="${pad.t}" width="4" height="${H}" class="down"><title>${fmtTime(p.t)} · erişilemedi</title></rect>`).join("");
  const hits = vals.map((p) => `<circle cx="${X(p.t).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="6" class="hit"><title>${xFormat(p.t)} · ${Math.round(p.v)}${unit}</title></circle>`).join("");
  const xl = `<text x="${pad.l}" y="${height - 4}" class="tick">${xFormat(t0)}</text><text x="${width - pad.r}" y="${height - 4}" text-anchor="end" class="tick">${xFormat(t1)}</text>`;
  const mk = marks.map((m) => `<line x1="${X(m.t)}" x2="${X(m.t)}" y1="${pad.t}" y2="${pad.t + H}" stroke="var(--ink2)" stroke-width="1" stroke-dasharray="2 3"/><text x="${X(m.t) + 4}" y="${pad.t + 10}" class="tick">${esc(m.label)}</text>`).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">${ticks}${gaps}${mk}${thr}<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${hits}${xl}</svg>`;
}

export function renderStatusPage(s, { live = false, title } = {}) {
  const worst = Object.values(s.components).includes("kesinti") ? "kesinti" : Object.values(s.components).includes("yavaşlama") ? "yavaşlama" : "çalışıyor";
  const headline = { "çalışıyor": "Tüm sistemler çalışıyor", "yavaşlama": "Bazı hizmetlerde yavaşlama var", "kesinti": "Hizmet kesintisi yaşanıyor" }[worst];
  const p95 = s.series.map((x) => ({ t: x.t, v: x.p95, down: !x.up })); const rps = s.series.map((x) => ({ t: x.t, v: x.rps, down: !x.up }));
  const open = s.incidents.filter((i) => !i.resolvedAt);
  return `<!DOCTYPE html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${live ? '<meta http-equiv="refresh" content="5">' : ""}<title>${esc(title ?? `${s.name} durum`)}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#101418;--ink2:#4d5663;--line:#e3e7ec;--s1:#2a78d6;--good:#0b7a0b;--good-bg:#e3f5e3;--warn:#8a5a00;--warn-bg:#fff2d6;--crit:#b3261e;--crit-bg:#fde7e5;--grid:#e8ecf0}
@media (prefers-color-scheme:dark){:root{--bg:#121416;--card:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--line:#2c2f33;--s1:#3987e5;--good:#5fd35f;--good-bg:#12301a;--warn:#fab219;--warn-bg:#3a2c0a;--crit:#ff8a80;--crit-bg:#3d1614;--grid:#2a2d31}}
*{box-sizing:border-box;margin:0}body{font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink);padding:28px 20px;line-height:1.5}
.wrap{max-width:980px;margin:0 auto}h1{font-size:22px;letter-spacing:-.2px}h2{font-size:13px;letter-spacing:.8px;text-transform:uppercase;color:var(--ink2);margin:0 0 10px}
.muted{color:var(--ink2);font-size:14px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin-top:16px}
.banner{display:flex;align-items:center;gap:12px;padding:16px 18px;border-radius:12px;margin-top:16px;font-weight:700;font-size:17px}
.banner.good{background:var(--good-bg);color:var(--good)}.banner.warn{background:var(--warn-bg);color:var(--warn)}.banner.crit{background:var(--crit-bg);color:var(--crit)}
.ico{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;font-size:13px;font-weight:800;color:#fff;flex:none}
.good .ico,.ico.good{background:var(--good)}.warn .ico,.ico.warn{background:var(--warn)}.crit .ico,.ico.crit{background:var(--crit)}
.comps{display:grid;grid-template-columns:repeat(2,1fr);gap:0 24px}.comp{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)}
.state{display:flex;gap:8px;align-items:center;font-size:14px;font-weight:600}.state.good{color:var(--good)}.state.warn{color:var(--warn)}.state.crit{color:var(--crit)}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.kpi b{display:block;font-size:26px;letter-spacing:-.4px}
.charts{display:grid;grid-template-columns:1fr 1fr;gap:16px}svg{width:100%;height:auto;display:block}
.grid{stroke:var(--grid);stroke-width:1}.tick{fill:var(--ink2);font-size:11px}.thr{stroke:var(--crit);stroke-width:1.5;stroke-dasharray:5 4}.thr-l{fill:var(--crit)}
.down{fill:var(--crit);opacity:.35}.hit{fill:transparent}.hit:hover{fill:var(--s1);fill-opacity:.25}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line)}th{color:var(--ink2);font-weight:600;font-size:12px}
.pill{display:inline-flex;gap:6px;align-items:center;font-size:12px;font-weight:700;padding:2px 8px;border-radius:99px}.pill.crit{background:var(--crit-bg);color:var(--crit)}.pill.warn{background:var(--warn-bg);color:var(--warn)}.pill.good{background:var(--good-bg);color:var(--good)}
@media (max-width:720px){.comps,.charts,.kpis{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
<div style="display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap"><div><div class="muted">durum.eduline.example</div><h1>${esc(s.name)} sistem durumu</h1></div><div class="muted">Son güncelleme ${fmtTime(s.generatedAt)}${live ? " · 5 sn'de bir yenilenir" : ""}</div></div>
<div class="banner ${CLS[worst]}" role="status"><span class="ico">${ICON[worst]}</span>${headline}</div>
<div class="card"><h2>Bileşenler</h2><div class="comps">${Object.entries(s.components).map(([k, v]) => `<div class="comp"><span>${COMP[k]}</span><span class="state ${CLS[v]}"><span class="ico ${CLS[v]}" aria-hidden="true">${ICON[v]}</span>${v[0].toLocaleUpperCase("tr-TR") + v.slice(1)}</span></div>`).join("")}</div></div>
<div class="card kpis"><div class="kpi"><span class="muted">Erişilebilirlik (izleme süresi)</span><b>%${(s.availability * 100).toFixed(2).replace(".", ",")}</b><span class="muted">${s.probes} yoklama</span></div><div class="kpi"><span class="muted">Anlık p95</span><b>${s.series.at(-1)?.p95 != null ? Math.round(s.series.at(-1).p95) + " ms" : "—"}</b><span class="muted">eşik 1.000 ms</span></div><div class="kpi"><span class="muted">Açık olay</span><b>${open.length}</b><span class="muted">toplam ${s.incidents.length} olay</span></div></div>
<div class="charts"><div class="card"><h2>Yanıt süresi p95 (ms)</h2>${lineChart(p95, { threshold: 1000, unit: "", label: "Yanıt süresi p95" })}</div><div class="card"><h2>Trafik (istek / sn)</h2>${lineChart(rps, { unit: "", label: "Saniyedeki istek" })}</div></div>
<div class="card"><h2>Olaylar</h2>${s.incidents.length ? `<table><thead><tr><th>Durum</th><th>Olay</th><th>Başladı</th><th>Tespit</th><th>Süre</th><th>En kötü</th></tr></thead><tbody>${s.incidents.map((i) => `<tr><td><span class="pill ${i.resolvedAt ? "good" : i.severity === "kritik" ? "crit" : "warn"}">${i.resolvedAt ? "✓ Çözüldü" : i.severity === "kritik" ? "✕ Devam ediyor" : "! Devam ediyor"}</span></td><td>${esc(i.title)}</td><td>${fmtTime(i.startedAt)}</td><td>+${Math.round((i.detectedAt - i.startedAt) / 1000)} sn</td><td>${i.resolvedAt ? fmtDur(i.resolvedAt - i.startedAt) : "—"}</td><td>${i.peak != null ? Math.round(i.peak) + i.unit : ""}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">İzleme süresince olay yok.</p>`}</div>
<p class="muted" style="margin-top:14px">Kurallar: ${s.rules.map((r) => `${esc(r.title)} (${r.op} ${r.threshold}${r.unit}, ${r.forSec} sn)`).join(" · ")}</p>
</div></body></html>`;
}
