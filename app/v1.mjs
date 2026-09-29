// v1 — platformun devralındığı hâli (bilinçli olarak korunmuştur; sorunlar yorumlarda).
// Sınav saatinde yavaşlamanın kök nedenleri:
//  1) submissions tablosunda indeks yok → mükerrer kontrolü ve sıralama (rank) her gönderimde 400 bin satırı tarar.
//  2) Notlandırma soru başına ayrı sorgu (N+1) ve soru tablosu da indekssiz tarama.
//  3) Sorgular her istekte yeniden hazırlanıyor (prepare), önbellek yok.
//  4) Tek süreç, senkron SQLite çağrıları olay döngüsünü kilitliyor → kuyruğa giren her istek bekliyor.
//  5) journal_mode=DELETE: her yazma disk senkronu.
export function openV1(db) {
  db.pragma("journal_mode = DELETE");
  return {
    version: "v1",
    ready: () => db.prepare("SELECT 1 AS ok").get().ok === 1,
    courses(studentId) {
      const rows = db.prepare("SELECT course_id, progress FROM enrollments WHERE student_id = ?").all(studentId); // tam tarama (60 bin satır)
      return rows.map((r) => {
        const c = db.prepare("SELECT id, title, teacher FROM courses WHERE id = ?").get(r.course_id);
        const next = db.prepare("SELECT title, starts_at, live FROM lessons WHERE course_id = ? AND starts_at >= ? ORDER BY starts_at LIMIT 1").get(r.course_id, "2026-09-29"); // N+1 + tarama
        return { ...c, progress: r.progress, next: next ?? null };
      });
    },
    exam(examId) {
      const e = db.prepare("SELECT id, course_id, title, duration_min FROM exams WHERE id = ?").get(examId); if (!e) return null;
      const qs = db.prepare("SELECT idx, body, choices, points FROM questions WHERE exam_id = ? ORDER BY idx").all(examId); // tarama + sıralama
      return { ...e, questions: qs.map((q) => ({ ...q, choices: JSON.parse(q.choices) })) };
    },
    submit(examId, studentId, answers) {
      const e = db.prepare("SELECT id FROM exams WHERE id = ?").get(examId); if (!e) return { status: 404 };
      const dup = db.prepare("SELECT id FROM submissions WHERE exam_id = ? AND student_id = ?").get(examId, studentId); // tam tarama
      if (dup) return { status: 409, body: { error: "Bu sınav zaten gönderilmiş" } };
      let score = 0;
      answers.forEach((a, i) => { const q = db.prepare("SELECT answer, points FROM questions WHERE exam_id = ? AND idx = ?").get(examId, i + 1); if (q && q.answer === a) score += q.points; }); // N+1 × tarama
      db.prepare("INSERT INTO submissions (exam_id, student_id, score, answers, created_at) VALUES (?, ?, ?, ?, ?)").run(examId, studentId, score, JSON.stringify(answers), new Date().toISOString());
      const rank = db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE exam_id = ? AND score > ?").get(examId, score).n + 1; // tam tarama
      const total = db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE exam_id = ?").get(examId).n; // tam tarama
      return { status: 201, body: { score, rank, total } };
    },
  };
}
