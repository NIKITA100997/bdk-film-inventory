import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { CloseOutlined } from "@ant-design/icons";

interface FullScreenScannerProps {
  open: boolean;
  onClose: () => void;
  onScan: (decodedText: string) => void;
  // Раздел про телефонную версию — "Ввести номер вручную": закрывает
  // камеру и передаёт управление вызывающему коду (в AppLayout.tsx это
  // уже существующий полноэкранный поиск в шапке, searchOpen).
  onManualEntry?: () => void;
}

const QR_REGION_ID = "html5qr-fullscreen-region";

/** Короткий бип через Web Audio API — та же реализация, что в
 * QrScanModal.tsx (без файла-ассета, генерируется на лету). AudioContext
 * может быть заблокирован браузером до первого жеста пользователя — не
 * критично, звук просто не сыграет в этом случае. */
function playBeep() {
  try {
    const AudioCtx =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.15);
    oscillator.onended = () => ctx.close();
  } catch {
    // недоступно/заблокировано — не критично, сканирование продолжает работать
  }
}

/** Скан QR на весь экран (раздел про телефонную версию) — та же логика
 * сканирования, что в QrScanModal.tsx (Html5Qrcode.start/stop, бип,
 * вибро, фоллбэк на фронтальную камеру, обработка ошибки доступа),
 * перенесённая в полноэкранный оверлей вместо маленького модального
 * окна: на телефоне это главная точка входа (таб "Скан"), а не
 * второстепенное действие в шапке. Вместо afterOpenChange (механизм
 * antd Modal, которого здесь нет) старт сканера вызывается в useEffect
 * по open — обычный conditional render гарантирует DOM-узел к моменту
 * эффекта, той гонки с анимацией открытия, что описана в QrScanModal.tsx,
 * здесь просто не возникает. */
export default function FullScreenScanner({ open, onClose, onScan, onManualEntry }: FullScreenScannerProps) {
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErrorMessage(null);
    const el = document.getElementById(QR_REGION_ID);
    if (!el) return;

    const html5Qrcode = new Html5Qrcode(QR_REGION_ID);
    scannerRef.current = html5Qrcode;
    const config = { fps: 10, qrbox: { width: 250, height: 250 } };

    const stop = () => {
      if (scannerRef.current && scannerRef.current.isScanning) {
        scannerRef.current.stop().catch(() => {});
      }
      scannerRef.current = null;
    };

    const handleDecoded = (decodedText: string) => {
      playBeep();
      navigator.vibrate?.(200);
      onScan(decodedText);
      stop();
      onClose();
    };

    html5Qrcode.start({ facingMode: "environment" }, config, handleDecoded, () => {}).catch((err) => {
      console.warn("Camera start environment failed, trying default camera...", err);
      html5Qrcode.start({ facingMode: "user" }, config, handleDecoded, () => {}).catch(() => {
        setErrorMessage("Не удалось получить доступ к камере. Проверьте разрешения в браузере.");
      });
    });

    return stop;
    // onScan/onClose имеют стабильную идентичность в местах вызова этой сессии — не в зависимостях намеренно
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  return (
    <div style={{ position: "fixed", inset: 0, background: "#0d0e12", zIndex: 2000, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", justifyContent: "flex-end", padding: "12px 12px 0" }}>
        <button
          onClick={onClose}
          aria-label="Закрыть камеру"
          style={{
            background: "rgba(255,255,255,0.14)",
            border: "none",
            borderRadius: 8,
            width: 36,
            height: 36,
            color: "#fff",
            fontSize: 16,
            cursor: "pointer",
          }}
        >
          <CloseOutlined />
        </button>
      </div>
      {errorMessage && (
        <div style={{ margin: "12px 16px 0", padding: "10px 14px", background: "#B8483C", color: "#fff", borderRadius: 8, fontSize: 13 }}>
          {errorMessage}
        </div>
      )}
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", minHeight: 0, padding: "0 16px" }}>
        <div id={QR_REGION_ID} style={{ width: "100%", maxWidth: 420, minHeight: 320, borderRadius: 12, overflow: "hidden" }} />
      </div>
      <div style={{ textAlign: "center", color: "#fff", opacity: 0.85, fontSize: 13, padding: "0 20px 18px" }}>
        Наведите камеру на QR-код на бирке
      </div>
      {onManualEntry && (
        <button
          onClick={() => {
            onClose();
            onManualEntry();
          }}
          style={{
            background: "transparent",
            border: "1px solid rgba(255,255,255,0.4)",
            color: "#fff",
            borderRadius: 8,
            padding: "10px 16px",
            margin: "0 20px 28px",
            fontSize: 13,
          }}
        >
          Ввести номер вручную
        </button>
      )}
    </div>
  );
}
