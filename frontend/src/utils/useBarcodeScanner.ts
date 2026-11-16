import { useEffect, useRef } from "react";
import { triggerScanFeedback } from "./feedback";

type BarcodeHandler = (barcode: string) => void | boolean;

interface BarcodeScannerOptions {
  onScan?: BarcodeHandler;
  enabled?: boolean;
  /** Максимальный интервал между символами (мс) для распознавания как аппаратный сканер ТСД */
  maxIntervalMs?: number;
  /** Минимальная длина штрихкода */
  minLength?: number;
  /** Перехватывать ли ввод, если фокус в input/textarea */
  interceptInputs?: boolean;
}

// Стек активных локальных обработчиков (LIFO: модальное окно поверх страницы имеет приоритет)
const activeHandlers: BarcodeHandler[] = [];

export function registerBarcodeHandler(handler: BarcodeHandler): () => void {
  activeHandlers.push(handler);
  return () => {
    const idx = activeHandlers.indexOf(handler);
    if (idx !== -1) activeHandlers.splice(idx, 1);
  };
}

export function dispatchBarcode(barcode: string): boolean {
  // Вызываем обработчики с конца стека (самый верхний монтированный компонент)
  for (let i = activeHandlers.length - 1; i >= 0; i--) {
    const handler = activeHandlers[i];
    const handled = handler(barcode);
    // Если обработчик вернул false, передаём дальше по цепочке, иначе считаем обработанным
    if (handled !== false) {
      triggerScanFeedback(true);
      return true;
    }
  }
  return false;
}

/**
 * Хук для подключения аппаратного сканера штрихкодов ТСД на конкретном экране или компоненте.
 */
export function useBarcodeScanner({
  onScan,
  enabled = true,
}: {
  onScan: BarcodeHandler;
  enabled?: boolean;
}) {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    if (!enabled) return;
    const unregister = registerBarcodeHandler((barcode) => onScanRef.current(barcode));
    return unregister;
  }, [enabled]);
}

/**
 * Глобальный слушатель клавиатурных событий аппаратного сканера ТСД.
 * Монтируется один раз в корне приложения (AppLayout).
 */
export function useGlobalBarcodeScanner({
  onFallbackScan,
  enabled = true,
  maxIntervalMs = 50,
  minLength = 2,
  interceptInputs = true,
}: BarcodeScannerOptions & { onFallbackScan?: BarcodeHandler }) {
  const bufferRef = useRef<string>("");
  const lastKeyTimeRef = useRef<number>(0);

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Игнорируем функциональные клавиши
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      const now = performance.now();
      const delta = now - lastKeyTimeRef.current;
      lastKeyTimeRef.current = now;

      // Если пауза между символами была больше пороговой (ручной ввод), очищаем буфер
      if (delta > maxIntervalMs) {
        bufferRef.current = "";
      }

      if (e.key === "Enter") {
        const barcode = bufferRef.current.trim();
        bufferRef.current = "";

        if (barcode.length >= minLength) {
          // Это аппаратный ввод со сканера!
          const target = e.target as HTMLElement | null;
          const isInput =
            target &&
            (target.tagName === "INPUT" ||
              target.tagName === "TEXTAREA" ||
              target.isContentEditable);

          if (isInput && interceptInputs) {
            // Очищаем значение поля, чтобы отсканированный штрихкод не залипал в инпуте случайным текстом
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
              // Если инпут не был целевым для ручного ввода
              e.preventDefault();
              e.stopPropagation();
            }
          }

          // Передаём в локальные обработчики (модалки / формы)
          const handled = dispatchBarcode(barcode);
          if (!handled && onFallbackScan) {
            onFallbackScan(barcode);
            triggerScanFeedback(true);
          }
        }
        return;
      }

      // Накапливаем печатаемые символы
      if (e.key.length === 1) {
        bufferRef.current += e.key;
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [enabled, maxIntervalMs, minLength, interceptInputs, onFallbackScan]);
}
