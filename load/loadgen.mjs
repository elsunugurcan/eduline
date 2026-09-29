// Kapalı döngü yük üreteci: her sanal öğrenci (VU) bir istek bitince hemen sonrakini gönderir.
// Senaryo karışımı sınav anını taklit eder: %60 cevap gönderme, %25 sınav açma, %15 ders listesi.
// İstemci zaman aşımı (varsayılan 5 sn) gerçek kullanıcının vazgeçmesi gibi hata sayılır.
import http from "node:http";

const MIX = [["submit", 0.6], ["exam", 0.25], ["courses", 0.15]];
export function percentile(sorted, q) { if (!sorted.length) return 0; return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]; }

export async function run({ port, vus = 20, durationSec = 10, rampSec = 0, timeoutMs = 5000, seed = 1, onSecond, until } = {}) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: vus + 8 });
  let x = seed >>> 0 || 1; const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 0x100000000; };
  const req = (method, path, body) => new Promise((resolve) => {
    const t = performance.now(); const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: "127.0.0.1", port, method, path, agent, timeout: timeoutMs, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} }, (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode, ms: performance.now() - t })); });
    r.on("timeout", () => { r.destroy(new Error("timeout")); });
    r.on("error", (e) => resolve({ status: 0, err: e.message === "timeout" ? "timeout" : e.code ?? e.message, ms: performance.now() - t }));
    if (data) r.write(data); r.end();
  });
  const pickOp = () => { let r = rnd(); for (const [op, w] of MIX) { if ((r -= w) <= 0) return op; } return "submit"; };
  const start = performance.now(); const endAt = start + durationSec * 1000;
  const all = []; const perSec = []; const errors = {}; let conflicts = 0;
  const bucket = (t) => { const s = Math.floor((t - start) / 1000); return (perSec[s] ??= { t: s, n: 0, lat: [], err: 0, vus: 0 }); };
  let activeVus = 0;
  const vu = async (i) => {
    const delay = rampSec ? (i / vus) * rampSec * 1000 : 0; if (delay) await new Promise((r) => setTimeout(r, delay));
    activeVus++;
    while (performance.now() < endAt && !(until?.())) {
      const op = pickOp(); const student = 1 + Math.floor(rnd() * 15000), exam = 1 + Math.floor(rnd() * 300);
      const r = op === "submit" ? await req("POST", `/api/exams/${exam}/submit`, { student, answers: Array.from({ length: 40 }, () => Math.floor(rnd() * 5)) })
        : op === "exam" ? await req("GET", `/api/exams/${exam}`) : await req("GET", `/api/courses?student=${student}`);
      const b = bucket(performance.now()); b.vus = activeVus;
      const failed = r.status === 0 || r.status >= 500;
      if (r.status === 409) conflicts++;
      if (failed) { const k = r.err ?? `HTTP ${r.status}`; errors[k] = (errors[k] ?? 0) + 1; b.err++; if (r.err && r.err !== "timeout") await new Promise((z) => setTimeout(z, 50)); }
      else { all.push(r.ms); b.lat.push(r.ms); }
      b.n++;
    }
    activeVus--;
  };
  const ticker = onSecond ? setInterval(() => { const s = Math.floor((performance.now() - start) / 1000) - 1; const b = perSec[s]; if (b) onSecond(summarizeSecond(b)); }, 1000) : null;
  await Promise.all(Array.from({ length: vus }, (_, i) => vu(i)));
  if (ticker) clearInterval(ticker);
  agent.destroy();
  const elapsed = (performance.now() - start) / 1000; all.sort((a, b) => a - b);
  const total = all.length + Object.values(errors).reduce((a, b) => a + b, 0);
  return { vus, durationSec: +elapsed.toFixed(1), requests: total, ok: all.length, rps: +(all.length / elapsed).toFixed(1), p50: +percentile(all, 0.5).toFixed(1), p95: +percentile(all, 0.95).toFixed(1), p99: +percentile(all, 0.99).toFixed(1), errors, errorCount: total - all.length, errorRate: total ? +((total - all.length) / total).toFixed(4) : 0, conflicts, timeline: perSec.filter(Boolean).map(summarizeSecond) };
}
function summarizeSecond(b) { const s = [...b.lat].sort((a, c) => a - c); return { t: b.t, rps: b.lat.length, p95: +percentile(s, 0.95).toFixed(1), errors: b.err, vus: b.vus }; }
