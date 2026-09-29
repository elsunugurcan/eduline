// İzleme ajanı: sağlık/hazırlık yoklamaları, sentetik öğrenci yolculuğu, /metrics.json kazıma, kural değerlendirme,
// uyarı gönderimi (günlük + isteğe bağlı webhook), olay (incident) kaydı ve canlı durum sayfası.
//   node monitor/monitor.mjs --target http://localhost:8302 --port 8400 [--interval 2000] [--webhook https://...]
import http from "node:http";
import fs from "node:fs";
import { diff, summarize } from "../app/metrics.mjs";
import { RULES, availability, componentStatus, evaluate, formatAlert } from "./rules.mjs";
import { renderStatusPage } from "./status-page.mjs";

const timed = async (url, opts = {}, timeoutMs = 3000) => {
  const t = performance.now(); const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), timeoutMs);
  try { const r = await fetch(url, { ...opts, signal: ctl.signal }); const body = await r.text(); return { ok: r.ok, status: r.status, ms: performance.now() - t, body }; }
  catch (e) { return { ok: false, status: 0, ms: performance.now() - t, error: e.name === "AbortError" ? "zaman aşımı" : e.cause?.code ?? e.message }; }
  finally { clearTimeout(to); }
};

export function createMonitor({ target, intervalMs = 2000, webhook, dataDir = "data/monitor", name = "Eduline", log = console.log } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const alertLog = fs.createWriteStream(`${dataDir}/alerts.log`, { flags: "a" });
  let state = {}, lastSnap = null, lastSnapAt = 0, timer = null;
  const probes = [], series = [], incidents = [], alerts = [];
  const tick = async () => {
    const t = Date.now();
    // Sentetik yolculuk (ders listesi → sınav açma, yazma yapmaz) diğer yoklamalarla paralel çalışır
    const journey = (async () => { const s1 = await timed(`${target}/api/courses?student=1`, {}, 5000); const s2 = s1.ok ? await timed(`${target}/api/exams/1`, {}, 5000) : { ok: false, ms: 0 }; return { ok: s1.ok && s2.ok, ms: s1.ms + s2.ms }; })();
    const [health, ready, snapRes, synthetic] = await Promise.all([timed(`${target}/health`, {}, 2000), timed(`${target}/ready`, {}, 2000), timed(`${target}/metrics.json`, {}, 3000), journey]);
    let window = null;
    if (snapRes.ok) {
      const snap = JSON.parse(snapRes.body);
      const restarted = lastSnap && snap.startedAt !== lastSnap.startedAt && Object.values(snap.hist).reduce((a, h) => a + h.count, 0) < Object.values(lastSnap.hist).reduce((a, h) => a + h.count, 0);
      if (lastSnap && !restarted) { const d = summarize(diff(snap, lastSnap)); const secs = (t - lastSnapAt) / 1000; window = { ...d, rps: d.count / secs, loopLag: snap.loop?.p99 ?? null }; }
      lastSnap = snap; lastSnapAt = t;
    }
    const sample = { t, health: { ok: health.ok, ms: health.ms, error: health.error }, ready: { ok: ready.ok }, metricsOk: snapRes.ok, synthetic, window };
    probes.push({ t, ok: health.ok && ready.ok }); if (probes.length > 5000) probes.shift();
    series.push({ t, loopLag: window?.loopLag ?? null, p95: window?.p95 ?? null, rps: window?.rps ?? null, errorRate: window?.errorRate ?? null, synthetic: synthetic.ms, up: health.ok }); if (series.length > 900) series.shift();
    const r = evaluate(state, sample); state = r.state;
    for (const ev of r.events) {
      const text = formatAlert(ev); const rec = { at: new Date(ev.at).toISOString(), type: ev.type, rule: ev.rule.id, severity: ev.rule.severity, text };
      alerts.push(rec); alertLog.write(JSON.stringify(rec) + "\n"); log(`[izleme] ${text}`);
      if (webhook) fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `${name}: ${text}` }) }).catch(() => {});
      if (ev.type === "firing") incidents.push({ id: ev.incidentId, rule: ev.rule.id, title: ev.rule.title, severity: ev.rule.severity, component: ev.rule.component, startedAt: ev.startedAt, detectedAt: ev.at, resolvedAt: null, peak: ev.value, unit: ev.rule.unit });
      else { const inc = incidents.find((i) => i.id === ev.incidentId); if (inc) { inc.resolvedAt = ev.at; inc.peak = ev.peak; } }
    }
    for (const inc of incidents) if (!inc.resolvedAt && state[inc.rule]?.peak != null) inc.peak = Math.max(inc.peak, state[inc.rule].peak);
    fs.writeFileSync(`${dataDir}/status.json`, JSON.stringify(status(), null, 0));
  };
  const status = () => ({ name, target, generatedAt: Date.now(), components: componentStatus(state), firing: RULES.filter((r) => state[r.id]?.status === "firing").map((r) => ({ id: r.id, title: r.title, severity: r.severity })), availability: availability(probes), probes: probes.length, series: series.slice(-300), incidents: [...incidents].reverse(), alerts: alerts.slice(-50).reverse(), rules: RULES.map(({ id, title, severity, threshold, unit, forSec, op }) => ({ id, title, severity, threshold, unit, forSec, op })) });
  let running = false;
  return {
    start() { const loop = async () => { if (running) return; running = true; try { await tick(); } catch (e) { log(`[izleme] hata: ${e.message}`); } finally { running = false; } }; loop(); timer = setInterval(loop, intervalMs); return this; },
    stop() { clearInterval(timer); alertLog.end(); },
    status, incidents, alerts,
    serve(port) {
      const srv = http.createServer((req, res) => {
        if (req.url.startsWith("/status.json")) { res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); return res.end(JSON.stringify(status())); }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(renderStatusPage(status(), { live: true }));
      });
      srv.listen(port, () => log(`[izleme] durum sayfası http://localhost:${port}`)); return srv;
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const m = createMonitor({ target: arg("target", "http://localhost:8302"), intervalMs: Number(arg("interval", 2000)), webhook: arg("webhook", process.env.ALERT_WEBHOOK) }).start();
  m.serve(Number(arg("port", 8400)));
  process.on("SIGINT", () => { m.stop(); process.exit(0); });
}
