import { useEffect } from "react";
import { Alert, Button, Checkbox, Descriptions, Form, Input, InputNumber, Modal, Select, Space, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Dayjs } from "dayjs";
import OccurredAtField from "../OccurredAtField";
import FilmRestrictionPicker from "../FilmRestrictionPicker";
import LocationSelect from "../LocationSelect";
import { toOccurredAtIso } from "../../utils/occurredAt";
import { apiErrorMessage } from "../../utils/apiError";
import { listWriteOffReasons } from "../../api/writeOffReasons";
import { adjustUnit, getReturnPreview, getUnit, placeUnit, returnUnit, writeOffUnit, type MaterialUnit } from "../../api/units";
import { adjustPartUnit, getPartUnit, returnPartUnit, writeOffPartUnit, type PartUnit } from "../../api/partUnits";
import { placePartUnit } from "../../api/partStorage";
import { suggestLocation } from "../../api/storage";
import { listAreas } from "../../api/areas";
import { OP_DONE, OP_LABEL, lotTitle, type LotOp, type LotRef } from "./lotOps";

interface Values {
  location_code?: string;
  qty?: number;
  reason?: string;
  note?: string;
  film_restriction?: string | null;
  // корректировка рулона: ширина и тип (рулон / штрипс)
  width_mm?: number;
  is_strip?: boolean;
  /** возврат рулона: остаток сразу списать */
  write_off?: boolean;
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
  /** Обновлённая запись партии (рулон или партия п/ф) — экрану, чтобы показать новое состояние. */
  onDone?: (updated: MaterialUnit | PartUnit) => void;
}) {
  const [form] = Form.useForm<Values>();
  const qc = useQueryClient();
  const film = lot.kind === "plenka";
  const unit = lot.unit;

  // участок — названием, даже если экран передал код
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaName = lot.area_name ? (areasQuery.data?.find((a) => a.code === lot.area_name)?.name ?? lot.area_name) : null;
  const reasonsQuery = useQuery({
    queryKey: ["write-off-reasons", film ? "warehouse" : "parts"],
    queryFn: () => listWriteOffReasons(film ? "warehouse" : "parts"),
    enabled: op === "writeoff" || (film && op === "return"),
  });
  const returnWriteOff = Form.useWatch("write_off", form);
  const previewQuery = useQuery({
    queryKey: ["return-preview", lot.lot_id],
    queryFn: () => getReturnPreview(lot.lot_id),
    enabled: film && op === "return",
  });
  const expected = previewQuery.data?.expected_return_length_m;
  // Корректировка — по полной записи партии: у п/ф сервер правит общее
  // количество (вместе с отчитанным), а человек считает то, что лежит;
  // у рулона — длину по учёту (без вычета расхода по отчётам).
  const fullQuery = useQuery({
    queryKey: ["lot-full", lot.kind, lot.lot_id],
    queryFn: async () => {
      if (film) {
        const u = await getUnit(lot.lot_id);
        return { total: u.length_m, free: u.length_m, restriction: null as string | null, width: u.width_mm, is_strip: u.is_strip };
      }
      const u = await getPartUnit(lot.lot_id);
      return { total: u.quantity_pieces, free: u.quantity_available, restriction: u.film_restriction, width: null, is_strip: null };
    },
    enabled: op === "adjust",
  });
  const full = fullQuery.data;
  const reported = full ? Math.max(0, full.total - full.free) : 0;
  useEffect(() => {
    if (full && form.getFieldValue("qty") == null)
      form.setFieldsValue({
        qty: film ? full.total : full.free,
        film_restriction: full.restriction ?? undefined,
        width_mm: full.width ?? undefined,
        is_strip: full.is_strip ?? undefined,
      });
  }, [full, film, form]);
  useEffect(() => {
    if (expected != null && form.getFieldValue("qty") == null) form.setFieldsValue({ qty: expected });
  }, [expected, form]);

  const suggest = useMutation({
    mutationFn: () => suggestLocation({ material_sku_id: lot.sku_id!, is_strip: lot.is_strip }),
    onSuccess: (code) => (code ? form.setFieldsValue({ location_code: code }) : message.info("Свободной ячейки по правилам нет — укажите вручную")),
  });

  // рулон без адреса — сразу предложить ячейку по правилам (как было в карточке материала)
  useEffect(() => {
    if (op === "move" && film && lot.sku_id != null && !lot.location_code) suggest.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = useMutation({
    mutationFn: async (v: Values) => {
      const at = toOccurredAtIso(v.occurred_at);
      const id = lot.lot_id;
      if (op === "move") return film ? placeUnit(id, v.location_code!.trim(), at) : placePartUnit(id, v.location_code!.trim(), at);
      if (op === "return")
        return film
          ? returnUnit(id, {
              actual_length_m: v.qty!,
              // рулон израсходован — остаток списывается тем же действием, без захода «на хранение»
              write_off_reason: v.write_off ? v.reason : undefined,
              write_off_note: v.write_off ? v.note || undefined : undefined,
              occurred_at: at,
            })
          : returnPartUnit(id, v.qty!, at);
      if (op === "writeoff")
        return film
          ? writeOffUnit(id, v.reason!, v.note || undefined, at)
          : writeOffPartUnit(id, { quantity_pieces: v.qty!, reason: v.reason!, note: v.note || undefined, occurred_at: at });
      if (!full) throw new Error("Партия не загружена");
      return film
        ? adjustUnit(id, {
            actual_length_m: v.qty!,
            // ширину и тип шлём, только если поменяли — иначе сервер не трогает
            width_mm: v.width_mm != null && v.width_mm !== full.width ? v.width_mm : undefined,
            is_strip: v.is_strip != null && v.is_strip !== full.is_strip ? v.is_strip : undefined,
            reason: v.reason!.trim(),
            note: v.note || undefined,
            occurred_at: at,
          })
        : adjustPartUnit(id, {
            actual_quantity_pieces: v.qty! + reported,
            reason: v.reason!.trim(),
            note: v.note || undefined,
            // пометка плёнки на партии («Ламис», «с кромкой»…): поставить / снять
            film_restriction: v.film_restriction ?? undefined,
            clear_film_restriction: !v.film_restriction && !!full.restriction,
            occurred_at: at,
          });
    },
    onSuccess: (updated) => {
      message.success(`${lotTitle(lot)} — ${OP_DONE[op]}`);
      // остатки, движения и карточки обоих видов
      for (const key of ["unified-lots", "unified-movements", "materials-explorer", "units", "unit", "part-units", "part-unit", "part-stock", "material-card", "storage", "part-rack-occupancy", "rack-occupancy", "storage-places", "lot-full", "return-preview"])
        qc.invalidateQueries({ queryKey: [key] });
      onDone?.(updated);
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, `Не удалось: ${OP_LABEL[op].toLowerCase()}`)),
  });

  // корректировка подставляется после загрузки полной партии (fullQuery)
  const initialQty = op === "writeoff" ? lot.qty : op === "adjust" ? undefined : film ? undefined : lot.qty;

  return (
    <Modal
      open
      title={`${OP_LABEL[op]} — ${lotTitle(lot)}`}
      onCancel={onClose}
      okText={OP_LABEL[op]}
      okButtonProps={{ danger: op === "writeoff", loading: run.isPending, disabled: op === "adjust" && !full }}
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
          {areaName ? ` · ${areaName}` : ""}
          {lot.location_code ? ` · ${lot.location_code}` : ""}
        </Descriptions.Item>
      </Descriptions>
      <Form form={form} layout="vertical" initialValues={{ qty: initialQty, location_code: lot.location_code ?? undefined }} onFinish={(v) => run.mutate(v)}>
        {op === "move" && (
          <Form.Item label="Адрес ячейки" required>
            <Space.Compact style={{ width: "100%" }}>
              <Form.Item name="location_code" noStyle rules={[{ required: true, whitespace: true, message: "Укажите адрес" }]}>
                {film ? (
                  // реальные полки с занятостью; закрытые зонированием под другую плёнку не показываются
                  <LocationSelect sku={lot.sku} placeholder="Выберите полку" />
                ) : (
                  <Input placeholder="например, ЗГ-1-01" autoFocus />
                )}
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
                  : "Измерьте остаток и введите факт (0 — израсходован полностью); расход досчитается"
                : `На участке ${fmt(lot.qty)} шт; меньше — остальное считается израсходованным`
            }
            rules={[{ required: true, message: "Укажите количество" }]}
          >
            <InputNumber min={0} max={film ? undefined : lot.qty} step={film ? 0.1 : 1} style={{ width: "100%" }} inputMode="decimal" autoFocus />
          </Form.Item>
        )}
        {op === "return" && film && (
          <>
            <Form.Item name="write_off" valuePropName="checked" style={{ marginTop: -8 }}>
              <Checkbox>Рулон израсходован — остаток сразу списать</Checkbox>
            </Form.Item>
            {returnWriteOff && (
              <>
                <Form.Item name="reason" label="Причина списания остатка" rules={[{ required: true, message: "Выберите причину" }]}>
                  <Select loading={reasonsQuery.isLoading} options={(reasonsQuery.data ?? []).map((r) => ({ value: r.code, label: r.name }))} />
                </Form.Item>
                <Form.Item name="note" label="Комментарий">
                  <Input />
                </Form.Item>
              </>
            )}
          </>
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
            <Form.Item
              name="qty"
              label={film ? "Длина рулона по учёту, м" : "Фактически в наличии, шт"}
              extra={
                !full
                  ? "Загружаю партию…"
                  : film
                    ? `По учёту ${fmt(full.total)} м${lot.status.replace(/_/g, " ") === "Выдан участку" ? "; расход по отчётам вычитается отдельно" : ""}`
                    : reported > 0
                      ? `В партии ${fmt(full.total)} шт, из них ${fmt(reported)} уже отчитаны в производстве — введите, сколько лежит`
                      : `По учёту ${fmt(full.total)} шт`
              }
              rules={[{ required: true, message: "Укажите количество" }]}
            >
              <InputNumber min={0} step={film ? 0.1 : 1} style={{ width: "100%" }} inputMode="decimal" autoFocus />
            </Form.Item>
            {film && (
              <Space size={12} style={{ width: "100%" }} wrap>
                <Form.Item name="width_mm" label="Ширина, мм" rules={[{ required: true, message: "Ширина" }]}>
                  <InputNumber min={1} style={{ width: 140 }} />
                </Form.Item>
                <Form.Item name="is_strip" label="Тип">
                  <Select
                    style={{ width: 140 }}
                    options={[
                      { value: false, label: "Рулон" },
                      { value: true, label: "Штрипс" },
                    ]}
                  />
                </Form.Item>
              </Space>
            )}
            <Form.Item name="reason" label="Причина корректировки" rules={[{ required: true, whitespace: true, message: "Укажите причину" }]}>
              <Input placeholder="например, пересчитали при инвентаризации" />
            </Form.Item>
            <Form.Item name="note" label="Комментарий">
              <Input />
            </Form.Item>
            {!film && (
              <Form.Item name="film_restriction" label="Пометка по плёнке (необязательно)">
                <FilmRestrictionPicker />
              </Form.Item>
            )}
          </>
        )}

        <OccurredAtField />
      </Form>
    </Modal>
  );
}
