// v2 — bakım sonrası hâl. Aynı API, aynı sonuçlar (test/esdegerlik.test.mjs doğrular).
//  1) İndeksler: enrollments(student_id), lessons(course_id, starts_at), questions(exam_id, idx),
//     submissions(exam_id, student_id) UNIQUE, submissions(exam_id, score).
//  2) Sorgular bir kez hazırlanır; kurs ve sınav/cevap anahtarı bellekte önbelleklenir (TTL).
//  3) Notlandırma cevap anahtarıyla bellekte; mükerrer kontrolü UNIQUE kısıtıyla (tek yazma).
//  4) WAL + synchronous=NORMAL + busy_timeout: okuyucular yazıcıyı beklemez, çok süreç güvenli.
//  5) Süreç kümesi (server.mjs): çekirdek başına işçi, kesintisiz yeniden başlatma.
export function migrateV2(db) {
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_enrollments_student ON enrollments(student_id);
    CREATE INDEX IF NOT EXISTS idx_lessons_course_start ON lessons(course_id, starts_at);
    CREATE INDEX IF NOT EXISTS idx_questions_exam_idx ON questions(exam_id, idx);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_submissions_exam_student ON submissions(exam_id, student_id);
    CREATE INDEX IF NOT EXISTS idx_submissions_exam_score ON submissions(exam_id, score);
    ANALYZE;
  `);
}
export function openV2(db, { cacheTtlMs = 60_000 } = {}) {
  db.pragma("journal_mode = WAL"); db.pragma("synchronous = NORMAL"); db.pragma("busy_timeout = 5000"); db.pragma("cache_size = -32000");
  const q = {
    ping: db.prepare("SELECT 1 AS ok"),
    enroll: db.prepare("SELECT course_id, progress FROM enrollments WHERE student_id = ?"),
    course: db.prepare("SELECT id, title, teacher FROM courses WHERE id = ?"),
    next: db.prepare("SELECT title, starts_at, live FROM lessons WHERE course_id = ? AND starts_at >= ? ORDER BY starts_at LIMIT 1"),
    exam: db.prepare("SELECT id, course_id, title, duration_min FROM exams WHERE id = ?"),
    questions: db.prepare("SELECT idx, body, choices, points, answer FROM questions WHERE exam_id = ? ORDER BY idx"),
    insert: db.prepare("INSERT INTO submissions (exam_id, student_id, score, answers, created_at) VALUES (?, ?, ?, ?, ?)"),
    rank: db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE exam_id = ? AND score > ?"),
    total: db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE exam_id = ?"),
  };
  const cache = new Map();
  const cached = (key, load) => { const hit = cache.get(key); if (hit && hit.exp > Date.now()) return hit.v; const v = load(); cache.set(key, { v, exp: Date.now() + cacheTtlMs }); return v; };
  const courseInfo = (id) => cached(`c${id}`, () => ({ ...q.course.get(id), next: q.next.get(id, "2026-09-29") ?? null }));
  const examInfo = (id) => cached(`e${id}`, () => {
    const e = q.exam.get(id); if (!e) return null;
    const rows = q.questions.all(id);
    return { public: { ...e, questions: rows.map(({ answer, ...r }) => ({ ...r, choices: JSON.parse(r.choices) })) }, key: rows.map((r) => [r.answer, r.points]) };
  });
  const submitTx = db.transaction((examId, studentId, score, answers) => {
    q.insert.run(examId, studentId, score, JSON.stringify(answers), new Date().toISOString());
    return { rank: q.rank.get(examId, score).n + 1, total: q.total.get(examId).n };
  });
  return {
    version: "v2",
    ready: () => q.ping.get().ok === 1,
    courses: (studentId) => q.enroll.all(studentId).map((r) => { const c = courseInfo(r.course_id); return { id: c.id, title: c.title, teacher: c.teacher, progress: r.progress, next: c.next }; }),
    exam: (examId) => examInfo(examId)?.public ?? null,
    submit(examId, studentId, answers) {
      const e = examInfo(examId); if (!e) return { status: 404 };
      let score = 0; answers.forEach((a, i) => { const k = e.key[i]; if (k && k[0] === a) score += k[1]; });
      try { const { rank, total } = submitTx(examId, studentId, score, answers); return { status: 201, body: { score, rank, total } }; }
      catch (err) { if (String(err.code).startsWith("SQLITE_CONSTRAINT")) return { status: 409, body: { error: "Bu sınav zaten gönderilmiş" } }; throw err; }
    },
  };
}
