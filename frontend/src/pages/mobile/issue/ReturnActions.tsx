import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  Input,
  InputNumber,
  Modal,
  Popover,
  Select,
  Space,
  Typography,
  message,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs, { type Dayjs } from "dayjs";
import ActionIcon from "../../../components/ActionIcon";
import { toOccurredAtIso } from "../../../utils/occurredAt";
import {
  getReturnPreview,
  placeUnit,
  printLabel,
  returnUnit,
} from "../../../api/units";
import { suggestLocation } from "../../../api/storage";
import { listWriteOffReasons } from "../../../api/writeOffReasons";
import {
  type ProductionTaskLineIssuedUnit,
} from "../../../api/production";
import { rollNo } from "../../../utils/lotNo";
import { issueErrorMessage } from "./model";

/** Приём возврата прямо в «Выдано по заданиям» — там же, где плёнку
 * выдавали, а не в отдельной карточке единицы (раздел про единый процесс
 * возврата). Длина остатка по расчёту (хорошие и брак за смену уже
 * учтены) прописывается автоматически — вводить/поправлять число негде.
 * Диалог сразу же предлагает место по правилу зонирования (если оно
 * есть) и позволяет указать полку вручную — приём и размещение одним
 * действием, а не отдельным походом на «Стеллажи → Без места». */
// Раздел про общий штрипс на детали одного задания — "Взять со склада"
// по одной строке, когда рядом (в этом же задании) есть другие ещё не
// решённые строки такой же ширины с уже готовым точным донором каждая:
// вместо того чтобы щёлкать "✓" по очереди на каждой, всплывающая
// подсказка сразу предлагает решить и по ним, одним нажатием на эту же
// кнопку. Siblings пуст (обычный случай, ширина уникальна в задании) —
// кнопка ведёт себя ровно как раньше, без лишнего клика на подтверждение.
export function AcceptStockAction({
  unitId,
  onAccept,
  siblings,
}: {
  unitId: number;
  onAccept: () => void;
  siblings: { label: string; unitId: number; accept: () => void }[];
}) {
  const [open, setOpen] = useState(false);
  const [unchecked, setUnchecked] = useState<Set<number>>(new Set());

  if (siblings.length === 0) {
    return (
      <ActionIcon tone="filled" tip={`Взять со склада — штрипс ${rollNo(unitId)}`} onClick={onAccept}>
        ✓
      </ActionIcon>
    );
  }

  const checkedCount = siblings.filter((s) => !unchecked.has(s.unitId)).length;
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      title="Взять со склада"
      content={
        <Space direction="vertical" style={{ width: 260 }}>
          <Typography.Text style={{ fontSize: 12.5 }}>
            Эта же ширина также нужна ещё в этом задании — на складе уже есть свой штрипс и для них, взять сразу?
          </Typography.Text>
          {siblings.map((s) => (
            <Checkbox
              key={s.unitId}
              checked={!unchecked.has(s.unitId)}
              onChange={(e) =>
                setUnchecked((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.delete(s.unitId);
                  else next.add(s.unitId);
                  return next;
                })
              }
            >
              {s.label} — штрипс {rollNo(s.unitId)}
            </Checkbox>
          ))}
          <Button
            type="primary"
            size="small"
            block
            onClick={() => {
              onAccept();
              siblings.forEach((s) => !unchecked.has(s.unitId) && s.accept());
              setOpen(false);
            }}
          >
            Взять со склада — штрипс {rollNo(unitId)}{checkedCount > 0 ? ` + ещё ${checkedCount}` : ""}
          </Button>
        </Space>
      }
    >
      <ActionIcon tone="filled" tip={`Взять со склада — штрипс ${rollNo(unitId)} (есть и на соседние строки)`} onClick={() => setOpen(true)}>
        ✓
      </ActionIcon>
    </Popover>
  );
}

export function AcceptReturnButton({ unit }: { unit: ProductionTaskLineIssuedUnit }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="small" type="primary" onClick={() => setOpen(true)}>
        Принять {rollNo(unit.id)}
      </Button>
      {open && <AcceptReturnModal unit={unit} onClose={() => setOpen(false)} />}
    </>
  );
}

export function AcceptReturnModal({ unit, onClose }: { unit: ProductionTaskLineIssuedUnit; onClose: () => void }) {
  const qc = useQueryClient();
  const [locationCode, setLocationCode] = useState("");
  const [locationTouched, setLocationTouched] = useState(false);
  const [occurredAt, setOccurredAt] = useState<Dayjs | null>(null);

  const previewQuery = useQuery({ queryKey: ["return-preview", unit.id], queryFn: () => getReturnPreview(unit.id) });
  const suggestionQuery = useQuery({
    queryKey: ["suggest-location", "accept-return", unit.id],
    queryFn: () => suggestLocation({ material_sku_id: unit.material_sku_id, is_strip: unit.is_strip }),
  });

  useEffect(() => {
    if (suggestionQuery.data && !locationTouched) setLocationCode(suggestionQuery.data);
  }, [suggestionQuery.data, locationTouched]);

  const expected = previewQuery.data?.expected_return_length_m;
  const [actualLength, setActualLength] = useState<number | null>(null);
  const [lengthTouched, setLengthTouched] = useState(false);

  useEffect(() => {
    if (!lengthTouched) setActualLength(expected ?? unit.length_m);
  }, [expected, unit.length_m, lengthTouched]);

  // Раздел про "штрипсы с остатком 0 в баннере Готово к возврату" —
  // рулон, израсходованный в ноль на участке, не нужно сначала "принять
  // на склад", а потом отдельно списывать: тот же приём, что и в
  // мобильной карточке единицы (UnitCard.tsx) — write_off_reason в
  // ReturnRequest списывает остаток тем же действием. Чекбокс сам
  // включается, когда фактическая длина — 0 (обычный случай для этого
  // баннера), но кладовщик может его снять, если решил всё-таки принять
  // огрызок на склад.
  const [writeOff, setWriteOff] = useState(false);
  const [writeOffTouched, setWriteOffTouched] = useState(false);
  const [writeOffReason, setWriteOffReason] = useState<string | undefined>(undefined);
  const [writeOffNote, setWriteOffNote] = useState("");
  const writeOffReasonsQuery = useQuery({ queryKey: ["write-off-reasons", "warehouse"], queryFn: () => listWriteOffReasons("warehouse") });
  useEffect(() => {
    if (!writeOffTouched) setWriteOff((actualLength ?? expected ?? unit.length_m) === 0);
  }, [actualLength, expected, unit.length_m, writeOffTouched]);

  const acceptMutation = useMutation({
    mutationFn: async () => {
      const occurredAtIso = toOccurredAtIso(occurredAt);
      const returned = await returnUnit(unit.id, {
        actual_length_m: actualLength ?? expected ?? unit.length_m,
        occurred_at: occurredAtIso,
        write_off_reason: writeOff ? writeOffReason : undefined,
        write_off_note: writeOff ? writeOffNote.trim() || undefined : undefined,
      });
      if (!writeOff && locationCode.trim()) await placeUnit(returned.id, locationCode.trim(), occurredAtIso);
      return { returned, placed: !writeOff && !!locationCode.trim() };
    },
    onSuccess: ({ returned, placed }) => {
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      qc.invalidateQueries({ queryKey: ["units-unplaced"] });
      qc.invalidateQueries({ queryKey: ["rack-occupancy"] });
      qc.invalidateQueries({ queryKey: ["issue-manual-issued"] });
      message.success(
        writeOff ? (
          `${rollNo(returned.id)} принят и сразу списан`
        ) : (
          <>
            {rollNo(returned.id)} принят{placed ? ` и размещён: ${locationCode.trim()}` : ""} —{" "}
            <a onClick={() => printLabel(returned.id, { kind: "cutting_issue" })}>печать бирки</a>
          </>
        ),
      );
      onClose();
    },
    onError: (e) => message.error(issueErrorMessage(e, "Не удалось принять возврат")),
  });

  return (
    <Modal title={`Принять ${rollNo(unit.id)} на склад`} open onCancel={onClose} footer={null} destroyOnHidden>
      {expected != null ? (
        <Alert
          style={{ marginBottom: 8 }}
          type="info"
          showIcon
          message={`Остаток по расчёту: ${expected} м (хорошие и брак уже учтены) — поправьте ниже, если обмер показал другое.`}
        />
      ) : (
        !previewQuery.isLoading && (
          <Alert
            style={{ marginBottom: 8 }}
            type="warning"
            showIcon
            message="Расчёт остатка недоступен — впишите фактическую длину вручную."
          />
        )
      )}
      <Typography.Text strong>Фактическая длина остатка, м</Typography.Text>
      <InputNumber
        style={{ width: "100%", marginTop: 8 }}
        min={0}
        step={0.1}
        value={actualLength}
        onChange={(v) => {
          setLengthTouched(true);
          setActualLength(v);
        }}
      />
      <Typography.Text type="secondary" style={{ display: "block", marginTop: 4, marginBottom: 16, fontSize: 12 }}>
        0 — если рулон израсходован полностью. Всё, что не вернулось, система досчитает как расход по этому рулону.
      </Typography.Text>

      <Checkbox
        checked={writeOff}
        onChange={(e) => {
          setWriteOffTouched(true);
          setWriteOff(e.target.checked);
        }}
        style={{ marginBottom: 16 }}
      >
        Списать этот остаток сразу, без размещения на склад
      </Checkbox>

      {writeOff ? (
        <>
          <Typography.Text strong>Причина списания</Typography.Text>
          <Select
            style={{ width: "100%", marginTop: 8, marginBottom: 12 }}
            loading={writeOffReasonsQuery.isLoading}
            value={writeOffReason}
            onChange={setWriteOffReason}
            options={(writeOffReasonsQuery.data ?? []).map((r) => ({ value: r.code, label: r.name }))}
          />
          <Input.TextArea
            style={{ marginBottom: 16 }}
            placeholder="Комментарий (необязательно)"
            rows={2}
            value={writeOffNote}
            onChange={(e) => setWriteOffNote(e.target.value)}
          />
        </>
      ) : (
        <>
          {suggestionQuery.isLoading ? null : suggestionQuery.data ? (
            <Alert style={{ marginBottom: 8 }} type="success" showIcon message={`По правилу зонирования подходит: ${suggestionQuery.data}`} />
          ) : (
            <Alert style={{ marginBottom: 8 }} type="warning" showIcon message="Нет подходящего правила зонирования — укажите полку вручную" />
          )}
          <Typography.Text strong>Куда поместить остаток (необязательно)</Typography.Text>
          <Input
            style={{ marginTop: 8, marginBottom: 16 }}
            placeholder="Например, Ш-1-04 — оставьте пустым, если пока не знаете"
            value={locationCode}
            onChange={(e) => {
              setLocationTouched(true);
              setLocationCode(e.target.value);
            }}
          />
        </>
      )}
      <DatePicker
        style={{ width: "100%", marginBottom: 16 }}
        format="DD.MM.YYYY"
        placeholder="Дата возврата: сейчас"
        value={occurredAt}
        onChange={setOccurredAt}
        disabledDate={(d) => d.isAfter(dayjs(), "day")}
      />

      <Button
        type="primary"
        block
        loading={acceptMutation.isPending}
        disabled={actualLength == null || (writeOff && !writeOffReason)}
        onClick={() => acceptMutation.mutate()}
      >
        {writeOff ? "Принять и списать" : locationCode.trim() ? "Принять и разместить" : "Принять без места"}
      </Button>
      <Button block style={{ marginTop: 8 }} onClick={onClose}>
        Отмена
      </Button>
    </Modal>
  );
}
