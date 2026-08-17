const { spawn, spawnSync } = require("child_process");
const path = require("path");

const root = __dirname;
const frontendDir = path.join(root, "frontend");
const backendDir = path.join(root, "backend");

// HTTPS для сканирования QR на планшетах (getUserMedia работает только в
// безопасном контексте) — генерируем сертификат один раз, до старта
// серверов, тот же файл использует и uvicorn (--ssl-keyfile/--ssl-certfile),
// и vite.config.ts (сам подхватывает certs/, если они есть).
console.log("🔐 Generating HTTPS dev certificate (if missing)...");
spawnSync("node", [path.join(frontendDir, "scripts", "gen-dev-cert.js")], { stdio: "inherit" });

console.log("🚀 Starting Vite Frontend on port 5173...");
const vite = spawn("cmd.exe", ["/c", "npx vite --host 0.0.0.0 --port 5173"], {
  cwd: frontendDir,
  detached: true,
  stdio: "ignore",
});
vite.unref();

console.log("🚀 Starting Uvicorn Backend on port 8002...");
const uvicorn = spawn(
  "cmd.exe",
  [
    "/c",
    "python -m uvicorn app.main:app --reload --port 8002 --host 0.0.0.0 --ssl-keyfile ../certs/dev-key.pem --ssl-certfile ../certs/dev-cert.pem",
  ],
  {
    cwd: backendDir,
    detached: true,
    stdio: "ignore",
  },
);
uvicorn.unref();

console.log("✅ Servers launched in background! https://localhost:5173");
