// v1 ile v2 aynı veri üzerinde birebir aynı sonuçları üretmeli (performans düzeltmesi davranış değiştirmez).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { openV1 } from "../app/v1.mjs";
import { migrateV2, openV2 } from "../app/v2.mjs";

const ok = fs.existsSync("data/base.db");
test("v1 ≡ v2: ders listesi, sınav, notlandırma, sıralama, mükerrer gönderim", { skip: !ok && "önce npm run seed" }, () => {
  fs.copyFileSync("data/base.db", "data/test-v1.db"); fs.copyFileSync("data/base.db", "data/test-v2.db");
  const d1 = new Database("data/test-v1.db"), d2 = new Database("data/test-v2.db"); migrateV2(d2);
  const a = openV1(d1), b = openV2(d2);
  for (const st of [1, 42, 777, 15000]) assert.deepEqual(b.courses(st), a.courses(st));
  for (const ex of [1, 150, 300]) assert.deepEqual(b.exam(ex), a.exam(ex));
  assert.equal(b.exam(999), null); assert.equal(a.exam(999), null);
  let x = 5; const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 60; i++) {
    const ex = 1 + Math.floor(rnd() * 300), st = 1 + Math.floor(rnd() * 15000), ans = Array.from({ length: 40 }, () => Math.floor(rnd() * 5));
    const r1 = a.submit(ex, st, ans), r2 = b.submit(ex, st, ans);
    assert.deepEqual(r2, r1, `sınav ${ex}, öğrenci ${st}`);
    if (r1.status === 201) { assert.equal(a.submit(ex, st, ans).status, 409); assert.equal(b.submit(ex, st, ans).status, 409); }
  }
  assert.equal(b.submit(999, 1, []).status, 404);
  d1.close(); d2.close(); for (const f of ["data/test-v1.db", "data/test-v2.db"]) for (const s of ["", "-wal", "-shm"]) fs.rmSync(f + s, { force: true });
});
