// Sınav saati senaryosu: sunucu + izleme ajanı ayağa kalkar, sanal öğrenciler 15 sn'de tepe yüke çıkar,
// 35. saniyede sürüm dağıtımı (yeniden başlatma) yapılır. Uyarılar, olaylar, zaman çizelgesi kaydedilir.
//   node ops/exam-peak.mjs v1   (eski: tek süreç, dağıtım = süreci durdur/başlat)
//   node ops/exam-peak.mjs v2   (yeni: küme, dağıtım = SIGHUP ile kesintisiz yenileme)
import fs from "node:fs";
import { run } from "../load/loadgen.mjs";
import { createMonitor } from "../monitor/monitor.mjs";
import { renderStatusPage } from "../monitor/status-page.mjs";
import { freshDb, sleep, startServer, stopServer, waitHealthy } from "./lib.mjs";

const version = process.argv[2] ?? "v2"; const VUS = Number(process.argv[3] ?? 60), DURATION = 60, RAMP = 15, DEPLOY_AT = 35;
const port = version === "v1" ? 8311 : 8312; const db = freshDb(`peak-${version}`);
fs.rmSync(`data/monitor-${version}`, { recursive: true, force: true });
let server = startServer({ version, db, port, workers: version === "v2" ? 2 : undefined, log: `data/peak-${version}.log` });
await waitHealthy(port);
const monitor = createMonitor({ target: `http://127.0.0.1:${port}`, intervalMs: 1000, dataDir: `data/monitor-${version}`, name: "Eduline", log: (m) => console.log(`  ${m}`) }).start();
await sleep(3000); // izleme temel çizgisi

console.log(`${version}: ${VUS} sanal öğrenci, ${DURATION} sn (${RAMP} sn tırmanma), ${DEPLOY_AT}. sn'de dağıtım`);
const t0 = Date.now(); let deploy = null; let peakStatusHtml = null;
const deployTimer = setTimeout(async () => {
  const at = Date.now(); console.log(`  [dağıtım] ${version === "v1" ? "süreç durduruluyor ve yeniden başlatılıyor" : "SIGHUP → kesintisiz yenileme"}`);
  if (version === "v1") { await stopServer(server); server = startServer({ version, db, port, log: `data/peak-${version}.log` }); await waitHealthy(port); }
  else { server.kill("SIGHUP"); const start = Date.now(); while (Date.now() - start < 20_000) { await sleep(200); try { const d = JSON.parse(fs.readFileSync(`data/${version}-deploy.json`, "utf8")); if (Date.parse(d.at) >= at) break; } catch {} } }
  deploy = { atSec: +((at - t0) / 1000).toFixed(1), durationMs: Date.now() - at }; console.log(`  [dağıtım] bitti (${deploy.durationMs} ms)`);
}, DEPLOY_AT * 1000);
const snapTimer = setTimeout(() => { peakStatusHtml = renderStatusPage(monitor.status()); }, (DEPLOY_AT - 3) * 1000);
const load = await run({ port, vus: VUS, durationSec: DURATION, rampSec: RAMP, timeoutMs: 5000, seed: version === "v1" ? 11 : 11 });
clearTimeout(deployTimer); clearTimeout(snapTimer);
console.log(`  yük bitti: ${load.rps} istek/sn, p95 ${load.p95} ms, hata ${load.errorCount} (${(load.errorRate * 100).toFixed(2)}%)`);
// Toparlanma: yük bittikten sonra tüm uyarılar çözülene kadar bekle (en fazla 60 sn). Eski sürümde, kullanıcıların
// vazgeçtiği istekler kuyrukta işlenmeye devam ettiği için sistem yük bitse de bir süre yanıt veremez.
const loadEnd = Date.now(); let recoverySec = null;
await sleep(3000);
while (Date.now() - loadEnd < 60_000) { const st = monitor.status(); if (!st.firing.length && st.series.at(-1)?.up) { recoverySec = +((Date.now() - loadEnd) / 1000).toFixed(1); break; } await sleep(1000); }
await sleep(3000);
const status = monitor.status(); monitor.stop(); await stopServer(server);

// Dağıtım penceresindeki hatalar (dağıtım anı → bitişi + 2 sn)
const win = deploy ? load.timeline.filter((s) => s.t >= Math.floor(deploy.atSec) && s.t <= Math.ceil(deploy.atSec + deploy.durationMs / 1000) + 2) : [];
const result = { version, recoverySec, vus: VUS, durationSec: DURATION, rampSec: RAMP, deploy: deploy && { ...deploy, errorsDuring: win.reduce((s, x) => s + x.errors, 0), requestsDuring: win.reduce((s, x) => s + x.rps + x.errors, 0) }, load, incidents: status.incidents, alerts: status.alerts, availability: status.availability, series: status.series };
fs.mkdirSync("reports", { recursive: true });
fs.writeFileSync(`reports/exam-peak-${version}.json`, JSON.stringify(result, null, 1));
fs.writeFileSync(`reports/status-${version}-final.html`, renderStatusPage(status));
if (peakStatusHtml) fs.writeFileSync(`reports/status-${version}-peak.html`, peakStatusHtml);
console.log(`  olaylar: ${status.incidents.map((i) => i.title).join(", ") || "yok"} · dağıtım sırasında hata: ${result.deploy?.errorsDuring ?? "—"}`);
console.log(`  → reports/exam-peak-${version}.json`);
process.exit(0);
