import { useMemo, useState } from "react";
import { isAxiosError } from "axios";
import { Button, Form, Input, Modal, Select, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listMaterialSkus } from "../api/dictionaries";
import { addPropertyOption, type ItemProperty } from "../api/itemTypes";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

/** «+ цвет из плёнки»: новый цвет двери берётся из справочника плёнки
 * (материал · цвет), название — коммерческое (можно поправить). Так в
 * списке нет дублей, а цвет связан с плёнкой для потребности и закрепления
 * плёнки за панелями. */
export default function NewFilmColorButton({ property, onCreated }: { property: ItemProperty; onCreated: (optionId: number) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="small" type="link" onClick={() => setOpen(true)} style={{ paddingInline: 4 }}>
        + цвет из плёнки
      </Button>
      {open && <NewFilmColorModal property={property} onClose={() => setOpen(false)} onCreated={onCreated} />}
    </>
  );
}

function NewFilmColorModal({
  property,
  onClose,
  onCreated,
}: {
  property: ItemProperty;
  onClose: () => void;
  onCreated: (optionId: number) => void;
}) {
  const qc = useQueryClient();
  const skusQuery = useQuery({ queryKey: ["material-skus"], queryFn: () => listMaterialSkus() });
  // Пары «материал · цвет» из активной плёнки (толщина и производитель — у детали).
  const pairs = useMemo(() => {
    const seen = new Map<string, { material: string; color: string }>();
    for (const s of skusQuery.data ?? []) {
      if (!s.is_active) continue;
      const key = `${s.material.name}|${s.color.name}`;
      if (!seen.has(key)) seen.set(key, { material: s.material.name, color: s.color.name });
    }
    return [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0], "ru"));
  }, [skusQuery.data]);
  const [pair, setPair] = useState<string | undefined>();
  const [name, setName] = useState("");
  const chosen = pairs.find(([k]) => k === pair)?.[1];
  const taken = property.options.some((o) => o.value.trim().toLowerCase() === name.trim().toLowerCase());

  const mutation = useMutation({
    mutationFn: () =>
      addPropertyOption(property.id, {
        value: name.trim(),
        params: { материал_плёнки: chosen!.material, цвет_плёнки: chosen!.color },
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["item-types"] });
      message.success(`Цвет «${r.value}» добавлен`);
      onCreated(r.option_id);
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось добавить цвет")),
  });

  return (
    <Modal
      open
      title="Новый цвет из плёнки"
      onCancel={onClose}
      okText="Добавить"
      cancelText="Отмена"
      okButtonProps={{ disabled: !chosen || !name.trim() || taken, loading: mutation.isPending }}
      onOk={() => mutation.mutate()}
      destroyOnHidden
    >
      <Form layout="vertical">
        <Form.Item label="Плёнка (материал · цвет)" required>
          <Select
            showSearch
            optionFilterProp="label"
            loading={skusQuery.isLoading}
            placeholder="Найдите цвет плёнки"
            value={pair}
            onChange={(v: string) => {
              setPair(v);
              const p = pairs.find(([k]) => k === v)?.[1];
              if (p && !name.trim()) setName(`${p.material} ${p.color}`);
            }}
            options={pairs.map(([k, p]) => ({ value: k, label: `${p.material} · ${p.color}` }))}
          />
        </Form.Item>
        <Form.Item
          label="Название цвета двери"
          required
          validateStatus={taken ? "error" : undefined}
          help={taken ? "Такой цвет уже есть в списке" : "Как в прайсе и 1С, например «ПЭТ Бежевый (cream silk)»"}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Form.Item>
        <Typography.Text type="secondary">
          ПЭТ 2Д или 3Д, толщина и производитель — у конкретной панели: если по цвету плёнка одна, закрепится сама.
        </Typography.Text>
      </Form>
    </Modal>
  );
}
