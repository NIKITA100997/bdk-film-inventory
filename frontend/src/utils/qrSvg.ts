import { QrCode, Ecc } from "@rc-component/qrcode/es/libs/qrcodegen";
import { generatePath } from "@rc-component/qrcode/es/utils";

/**
 * Генерирует чистый векторный SVG QR-кода без использования canvas и без DOM-зависимостей.
 * Работает синхронно, идеально для встраивания в печатные формы (A4) с любым разрешением.
 */
export function renderQrSvg(text: string, size = 75, margin = 1): string {
  if (!text) return "";
  try {
    const qr = QrCode.encodeText(text, Ecc.MEDIUM);
    const modules = qr.getModules();
    const path = generatePath(modules, margin);
    const total = qr.size + margin * 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}" shape-rendering="crispEdges" style="display:block">
      <rect width="${total}" height="${total}" fill="#fff"/>
      <path d="${path}" fill="#000"/>
    </svg>`;
  } catch (err) {
    console.warn("Failed to generate QR SVG for:", text, err);
    return "";
  }
}
