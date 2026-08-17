import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// HTTPS для сканирования QR на планшетах (раздел про сканирование) —
// камера (getUserMedia) работает только в безопасном контексте (HTTPS
// или localhost), а планшеты заходят по http://<LAN-IP>:5173. Сертификат
// генерируется отдельным шагом (scripts/gen-dev-cert.js, запускается из
// start.bat/start_dev.js перед стартом серверов) — если его ещё нет
// (например, `npm run dev` запущен напрямую до первого запуска
// start.bat), тихо остаёмся на http, ничего не ломаем.
const certDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'certs')
const certPath = join(certDir, 'dev-cert.pem')
const keyPath = join(certDir, 'dev-key.pem')
const httpsConfig =
  existsSync(certPath) && existsSync(keyPath)
    ? { cert: readFileSync(certPath), key: readFileSync(keyPath) }
    : undefined

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    https: httpsConfig,
  },
})
