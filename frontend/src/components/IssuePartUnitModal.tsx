import { useState } from "react";
import { isAxiosError } from "axios";
import { Form, InputNumber, Modal, Typography, message } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { issuePartUnit, type PartUnit } from "../api/partUnits";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

/** «Передать на участок» — партию «На хранении» (сделана, но не передана:
 * отфрезерована, лежит на участке п/ф) на участок её этапа. Можно часть —
 * она отделится своей партией. */
export default function IssuePartUnitModal({
  unit,
  onClose,
  onDone,
  size,
}: {
  unit: PartUnit;
  onClose: () => void;
  onDone?: (issued: PartUnit) => void;
  size?: "large";
}) {
  const qc = useQueryClient();
  const [qty, setQty] = useState<number | null>(unit.quantity_pieces);
  const mutation = useMutation({
    mutationFn: () => issuePartUnit(unit.id, qty === unit.quantity_pieces ? null : qty),
    onSuccess: (issued) => {
      qc.invalidateQueries({ queryKey: ["part-units"] });
      qc.invalidateQueries({ queryKey: ["part-unit-events"] });
      qc.invalidateQueries({ queryKey: ["unified-lots"] });
      message.success(`Передано на участок: партия №${issued.id}, ${issued.quantity_pieces} шт`);
      onDone?.(issued);
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось передать на участок")),
  });
  return (
    <Modal
      open
      title={`Передать на участок — партия №${unit.id}`}
      okText="Передать"
      cancelText="Отмена"
      okButtonProps={{ disabled: !qty || qty <= 0 || qty > unit.quantity_pieces, loading: mutation.isPending, size }}
      cancelButtonProps={{ size }}
      onOk={() => mutation.mutate()}
      onCancel={onClose}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">
        «{unit.part_name}» на этапе «{unit.stage_name}» — {unit.quantity_pieces} шт на хранении. Переданные уйдут на
        участок этапа и станут доступны его отчётам.
      </Typography.Paragraph>
      <Form layout="vertical">
        <Form.Item label="Сколько передать, шт" extra="Меньше, чем в партии, — остаток останется на хранении.">
          <InputNumber size={size} min={0} max={unit.quantity_pieces} style={{ width: "100%" }} value={qty} onChange={setQty} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
