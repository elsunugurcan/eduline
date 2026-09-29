// Kapasite planı: her sürümü artan eşzamanlılıkta ölçer; SLO'yu (p95 ≤ 500 ms, hata ≤ %1) sağlayan en yüksek
// verimi bulur ve sınav saati hedefiyle karşılaştırır.
// Hedef: 3.000 eşzamanlı öğrenci × öğrenci başına 10 sn'de 1 istek = 300 istek/sn.
//   node load/capacity.mjs [süre sn=8]
import fs from "node:fs";
import { run } from "./loadgen.mjs";
import { freshDb, sleep, startServer, stopServer, waitHealthy } from "../ops/lib.mjs";

const DUR = Number(process.argv[2] ?? 8); const LEVELS = [1, 5, 10, 25, 50, 100, 200];
const SLO = { p95: 500, errorRate: 0.01 }; const TARGET_RPS = 300;
const out = { slo: SLO, targetRps: TARGET_RPS, targetNote: "3.000 eşzamanlı öğrenci × 0,1 istek/sn", levels: LEVELS, durationSec: DUR, versions: {} };
for (const version of ["v1", "v2"]) {
  const port = version === "v1" ? 8321 : 8322; const db = freshDb(`cap-${version}`);
  const srv = startServer({ version, db, port, workers: version === "v2" ? 2 : undefined }); await waitHealthy(port);
  const rows = [];
  for (const vus of LEVELS) {
    const r = await run({ port, vus, durationSec: DUR, timeoutMs: 5000, seed: vus });
    const ok = r.p95 <= SLO.p95 && r.errorRate <= SLO.errorRate;
    rows.push({ vus, rps: r.rps, p50: r.p50, p95: r.p95, p99: r.p99, errorRate: r.errorRate, withinSlo: ok });
    console.log(`${version} ${String(vus).padStart(3)} VU → ${String(r.rps).padStart(7)} istek/sn · p95 ${String(r.p95).padStart(7)} ms · hata %${(r.errorRate * 100).toFixed(1)} ${ok ? "✓" : "✗"}`);
    await sleep(500);
  }
  await stopServer(srv);
  const best = rows.filter((r) => r.withinSlo).sort((a, b) => b.rps - a.rps)[0] ?? null;
  out.versions[version] = { rows, maxRpsWithinSlo: best?.rps ?? 0, atVus: best?.vus ?? 0, headroom: best ? +(best.rps / TARGET_RPS).toFixed(2) : 0 };
  console.log(`${version}: SLO içinde en yüksek ${best?.rps ?? 0} istek/sn → hedefin ${out.versions[version].headroom}×`);
}
fs.mkdirSync("reports", { recursive: true });
fs.writeFileSync("reports/capacity.json", JSON.stringify(out, null, 1));
console.log("→ reports/capacity.json");
process.exit(0);
