import { useState } from "react";
import { Space, Tooltip } from "antd";
import { SettingOutlined } from "@ant-design/icons";
import { useAuth } from "../auth/AuthContext";

export interface ColumnOption {
  key: string;
  label: string;
  locked?: boolean;
}

function loadVisible(storageKey: string, allKeys: string[], hiddenByDefault: string[]): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const saved = JSON.parse(raw) as Record<string, boolean>;
      const merged: Record<string, boolean> = {};
      for (const k of allKeys) merged[k] = k in saved ? saved[k] : !hiddenByDefault.includes(k);
      return merged;
    }
  } catch {
    // повреждённое значение в localStorage — просто игнорируем, вернём дефолт
  }
  const defaults: Record<string, boolean> = {};
  for (const k of allKeys) defaults[k] = !hiddenByDefault.includes(k);
  return defaults;
}

/** Набор видимых столбцов таблицы — свой у каждого сотрудника, хранится в
 * localStorage (раздел про настройку столбцов на планшете). Общий хук для
 * ResponsiveTable (карточки на узких экранах) и ReportTable (отчёты с
 * экспортом) — один и тот же значок-шестерёнка и одна логика сохранения
 * вместо двух разных способов выбрать столбцы. */
export function useColumnSettings(tableKey: string | undefined, columns: ColumnOption[], defaultHiddenKeys: string[] = []) {
  const { user } = useAuth();
  const allKeys = columns.map((c) => c.key);
  const storageKey = tableKey ? `columns:${tableKey}:${user?.id ?? "anon"}` : "";

  const [visible, setVisible] = useState<Record<string, boolean>>(() =>
    tableKey ? loadVisible(storageKey, allKeys, defaultHiddenKeys) : {},
  );

  const isVisible = (key: string): boolean => {
    const col = columns.find((c) => c.key === key);
    if (!tableKey || col?.locked) return true;
    return visible[key] ?? !defaultHiddenKeys.includes(key);
  };

  const toggle = (key: string) => {
    const next = { ...visible, [key]: !isVisible(key) };
    setVisible(next);
    if (tableKey) localStorage.setItem(storageKey, JSON.stringify(next));
  };

  const reset = () => {
    const defaults: Record<string, boolean> = {};
    for (const k of allKeys) defaults[k] = !defaultHiddenKeys.includes(k);
    setVisible(defaults);
    if (tableKey) localStorage.setItem(storageKey, JSON.stringify(defaults));
  };

  const visibleKeys = columns.filter((c) => isVisible(c.key)).map((c) => c.key);
  const toggleableCount = columns.filter((c) => !c.locked).length;

  return { isVisible, toggle, reset, visibleKeys, enabled: !!tableKey && toggleableCount > 0 };
}

export function ColumnSettingsButton({
  columns,
  settings,
}: {
  columns: ColumnOption[];
  settings: ReturnType<typeof useColumnSettings>;
}) {
  const [open, setOpen] = useState(false);
  if (!settings.enabled) return null;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, position: "relative" }}>
      <span style={{ fontSize: 12, color: "#8A8C99" }}>
        {settings.visibleKeys.length} из {columns.length} столбцов
      </span>
      <Tooltip title="Настроить столбцы">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          style={{
            width: 30,
            height: 30,
            borderRadius: 6,
            border: "1px solid #D2CEC1",
            background: open ? "#FBEADD" : "#fff",
            color: open ? "#C97A2B" : "inherit",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          aria-label="Настроить столбцы"
        >
          <SettingOutlined />
        </button>
      </Tooltip>
      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 19 }} onClick={() => setOpen(false)} />
          <div
            style={{
              position: "absolute",
              top: 36,
              right: 0,
              width: 280,
              background: "#fff",
              border: "1px solid #D2CEC1",
              borderRadius: 10,
              boxShadow: "0 8px 24px -12px rgba(30,31,43,0.3)",
              padding: 14,
              zIndex: 20,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>Столбцы таблицы</span>
              <button
                type="button"
                onClick={settings.reset}
                style={{ fontSize: 12, color: "#C97A2B", background: "none", border: "none", cursor: "pointer", padding: 0 }}
              >
                Сбросить
              </button>
            </div>
            <Space direction="vertical" size={2} style={{ width: "100%" }}>
              {columns.map((c) => (
                <label
                  key={c.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 13.5,
                    padding: "3px 2px",
                    color: c.locked ? "#9799A6" : "inherit",
                  }}
                >
                  <input type="checkbox" checked={settings.isVisible(c.key)} disabled={c.locked} onChange={() => settings.toggle(c.key)} />
                  <span>{c.label}</span>
                  {c.locked && (
                    <span style={{ marginLeft: "auto", fontSize: 10, border: "1px solid #E2DFD6", borderRadius: 4, padding: "1px 5px" }}>
                      закреплено
                    </span>
                  )}
                </label>
              ))}
            </Space>
            <div style={{ fontSize: 11.5, color: "#9799A6", marginTop: 10, paddingTop: 10, borderTop: "1px dashed #E2DFD6" }}>
              Сохраняется в вашем профиле на этом устройстве — у коллег может быть другой набор.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
