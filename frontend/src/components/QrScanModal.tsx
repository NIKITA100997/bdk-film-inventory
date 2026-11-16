import { useEffect, useRef, useState } from "react";
import { Modal, Alert, Button } from "antd";
import { Html5Qrcode } from "html5-qrcode";
import { triggerScanFeedback } from "../utils/feedback";

interface QrScanModalProps {
  open: boolean;
  onClose: () => void;
  onScan: (decodedText: string) => void;
  title?: string;
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
    const el = document.getElementById(qrRegionId);
    if (!el) return;

    const html5Qrcode = new Html5Qrcode(qrRegionId);
    scannerRef.current = html5Qrcode;

    const config = { fps: 10, qrbox: { width: 250, height: 250 } };

    const handleDecoded = (decodedText: string) => {
      triggerScanFeedback(true);
      onScan(decodedText);
      if (scannerRef.current && scannerRef.current.isScanning) {
        scannerRef.current.stop().catch(() => {});
      }
      onClose();
    };

    html5Qrcode.start({ facingMode: "environment" }, config, handleDecoded, () => {}).catch((err) => {
      console.warn("Camera start environment failed, trying default camera...", err);
      html5Qrcode
        .start({ facingMode: "user" }, config, handleDecoded, () => {})
        .catch(() => {
          setErrorMessage("Не удалось получить доступ к камере. Проверьте разрешения в браузере.");
        });
    });
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
          message="Наведите камеру планшета/устройства на QR-код"
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}
      <div id={qrRegionId} style={{ width: "100%", borderRadius: 8, overflow: "hidden", minHeight: 280 }} />
    </Modal>
  );
}
