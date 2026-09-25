import { useEffect, useMemo, useState } from "react";
import { isAxiosError } from "axios";
import { Alert, Form, InputNumber, Modal, Select, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getMakeTargets, makeFromPartUnit, type PartUnit } from "../api/partUnits";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

/** «Выпуск детали из заготовки» — общая заготовка до фрезеровки становится
 * деталью с пазом: выбрать деталь и сколько штук; заготовка списывается в
 * производство по норме состава, партия детали появляется на этапе
 * операции, на её участке (у МК — отфрезерована, на участке п/ф). Для
 * десктопа и мобильной карточки. */
export default function MakeFromUnitModal({
  unit,
  onClose,
  onDone,
  size,
}: {
  unit: PartUnit;
  onClose: () => void;
  onDone?: (made: PartUnit) => void;
  size?: "large";
}) {
  const qc = useQueryClient();
  const [target, setTarget] = useState<number | undefined>();
  const [qty, setQty] = useState<number | null>(null);
  const targetsQuery = useQuery({ queryKey: ["part-unit-make-targets", unit.id], queryFn: () => getMakeTargets(unit.id) });
  const targets = useMemo(() => targetsQuery.data ?? [], [targetsQuery.data]);
  const chosen = targets.find((t) => t.part_id === target);
  const available = unit.quantity_available;
  const maxQty = chosen ? Math.floor((available / chosen.per_unit) * 1000) / 1000 : undefined;

  useEffect(() => {
    if (targets.length === 1 && target === undefined) setTarget(targets[0].part_id);
  }, [targets, target]);

  const mutation = useMutation({
    mutationFn: () => makeFromPartUnit(unit.id, { target_part_id: target!, quantity_pieces: qty! }),
    onSuccess: (made) => {
      qc.invalidateQueries({ queryKey: ["part-units"] });
      qc.invalidateQueries({ queryKey: ["part-unit-events"] });
      qc.invalidateQueries({ queryKey: ["unified-lots"] });
      message.success(`Готово: партия №${made.id} «${made.part_name}», ${made.quantity_pieces} шт — на этапе «${made.stage_name}»`);
      onDone?.(made);
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось выпустить деталь")),
  });

  return (
    <Modal
      open
      title={`Выпуск детали из партии №${unit.id}`}
      okText="Выпустить"
      cancelText="Отмена"
      okButtonProps={{ disabled: !target || !qty || qty <= 0, loading: mutation.isPending, size }}
      cancelButtonProps={{ size }}
      onOk={() => mutation.mutate()}
      onCancel={onClose}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">
        «{unit.part_name}» — в наличии {available} шт. Заготовка спишется в производство, партия детали появится на
        этапе{chosen ? ` «${chosen.operation}»` : " операции"} — на его участке, уже сделанной. Дальше, как обычно, —
        «Перевести на следующий этап».
      </Typography.Paragraph>
      {targetsQuery.isSuccess && targets.length === 0 && (
        <Alert type="warning" showIcon message="Из этой детали по составу ничего не делается" />
      )}
      <Form layout="vertical">
        <Form.Item label="Какая деталь" required>
          <Select
            size={size}
            showSearch
            optionFilterProp="label"
            placeholder="Деталь с пазом"
            loading={targetsQuery.isLoading}
            value={target}
            onChange={setTarget}
            options={targets.map((t) => ({ value: t.part_id, label: t.part_name }))}
          />
        </Form.Item>
        <Form.Item
          label="Сколько штук детали"
          required
          extra={chosen && chosen.per_unit !== 1 ? `на 1 шт — ${chosen.per_unit} шт заготовки; хватит на ${maxQty}` : undefined}
        >
          <InputNumber size={size} min={0} max={maxQty} style={{ width: "100%" }} value={qty} onChange={(v) => setQty(v)} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
