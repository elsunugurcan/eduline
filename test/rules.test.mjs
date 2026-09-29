import { test } from "node:test";
import assert from "node:assert/strict";
import { RULES, evaluate, componentStatus, availability, formatAlert } from "../monitor/rules.mjs";

const s = (t, over = {}) => ({ t: t * 1000, health: { ok: true }, ready: { ok: true }, synthetic: { ok: true, ms: 100 }, window: { p95: 50, errorRate: 0, loopLag: 10 }, ...over });

test("eşik 'forSec' dolmadan uyarı üretilmez, dolunca bir kez 'firing'", () => {
  let st = {}; const evs = [];
  for (let t = 0; t <= 8; t += 2) { const r = evaluate(st, s(t, { window: { p95: 1500, errorRate: 0, loopLag: 10 } })); st = r.state; evs.push(...r.events); }
  const fired = evs.filter((e) => e.rule.id === "latency-p95" && e.type === "firing");
  assert.equal(fired.length, 1); assert.equal(fired[0].at, 6000); assert.equal(st["latency-p95"].status, "firing");
  assert.equal(evs.some((e) => e.rule.id === "latency-p95-critical"), false);
});
test("kısa sıçrama (flapping) uyarı üretmez", () => {
  let st = {}; const evs = [];
  [1500, 50, 1500, 50, 1500].forEach((v, i) => { const r = evaluate(st, s(i * 2, { window: { p95: v, errorRate: 0, loopLag: 1 } })); st = r.state; evs.push(...r.events); });
  assert.equal(evs.length, 0);
});
test("çözülünce süre ve en kötü değer raporlanır", () => {
  let st = {}; const evs = [];
  for (const [t, ok] of [[0, false], [2, false], [4, false], [6, true]]) { const r = evaluate(st, s(t, { health: { ok } })); st = r.state; evs.push(...r.events); }
  const res = evs.find((e) => e.type === "resolved" && e.rule.id === "api-down");
  assert.ok(res); assert.equal(res.at - res.startedAt, 6000);
  assert.match(formatAlert(res), /Çözüldü: API erişilemiyor — süre 6 sn/);
});
test("bileşen durumu: kritik → kesinti, uyarı → yavaşlama", () => {
  assert.deepEqual(componentStatus({ "api-down": { status: "firing" }, "synthetic-slow": { status: "firing" } }), { api: "kesinti", exam: "çalışıyor", live: "yavaşlama", db: "çalışıyor" });
  assert.deepEqual(componentStatus({}), { api: "çalışıyor", exam: "çalışıyor", live: "çalışıyor", db: "çalışıyor" });
});
test("olay döngüsü gecikmesi kuralı, sunucu içi p95 normal görünse de yakalar", () => {
  let st = {}; const evs = [];
  for (let t = 0; t <= 6; t += 2) { const r = evaluate(st, s(t, { window: { p95: 120, errorRate: 0, loopLag: 1100 } })); st = r.state; evs.push(...r.events); }
  assert.deepEqual(evs.map((e) => e.rule.id), ["event-loop-lag"]);
});
test("veri yoksa (null) kural tetiklenmez; erişilebilirlik hesabı", () => {
  const r = evaluate({}, s(0, { window: null })); assert.equal(r.events.length, 0);
  assert.equal(availability([{ ok: true }, { ok: false }, { ok: true }, { ok: true }]), 0.75);
  assert.ok(RULES.every((x) => x.forSec >= 4), "her kural en az 4 sn beklemeli (gürültü önleme)");
});
