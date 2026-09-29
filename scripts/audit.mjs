// Bağımlılık güvenlik denetimi (npm audit) — özet reports/audit.json'a yazılır, rapora girer.
import { execSync } from "node:child_process";
import fs from "node:fs";
let raw; try { raw = execSync("npm audit --json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch (e) { raw = e.stdout; } // açık varsa npm çıkış kodu 1 döner
const m = JSON.parse(raw).metadata.vulnerabilities;
fs.mkdirSync("reports", { recursive: true }); fs.writeFileSync("reports/audit.json", JSON.stringify({ at: new Date().toISOString(), ...m }, null, 1) + "\n");
console.log(m.total ? `✗ ${m.total} açık (kritik ${m.critical}, yüksek ${m.high})` : "✓ bilinen açık yok");
process.exit(m.critical || m.high ? 1 : 0);
