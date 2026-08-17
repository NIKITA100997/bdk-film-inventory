@echo off
echo ===================================================
echo 🚀 Перезапуск сервисов Учёта плёнок БДК
echo ===================================================

echo Освобождаем порты 8002 и 5173...
powershell -Command "Get-NetTCPConnection -LocalPort 8002 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" 2>nul
powershell -Command "Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" 2>nul

echo Разрешаем входящие подключения для планшетов (порты 5173 и 8002)...
netsh advfirewall firewall add rule name="BDK 5173" dir=in action=allow protocol=TCP localport=5173 2>nul
netsh advfirewall firewall add rule name="BDK 8002" dir=in action=allow protocol=TCP localport=8002 2>nul

timeout /t 2 /nobreak >nul

echo Готовим HTTPS-сертификат для сканирования QR на планшетах...
node "%~dp0frontend\scripts\gen-dev-cert.js"

start "Бэкенд FastAPI (Port 8002)" cmd /k "cd /d %~dp0backend && .venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8002 --host 0.0.0.0 --ssl-keyfile ..\certs\dev-key.pem --ssl-certfile ..\certs\dev-cert.pem"
start "Фронтенд Vite (Port 5173)" cmd /k "cd /d %~dp0frontend && npm run dev -- --host 0.0.0.0"

echo.
echo ✅ Серверы перезапущены и готовы к подключению с планшетов!
echo 🌐 Компьютер: https://localhost:5173
echo 📷 На каждом новом планшете один раз откройте https://^<IP-компьютера^>:5173
echo    и https://^<IP-компьютера^>:8002/docs, примите предупреждение браузера
echo    ("Дополнительно" -^> "Перейти") — иначе камера для сканирования QR не заработает.
echo ===================================================
