// Eduline API sunucusu.
//   node app/server.mjs --version v1 --db data/v1.db --port 8301           (eski: tek süreç)
//   node app/server.mjs --version v2 --db data/v2.db --port 8302 --workers 2 (yeni: küme + kesintisiz yeniden başlatma)
// v2'de ana sürece SIGHUP gönderilince işçiler tek tek yenilenir (rolling restart); SIGTERM'de istekler bitirilip kapanır.
import cluster from "node:cluster";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import Database from "better-sqlite3";
import { openV1 } from "./v1.mjs";
import { migrateV2, openV2 } from "./v2.mjs";
import { createRegistry, merge, toPrometheus } from "./metrics.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const VERSION = arg("version", "v2"), DB = arg("db", `data/${VERSION}.db`), PORT = Number(arg("port", 8300)), WORKERS = Number(arg("workers", VERSION === "v2" ? Math.min(4, os.cpus().length) : 1));
const LOG = arg("log", ""); // JSON satır günlüğü (isteğe bağlı)

if (VERSION === "v2" && cluster.isPrimary) primary(); else worker();

function primary() {
  { const db = new Database(DB); migrateV2(db); db.close(); } // şema göçü bir kez, işçilerden önce
  let generation = 0; const log = (m) => console.log(`[ana ${process.pid}] ${m}`);
  const spawn = () => { const w = cluster.fork({ EDULINE_GEN: String(generation) }); w.on("message", (m) => onMessage(w, m)); return w; };
  for (let i = 0; i < WORKERS; i++) spawn();
  try { fs.mkdirSync("data", { recursive: true }); fs.writeFileSync(`data/${VERSION}.pid`, String(process.pid)); } catch {}
  log(`v2 · ${WORKERS} işçi · http://localhost:${PORT}`);

  // Metrik birleştirme: bir işçi /metrics isterse ana süreç tüm işçilerden anlık görüntü toplar.
  const pending = new Map();
  function onMessage(w, m) {
    if (m?.cmd === "metrics-req") {
      const live = Object.values(cluster.workers).filter((x) => x && x.isConnected());
      const job = { from: w, parts: [], expect: live.length }; pending.set(m.id, job);
      live.forEach((x) => x.send({ cmd: "metrics-collect", id: m.id }));
      setTimeout(() => finish(m.id), 500);
    } else if (m?.cmd === "metrics-part") { const job = pending.get(m.id); if (job) { job.parts.push(m.snap); if (job.parts.length >= job.expect) finish(m.id); } }
  }
  function finish(id) { const job = pending.get(id); if (!job) return; pending.delete(id); if (job.from.isConnected()) job.from.send({ cmd: "metrics-res", id, snap: merge(job.parts) }); }

  // Kesintisiz yeniden başlatma: yeni işçi dinlemeye başlamadan eskisi kapatılmaz.
  let rolling = false;
  process.on("SIGHUP", async () => {
    if (rolling) return; rolling = true; generation++; const t0 = Date.now();
    const old = Object.values(cluster.workers).filter(Boolean);
    log(`yeniden başlatma başladı (${old.length} işçi)`);
    for (const w of old) {
      const fresh = spawn();
      await new Promise((r) => fresh.once("listening", r));
      await new Promise((r) => { w.once("exit", r); w.send({ cmd: "drain" }); setTimeout(() => { if (!w.isDead()) w.kill("SIGKILL"); }, 10_000); });
    }
    rolling = false; log(`yeniden başlatma bitti (${Date.now() - t0} ms)`);
    try { fs.writeFileSync(`data/${VERSION}-deploy.json`, JSON.stringify({ at: new Date().toISOString(), ms: Date.now() - t0, generation }) + "\n"); } catch {}
  });
  cluster.on("exit", (w, code, signal) => { if (!w.exitedAfterDisconnect && !rolling && code !== 0 && !shuttingDown) { log(`işçi ${w.process.pid} beklenmedik şekilde çıktı (${signal ?? code}), yenisi başlatılıyor`); spawn(); } });
  let shuttingDown = false;
  process.on("SIGTERM", () => { shuttingDown = true; for (const w of Object.values(cluster.workers)) w?.send({ cmd: "drain" }); setTimeout(() => process.exit(0), 10_000).unref(); cluster.on("exit", () => { if (!Object.keys(cluster.workers).length) process.exit(0); }); });
}

function worker() {
  const db = new Database(DB);
  const api = VERSION === "v1" ? openV1(db) : openV2(db);
  const reg = createRegistry();
  const logStream = LOG ? fs.createWriteStream(LOG, { flags: "a" }) : null;
  const inCluster = cluster.isWorker;
  const waiting = new Map(); let seq = 0; let draining = false;
  if (inCluster) process.on("message", (m) => {
    if (m?.cmd === "metrics-collect") process.send({ cmd: "metrics-part", id: m.id, snap: reg.snapshot() });
    else if (m?.cmd === "metrics-res") { waiting.get(m.id)?.(m.snap); waiting.delete(m.id); }
    else if (m?.cmd === "drain") drain();
  });
  const clusterSnapshot = () => new Promise((res) => { const id = `${process.pid}-${++seq}`; waiting.set(id, res); process.send({ cmd: "metrics-req", id }); setTimeout(() => { if (waiting.delete(id)) res(reg.snapshot()); }, 1000); });

  const send = (res, code, body, type = "application/json; charset=utf-8") => { const s = typeof body === "string" ? body : JSON.stringify(body); const h = { "Content-Type": type, "Content-Length": Buffer.byteLength(s), "X-Eduline-Version": VERSION }; if (draining) h.Connection = "close"; res.writeHead(code, h); res.end(s); };
  const readBody = (req) => new Promise((ok, fail) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > 1e5) req.destroy(); }); req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { fail(e); } }); req.on("error", fail); });

  const server = http.createServer(async (req, res) => {
    const t0 = performance.now(); const url = new URL(req.url, "http://x"); const p = url.pathname; let route = "other", code = 500;
    try {
      let m;
      if (p === "/health") { route = "health"; code = 200; send(res, 200, { ok: true, version: VERSION, pid: process.pid }); }
      else if (p === "/ready") { route = "ready"; const ok = api.ready(); code = ok ? 200 : 503; send(res, code, { ok }); }
      else if (p === "/metrics") { route = "metrics"; code = 200; send(res, 200, toPrometheus(inCluster ? await clusterSnapshot() : reg.snapshot()), "text/plain; version=0.0.4"); }
      else if (p === "/metrics.json") { route = "metrics"; code = 200; send(res, 200, inCluster ? await clusterSnapshot() : reg.snapshot()); }
      else if (p === "/api/courses" && req.method === "GET") { route = "courses"; const s = Number(url.searchParams.get("student")); code = 200; send(res, 200, api.courses(s)); }
      else if ((m = p.match(/^\/api\/exams\/(\d+)$/)) && req.method === "GET") { route = "exam"; const e = api.exam(Number(m[1])); code = e ? 200 : 404; send(res, code, e ?? { error: "Sınav bulunamadı" }); }
      else if ((m = p.match(/^\/api\/exams\/(\d+)\/submit$/)) && req.method === "POST") {
        route = "submit"; const b = await readBody(req);
        if (!Number.isInteger(b.student) || !Array.isArray(b.answers) || b.answers.length > 100) { code = 400; send(res, 400, { error: "Geçersiz gövde" }); }
        else { const r = api.submit(Number(m[1]), b.student, b.answers); code = r.status; send(res, code, r.body ?? { error: "Sınav bulunamadı" }); }
      }
      else { code = 404; send(res, 404, { error: "Bulunamadı" }); }
    } catch (err) {
      code = 500; if (!res.headersSent) send(res, 500, { error: "Sunucu hatası" });
      logStream?.write(JSON.stringify({ t: new Date().toISOString(), level: "error", msg: err.message, stack: err.stack?.split("\n").slice(0, 4), path: p }) + "\n");
    } finally {
      const ms = performance.now() - t0; if (route !== "metrics") reg.observe(route, code, ms);
      logStream?.write(JSON.stringify({ t: new Date().toISOString(), v: VERSION, pid: process.pid, route, code, ms: +ms.toFixed(1) }) + "\n");
    }
  });
  server.keepAliveTimeout = 5000;
  server.listen(PORT, () => { if (!inCluster) console.log(`[${VERSION} ${process.pid}] http://localhost:${PORT} · ${DB}`); });

  // Boşaltma: önce her yanıta "Connection: close" eklenir (istemci soketi yeniden kullanmaz), 2 sn sonra yeni bağlantı
  // kabulü durdurulur; açık kalan istekler bitince süreç çıkar. Boşta soket kapatma yarışı (ECONNRESET) böylece önlenir.
  function drain() { if (draining) return; draining = true; setTimeout(() => { server.close(() => { db.close(); process.exit(0); }); }, 2000).unref(); setTimeout(() => server.closeAllConnections?.(), 8000).unref(); }
  if (!inCluster) process.on("SIGTERM", () => { db.close(); process.exit(0); }); // v1: anında çıkış (eski davranış: devam eden istekler düşer)
}
