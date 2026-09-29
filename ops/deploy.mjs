// Kesintisiz dağıtım: çalışan v2 ana sürecine SIGHUP gönderir, işçiler tek tek yenilenir; bitişi bekler.
//   node ops/deploy.mjs [data/v2.pid]
import fs from "node:fs";
const pidFile = process.argv[2] ?? "data/v2.pid";
const pid = Number(fs.readFileSync(pidFile, "utf8")); const t0 = Date.now();
process.kill(pid, "SIGHUP"); console.log(`SIGHUP → ${pid}, işçiler yenileniyor…`);
for (;;) {
  await new Promise((r) => setTimeout(r, 250));
  try { const d = JSON.parse(fs.readFileSync("data/v2-deploy.json", "utf8")); if (Date.parse(d.at) >= t0 - 50) { console.log(`✓ tamamlandı: ${d.ms} ms, nesil ${d.generation}`); break; } } catch {}
  if (Date.now() - t0 > 60_000) { console.error("✗ 60 sn içinde tamamlanmadı"); process.exit(1); }
}
