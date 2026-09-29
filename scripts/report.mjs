// Aylık sağlık raporu: tüm ölçüm çıktılarından tek sayfalık HTML (müşteriye gönderilen) + ekran görüntüleri.
//   node scripts/report.mjs
import fs from "node:fs";
import { lineChart } from "../monitor/status-page.mjs";
import { RULES } from "../monitor/rules.mjs";

const J = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const v1 = J("reports/exam-peak-v1.json"), v2 = J("reports/exam-peak-v2.json"), cap = J("reports/capacity.json"), bk = J("reports/backup-drill.json");
const audit = fs.existsSync("reports/audit.json") ? J("reports/audit.json") : null;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const n = (x, d = 0) => Number(x).toLocaleString("tr-TR", { maximumFractionDigits: d, minimumFractionDigits: d });
const pct = (x, d = 1) => "%" + n(x * 100, d);
const sec = (ms) => (ms >= 1000 ? n(ms / 1000, 1) + " sn" : n(ms) + " ms");

// Sınav saati zaman çizelgesi: istemci tarafı p95 (başarılı istekler) ve saniyedeki hata — ayrı grafikler (tek eksen kuralı)
const tl = (r, key) => r.load.timeline.map((s) => ({ t: s.t * 1000, v: key === "p95" ? (s.rps ? s.p95 : null) : s[key] }));
const peakChart = (r, key, opts) => lineChart(tl(r, key), { width: 520, height: 140, xFormat: (t) => `${Math.round(t / 1000)}. sn`, marks: [{ t: r.deploy.atSec * 1000, label: "dağıtım" }], ...opts });
const deployMark = (r) => `dağıtım ${n(r.deploy.atSec)}. sn`;

// Kapasite: VU → p95 (log ölçek) iki seri + SLO çizgisi
function capacityChart() {
  const W = 560, H = 230, pad = { l: 66, r: 96, t: 12, b: 34 }; const w = W - pad.l - pad.r, h = H - pad.t - pad.b;
  const L = cap.levels; const X = (i) => pad.l + (i / (L.length - 1)) * w; const lo = Math.log10(0.5), hi = Math.log10(10000); const Y = (v) => pad.t + h - ((Math.log10(Math.max(v, 0.5)) - lo) / (hi - lo)) * h;
  const grid = [1, 10, 100, 1000, 10000].map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${pad.l - 6}" y="${Y(v) + 4}" text-anchor="end" class="tick">${n(v)} ms</text>`).join("");
  const xt = L.map((v, i) => `<text x="${X(i)}" y="${H - 14}" text-anchor="middle" class="tick">${v}</text>`).join("") + `<text x="${pad.l + w / 2}" y="${H - 1}" text-anchor="middle" class="tick">eşzamanlı sanal öğrenci</text>`;
  const series = [["v1", "var(--s2)", "Önce (v1)"], ["v2", "var(--s1)", "Sonra (v2)"]].map(([k, col, label]) => {
    const rows = cap.versions[k].rows; const pts = rows.map((r, i) => r.errorRate >= 0.5 ? null : [X(i), Y(r.p95), r]).filter(Boolean);
    const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
    const dots = pts.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="4" fill="${col}" stroke="var(--card)" stroke-width="2"><title>${label} · ${r.vus} VU: p95 ${n(r.p95, 1)} ms, ${n(r.rps, 1)} istek/sn, hata ${pct(r.errorRate)}</title></circle>`).join("");
    const last = pts.at(-1); const fails = rows.filter((r) => r.errorRate >= 0.5).length;
    return `<path d="${d}" fill="none" stroke="${col}" stroke-width="2"/>${dots}<text x="${last[0] + 8}" y="${last[1] + 4}" class="lbl">${label}</text>${fails ? `<text x="${last[0] + 8}" y="${last[1] + 18}" class="tick">${rows.find((r) => r.errorRate >= 0.5).vus}+ VU: %${n(rows.find((r) => r.errorRate >= 0.5).errorRate * 100)}–${n(rows.at(-1).errorRate * 100)} hata</text>` : ""}`;
  }).join("");
  const slo = `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(cap.slo.p95)}" y2="${Y(cap.slo.p95)}" class="thr"/><text x="${W - pad.r + 4}" y="${Y(cap.slo.p95) + 4}" class="tick thr-l">SLO 500 ms</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Eşzamanlılığa göre p95 yanıt süresi, önce ve sonra">${grid}${slo}${series}${xt}</svg>`;
}
const incRows = (r) => r.incidents.length ? r.incidents.slice().reverse().map((i) => `<tr><td><span class="pill ${i.severity === "kritik" ? "crit" : "warn"}">${i.severity === "kritik" ? "✕ Kritik" : "! Uyarı"}</span></td><td>${esc(i.title)}</td><td>+${n((i.detectedAt - i.startedAt) / 1000)} sn</td><td>${i.resolvedAt ? n((i.resolvedAt - i.startedAt) / 1000) + " sn" : "sürüyor"}</td><td>${i.peak != null && i.unit ? n(i.peak) + " " + i.unit : "—"}</td></tr>`).join("") : `<tr><td colspan="5" class="muted">Olay yok — hiçbir kural tetiklenmedi.</td></tr>`;

const html = `<!DOCTYPE html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Eduline — Bakım ve İzleme Raporu</title>
<style>
:root{--bg:#f4f5f8;--card:#fff;--ink:#0f1320;--ink2:#4d5566;--line:#e3e6ed;--s1:#2a78d6;--s2:#eb6834;--good:#0b7a0b;--good-bg:#e3f5e3;--warn:#8a5a00;--warn-bg:#fff2d6;--crit:#b3261e;--crit-bg:#fde7e5;--grid:#e8ebf1;--brand:#6d4ae6}
*{box-sizing:border-box;margin:0}body{font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink);padding:32px;line-height:1.5}
.wrap{max-width:1180px;margin:0 auto}header{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:20px;gap:16px}h1{font-size:28px;letter-spacing:-.4px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.9px;color:var(--ink2);margin:0 0 12px}.muted{color:var(--ink2);font-size:14px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px}
.kpi b{display:block;font-size:30px;letter-spacing:-.6px;margin-top:2px}.kpi .from{color:#8b93a3;text-decoration:line-through;font-size:14px}.kpi .up{color:var(--good);font-weight:800;font-size:14px}
.tag{display:inline-block;font-size:12px;font-weight:800;padding:3px 8px;border-radius:6px;margin-bottom:10px}.t1{background:#fdeee7;color:#a8431a}.t2{background:#e6f0fb;color:#1c5cab}
svg{width:100%;height:auto;display:block}.grid{stroke:var(--grid);stroke-width:1}.tick{fill:var(--ink2);font-size:11px}.lbl{fill:var(--ink);font-size:12px;font-weight:700}.thr{stroke:var(--crit);stroke-width:1.5;stroke-dasharray:5 4}.thr-l{fill:var(--crit)}.down{fill:var(--crit);opacity:.35}.hit{fill:transparent}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line)}th{color:var(--ink2);font-weight:600;font-size:12px}td.r,th.r{text-align:right}
.pill{display:inline-flex;font-size:12px;font-weight:700;padding:2px 8px;border-radius:99px;white-space:nowrap}.pill.crit{background:var(--crit-bg);color:var(--crit)}.pill.warn{background:var(--warn-bg);color:var(--warn)}.pill.good{background:var(--good-bg);color:var(--good)}
.legend{display:flex;gap:16px;font-size:13px;color:var(--ink2);margin-top:8px}.sw{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:middle}
ul{padding-left:18px;font-size:14px}li{margin:3px 0}.sub{font-size:13px;color:var(--ink2);margin:-6px 0 8px}
</style></head><body><div class="wrap">
<header><div><div class="muted">Eduline · 15.000 öğrenci · canlı ders ve sınav platformu</div><h1>Bakım ve izleme raporu — sınav saati kapasitesi</h1></div><div class="muted" style="text-align:right">Ölçüm: ${new Date(bk.at).toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" })}<br>Node ${process.versions.node} · SQLite · 2 çekirdek</div></header>

<div class="grid4">
  <div class="card kpi"><span class="muted">SLO içinde kapasite</span><b>${n(cap.versions.v2.maxRpsWithinSlo)} istek/sn</b><span class="from">${n(cap.versions.v1.maxRpsWithinSlo, 1)}</span> <span class="up">hedefin ${n(cap.versions.v2.headroom, 1)}×</span></div>
  <div class="card kpi"><span class="muted">Sınav saati hata oranı</span><b>${pct(v2.load.errorRate, 2)}</b><span class="from">${pct(v1.load.errorRate)}</span> <span class="up">${n(v2.load.requests)} istek</span></div>
  <div class="card kpi"><span class="muted">Dağıtım sırasında hata</span><b>${n(v2.deploy.errorsDuring)}</b><span class="from">${n(v1.deploy.errorsDuring)}</span> <span class="up">${n(v2.deploy.requestsDuring)} istekte</span></div>
  <div class="card kpi"><span class="muted">Yedekten dönüş (RTO)</span><b>${sec(bk.restore.rtoMs)}</b><span class="muted">yedek ${sec(bk.backup.ms)} · yük altında, 0 hata</span></div>
</div>

<div class="grid2" style="margin-top:16px">
  <div class="card"><span class="tag t1">ÖNCE · v1</span><h2>Sınav saati: p95 yanıt süresi (ms)</h2><div class="sub">${v1.vus} sanal öğrenci · ${deployMark(v1)} · istemci ölçümü, başarılı istekler</div>${peakChart(v1, "p95", { threshold: 1000, color: "var(--s2)", label: "Önce: saniyelik p95" })}<h2 style="margin-top:12px">Hata / sn (zaman aşımı, bağlantı reddi)</h2>${peakChart(v1, "errors", { color: "var(--crit)", label: "Önce: saniyelik hata", max: Math.max(5, ...v1.load.timeline.map((s) => s.errors)) * 1.1 })}</div>
  <div class="card"><span class="tag t2">SONRA · v2</span><h2>Sınav saati: p95 yanıt süresi (ms)</h2><div class="sub">${v2.vus} sanal öğrenci · ${deployMark(v2)} · aynı ölçek eşiği 1.000 ms</div>${peakChart(v2, "p95", { threshold: 1000, max: 1100, color: "var(--s1)", label: "Sonra: saniyelik p95" })}<h2 style="margin-top:12px">Hata / sn</h2>${peakChart(v2, "errors", { color: "var(--crit)", label: "Sonra: saniyelik hata", max: Math.max(5, ...v1.load.timeline.map((s) => s.errors)) * 1.1 })}</div>
</div>

<div class="grid2" style="margin-top:16px">
  <div class="card"><h2>Kapasite planı · p95 (log ölçek)</h2>${capacityChart()}<div class="legend"><span><i class="sw" style="background:var(--s2)"></i>Önce (v1, tek süreç)</span><span><i class="sw" style="background:var(--s1)"></i>Sonra (v2, 2 işçi)</span></div>
    <table style="margin-top:10px"><tr><th></th><th class="r">SLO içinde en yüksek</th><th class="r">Hedef</th><th class="r">Pay</th></tr><tr><td>Önce</td><td class="r">${n(cap.versions.v1.maxRpsWithinSlo, 1)} istek/sn</td><td class="r">${cap.targetRps}</td><td class="r"><span class="pill crit">${n(cap.versions.v1.headroom, 2)}×</span></td></tr><tr><td>Sonra</td><td class="r"><b>${n(cap.versions.v2.maxRpsWithinSlo)} istek/sn</b></td><td class="r">${cap.targetRps}</td><td class="r"><span class="pill good">${n(cap.versions.v2.headroom, 1)}×</span></td></tr></table>
    <p class="muted" style="margin-top:8px">SLO: p95 ≤ ${cap.slo.p95} ms, hata ≤ %1. Hedef: ${esc(cap.targetNote)} = ${cap.targetRps} istek/sn. Yük üreteci aynı makinede çalıştığı için v2'nin tavanı üretecin sınırıdır.</p></div>
  <div class="card"><h2>İzleme: tespit edilen olaylar (önce)</h2><table><tr><th>Önem</th><th>Olay</th><th>Tespit</th><th>Süre</th><th>En kötü</th></tr>${incRows(v1)}</table>
    <h2 style="margin-top:16px">İzleme: sonra</h2><table><tr><th>Önem</th><th>Olay</th><th>Tespit</th><th>Süre</th><th>En kötü</th></tr>${incRows(v2)}</table>
    <p class="muted" style="margin-top:8px">Önce: erişilebilirlik ${pct(v1.availability)}, yük bittikten sonra toparlanma ${v1.recoverySec != null ? n(v1.recoverySec, 1) + " sn" : "60 sn'yi aştı"}. Sonra: erişilebilirlik ${pct(v2.availability, 2)}.</p></div>
</div>

<div class="grid2" style="margin-top:16px">
  <div class="card"><h2>Kök nedenler ve düzeltmeler</h2><ul>
    <li><b>İndekssiz 400 bin satırlık gönderim tablosu</b> — her gönderimde mükerrer kontrolü ve sıralama tam tarama. → 5 indeks, UNIQUE kısıt.</li>
    <li><b>N+1 notlandırma</b> — soru başına sorgu. → Cevap anahtarı bellekte önbellek (TTL), tek işlem.</li>
    <li><b>Olay döngüsü kilitleniyor</b> — senkron sorgular kuyruk oluşturuyor, sunucu içi süreler bunu göstermiyor. → Olay döngüsü gecikmesi metriği ve kuralı.</li>
    <li><b>Dağıtımda kesinti</b> — süreç durdurulup başlatılıyordu. → Küme + SIGHUP ile tek tek yenileme; boşaltmada <code>Connection: close</code> (ilk denemede 75 ECONNRESET ölçüldü, düzeltmeden sonra 0).</li>
    <li><b>Yedek doğrulanmıyordu</b> — sayfa sayfa yedek, yoğun yazma altında sürekli baştan başlıyordu (9,2 sn). → <code>VACUUM INTO</code> anlık yedek, bütünlük kontrolü, SHA-256, geri yükleme tatbikatı.</li></ul></div>
  <div class="card"><h2>Yedekleme tatbikatı · uyarı kuralları · bakım</h2>
    <table><tr><td>Yedek (yük altında, ${n(bk.loadDuringBackup.rps)} istek/sn)</td><td class="r">${n(bk.backup.sizeMB, 1)} MB · ${sec(bk.backup.ms)}</td></tr><tr><td>Bütünlük / tutarlılık</td><td class="r"><span class="pill good">✓ ${esc(bk.backup.integrity)} · ${bk.backup.consistent ? "tutarlı" : "TUTARSIZ"}</span></td></tr><tr><td>Geri yükleme → ilk sağlıklı yanıt</td><td class="r">${sec(bk.restore.rtoMs)} · örnek gönderim HTTP ${bk.restore.sampleSubmitStatus}</td></tr><tr><td>Bağımlılık denetimi (npm audit)</td><td class="r">${audit ? `<span class="pill ${audit.total ? "crit" : "good"}">${audit.total ? audit.total + " açık" : "✓ 0 açık"}</span>` : "—"}</td></tr></table>
    <p class="muted" style="margin:12px 0 6px">${RULES.length} uyarı kuralı: ${RULES.map((r) => `${esc(r.title)} (${r.op} ${n(r.threshold)}${r.unit}, ${r.forSec} sn)`).join(" · ")}</p></div>
</div>
<p class="muted" style="margin-top:14px">Tüm sayılar bu depodaki betiklerle üretilmiştir: npm run seed · npm run peak · npm run capacity · npm run drill · npm run report. Kurgusal platform; veri deterministik olarak üretilir.</p>
</div></body></html>`;
fs.writeFileSync("reports/index.html", html);
console.log("reports/index.html yazıldı");

if (process.argv.includes("--shots")) {
  const { chromium } = await import("playwright");
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  fs.mkdirSync("screenshots", { recursive: true });
  const shot = async (file, out, { w = 1280, h = 800, full = true } = {}) => { const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 }); await p.goto("file://" + process.cwd() + "/" + file); await p.waitForTimeout(300); await p.screenshot({ path: out, fullPage: full }); await p.close(); };
  await shot("reports/index.html", "screenshots/rapor.png"); await shot("reports/index.html", "screenshots/rapor-ust.png", { full: false });
  for (const f of ["status-v1-peak", "status-v1-final", "status-v2-final"]) if (fs.existsSync(`reports/${f}.html`)) { await shot(`reports/${f}.html`, `screenshots/${f}.png`, { w: 1100, h: 900 }); await shot(`reports/${f}.html`, `screenshots/${f}-ust.png`, { w: 1280, h: 800, full: false }); }
  await b.close(); console.log("screenshots/ güncellendi");
}
