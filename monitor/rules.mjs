// Uyarı kuralları ve durum makinesi (saf fonksiyonlar; test/rules.test.mjs).
// Her kural: değer(örnek) → sayı | null; eşik aşılı kalma süresi `forSec` dolunca "firing", eşik altına inince "resolved".
export const RULES = [
  { id: "api-down", title: "API erişilemiyor", severity: "kritik", component: "api", value: (s) => (s.health.ok ? 0 : 1), threshold: 1, op: ">=", forSec: 4, unit: "" },
  { id: "db-not-ready", title: "Veritabanı hazır değil", severity: "kritik", component: "db", value: (s) => (s.ready.ok ? 0 : 1), threshold: 1, op: ">=", forSec: 4, unit: "" },
  { id: "latency-p95", title: "Yanıt süresi yüksek (p95)", severity: "uyarı", component: "exam", value: (s) => s.window?.p95 ?? null, threshold: 1000, op: ">", forSec: 6, unit: "ms" },
  { id: "latency-p95-critical", title: "Yanıt süresi çok yüksek (p95)", severity: "kritik", component: "exam", value: (s) => s.window?.p95 ?? null, threshold: 3000, op: ">", forSec: 6, unit: "ms" },
  { id: "event-loop-lag", title: "İstekler kuyrukta bekliyor (olay döngüsü gecikmesi)", severity: "kritik", component: "exam", value: (s) => s.window?.loopLag ?? null, threshold: 500, op: ">", forSec: 4, unit: "ms" },
  { id: "error-rate", title: "Hata oranı yüksek", severity: "kritik", component: "api", value: (s) => (s.window ? s.window.errorRate * 100 : null), threshold: 2, op: ">", forSec: 6, unit: "%" },
  { id: "synthetic-slow", title: "Sentetik öğrenci yolculuğu yavaş", severity: "uyarı", component: "live", value: (s) => s.synthetic?.ms ?? null, threshold: 2000, op: ">", forSec: 6, unit: "ms" },
];
const breach = (r, v) => v != null && (r.op === ">" ? v > r.threshold : v >= r.threshold);

/** state: { [ruleId]: { status: "ok"|"pending"|"firing", since, peak, incidentId } } → yeni durum + olaylar */
export function evaluate(state, sample, rules = RULES) {
  const next = { ...state }; const events = [];
  for (const r of rules) {
    const v = r.value(sample); const cur = next[r.id] ?? { status: "ok" };
    if (breach(r, v)) {
      if (cur.status === "ok") next[r.id] = { status: "pending", since: sample.t, peak: v };
      else if (cur.status === "pending") { const peak = Math.max(cur.peak, v); if ((sample.t - cur.since) / 1000 >= r.forSec) { const incidentId = `${r.id}-${sample.t}`; next[r.id] = { status: "firing", since: cur.since, peak, incidentId }; events.push({ type: "firing", rule: r, value: v, at: sample.t, startedAt: cur.since, incidentId }); } else next[r.id] = { ...cur, peak }; }
      else next[r.id] = { ...cur, peak: Math.max(cur.peak, v) };
    } else if (cur.status === "firing") { events.push({ type: "resolved", rule: r, value: v, at: sample.t, startedAt: cur.since, peak: cur.peak, incidentId: cur.incidentId }); next[r.id] = { status: "ok" }; }
    else if (cur.status === "pending") next[r.id] = { status: "ok" };
  }
  return { state: next, events };
}
/** Bileşen durumu: kritik uyarı → "kesinti", uyarı → "yavaşlama", yoksa "çalışıyor". */
export function componentStatus(state, rules = RULES) {
  const comps = { api: "çalışıyor", exam: "çalışıyor", live: "çalışıyor", db: "çalışıyor" };
  for (const r of rules) if (state[r.id]?.status === "firing") { const c = r.component; comps[c] = r.severity === "kritik" ? "kesinti" : comps[c] === "kesinti" ? "kesinti" : "yavaşlama"; }
  return comps;
}
/** Erişilebilirlik: sağlık yoklamalarının başarılı oranı. */
export const availability = (probes) => (probes.length ? probes.filter((p) => p.ok).length / probes.length : 1);
export function formatAlert(ev) {
  const val = typeof ev.value === "number" ? `${Math.round(ev.value * 10) / 10}${ev.rule.unit}` : "";
  return ev.type === "firing" ? `🔴 [${ev.rule.severity.toLocaleUpperCase("tr-TR")}] ${ev.rule.title}: ${val} (eşik ${ev.rule.threshold}${ev.rule.unit}, ${ev.rule.forSec} sn)` : `✅ Çözüldü: ${ev.rule.title} — süre ${Math.round((ev.at - ev.startedAt) / 1000)} sn, en kötü ${Math.round(ev.peak * 10) / 10}${ev.rule.unit}`;
}
