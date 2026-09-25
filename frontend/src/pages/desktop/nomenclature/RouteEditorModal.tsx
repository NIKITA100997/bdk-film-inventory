import { useState } from "react";
import { isAxiosError } from "axios";
import { Button, Input, Modal, Select, Space, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listAreas } from "../../../api/areas";
import { setItemRoute, type TechCard } from "../../../api/items";

type Row = { code: string; name: string; area: string | null };

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

/** Маршрут любой позиции (единая модель, пункт 3): операции по порядку —
 * название работы и участок, где её делают. Правка на месте: партии и
 * история остаются на своих операциях, операцию с партиями убрать нельзя. */
export default function RouteEditorModal({ card, onClose }: { card: TechCard; onClose: () => void }) {
  const qc = useQueryClient();
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaOptions = (areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }));
  // code — ключ сопоставления со старыми этапами: у существующих операций
  // сохраняем прежний, у новых — название.
  const [rows, setRows] = useState<Row[]>(
    card.operations.map((o) => ({ code: o.code ?? o.name, name: o.name, area: o.area })),
  );
  const patch = (i: number, p: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const move = (i: number, d: number) =>
    setRows((rs) => {
      const t = i + d;
      if (t < 0 || t >= rs.length) return rs;
      const next = [...rs];
      [next[i], next[t]] = [next[t], next[i]];
      return next;
    });

  const mutation = useMutation({
    mutationFn: () =>
      setItemRoute(
        card.item_id,
        rows.map((r) => ({ code: r.code || r.name.trim(), name: r.name.trim(), area: r.area })),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["techcard", card.item_id] });
      qc.invalidateQueries({ queryKey: ["parts"] });
      qc.invalidateQueries({ queryKey: ["dict-autocomplete", "parts"] });
      message.success("Маршрут сохранён");
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить маршрут")),
  });
  // Без участка — только последняя операция («Готово» — общий запас).
  const invalid = rows.some((r, i) => !r.name.trim() || (!r.area && i < rows.length - 1));

  return (
    <Modal
      open
      width={760}
      title={`Маршрут — ${card.name}`}
      okText="Сохранить"
      cancelText="Отмена"
      onCancel={onClose}
      okButtonProps={{ disabled: invalid, loading: mutation.isPending }}
      onOk={() => mutation.mutate()}
    >
      <Typography.Paragraph type="secondary">
        Операции по порядку: что делают и на каком участке. Партии и история остаются на своих операциях; операцию,
        на которой есть партии, убрать нельзя — можно поменять участок или порядок.
      </Typography.Paragraph>
      <Space direction="vertical" style={{ width: "100%" }}>
        {rows.map((r, i) => (
          <Space key={i} wrap>
            <Typography.Text type="secondary" style={{ width: 20, display: "inline-block" }}>
              {i + 1}.
            </Typography.Text>
            <Input
              placeholder="Операция, например «Склейка щитов»"
              value={r.name}
              style={{ width: 240 }}
              onChange={(e) => patch(i, { name: e.target.value })}
            />
            <Select
              showSearch
              optionFilterProp="label"
              allowClear={i === rows.length - 1}
              placeholder={i === rows.length - 1 ? "Участок (пусто — общий запас)" : "Участок"}
              style={{ width: 280 }}
              value={r.area ?? undefined}
              options={areaOptions}
              onChange={(v) => patch(i, { area: v ?? null, name: r.name || areaOptions.find((a) => a.value === v)?.label || "" })}
            />
            <Button size="small" disabled={i === 0} onClick={() => move(i, -1)}>
              ↑
            </Button>
            <Button size="small" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
              ↓
            </Button>
            <Button size="small" danger onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
              Убрать
            </Button>
          </Space>
        ))}
        <Button block onClick={() => setRows((rs) => [...rs, { code: "", name: "", area: null }])}>
          + операция
        </Button>
      </Space>
    </Modal>
  );
}
