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

    // Зона сканирования — доля от реального размера видеокадра, а не
    // фиксированные 250px: на широком планшетном экране 250px — маленькое
    // пятно посреди кадра, из-за чего код на этикетке рулона приходится
    // ловить почти впритык к камере. width/height ideal — просим более
    // высокое разрешение видео явно, а не полагаемся на выбор браузера по
    // умолчанию (обычно занижен ради экономии трафика/CPU, мелкий QR на
    // этикетке от этого не распознаётся).
    const config = {
      fps: 10,
      qrbox: (viewfinderWidth: number, viewfinderHeight: number) => {
        const size = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.75);
        return { width: size, height: size };
      },
    };
    const videoConstraintsFor = (facingMode: "environment" | "user"): MediaTrackConstraints => ({
      facingMode,
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    });

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

    html5Qrcode
      .start(videoConstraintsFor("environment"), config, handleDecoded, () => {})
      .then(afterStart)
      .catch((err) => {
        console.warn("Camera start environment failed, trying default camera...", err);
        html5Qrcode
          .start(videoConstraintsFor("user"), config, handleDecoded, () => {})
          .then(afterStart)
          .catch(() => {
            setErrorMessage("Не удалось получить доступ к камере. Проверьте разрешения в браузере.");
          });
      });
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
