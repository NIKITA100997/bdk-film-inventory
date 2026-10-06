import { useEffect } from "react";
import { Alert, Button, Descriptions, Form, Input, InputNumber, Modal, Select, Space, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Dayjs } from "dayjs";
import OccurredAtField from "../OccurredAtField";
import { toOccurredAtIso } from "../../utils/occurredAt";
import { apiErrorMessage } from "../../utils/apiError";
import { listWriteOffReasons } from "../../api/writeOffReasons";
import { adjustUnit, getReturnPreview, placeUnit, returnUnit, writeOffUnit } from "../../api/units";
import { adjustPartUnit, returnPartUnit, writeOffPartUnit } from "../../api/partUnits";
import { placePartUnit } from "../../api/partStorage";
import { suggestLocation } from "../../api/storage";
import { OP_DONE, OP_LABEL, lotTitle, type LotOp, type LotRef } from "./lotOps";

interface Values {
  location_code?: string;
  qty?: number;
  reason?: string;
  note?: string;
  occurred_at?: Dayjs | null;
}

const fmt = (v: number) => `${Math.round(v * 100) / 100}`;

/** Одно окно операции с партией (слой 4 единой модели, 06.10): переместить,
 * вернуть на склад, списать, скорректировать — одинаково для рулона плёнки
 * и партии п/ф. Поля и подписи общие, единица — у партии (м или шт);
 * отличия видов — только там, где они есть на самом деле: рулон
 * списывается целиком (частично — «Списать метраж»), у рулона есть
 * подбор адреса и ожидаемый остаток при возврате. */
export default function LotOperationModal({
  lot,
  op,
  onClose,
  onDone,
}: {
  lot: LotRef;
  op: LotOp;
  onClose: () => void;
  onDone?: () => void;
}) {
  const [form] = Form.useForm<Values>();
  const qc = useQueryClient();
  const film = lot.kind === "plenka";
  const unit = lot.unit;

  const reasonsQuery = useQuery({
    queryKey: ["write-off-reasons", film ? "warehouse" : "parts"],
    queryFn: () => listWriteOffReasons(film ? "warehouse" : "parts"),
    enabled: op === "writeoff",
  });
  const previewQuery = useQuery({
    queryKey: ["return-preview", lot.lot_id],
    queryFn: () => getReturnPreview(lot.lot_id),
    enabled: film && op === "return",
  });
  const expected = previewQuery.data?.expected_return_length_m;
  useEffect(() => {
    if (expected != null && form.getFieldValue("qty") == null) form.setFieldsValue({ qty: expected });
  }, [expected, form]);

  const suggest = useMutation({
    mutationFn: () => suggestLocation({ material_sku_id: lot.sku_id!, is_strip: lot.is_strip }),
    onSuccess: (code) => (code ? form.setFieldsValue({ location_code: code }) : message.info("Свободного места по правилам нет — укажите вручную")),
  });

  const run = useMutation({
    mutationFn: async (v: Values) => {
      const at = toOccurredAtIso(v.occurred_at);
      const id = lot.lot_id;
      if (op === "move") return film ? placeUnit(id, v.location_code!.trim(), at) : placePartUnit(id, v.location_code!.trim(), at);
      if (op === "return")
        return film ? returnUnit(id, { actual_length_m: v.qty!, occurred_at: at }) : returnPartUnit(id, v.qty!, at);
      if (op === "writeoff")
        return film
          ? writeOffUnit(id, v.reason!, v.note || undefined, at)
          : writeOffPartUnit(id, { quantity_pieces: v.qty!, reason: v.reason!, note: v.note || undefined, occurred_at: at });
      return film
        ? adjustUnit(id, { actual_length_m: v.qty!, reason: v.reason!.trim(), note: v.note || undefined, occurred_at: at })
        : adjustPartUnit(id, { actual_quantity_pieces: v.qty!, reason: v.reason!.trim(), note: v.note || undefined, occurred_at: at });
    },
    onSuccess: () => {
      message.success(`${lotTitle(lot)} — ${OP_DONE[op]}`);
      // остатки, движения и карточки обоих видов
      for (const key of ["unified-lots", "unified-movements", "materials-explorer", "units", "unit", "part-units", "part-unit", "part-stock", "material-card", "storage"])
        qc.invalidateQueries({ queryKey: [key] });
      onDone?.();
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, `Не удалось: ${OP_LABEL[op].toLowerCase()}`)),
  });

  // у выданного рулона qty — остаток за вычетом расхода, а корректируется
  // длина по учёту: без length_m не подставляем, пусть введут факт
  const filmAdjust = lot.length_m ?? (lot.status.replace(/_/g, " ") === "Выдан участку" ? undefined : lot.qty);
  const initialQty = op === "writeoff" ? lot.qty : op === "adjust" ? (film ? filmAdjust : lot.qty) : film ? undefined : lot.qty;

  return (
    <Modal
      open
      title={`${OP_LABEL[op]} — ${lotTitle(lot)}`}
      onCancel={onClose}
      okText={OP_LABEL[op]}
      okButtonProps={{ danger: op === "writeoff", loading: run.isPending }}
      cancelText="Отмена"
      onOk={() => form.submit()}
      destroyOnHidden
    >
      <Descriptions size="small" column={1} style={{ marginBottom: 12 }}>
        <Descriptions.Item label="Позиция">{lot.item_name}</Descriptions.Item>
        <Descriptions.Item label="Сейчас">
          {fmt(lot.qty)} {unit}
          {lot.detail ? ` · ${lot.detail}` : ""}
          {lot.stage ? ` · этап «${lot.stage}»` : ""} · {lot.status.replace(/_/g, " ")}
          {lot.area_name ? ` · ${lot.area_name}` : ""}
          {lot.location_code ? ` · ${lot.location_code}` : ""}
        </Descriptions.Item>
      </Descriptions>
      <Form form={form} layout="vertical" initialValues={{ qty: initialQty, location_code: lot.location_code ?? undefined }} onFinish={(v) => run.mutate(v)}>
        {op === "move" && (
          <Form.Item label="Адрес ячейки" required>
            <Space.Compact style={{ width: "100%" }}>
              <Form.Item name="location_code" noStyle rules={[{ required: true, whitespace: true, message: "Укажите адрес" }]}>
                <Input placeholder="например, Стеллаж 1-2-3" autoFocus />
              </Form.Item>
              {film && lot.sku_id != null && (
                <Button loading={suggest.isPending} onClick={() => suggest.mutate()}>
                  Подобрать
                </Button>
              )}
            </Space.Compact>
          </Form.Item>
        )}

        {op === "return" && (
          <Form.Item
            name="qty"
            label={film ? "Фактический остаток рулона, м" : "Возвращается на склад, шт"}
            extra={
              film
                ? expected != null
                  ? `По отчётам должно остаться ~${fmt(expected)} м — измерьте и введите факт`
                  : "Измерьте остаток и введите факт — расход досчитается"
                : `На участке ${fmt(lot.qty)} шт; меньше — остальное считается израсходованным`
            }
            rules={[{ required: true, message: "Укажите количество" }]}
          >
            <InputNumber min={0} max={film ? undefined : lot.qty} step={film ? 0.1 : 1} style={{ width: "100%" }} inputMode="decimal" autoFocus />
          </Form.Item>
        )}

        {op === "writeoff" && (
          <>
            {film ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message={`Списывается весь рулон — ${fmt(lot.qty)} м`}
                description="Списать часть метража — «Склад → Остатки → Списать метраж»."
              />
            ) : (
              <Form.Item name="qty" label="Списать, шт" rules={[{ required: true, message: "Укажите количество" }]}>
                <InputNumber min={1} max={lot.qty} style={{ width: "100%" }} inputMode="numeric" autoFocus />
              </Form.Item>
            )}
            <Form.Item name="reason" label="Причина" rules={[{ required: true, message: "Выберите причину" }]}>
              <Select loading={reasonsQuery.isLoading} options={(reasonsQuery.data ?? []).map((r) => ({ value: r.code, label: r.name }))} />
            </Form.Item>
            <Form.Item name="note" label="Комментарий">
              <Input />
            </Form.Item>
          </>
        )}

        {op === "adjust" && (
          <>
            <Typography.Paragraph type="secondary" style={{ marginTop: -4 }}>
              Корректировка не переписывает историю — добавляется запись «Корректировка» с причиной.
            </Typography.Paragraph>
            <Form.Item name="qty" label={film ? "Фактическая длина, м" : "Фактическое количество, шт"} rules={[{ required: true, message: "Укажите количество" }]}>
              <InputNumber min={0} step={film ? 0.1 : 1} style={{ width: "100%" }} inputMode="decimal" autoFocus />
            </Form.Item>
            <Form.Item name="reason" label="Причина корректировки" rules={[{ required: true, whitespace: true, message: "Укажите причину" }]}>
              <Input placeholder="например, пересчитали при инвентаризации" />
            </Form.Item>
            <Form.Item name="note" label="Комментарий">
              <Input />
            </Form.Item>
          </>
        )}

        <OccurredAtField />
      </Form>
    </Modal>
  );
}
