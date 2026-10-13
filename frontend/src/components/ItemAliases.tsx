import { useState } from "react";
import { Button, Input, Space, Tag, Tooltip, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addItemAlias, deleteItemAlias, listItemAliases } from "../api/items";
import { useAuth } from "../auth/AuthContext";
import { hasPerm } from "../auth/permissions";
import { apiErrorMessage } from "../utils/apiError";

/** Синонимы позиции (14.10) — одинаково для плёнки, п/ф, материала, изделия:
 * как позицию называют в нарядах, графиках, счетах и прайсах 1С. Текст-
 * синоним дальше узнаётся везде, где позиция ищется по тексту. */
export default function ItemAliases({ itemId }: { itemId: number }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canEdit = hasPerm(user, "production_tasks.manage", "materials.manage", "part_units.manage", "purchasing.manage");
  const q = useQuery({ queryKey: ["item-aliases", itemId], queryFn: () => listItemAliases(itemId) });
  const [text, setText] = useState("");
  const done = (data: Awaited<ReturnType<typeof listItemAliases>>) => qc.setQueryData(["item-aliases", itemId], data);
  const add = useMutation({
    mutationFn: () => addItemAlias(itemId, text.trim()),
    onSuccess: (d) => {
      done(d);
      setText("");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось добавить синоним")),
  });
  const del = useMutation({
    mutationFn: (id: number) => deleteItemAlias(itemId, id),
    onSuccess: done,
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось убрать синоним")),
  });
  const list = q.data ?? [];
  if (!canEdit && list.length === 0) return null;
  return (
    <Space wrap size={[6, 6]} align="center">
      <Typography.Text type="secondary">Синонимы:</Typography.Text>
      {list.length === 0 && <Typography.Text type="secondary">нет</Typography.Text>}
      {list.map((a) => (
        <Tooltip key={`${a.film ? "f" : "i"}-${a.id ?? a.text}`} title={a.film ? "Сопоставление цвета плёнки — общее для всех её позиций, правится в «Справочниках»" : a.source ?? undefined}>
          <Tag
            color={a.film ? "blue" : undefined}
            closable={canEdit && !a.film && a.id != null}
            onClose={(e) => {
              e.preventDefault();
              if (a.id != null) del.mutate(a.id);
            }}
          >
            {a.text}
          </Tag>
        </Tooltip>
      ))}
      {canEdit && (
        <Space.Compact size="small">
          <Input
            size="small"
            style={{ width: 240 }}
            placeholder="как называют в 1С, наряде, графике"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPressEnter={() => text.trim() && add.mutate()}
          />
          <Button size="small" disabled={!text.trim()} loading={add.isPending} onClick={() => add.mutate()}>
            Добавить
          </Button>
        </Space.Compact>
      )}
    </Space>
  );
}
