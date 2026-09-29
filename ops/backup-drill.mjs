// Yedekleme + geri yükleme tatbikatı (canlı yük altında):
//  1) v2 sunucusu yük altındayken `VACUUM INTO` ile tutarlı anlık yedek alınır (WAL sayesinde yazmalar durmaz).
//     Not: SQLite'ın sayfa sayfa backup API'si, kaynak başka bir bağlantıdan yazıldıkça baştan başlar; yoğun
//     yazma altında yük bitene kadar tamamlanamadığı ölçüldü (ilk tatbikat), bu yüzden VACUUM INTO seçildi.
//  2) Yedek bütünlük kontrolünden geçirilir, tablo satır sayıları doğrulanır, SHA-256 özeti kaydedilir.
//  3) "Felaket": yedekten yeni bir sunucu ayağa kaldırılır; ilk sağlıklı yanıta kadar geçen süre (RTO) ölçülür.
//  4) Geri yüklenen sunucuda örnek bir öğrenci yolculuğu ve bir sınav gönderimi doğrulanır.
//   node ops/backup-drill.mjs
import fs from "node:fs";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { run } from "../load/loadgen.mjs";
import { freshDb, sleep, startServer, stopServer, waitHealthy } from "./lib.mjs";

const TABLES = ["students", "courses", "enrollments", "lessons", "exams", "questions", "submissions"];
const db = freshDb("drill-live"); const port = 8331;
const live = startServer({ version: "v2", db, port, workers: 2 }); await waitHealthy(port);
const loadP = run({ port, vus: 20, durationSec: 12, timeoutMs: 5000, seed: 99 }); // yedek sırasında gerçek yazma trafiği
await sleep(3000);

const src = new Database(db, { readonly: true }); const before = src.prepare("SELECT COUNT(*) n FROM submissions").get().n;
fs.mkdirSync("data/backups", { recursive: true });
const file = `data/backups/eduline-${new Date().toISOString().replace(/[:.]/g, "-")}.db`;
src.close();
const t0 = performance.now(); const bk = new Database(db); bk.pragma("busy_timeout = 5000");
bk.prepare("VACUUM INTO ?").run(file); bk.close(); // tek okuma işlemi içinde tutarlı anlık görüntü
const backupMs = performance.now() - t0; const pages = null;
const load = await loadP;

const b = new Database(file, { readonly: true });
const integrity = b.pragma("integrity_check", { simple: true });
const counts = Object.fromEntries(TABLES.map((t) => [t, b.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
const free = (() => { for (let st = 15000; st > 0; st--) { if (!b.prepare("SELECT 1 FROM submissions WHERE exam_id = 5 AND student_id = ?").get(st)) return st; } })();
b.close();
const sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sizeMB = fs.statSync(file).size / 1024 / 1024;
await stopServer(live);
const liveDb = new Database(db, { readonly: true }); const after = liveDb.prepare("SELECT COUNT(*) n FROM submissions").get().n; liveDb.close();

// Geri yükleme: yedeği yeni konuma kopyala, sunucuyu başlat, ilk sağlıklı yanıta kadar ölç
const restored = "data/drill-restored.db"; for (const f of [restored, restored + "-wal", restored + "-shm"]) fs.rmSync(f, { force: true });
const r0 = performance.now(); fs.copyFileSync(file, restored);
const rs = startServer({ version: "v2", db: restored, port: port + 1, workers: 2 }); await waitHealthy(port + 1);
const ready = await (await fetch(`http://127.0.0.1:${port + 1}/ready`)).json(); const rtoMs = performance.now() - r0;
const courses = await (await fetch(`http://127.0.0.1:${port + 1}/api/courses?student=42`)).json();
const submit = await fetch(`http://127.0.0.1:${port + 1}/api/exams/5/submit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ student: free, answers: Array(40).fill(0) }) });
const submitBody = await submit.json(); await stopServer(rs);

const result = {
  at: new Date().toISOString(), backup: { file: file.replace("data/", ""), sizeMB: +sizeMB.toFixed(1), method: "VACUUM INTO", ms: Math.round(backupMs), sha256, integrity, counts, submissionsBefore: before, submissionsAfterLive: after, consistent: counts.submissions >= before && counts.submissions <= after },
  loadDuringBackup: { rps: load.rps, p95: load.p95, errors: load.errorCount, requests: load.requests },
  restore: { rtoMs: Math.round(rtoMs), ready: ready.ok, sampleCourses: courses.length, sampleSubmitStatus: submit.status, sampleSubmit: submitBody },
};
result.passed = integrity === "ok" && result.backup.consistent && ready.ok && courses.length === 4 && submit.status === 201 && load.errorCount === 0;
fs.mkdirSync("reports", { recursive: true }); fs.writeFileSync("reports/backup-drill.json", JSON.stringify(result, null, 1));
console.log(`yedek: ${result.backup.sizeMB} MB, ${result.backup.ms} ms, bütünlük=${integrity}, gönderim sayısı ${before} ≤ ${counts.submissions} ≤ ${after}`);
console.log(`yedek sırasında yük: ${load.rps} istek/sn, p95 ${load.p95} ms, hata ${load.errorCount}`);
console.log(`geri yükleme (RTO): ${result.restore.rtoMs} ms · hazır=${ready.ok} · örnek gönderim HTTP ${submit.status}`);
console.log(result.passed ? "TATBİKAT BAŞARILI ✔" : "TATBİKAT BAŞARISIZ ✗");
fs.rmSync("data/backups", { recursive: true, force: true }); // demo: yedek dosyası depoda tutulmaz
process.exit(result.passed ? 0 : 1);
