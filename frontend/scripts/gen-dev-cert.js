// Самоподписанный HTTPS-сертификат для dev-серверов (раздел про
// сканирование QR на планшетах) — камера (getUserMedia) в браузере
// работает только в безопасном контексте (HTTPS или localhost), а
// планшеты заходят по http://<LAN-IP>:5173. Сертификат общий для
// фронтенда (vite.config.ts) и бэкенда (uvicorn --ssl-keyfile/--ssl-certfile),
// лежит в certs/ в корне репозитория, генерируется один раз — планшетам
// не придётся заново принимать предупреждение браузера при каждом
// перезапуске серверов. Регенерация — только вручную (удалить certs/),
// актуально если поменялся IP компьютера.
import { generate } from "selfsigned";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const certsDir = join(repoRoot, "certs");
const certPath = join(certsDir, "dev-cert.pem");
const keyPath = join(certsDir, "dev-key.pem");

if (existsSync(certPath) && existsSync(keyPath)) {
  console.log("[gen-dev-cert] Сертификат уже есть — certs/dev-cert.pem, ничего не делаю.");
  process.exit(0);
}

function localIPv4Addresses() {
  const addresses = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

const ips = localIPv4Addresses();
const altNames = [
  { type: 2, value: "localhost" },
  { type: 7, ip: "127.0.0.1" },
  ...ips.map((ip) => ({ type: 7, ip })),
];

const notBefore = new Date();
const notAfter = new Date(notBefore);
notAfter.setFullYear(notAfter.getFullYear() + 10);

const pems = await generate([{ name: "commonName", value: "bdk-film-tracker" }], {
  keySize: 2048,
  algorithm: "sha256",
  notBeforeDate: notBefore,
  notAfterDate: notAfter,
  extensions: [
    { name: "basicConstraints", cA: false, critical: true },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames },
  ],
});

mkdirSync(certsDir, { recursive: true });
writeFileSync(certPath, pems.cert);
writeFileSync(keyPath, pems.private);

console.log(`[gen-dev-cert] Сертификат создан: certs/dev-cert.pem (${["localhost", "127.0.0.1", ...ips].join(", ")}).`);
console.log("[gen-dev-cert] На каждом новом планшете откройте один раз оба адреса и примите предупреждение браузера:");
for (const ip of ips) {
  console.log(`  https://${ip}:5173  и  https://${ip}:8002/docs`);
}
