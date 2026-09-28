import { useEffect, useMemo, useState } from "react";
import { isAxiosError } from "axios";
import { Alert, AutoComplete, Checkbox, Form, InputNumber, Modal, Select, Space, Spin, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getItemProperties, isFilmColorProperty, listItemTypes, type PropertyValue } from "../api/itemTypes";
import NewFilmColorButton from "./NewFilmColorButton";
import { getTypeHints, variantsBatch } from "../api/modelBuilder";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

/** Вариант модели прямо из заказа: модель выбрана — задаёте размер, цвет,
 * кромку (с подсказками частых значений); такая позиция есть — берётся
 * она, нет — заводится с техкартой по правилам типа. Заранее заводить
 * каждый цвет не нужно. */
export default function VariantPicker({
  modelId,
  modelName,
  typeId,
  onPicked,
  onClose,
}: {
  modelId: number;
  modelName: string;
  typeId: number;
  onPicked: (itemId: number, name: string) => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const typesQuery = useQuery({ queryKey: ["item-types"], queryFn: () => listItemTypes() });
  const type = typesQuery.data?.find((t) => t.id === typeId);
  const modelProp = type?.properties.find((p) => p.code === type.model_property_code);
  const modelValuesQuery = useQuery({ queryKey: ["item-properties", modelId], queryFn: () => getItemProperties(modelId) });
  const optionId = modelProp ? (modelValuesQuery.data?.values[modelProp.id] as number | undefined) : undefined;
  const hintsQuery = useQuery({ queryKey: ["type-hints", typeId], queryFn: () => getTypeHints(typeId) });
  const [values, setValues] = useState<Record<number, PropertyValue>>({});

  // По умолчанию: список — самый частый вариант, да/нет — «нет».
  useEffect(() => {
    if (!type || !hintsQuery.data) return;
    setValues((prev) => {
      const next = { ...prev };
      for (const p of type.properties) {
        if (p.id === modelProp?.id || next[p.id] !== undefined) continue;
        if (p.value_type === "bool") next[p.id] = false;
        // Цвет — выбирают сами, не подставляем самый частый.
        else if (p.value_type === "list" && p.is_required && !isFilmColorProperty(p))
          next[p.id] = hintsQuery.data.properties[p.id]?.[0]?.value ?? null;
      }
      return next;
    });
  }, [type, hintsQuery.data, modelProp?.id]);

  const choices = useMemo(() => {
    const c: Record<number, PropertyValue[]> = {};
    for (const [k, v] of Object.entries(values)) if (v !== null && v !== "" && v !== undefined) c[Number(k)] = [v];
    if (modelProp && optionId) c[modelProp.id] = [optionId];
    return c;
  }, [values, modelProp, optionId]);
  const missing = (type?.properties ?? []).filter((p) => p.is_required && p.value_type !== "bool" && !choices[p.id]?.length);

  const previewQuery = useQuery({
    queryKey: ["variant-pick", typeId, choices],
    queryFn: () => variantsBatch(typeId, choices, false),
    enabled: !!type && !!optionId && missing.length === 0,
  });
  const row = previewQuery.data?.rows[0];

  const pickMutation = useMutation({
    mutationFn: () => variantsBatch(typeId, choices, true),
    onSuccess: (res) => {
      const r = res.rows[0];
      if (!r || r.status === "error" || !r.item_id) {
        message.error(r?.errors.join("; ") || "Не удалось подобрать вариант");
        return;
      }
      for (const key of [["items"], ["item-types"], ["type-hints"]]) qc.invalidateQueries({ queryKey: key });
      if (r.status === "created") message.success(`Заведён вариант «${r.name}»`);
      onPicked(r.item_id, r.name ?? "");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось подобрать вариант")),
  });

  const hints = hintsQuery.data?.properties ?? {};
  return (
    <Modal
      open
      width={640}
      title={`${modelName}: размер, цвет, кромка`}
      okText={row?.status === "exists" ? "Взять этот вариант" : "Завести и взять"}
      cancelText="Отмена"
      onCancel={onClose}
      okButtonProps={{ disabled: !row || row.status === "error", loading: pickMutation.isPending }}
      onOk={() => pickMutation.mutate()}
    >
      {!type || modelValuesQuery.isLoading ? (
        <Spin />
      ) : (
        <Form layout="vertical">
          {type.properties
            .filter((p) => p.id !== modelProp?.id)
            .map((p) => {
              const v = values[p.id];
              const set = (nv: PropertyValue) => setValues((prev) => ({ ...prev, [p.id]: nv }));
              const hint = hints[p.id] ?? [];
              const label = `${p.name}${p.unit ? `, ${p.unit}` : ""}`;
              return (
                <Form.Item key={p.id} label={label} required={p.is_required && p.value_type !== "bool"} style={{ marginBottom: 10 }}>
                  {p.value_type === "bool" ? (
                    <Checkbox checked={!!v} onChange={(e) => set(e.target.checked)} />
                  ) : p.value_type === "list" ? (
                    <Space size={4} wrap>
                      <Select
                        allowClear
                        showSearch
                        optionFilterProp="label"
                        style={{ width: 320 }}
                        value={(v as number | null) ?? undefined}
                        onChange={(nv) => set(nv ?? null)}
                        options={p.options.filter((o) => o.is_active).map((o) => ({ value: o.id, label: o.value }))}
                      />
                      {isFilmColorProperty(p) && <NewFilmColorButton property={p} onCreated={(id) => set(id)} />}
                    </Space>
                  ) : p.value_type === "number" ? (
                    <InputNumber style={{ width: 180 }} value={(v as number | null) ?? null} onChange={(nv) => set(nv)} />
                  ) : (
                    <AutoComplete
                      allowClear
                      style={{ width: "100%" }}
                      value={(v as string | null) ?? ""}
                      onChange={(nv) => set(nv)}
                      options={hint.map((h) => ({ value: String(h.value), label: `${h.value} (×${h.count})` }))}
                      filterOption={(input, opt) => String(opt?.value ?? "").toLowerCase().includes(input.toLowerCase())}
                      placeholder="Начните вводить или выберите"
                    />
                  )}
                  {p.value_type === "number" && hint.length > 0 && (
                    <Space size={[4, 4]} wrap style={{ marginTop: 4 }}>
                      {hint.map((h) => (
                        <Tag key={String(h.value)} style={{ cursor: "pointer", margin: 0 }} onClick={() => set(h.value)}>
                          {String(h.value)} <Typography.Text type="secondary">×{h.count}</Typography.Text>
                        </Tag>
                      ))}
                    </Space>
                  )}
                </Form.Item>
              );
            })}
        </Form>
      )}
      {missing.length > 0 ? (
        <Alert type="info" showIcon message={`Заполните: ${missing.map((p) => p.name).join(", ")}`} />
      ) : row ? (
        <Alert
          type={row.status === "error" ? "error" : row.status === "exists" ? "success" : "info"}
          showIcon
          message={row.name ?? "—"}
          description={
            row.status === "error"
              ? row.errors.join("; ")
              : row.status === "exists"
                ? "Такой вариант уже есть — возьмём его"
                : "Такого варианта ещё нет — заведётся с техкартой по правилам"
          }
        />
      ) : (
        previewQuery.isFetching && <Spin />
      )}
    </Modal>
  );
}
