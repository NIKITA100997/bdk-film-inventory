import { useState } from "react";
import { Alert, Button, Checkbox, Divider, Form, Input, InputNumber, Modal, Segmented, Space, Typography, message } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import DictAutoComplete from "../../components/DictAutoComplete";
import { useAuth } from "../../auth/AuthContext";
import { adjustUnit, bulkEditUnits, placeUnit, reassignUnitSku, type MaterialUnit } from "../../api/units";
import { apiErrorMessage } from "../../utils/apiError";

function usePerms() {
  const { user } = useAuth();
  const has = (c: string) => !!user?.is_superuser || !!user?.permissions.includes(c);
  return { sku: has("materials.manage"), correct: has("units.correct"), place: has("units.place") };
}

const PLACEABLE = new Set(["Принят", "На_хранении"]);

interface EditValues {
  material: string;
  color: string;
  thickness: number;
  manufacturer: string;
  is_strip: boolean;
  width_mm: number;
  length_m: number;
  location_code?: string;
  reason?: string;
}

/** Правка одной единицы плёнки из «Остатков» — всё в одном окне:
 * номенклатура (исправление ошибки ввода, materials.manage), тип рулон/
 * штрипс, ширина и длина (корректировка с причиной и событием в истории,
 * units.correct), место на стеллаже (units.place, для принятых и на
 * хранении). Меняется только то, что правили. */
export function UnitEditModal({ unit, onClose }: { unit: MaterialUnit; onClose: () => void }) {
  const qc = useQueryClient();
  const perms = usePerms();
  const [form] = Form.useForm<EditValues>();
  const initial: EditValues = {
    material: unit.material_sku.material.name,
    color: unit.material_sku.color.name,
    thickness: unit.material_sku.thickness.value_mm,
    manufacturer: unit.material_sku.manufacturer.name,
    is_strip: unit.is_strip,
    width_mm: unit.width_mm,
    length_m: unit.length_m,
    location_code: unit.location_code ?? "",
  };
  const isStrip = Form.useWatch("is_strip", form) ?? unit.is_strip;
  const width = Form.useWatch("width_mm", form) ?? unit.width_mm;
  const length = Form.useWatch("length_m", form) ?? unit.length_m;
  const correcting = isStrip !== unit.is_strip || width !== unit.width_mm || length !== unit.length_m;
  const canPlaceHere = perms.place && PLACEABLE.has(unit.status);

  const mutation = useMutation({
    mutationFn: async (v: EditValues) => {
      const done: string[] = [];
      const skuChanged =
        v.material !== initial.material || v.color !== initial.color || v.thickness !== initial.thickness || v.manufacturer !== initial.manufacturer;
      if (perms.sku && skuChanged) {
        await reassignUnitSku(unit.id, { material: v.material, color: v.color, thickness: v.thickness, manufacturer: v.manufacturer });
        done.push("номенклатура");
      }
      if (perms.correct && (v.is_strip !== unit.is_strip || v.width_mm !== unit.width_mm || v.length_m !== unit.length_m)) {
        await adjustUnit(unit.id, {
          actual_length_m: v.length_m,
          width_mm: v.width_mm !== unit.width_mm ? v.width_mm : undefined,
          is_strip: v.is_strip !== unit.is_strip ? v.is_strip : undefined,
          reason: (v.reason ?? "").trim(),
        });
        done.push("тип / размеры");
      }
      const loc = (v.location_code ?? "").trim();
      if (canPlaceHere && loc && loc !== (unit.location_code ?? "")) {
        await placeUnit(unit.id, loc);
        done.push("место");
      }
      return done;
    },
    onSuccess: (done) => {
      qc.invalidateQueries({ queryKey: ["materials-explorer"] });
      qc.invalidateQueries({ queryKey: ["material-card"] });
      qc.invalidateQueries({ queryKey: ["material-card-group"] });
      message.success(done.length ? `Единица №${unit.id}: изменено — ${done.join(", ")}` : "Ничего не изменилось");
      onClose();
    },
    onError: (e) => {
      // Часть правок могла пройти до ошибки — список обновится с тем, что сохранилось.
      qc.invalidateQueries({ queryKey: ["materials-explorer"] });
      message.error(apiErrorMessage(e, "Не удалось сохранить изменения"));
    },
  });

  return (
    <Modal title={`Изменить единицу №${unit.id}`} open onCancel={onClose} footer={null} destroyOnHidden width={560}>
      <Form form={form} layout="vertical" initialValues={initial} onFinish={(v) => mutation.mutate(v)}>
        <Typography.Text strong>Номенклатура</Typography.Text>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          Исправление ошибки ввода: единица остаётся той же — номер и история не меняются.
        </Typography.Paragraph>
        <Space wrap style={{ width: "100%" }} size={[8, 0]}>
          <Form.Item name="material" label="Материал" rules={[{ required: true }]}>
            <DictAutoComplete kind="materials" disabled={!perms.sku} />
          </Form.Item>
          <Form.Item name="color" label="Цвет" rules={[{ required: true }]}>
            <DictAutoComplete kind="colors" disabled={!perms.sku} />
          </Form.Item>
          <Form.Item name="thickness" label="Толщина, мм" rules={[{ required: true }]}>
            <InputNumber min={0} step={0.01} disabled={!perms.sku} />
          </Form.Item>
          <Form.Item name="manufacturer" label="Производитель" rules={[{ required: true }]}>
            <DictAutoComplete kind="manufacturers" disabled={!perms.sku} />
          </Form.Item>
        </Space>

        <Divider style={{ margin: "8px 0 12px" }} />
        <Typography.Text strong>Тип и размеры</Typography.Text>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          Корректировка: в истории единицы останется запись с причиной.
        </Typography.Paragraph>
        <Space wrap size={[16, 0]}>
          <Form.Item name="is_strip" label="Тип">
            <Segmented
              disabled={!perms.correct}
              options={[
                { label: "Рулон", value: false },
                { label: "Штрипс", value: true },
              ]}
            />
          </Form.Item>
          <Form.Item name="width_mm" label="Ширина, мм" rules={[{ required: true }]}>
            <InputNumber min={1} disabled={!perms.correct} />
          </Form.Item>
          <Form.Item name="length_m" label="Длина, м" rules={[{ required: true }]}>
            <InputNumber min={0} step={0.1} disabled={!perms.correct} />
          </Form.Item>
        </Space>
        {correcting && (
          <Form.Item name="reason" label="Причина корректировки" rules={[{ required: true, message: "Укажите причину" }]}>
            <Input placeholder="Например: при приёмке отметили как рулон" />
          </Form.Item>
        )}

        <Divider style={{ margin: "8px 0 12px" }} />
        <Form.Item
          name="location_code"
          label="Место (ячейка стеллажа)"
          extra={canPlaceHere ? "Например, Р-3-07." : "Разместить можно только принятую единицу или на хранении."}
        >
          <Input disabled={!canPlaceHere} placeholder="Р-3-07" />
        </Form.Item>

        {!perms.sku && !perms.correct && !canPlaceHere && (
          <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Нет прав на изменение этой единицы" />
        )}
        <Button type="primary" htmlType="submit" block loading={mutation.isPending}>
          Сохранить
        </Button>
      </Form>
    </Modal>
  );
}

interface BulkValues {
  is_strip?: boolean;
  material?: string;
  color?: string;
  thickness?: number;
  manufacturer?: string;
  location_code?: string;
  reason?: string;
}

/** Массовая правка выбранных единиц — одним действием на сервере, всё или
 * ничего: отметьте, что менять, остальное останется как есть. */
export function UnitBulkEditModal({ unitIds, onClose, onDone }: { unitIds: number[]; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const perms = usePerms();
  const [form] = Form.useForm<BulkValues>();
  const [what, setWhat] = useState({ type: false, sku: false, place: false });
  const mutation = useMutation({
    mutationFn: (v: BulkValues) =>
      bulkEditUnits({
        unit_ids: unitIds,
        is_strip: what.type ? (v.is_strip ?? false) : undefined,
        ...(what.sku ? { material: v.material, color: v.color, thickness: v.thickness, manufacturer: v.manufacturer } : {}),
        location_code: what.place ? v.location_code : undefined,
        reason: what.type ? v.reason : undefined,
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["materials-explorer"] });
      qc.invalidateQueries({ queryKey: ["material-card-group"] });
      message.success(`Изменено единиц: ${r.updated} из ${unitIds.length}`);
      onDone();
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось изменить выбранные")),
  });

  return (
    <Modal title={`Изменить выбранные (${unitIds.length})`} open onCancel={onClose} footer={null} destroyOnHidden width={560}>
      <Typography.Paragraph type="secondary">
        Отметьте, что поменять у всех выбранных. Проверяются все сразу: если хоть одна не подходит — не меняется ни одна.
      </Typography.Paragraph>
      <Form form={form} layout="vertical" initialValues={{ is_strip: true }} onFinish={(v) => mutation.mutate(v)}>
        <Checkbox disabled={!perms.correct} checked={what.type} onChange={(e) => setWhat((w) => ({ ...w, type: e.target.checked }))}>
          <b>Тип: рулон / штрипс</b>
        </Checkbox>
        {what.type && (
          <div style={{ margin: "8px 0 12px 24px" }}>
            <Form.Item name="is_strip" style={{ marginBottom: 8 }}>
              <Segmented
                options={[
                  { label: "Рулон", value: false },
                  { label: "Штрипс", value: true },
                ]}
              />
            </Form.Item>
            <Form.Item name="reason" label="Причина корректировки" rules={[{ required: true, message: "Укажите причину" }]}>
              <Input placeholder="Например: при приёмке отметили как рулон" />
            </Form.Item>
          </div>
        )}
        <Divider style={{ margin: "8px 0" }} />
        <Checkbox disabled={!perms.sku} checked={what.sku} onChange={(e) => setWhat((w) => ({ ...w, sku: e.target.checked }))}>
          <b>Номенклатура</b> (материал, цвет, толщина, производитель)
        </Checkbox>
        {what.sku && (
          <Space wrap size={[8, 0]} style={{ margin: "8px 0 0 24px" }}>
            <Form.Item name="material" label="Материал" rules={[{ required: true }]}>
              <DictAutoComplete kind="materials" />
            </Form.Item>
            <Form.Item name="color" label="Цвет" rules={[{ required: true }]}>
              <DictAutoComplete kind="colors" />
            </Form.Item>
            <Form.Item name="thickness" label="Толщина, мм" rules={[{ required: true }]}>
              <InputNumber min={0} step={0.01} />
            </Form.Item>
            <Form.Item name="manufacturer" label="Производитель" rules={[{ required: true }]}>
              <DictAutoComplete kind="manufacturers" />
            </Form.Item>
          </Space>
        )}
        <Divider style={{ margin: "8px 0" }} />
        <Checkbox disabled={!perms.place} checked={what.place} onChange={(e) => setWhat((w) => ({ ...w, place: e.target.checked }))}>
          <b>Место</b> — разместить все в одну ячейку
        </Checkbox>
        {what.place && (
          <Form.Item
            name="location_code"
            rules={[{ required: true, message: "Укажите ячейку" }]}
            extra="Только для принятых и на хранении."
            style={{ margin: "8px 0 0 24px" }}
          >
            <Input placeholder="Р-3-07" />
          </Form.Item>
        )}
        <Button
          type="primary"
          htmlType="submit"
          block
          style={{ marginTop: 16 }}
          disabled={!what.type && !what.sku && !what.place}
          loading={mutation.isPending}
        >
          Применить к {unitIds.length}
        </Button>
      </Form>
    </Modal>
  );
}
