import { useState } from "react";
import { Button, Checkbox, Select, Space, Typography, message } from "antd";
import { useMutation, useQuery } from "@tanstack/react-query";
import { listItems } from "../../../api/items";
import { resolveNaryadLine, type NaryadParsedLine } from "../../../api/production";
import { apiErrorMessage } from "../../../utils/apiError";

/** Нераспознанная строка наряда (15.10): в файле нет размеров в названии и
 * соответствия ещё нет — выбрать позицию номенклатуры; размеры берутся из
 * неё, цвет — из скобок названия; «Запомнить» добавляет название из файла
 * синонимом позиции, и в следующий раз строка распознается сама. */
export default function NaryadResolveCell({
  partName,
  quantity,
  onResolved,
}: {
  partName: string;
  quantity: number;
  onResolved: (line: NaryadParsedLine) => void;
}) {
  const [q, setQ] = useState("");
  const [itemId, setItemId] = useState<number>();
  const [remember, setRemember] = useState(true);
  const items = useQuery({
    queryKey: ["items-resolve", q],
    queryFn: () => listItems({ q }),
    enabled: q.trim().length >= 2,
    staleTime: 60000,
  });
  const opts = (items.data ?? [])
    .filter((i) => i.kind_code === "izdelie" || i.kind_code === "pf")
    .slice(0, 40)
    .map((i) => ({ value: i.id, label: i.name }));
  const m = useMutation({
    mutationFn: () => resolveNaryadLine({ part_name: partName, quantity_pieces: quantity, item_id: itemId!, remember }),
    onSuccess: (line) => {
      onResolved(line);
      message.success(remember ? "Сопоставлено и запомнено" : "Сопоставлено");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сопоставить")),
  });
  return (
    <Space direction="vertical" size={4} style={{ width: "100%", minWidth: 260 }}>
      <Typography.Text type="danger" style={{ fontSize: 12 }}>
        Не распознано: «{partName}»
      </Typography.Text>
      <Select
        showSearch
        allowClear
        filterOption={false}
        onSearch={setQ}
        value={itemId}
        onChange={setItemId}
        loading={items.isFetching}
        placeholder="Найдите позицию: добор, наличник, планка…"
        notFoundContent={q.trim().length < 2 ? "Введите 2+ буквы" : "Не найдено"}
        options={opts}
        style={{ width: "100%" }}
      />
      <Space size={8} wrap>
        <Checkbox checked={remember} onChange={(e) => setRemember(e.target.checked)}>
          Запомнить соответствие
        </Checkbox>
        <Button size="small" type="primary" disabled={!itemId} loading={m.isPending} onClick={() => m.mutate()}>
          Сопоставить
        </Button>
      </Space>
    </Space>
  );
}
