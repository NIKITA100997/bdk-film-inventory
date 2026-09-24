import { useEffect, useState } from "react";
import { isAxiosError } from "axios";
import { Button, Checkbox, Descriptions, Form, Input, InputNumber, Select, Space, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getItemProperties,
  listItemTypes,
  setItemProperties,
  type ItemProperty,
  type PropertyValue,
} from "../../../api/itemTypes";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

function showValue(p: ItemProperty, v: PropertyValue | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  if (p.value_type === "bool") return v ? "да" : "нет";
  if (p.value_type === "list") return p.options.find((o) => o.id === v)?.value ?? "—";
  return `${v}${p.unit ? ` ${p.unit}` : ""}`;
}

/** Тип позиции и значения его свойств — в карточке номенклатуры (единая
 * модель, пункты 1–2). */
export default function ItemPropertiesSection({ itemId, kindCode, canEdit }: { itemId: number; kindCode: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const typesQuery = useQuery({ queryKey: ["item-types"], queryFn: () => listItemTypes() });
  const valuesQuery = useQuery({ queryKey: ["item-properties", itemId], queryFn: () => getItemProperties(itemId) });
  const [editing, setEditing] = useState(false);
  const [typeId, setTypeId] = useState<number | null>(null);
  const [values, setValues] = useState<Record<string, PropertyValue>>({});

  useEffect(() => {
    if (valuesQuery.data) {
      setTypeId(valuesQuery.data.type_id);
      setValues(valuesQuery.data.values);
    }
  }, [valuesQuery.data]);

  const kindTypes = (typesQuery.data ?? []).filter((t) => t.kind_code === kindCode && (t.is_active || t.id === typeId));
  const type = (typesQuery.data ?? []).find((t) => t.id === typeId) ?? null;

  const mutation = useMutation({
    mutationFn: () => setItemProperties(itemId, { type_id: typeId, values }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["item-properties", itemId] });
      qc.invalidateQueries({ queryKey: ["item-types"] });
      message.success("Свойства сохранены");
      setEditing(false);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить свойства")),
  });

  if (valuesQuery.isLoading || typesQuery.isLoading) return <Typography.Text type="secondary">Загрузка…</Typography.Text>;

  if (!editing) {
    return (
      <Space direction="vertical" size="small" style={{ width: "100%" }}>
        <Space>
          <Typography.Text>Тип: {type ? <b>{type.name}</b> : <Typography.Text type="secondary">не задан</Typography.Text>}</Typography.Text>
          {canEdit && kindTypes.length > 0 && (
            <Button size="small" onClick={() => setEditing(true)}>
              Изменить
            </Button>
          )}
        </Space>
        {kindTypes.length === 0 && !type && (
          <Typography.Text type="secondary">
            Для этого вида типов пока нет — их заводят во вкладке «Типы и свойства».
          </Typography.Text>
        )}
        {type && type.properties.length > 0 && (
          <Descriptions size="small" column={1} bordered>
            {type.properties.map((p) => (
              <Descriptions.Item key={p.id} label={p.name}>
                {showValue(p, valuesQuery.data?.values[String(p.id)])}
              </Descriptions.Item>
            ))}
          </Descriptions>
        )}
      </Space>
    );
  }

  return (
    <Form layout="vertical">
      <Form.Item label="Тип">
        <Select
          allowClear
          placeholder="Без типа"
          value={typeId ?? undefined}
          onChange={(v) => {
            setTypeId(v ?? null);
            if (v !== typeId) setValues({});
          }}
          options={kindTypes.map((t) => ({ value: t.id, label: t.name }))}
        />
      </Form.Item>
      {type?.properties.map((p) => {
        const key = String(p.id);
        const v = values[key];
        const set = (nv: PropertyValue) => setValues((s) => ({ ...s, [key]: nv }));
        return (
          <Form.Item key={p.id} label={`${p.name}${p.unit ? `, ${p.unit}` : ""}`} required={p.is_required}>
            {p.value_type === "number" && (
              <InputNumber value={(v as number | null) ?? null} style={{ width: 200 }} onChange={(nv) => set(nv)} />
            )}
            {p.value_type === "text" && <Input value={(v as string | null) ?? ""} onChange={(e) => set(e.target.value)} />}
            {p.value_type === "bool" && <Checkbox checked={!!v} onChange={(e) => set(e.target.checked)} />}
            {p.value_type === "list" && (
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                style={{ width: 260 }}
                value={(v as number | null) ?? undefined}
                onChange={(nv) => set(nv ?? null)}
                options={p.options.filter((o) => o.is_active || o.id === v).map((o) => ({ value: o.id, label: o.value }))}
              />
            )}
          </Form.Item>
        );
      })}
      <Space>
        <Button type="primary" loading={mutation.isPending} onClick={() => mutation.mutate()}>
          Сохранить
        </Button>
        <Button
          onClick={() => {
            setEditing(false);
            setTypeId(valuesQuery.data?.type_id ?? null);
            setValues(valuesQuery.data?.values ?? {});
          }}
        >
          Отмена
        </Button>
      </Space>
    </Form>
  );
}
