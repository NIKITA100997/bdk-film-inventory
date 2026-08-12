import { useState } from "react";
import { Button, Tooltip } from "antd";
import { QrcodeOutlined } from "@ant-design/icons";
import QrScanModal from "./QrScanModal";

interface QrScanButtonProps {
  onScan: (code: string) => void;
  size?: "small" | "middle" | "large";
  tooltip?: string;
  buttonText?: string;
  type?: "default" | "primary" | "dashed" | "text" | "link";
  block?: boolean;
  style?: React.CSSProperties;
}

export default function QrScanButton({
  onScan,
  size = "middle",
  tooltip = "Сканировать QR камерой",
  buttonText,
  type = "default",
  block = false,
  style,
}: QrScanButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Tooltip title={tooltip}>
        <Button
          type={type}
          size={size}
          icon={<QrcodeOutlined />}
          onClick={() => setOpen(true)}
          block={block}
          style={style}
        >
          {buttonText}
        </Button>
      </Tooltip>
      <QrScanModal open={open} onClose={() => setOpen(false)} onScan={onScan} />
    </>
  );
}
