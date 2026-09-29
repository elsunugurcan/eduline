import { test } from "node:test";
import assert from "node:assert/strict";
import { BUCKETS, createRegistry, diff, merge, quantile, summarize, toPrometheus } from "../app/metrics.mjs";

test("kova yüzdeliği doğrusal ara değerle", () => {
  const c = new Array(BUCKETS.length + 1).fill(0); c[0] = 50; c[4] = 50; // 50× ≤5 ms, 50× 50–100 ms
  assert.equal(quantile(c, 0.5), 5); assert.equal(quantile(c, 0.95), 95); assert.equal(quantile(new Array(12).fill(0), 0.95), 0);
});
test("kayıt, fark, birleştirme ve özet", () => {
  const a = createRegistry(), b = createRegistry();
  a.observe("submit", 201, 3); a.observe("submit", 500, 40); b.observe("exam", 200, 700);
  const m = merge([a.snapshot(), b.snapshot()]); const sum = summarize(m);
  assert.equal(sum.count, 3); assert.equal(sum.errors, 1); assert.ok(Math.abs(sum.errorRate - 1 / 3) < 1e-9);
  const before = a.snapshot(); a.observe("submit", 201, 8); const d = summarize(diff(a.snapshot(), before)); assert.equal(d.count, 1); assert.equal(d.errors, 0);
});
test("Prometheus metin biçimi kümülatif kovalar", () => {
  const r = createRegistry(); r.observe("exam", 200, 7); r.observe("exam", 200, 30);
  const txt = toPrometheus(r.snapshot());
  assert.match(txt, /eduline_http_request_duration_ms_bucket\{route="exam",le="10"\} 1/);
  assert.match(txt, /eduline_http_request_duration_ms_bucket\{route="exam",le="50"\} 2/);
  assert.match(txt, /eduline_http_requests_total\{route="exam",code="200"\} 2/);
  assert.match(txt, /eduline_event_loop_lag_p99_ms/);
});
