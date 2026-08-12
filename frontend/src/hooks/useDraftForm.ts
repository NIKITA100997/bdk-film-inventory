import { useEffect, useRef } from "react";
import { message, type FormInstance } from "antd";

/** Автосохранение черновика длинной формы (9.4 раздел бэклога доработок):
 * приёмка сессией/создание строки заказа теряли ввод при обрыве связи или
 * случайном закрытии вкладки. Черновик пишется в localStorage на каждое
 * изменение и восстанавливается при монтировании формы; вызывающий сам
 * решает, когда считать форму "успешно отправленной" и звать clearDraft —
 * это разное для каждой формы (мутация, локальный стейт без API-вызова...). */
export function useDraftForm<T extends object>(key: string, form: FormInstance<T>) {
  const restoredRef = useRef(false);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const raw = localStorage.getItem(key);
    if (!raw) return;
    try {
      const draft = JSON.parse(raw) as Partial<T>;
      if (draft && Object.keys(draft).length > 0) {
        form.setFieldsValue(draft as T);
        message.info("Черновик восстановлен");
      }
    } catch {
      localStorage.removeItem(key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const handleValuesChange = () => {
    localStorage.setItem(key, JSON.stringify(form.getFieldsValue()));
  };

  const clearDraft = () => {
    localStorage.removeItem(key);
  };

  return { handleValuesChange, clearDraft };
}
