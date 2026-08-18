@echo off
echo ===================================================
echo 🚀 Быстрый режим для планшетов — Учёт плёнок БДК
echo ===================================================
echo Это собранная (production) версия сайта — грузится на
echo планшете быстро с первого раза, в отличие от обычного
echo start.bat. Но правки кода сюда сами не попадают — см.
echo подсказку в конце.
echo ===================================================

echo Собираем фронтенд...
cd /d "%~dp0frontend"
call npm run build
if errorlevel 1 (
  echo.
  echo ❌ Сборка не удалась — смотрите ошибку выше и попробуйте снова.
  pause
  exit /b 1
)
cd /d "%~dp0"

echo Освобождаем порт 8002...
powershell -Command "Get-NetTCPConnection -LocalPort 8002 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" 2>nul

echo Разрешаем входящие подключения для планшетов (порт 8002)...
netsh advfirewall firewall add rule name="BDK 8002" dir=in action=allow protocol=TCP localport=8002 2>nul

timeout /t 2 /nobreak >nul

echo Готовим HTTPS-сертификат для сканирования QR на планшетах...
node "%~dp0frontend\scripts\gen-dev-cert.js"

start /min "БДК — быстрый режим (Port 8002)" cmd /k "cd /d %~dp0backend && .venv\Scripts\python.exe -m uvicorn app.main:app --port 8002 --host 0.0.0.0 --ssl-keyfile ..\certs\dev-key.pem --ssl-certfile ..\certs\dev-cert.pem"

echo.
echo ✅ Готово — сайт и сервер теперь на одном порту 8002 (порт 5173 не нужен).
echo 🌐 Компьютер: https://localhost:8002
echo 📷 На каждом планшете откройте https://^<IP-компьютера^>:8002
echo    и один раз примите предупреждение браузера ("Дополнительно" -^> "Перейти").
echo.
echo ⚠️  Это собранная версия — если после этого меняли код, изменения
echo    здесь НЕ появятся сами. Для правок кода используйте обычный
echo    start.bat, а когда правки готовы — снова запустите start_fast.bat,
echo    чтобы пересобрать и обновить быстрый режим.
echo ===================================================
