// Demo veri tabanı: 15.000 öğrenci, 120 ders, 4.800 ders oturumu, 300 sınav × 40 soru, 400.000 geçmiş sınav gönderimi.
// Şema "eski" hâlindedir (yalnızca birincil anahtarlar). v2 indeksleri app/v2.mjs başlarken ekler.
// Kullanım: node app/seed.mjs  →  data/base.db + data/v1.db + data/v2.db   (deterministik, birkaç saniye)
import fs from "node:fs";
import Database from "better-sqlite3";

fs.mkdirSync("data", { recursive: true });
const FILE = "data/base.db";
for (const f of [FILE, FILE + "-wal", FILE + "-shm"]) fs.rmSync(f, { force: true });
const db = new Database(FILE);
db.pragma("journal_mode = DELETE");

db.exec(`
CREATE TABLE students (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL);
CREATE TABLE courses (id INTEGER PRIMARY KEY, title TEXT NOT NULL, teacher TEXT NOT NULL);
CREATE TABLE enrollments (id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL, course_id INTEGER NOT NULL, progress INTEGER NOT NULL DEFAULT 0);
CREATE TABLE lessons (id INTEGER PRIMARY KEY, course_id INTEGER NOT NULL, title TEXT NOT NULL, starts_at TEXT NOT NULL, live INTEGER NOT NULL DEFAULT 0);
CREATE TABLE exams (id INTEGER PRIMARY KEY, course_id INTEGER NOT NULL, title TEXT NOT NULL, duration_min INTEGER NOT NULL);
CREATE TABLE questions (id INTEGER PRIMARY KEY, exam_id INTEGER NOT NULL, idx INTEGER NOT NULL, body TEXT NOT NULL, choices TEXT NOT NULL, answer INTEGER NOT NULL, points INTEGER NOT NULL);
CREATE TABLE submissions (id INTEGER PRIMARY KEY, exam_id INTEGER NOT NULL, student_id INTEGER NOT NULL, score INTEGER NOT NULL, answers TEXT NOT NULL, created_at TEXT NOT NULL);
`);

let x = 20260929; const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 0x100000000; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const FIRST = ["Ayşe", "Mehmet", "Elif", "Can", "Zeynep", "Emre", "Deniz", "Selin", "Burak", "Ece", "Mert", "İrem", "Kaan", "Defne", "Ali", "Nehir", "Efe", "Ada", "Arda", "Yağmur"];
const LAST = ["Yılmaz", "Kaya", "Demir", "Şahin", "Çelik", "Arslan", "Doğan", "Kılıç", "Aydın", "Öztürk", "Koç", "Kurt", "Özdemir", "Aksoy", "Polat"];
const SUBJ = ["Matematik", "Fizik", "Kimya", "Biyoloji", "Türk Dili", "Tarih", "Coğrafya", "İngilizce", "Geometri", "Felsefe", "Programlama", "Veri Bilimi"];
const LEVEL = ["9. Sınıf", "10. Sınıf", "11. Sınıf", "12. Sınıf", "TYT Hazırlık", "AYT Hazırlık", "YDS", "Temel", "İleri", "Yoğun Kamp"];

const t0 = Date.now();
const tx = db.transaction(() => {
  const st = db.prepare("INSERT INTO students (id, name, email) VALUES (?, ?, ?)");
  for (let i = 1; i <= 15000; i++) st.run(i, `${pick(FIRST)} ${pick(LAST)}`, `ogrenci${i}@eduline.example`);
  const co = db.prepare("INSERT INTO courses (id, title, teacher) VALUES (?, ?, ?)");
  for (let i = 1; i <= 120; i++) co.run(i, `${SUBJ[(i - 1) % SUBJ.length]} · ${LEVEL[Math.floor((i - 1) / SUBJ.length) % LEVEL.length]}`, `${pick(FIRST)} ${pick(LAST)}`);
  const en = db.prepare("INSERT INTO enrollments (student_id, course_id, progress) VALUES (?, ?, ?)");
  for (let s = 1; s <= 15000; s++) { const set = new Set(); while (set.size < 4) set.add(1 + Math.floor(rnd() * 120)); for (const c of set) en.run(s, c, Math.floor(rnd() * 101)); }
  const le = db.prepare("INSERT INTO lessons (course_id, title, starts_at, live) VALUES (?, ?, ?, ?)");
  const base = Date.parse("2026-09-01T09:00:00Z");
  for (let c = 1; c <= 120; c++) for (let k = 0; k < 40; k++) le.run(c, `Ders ${k + 1}`, new Date(base + (k * 2 + (c % 3)) * 86400000 + (c % 8) * 3600000).toISOString(), k % 5 === 0 ? 1 : 0);
  const ex = db.prepare("INSERT INTO exams (id, course_id, title, duration_min) VALUES (?, ?, ?, ?)");
  const qu = db.prepare("INSERT INTO questions (exam_id, idx, body, choices, answer, points) VALUES (?, ?, ?, ?, ?, ?)");
  for (let e = 1; e <= 300; e++) {
    ex.run(e, 1 + ((e - 1) % 120), `Deneme sınavı ${e}`, 40);
    for (let q = 1; q <= 40; q++) qu.run(e, q, `Soru ${q}`, JSON.stringify(["A", "B", "C", "D", "E"]), Math.floor(rnd() * 5), q % 10 === 0 ? 5 : 2);
  }
  const su = db.prepare("INSERT INTO submissions (exam_id, student_id, score, answers, created_at) VALUES (?, ?, ?, ?, ?)");
  const seen = new Set();
  for (let n = 0; n < 400000;) {
    const e = 1 + Math.floor(rnd() * 300), s = 1 + Math.floor(rnd() * 15000); const k = e * 100000 + s; if (seen.has(k)) continue; seen.add(k);
    const ans = Array.from({ length: 40 }, () => Math.floor(rnd() * 5));
    su.run(e, s, Math.floor(rnd() * 90) + 5, JSON.stringify(ans), new Date(base - Math.floor(rnd() * 200) * 86400000).toISOString()); n++;
  }
});
tx();
db.close();
// Çalıştırma kopyaları (eski WAL/SHM dosyaları silinir — kalırlarsa kopya bozuk görünür)
for (const v of ["v1", "v2"]) { for (const ext of ["", "-wal", "-shm"]) fs.rmSync(`data/${v}.db${ext}`, { force: true }); fs.copyFileSync(FILE, `data/${v}.db`); }
const kb = fs.statSync(FILE).size / 1024 / 1024;
console.log(`data/base.db (+ v1.db, v2.db kopyaları) hazır (${kb.toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(1)} sn)`);
