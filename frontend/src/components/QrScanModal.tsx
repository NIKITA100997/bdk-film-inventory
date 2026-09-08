import { useEffect, useRef, useState } from "react";
import { Modal, Alert, Button } from "antd";
import { ThunderboltOutlined, ThunderboltFilled } from "@ant-design/icons";
import { Html5Qrcode } from "html5-qrcode";

interface QrScanModalProps {
  open: boolean;
  onClose: () => void;
  onScan: (decodedText: string) => void;
  title?: string;
}

/** Короткий бип через Web Audio API — без файла-ассета, генерируется на
 * лету. AudioContext может быть заблокирован браузером до первого жеста
 * пользователя — это не критично, звук просто не сыграет в этом случае. */
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

export default function QrScanModal({
  open,
  onClose,
  onScan,
  title = "Сканирование QR-кода камерой",
}: QrScanModalProps) {
  const qrRegionId = "html5qr-code-full-region";
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Раздел про "камера открывается, но код не распознаётся" — по описанию
  // пользователя доступ к камере в порядке, значит дело в самом
  // распознавании: фиксированная зона 250×250 не подстраивалась под
  // реальный размер видео (на планшете это могло быть далеко не то, что
  // нужно для мелкого кода на этикетке рулона), а разрешение видео вообще
  // не запрашивалось явно (браузер сам выбирал, часто заниженное). Фонарик
  // — типичная реальная причина нераспознавания в тёмном углу склада;
  // показываем кнопку только если камера физически умеет (torchFeature().
  // isSupported()), а не гадаем по типу устройства.
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  // Запускаем камеру не по факту open=true, а по afterOpenChange(true) —
  // AntD Modal монтирует содержимое (div#qrRegionId) через свою анимацию
  // открытия/портал, готовое сразу после commit React-рендера не
  // гарантировано; Html5Qrcode ищет элемент по id синхронно в конструкторе
  // и падал с "HTML Element with id=... not found", если запускался
  // слишком рано — то самое "сканирование не работает" у операторов на
  // планшетах. afterOpenChange вызывается уже после
  // завершения анимации открытия, элемент к этому моменту точно в DOM.
  const startScanner = () => {
    setErrorMessage(null);
    setTorchSupported(false);
    setTorchOn(false);
    const el = document.getElementById(qrRegionId);
    if (!el) return;

    const html5Qrcode = new Html5Qrcode(qrRegionId);
    scannerRef.current = html5Qrcode;

    // Раздел про "у одних работает, у других — белый экран" — адаптивная
    // зона сканирования (функция от реального размера видео) и запрошенное
    // разрешение помогали с распознаванием мелкого кода, но, похоже, не на
    // всех камерах/прошивках одинаково безопасны (qrbox-функция — более
    // новая часть API библиотеки; на слабой камере запрошенное разрешение
    // тоже может повести себя иначе). Поэтому — с откатом: сперва пробуем
    // "богатую" настройку, и только если она не завелась (на любом из двух
    // направлений камеры) — откатываемся на ИСХОДНУЮ, заведомо рабочую
    // конфигурацию (фиксированная зона 250×250, без запроса разрешения),
    // а не гадаем дальше. Так новым камерам достаётся улучшение, а старым/
    // капризным — гарантированно то же, что работало раньше.
    const richConfig = {
      fps: 10,
      qrbox: (viewfinderWidth: number, viewfinderHeight: number) => {
        // Защита от вырожденного кадра (0 или почти 0, пока видео ещё не
        // отдало реальные размеры) — 250 как безопасный минимум вместо
        // qrbox 0×0, которого библиотека не ждёт.
        const basis = Math.min(viewfinderWidth || 0, viewfinderHeight || 0);
        if (!basis || basis < 100) return { width: 250, height: 250 };
        return { width: Math.floor(basis * 0.75), height: Math.floor(basis * 0.75) };
      },
    };
    const richVideoConstraintsFor = (facingMode: "environment" | "user"): MediaTrackConstraints => ({
      facingMode,
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    });
    const safeConfig = { fps: 10, qrbox: { width: 250, height: 250 } };

    const handleDecoded = (decodedText: string) => {
      playBeep();
      navigator.vibrate?.(200);
      onScan(decodedText);
      if (scannerRef.current && scannerRef.current.isScanning) {
        scannerRef.current.stop().catch(() => {});
      }
      onClose();
    };

    const afterStart = () => {
      try {
        const supported = html5Qrcode.getRunningTrackCameraCapabilities().torchFeature().isSupported();
        setTorchSupported(supported);
      } catch {
        setTorchSupported(false);
      }
    };

    // async/try-catch, а не цепочка .then/.catch — на некоторых камерах/
    // прошивках html5Qrcode.start() может бросить исключение СИНХРОННО
    // (например, при валидации qrbox), а не только отклонить промис; голая
    // цепочка .catch() такое не ловит (исключение вылетает наружу ДО того,
    // как .then/.catch успевают подписаться), из-за чего сканер оставался
    // "белым экраном" без сообщения об ошибке вместо отката на безопасную
    // конфигурацию.
    const attempts: [string, () => Promise<null>][] = [
      ["rich environment", () => html5Qrcode.start(richVideoConstraintsFor("environment"), richConfig, handleDecoded, () => {})],
      ["rich user", () => html5Qrcode.start(richVideoConstraintsFor("user"), richConfig, handleDecoded, () => {})],
      ["safe environment", () => html5Qrcode.start({ facingMode: "environment" }, safeConfig, handleDecoded, () => {})],
      ["safe user", () => html5Qrcode.start({ facingMode: "user" }, safeConfig, handleDecoded, () => {})],
    ];

    void (async () => {
      for (const [label, attempt] of attempts) {
        try {
          await attempt();
          afterStart();
          return;
        } catch (err) {
          console.warn(`Camera start (${label}) failed, trying next option...`, err);
        }
      }
      setErrorMessage("Не удалось получить доступ к камере. Проверьте разрешения в браузере.");
    })();
  };

  const toggleTorch = () => {
    const next = !torchOn;
    scannerRef.current
      ?.getRunningTrackCameraCapabilities()
      .torchFeature()
      .apply(next)
      .then(() => setTorchOn(next))
      .catch(() => setErrorMessage("Не удалось переключить фонарик — устройство отклонило запрос."));
  };

  const stopScanner = () => {
    if (scannerRef.current && scannerRef.current.isScanning) {
      scannerRef.current.stop().catch(() => {});
    }
    scannerRef.current = null;
  };

  useEffect(() => stopScanner, []);

  const handleClose = () => {
    stopScanner();
    onClose();
  };

  return (
    <Modal
      open={open}
      onCancel={handleClose}
      afterOpenChange={(visible) => {
        if (visible) startScanner();
        else stopScanner();
      }}
      footer={[
        torchSupported && (
          <Button key="torch" icon={torchOn ? <ThunderboltFilled /> : <ThunderboltOutlined />} onClick={toggleTorch}>
            {torchOn ? "Выключить фонарик" : "Включить фонарик"}
          </Button>
        ),
        <Button key="close" onClick={handleClose}>
          Отмена
        </Button>,
      ]}
      title={title}
      destroyOnHidden
    >
      {errorMessage ? (
        <Alert message={errorMessage} type="error" showIcon style={{ marginBottom: 16 }} />
      ) : (
        <Alert
          message="Наведите камеру на QR-код"
          description="Если не распознаётся — поднесите ближе к этикетке и держите ровно (без наклона); в тёмном месте включите фонарик кнопкой снизу."
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}
      <div id={qrRegionId} style={{ width: "100%", borderRadius: 8, overflow: "hidden", minHeight: 280 }} />
    </Modal>
  );
}
