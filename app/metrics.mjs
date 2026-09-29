// Prometheus uyumlu, bağımlılıksız metrikler: rota başına istek sayacı ve süre histogramı.
// Küme (cluster) modunda her işçinin anlık görüntüsü birleştirilir.
export const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]; // ms

import { monitorEventLoopDelay } from "node:perf_hooks";
export function createRegistry() {
  // Olay döngüsü gecikmesi: senkron işler (ör. indekssiz sorgular) kuyruğu kilitlediğinde sunucu içi süre ölçümleri
  // bunu göremez; bekleyen isteklerin yaşadığı gecikme burada görünür. Her anlık görüntüde sıfırlanır.
  const eld = monitorEventLoopDelay({ resolution: 10 }); eld.enable();
  const hist = new Map();   // route -> { counts: number[], sum, count }
  const status = new Map(); // `${route}|${code}` -> n
  const started = Date.now();
  return {
    observe(route, code, ms) {
      let h = hist.get(route); if (!h) hist.set(route, (h = { counts: new Array(BUCKETS.length + 1).fill(0), sum: 0, count: 0 }));
      let i = BUCKETS.findIndex((b) => ms <= b); if (i < 0) i = BUCKETS.length;
      h.counts[i]++; h.sum += ms; h.count++;
      const k = `${route}|${code}`; status.set(k, (status.get(k) ?? 0) + 1);
    },
    snapshot() { const loop = { p99: +(eld.percentile(99) / 1e6).toFixed(1), max: +(eld.max / 1e6).toFixed(1) }; eld.reset(); return { loop, hist: Object.fromEntries([...hist].map(([r, h]) => [r, { counts: [...h.counts], sum: h.sum, count: h.count }])), status: Object.fromEntries(status), startedAt: started }; },
  };
}

export function merge(snaps) {
  const out = { loop: { p99: Math.max(0, ...snaps.map((s) => s.loop?.p99 ?? 0)), max: Math.max(0, ...snaps.map((s) => s.loop?.max ?? 0)) }, hist: {}, status: {}, startedAt: Math.min(...snaps.map((s) => s.startedAt)) };
  for (const s of snaps) {
    for (const [r, h] of Object.entries(s.hist)) { const o = (out.hist[r] ??= { counts: new Array(BUCKETS.length + 1).fill(0), sum: 0, count: 0 }); h.counts.forEach((c, i) => (o.counts[i] += c)); o.sum += h.sum; o.count += h.count; }
    for (const [k, n] of Object.entries(s.status)) out.status[k] = (out.status[k] ?? 0) + n;
  }
  return out;
}

/** Histogramdan yüzdelik tahmini (kova içinde doğrusal ara değer). counts: kova başına (kümülatif değil). */
export function quantile(counts, q) {
  const total = counts.reduce((a, b) => a + b, 0); if (!total) return 0;
  const rank = q * total; let cum = 0;
  for (let i = 0; i < counts.length; i++) {
    const prev = cum; cum += counts[i];
    if (cum >= rank && counts[i] > 0) {
      const lo = i === 0 ? 0 : BUCKETS[i - 1], hi = i < BUCKETS.length ? BUCKETS[i] : BUCKETS.at(-1) * 2;
      return lo + ((rank - prev) / counts[i]) * (hi - lo);
    }
  }
  return BUCKETS.at(-1) * 2;
}
/** İki anlık görüntü arasındaki fark (pencere metrikleri için). */
export function diff(now, before) {
  const out = { hist: {}, status: {} };
  for (const [r, h] of Object.entries(now.hist)) { const b = before?.hist?.[r]; out.hist[r] = { counts: h.counts.map((c, i) => c - (b?.counts[i] ?? 0)), sum: h.sum - (b?.sum ?? 0), count: h.count - (b?.count ?? 0) }; }
  for (const [k, n] of Object.entries(now.status)) out.status[k] = n - (before?.status?.[k] ?? 0);
  return out;
}
export function summarize(snap) {
  const all = new Array(BUCKETS.length + 1).fill(0); let count = 0;
  for (const h of Object.values(snap.hist)) { h.counts.forEach((c, i) => (all[i] += c)); count += h.count; }
  const errors = Object.entries(snap.status).filter(([k]) => /\|5\d\d$/.test(k)).reduce((s, [, n]) => s + n, 0);
  return { count, errors, errorRate: count ? errors / count : 0, p50: quantile(all, 0.5), p95: quantile(all, 0.95), p99: quantile(all, 0.99) };
}
export function toPrometheus(snap) {
  const lines = ["# HELP eduline_http_request_duration_ms İstek süresi (ms)", "# TYPE eduline_http_request_duration_ms histogram"];
  for (const [r, h] of Object.entries(snap.hist)) {
    let cum = 0; BUCKETS.forEach((b, i) => { cum += h.counts[i]; lines.push(`eduline_http_request_duration_ms_bucket{route="${r}",le="${b}"} ${cum}`); });
    lines.push(`eduline_http_request_duration_ms_bucket{route="${r}",le="+Inf"} ${h.count}`, `eduline_http_request_duration_ms_sum{route="${r}"} ${h.sum.toFixed(1)}`, `eduline_http_request_duration_ms_count{route="${r}"} ${h.count}`);
  }
  lines.push("# HELP eduline_http_requests_total İstek sayısı", "# TYPE eduline_http_requests_total counter");
  for (const [k, n] of Object.entries(snap.status)) { const [r, c] = k.split("|"); lines.push(`eduline_http_requests_total{route="${r}",code="${c}"} ${n}`); }
  lines.push(`# TYPE eduline_event_loop_lag_p99_ms gauge`, `eduline_event_loop_lag_p99_ms ${snap.loop?.p99 ?? 0}`, `# TYPE eduline_process_uptime_seconds gauge`, `eduline_process_uptime_seconds ${((Date.now() - snap.startedAt) / 1000).toFixed(0)}`);
  return lines.join("\n") + "\n";
}
