// Operasyon betikleri için ortak yardımcılar: sunucu başlatma/durdurma, sağlık bekleme, taze veri tabanı kopyası.
import { spawn } from "node:child_process";
import fs from "node:fs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function freshDb(name) {
  if (!fs.existsSync("data/base.db")) throw new Error("data/base.db yok — önce: npm run seed");
  const file = `data/${name}.db`; for (const f of [file, file + "-wal", file + "-shm"]) fs.rmSync(f, { force: true });
  fs.copyFileSync("data/base.db", file); return file;
}
export async function waitHealthy(port, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return true; } catch {} await sleep(150); }
  throw new Error(`:${port} sağlıklı hâle gelmedi`);
}
export function startServer({ version, db, port, workers, log }) {
  const args = ["app/server.mjs", "--version", version, "--db", db, "--port", String(port)];
  if (workers) args.push("--workers", String(workers)); if (log) args.push("--log", log);
  const p = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(d)); p.stderr.on("data", (d) => process.stderr.write(d));
  return p;
}
export const stopServer = (p) => new Promise((r) => { if (!p || p.exitCode != null) return r(); p.once("exit", r); p.kill("SIGTERM"); setTimeout(() => p.kill("SIGKILL"), 12_000).unref(); });
