import { useState } from "react";
import { Alert, AutoComplete, Button, Space, Typography, message } from "antd";
import { useQueryClient } from "@tanstack/react-query";
import { setOrderLinesOption, type OrderLine, type ProductionOrder } from "../../../api/productionOrders";
import type { LineOption, OptionField } from "../../../api/customerOrders";
import { apiErrorMessage } from "../../../utils/apiError";

/** «Уточнить перед запуском» (26.10): выборы исполнения, которых не было в
 * счёте (цвет уплотнителя, тип стекла…), — по каждому полю строки без него
 * и одно значение сразу всем. */
export default function OptionsToClarify({ order, canManage }: { order: ProductionOrder; canManage: boolean }) {
  const fields = new Map<string, { f: OptionField; lines: OrderLine[] }>();
  for (const l of order.lines) {
    const have = new Set((l.options ?? []).filter((o) => o.value).map((o) => o.code));
    for (const f of l.option_fields ?? []) {
      if (have.has(f.code)) continue;
      const cur = fields.get(f.code) ?? { f, lines: [] };
      cur.lines.push(l);
      fields.set(f.code, cur);
    }
  }
  if (!fields.size) return null;
  return (
    <Alert
      type="warning"
      showIcon
      message="Уточнить перед запуском — нет в счёте"
      description={
        <Space direction="vertical" style={{ width: "100%" }}>
          {[...fields.values()].map(({ f, lines }) => (
            <FieldRow key={f.code} order={order} field={f} lines={lines} canManage={canManage} />
          ))}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Запуск не блокируется: что задано — уйдёт указанием мастеру на своей операции; поправить у одной строки — значок ✎ в строке.
          </Typography.Text>
        </Space>
      }
    />
  );
}

function FieldRow({ order, field, lines, canManage }: { order: ProductionOrder; field: OptionField; lines: OrderLine[]; canManage: boolean }) {
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const apply = async () => {
    setBusy(true);
    try {
      await setOrderLinesOption(order.id, { line_ids: lines.map((l) => l.id), code: field.code, name: field.name, value: value.trim(), op: field.op ?? null });
      qc.invalidateQueries({ queryKey: ["production-order", order.id] });
      qc.invalidateQueries({ queryKey: ["production-orders"] });
      message.success(`${field.name}: задано ${lines.length} строкам`);
      setValue("");
    } catch (e) {
      message.error(apiErrorMessage(e, "Не удалось сохранить"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Space wrap>
      <Typography.Text strong>{field.name}</Typography.Text>
      <Typography.Text type="secondary">
        не задано у {lines.length} {lines.length === 1 ? "строки" : "строк"}
        {field.op ? ` · операция «${field.op}»` : ""}
      </Typography.Text>
      {canManage && (
        <>
          <AutoComplete
            style={{ width: 220 }}
            placeholder="значение"
            value={value}
            onChange={setValue}
            options={(field.options ?? []).map((o) => ({ value: o }))}
            filterOption={(input, o) => String(o?.value ?? "").toLowerCase().includes(input.toLowerCase())}
          />
          <Button type="primary" size="small" disabled={!value.trim()} loading={busy} onClick={apply}>
            Задать всем {lines.length}
          </Button>
        </>
      )}
    </Space>
  );
}

/** Сохранить выборы одной строки (правка ✎): по полю за раз. */
export async function saveOrderLineOptions(order: ProductionOrder, line: OrderLine, next: LineOption[]) {
  const before = new Map((line.options ?? []).map((o) => [o.code, o]));
  const after = new Map(next.map((o) => [o.code, o]));
  const codes = new Set([...before.keys(), ...after.keys()]);
  for (const code of codes) {
    const b = before.get(code);
    const a = after.get(code);
    if ((b?.value ?? "") === (a?.value ?? "")) continue;
    const ref = a ?? b!;
    await setOrderLinesOption(order.id, { line_ids: [line.id], code, name: ref.name, value: a?.value ?? null, op: ref.op ?? null });
  }
}
