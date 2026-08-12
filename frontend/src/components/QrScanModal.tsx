import { useEffect, useRef, useState } from "react";
import { Modal, Alert, Button } from "antd";
import { Html5Qrcode } from "html5-qrcode";

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

  useEffect(() => {
    if (!open) return;
    setErrorMessage(null);

    const html5Qrcode = new Html5Qrcode(qrRegionId);
    scannerRef.current = html5Qrcode;

    const config = { fps: 10, qrbox: { width: 250, height: 250 } };

    html5Qrcode
      .start(
        { facingMode: "environment" },
        config,
        (decodedText) => {
          onScan(decodedText);
          if (scannerRef.current && scannerRef.current.isScanning) {
            scannerRef.current.stop().catch(() => {});
          }
          onClose();
        },
        () => {},
      )
      .catch((err) => {
        console.warn("Camera start environment failed, trying default camera...", err);
        html5Qrcode
          .start(
            { facingMode: "user" },
            config,
            (decodedText) => {
              onScan(decodedText);
              if (scannerRef.current && scannerRef.current.isScanning) {
                scannerRef.current.stop().catch(() => {});
              }
              onClose();
            },
            () => {},
          )
          .catch(() => {
            setErrorMessage("Не удалось получить доступ к камере. Проверьте разрешения в браузере.");
          });
      });

    return () => {
      if (scannerRef.current && scannerRef.current.isScanning) {
        scannerRef.current.stop().catch(() => {});
      }
    };
  }, [open]);

  const handleClose = () => {
    if (scannerRef.current && scannerRef.current.isScanning) {
      scannerRef.current.stop().catch(() => {});
    }
    onClose();
  };

  return (
    <Modal
      open={open}
      onCancel={handleClose}
      footer={[
        <Button key="close" onClick={handleClose}>
          Отмена
        </Button>,
      ]}
      title={title}
      destroyOnClose
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
