import { useEffect, useState, type ReactNode } from "react";
import { optionLabel } from "../../../utils/optionLabel";
import { Button, Descriptions, Form, Select, Space, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getItemProperties,
  listItemTypes,
  setItemProperties,
  type ItemProperty,
  type PropertyValue,
} from "../../../api/itemTypes";
import PropertyInputs from "./PropertyInputs";
import { apiErrorMessage } from "../../../utils/apiError";

function showValue(p: ItemProperty, v: PropertyValue | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  if (p.value_type === "bool") return v ? "да" : "нет";
  if (p.value_type === "list") return optionLabel(p.options.find((o) => o.id === v));
  return `${v}${p.unit ? ` ${p.unit}` : ""}`;
}

/** Тип позиции и значения его свойств — в карточке номенклатуры (единая
 * модель, пункты 1–2). */
export default function ItemPropertiesSection({
  itemId,
  kindCode,
  canEdit,
  title,
  extra = [],
  extraAction,
}: {
  itemId: number;
  kindCode: string;
  canEdit: boolean;
  // заголовок раздела: «Изменить» — справа в заголовке, как у остальных разделов карточки
  title?: string;
  /** Ещё строки той же таблицы (параметры детали) — одной таблицей со свойствами. */
  extra?: { label: string; value: ReactNode }[];
  /** Ещё кнопка в заголовке (изменить параметры детали). */
  extraAction?: ReactNode;
}) {
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
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["item-properties", itemId] });
      qc.invalidateQueries({ queryKey: ["item-types"] });
      qc.invalidateQueries({ queryKey: ["techcard", itemId] });
      qc.invalidateQueries({ queryKey: ["items"] });
      if (res.rules_errors && res.rules_errors.length > 0)
        message.warning(`Свойства сохранены, но техкарта по правилам типа не пересчитана: ${res.rules_errors.join("; ")}`, 8);
      else message.success("Свойства сохранены");
      setEditing(false);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить свойства")),
  });

  if (valuesQuery.isLoading || typesQuery.isLoading) return <Typography.Text type="secondary">Загрузка…</Typography.Text>;

  if (!editing) {
    const editBtn = canEdit && kindTypes.length > 0 && (
      <Button size="small" onClick={() => setEditing(true)}>
        {extraAction ? "Изменить свойства" : "Изменить"}
      </Button>
    );
    const props = type?.properties ?? [];
    return (
      <Space direction="vertical" size="small" style={{ width: "100%" }}>
        {title && (
          <Space style={{ justifyContent: "space-between", width: "100%" }} align="center">
            <Typography.Title level={5} style={{ margin: 0 }}>
              {title}
            </Typography.Title>
            <Space size={6}>
              {editBtn}
              {extraAction}
            </Space>
          </Space>
        )}
        <Space>
          <Typography.Text>Тип: {type ? <b>{type.name}</b> : <Typography.Text type="secondary">не задан</Typography.Text>}</Typography.Text>
          {!title && editBtn}
        </Space>
        {kindTypes.length === 0 && !type && (
          <Typography.Text type="secondary">
            Для этого вида типов пока нет — их заводят во вкладке «Типы и свойства».
          </Typography.Text>
        )}
        {(props.length > 0 || extra.length > 0) && (
          <Descriptions size="small" column={{ xs: 1, md: 2 }} bordered>
            {props.map((p) => (
              <Descriptions.Item key={p.id} label={p.name}>
                {showValue(p, valuesQuery.data?.values[String(p.id)])}
              </Descriptions.Item>
            ))}
            {extra.map((e) => (
              <Descriptions.Item key={e.label} label={e.label}>
                {e.value}
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
      {type && <PropertyInputs type={type} values={values} onChange={setValues} />}
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
