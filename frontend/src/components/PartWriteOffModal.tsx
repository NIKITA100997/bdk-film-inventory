import { useState } from "react";
import { Form, Input, InputNumber, Modal, Select, Typography, message } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listPartUnits, writeOffPartFifo, type PartUnit } from "../api/partUnits";
import { listWriteOffReasons } from "../api/writeOffReasons";
import { listAreas } from "../api/areas";
import { apiErrorMessage } from "../utils/apiError";

const r2 = (v: number) => Math.round(v * 100) / 100;
const LIVE = new Set(["На_хранении", "Выдан_участку"]);

/** Списать N шт детали одним действием (27.10): количество снимается с партий
 * по FIFO (старые первыми), по желанию — только с участка / этапа. */
export default function PartWriteOffModal({
  partId,
  partName,
  open,
  onClose,
}: {
  partId: number | null;
  partName?: string;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas, enabled: open });
  const areaLabel = (code: string) => areasQuery.data?.find((a) => a.code === code)?.name ?? code;
  const [form] = Form.useForm<{ area?: string; stage_id?: number; qty?: number; reason?: string; note?: string }>();
  const [busy, setBusy] = useState(false);
  const unitsQuery = useQuery({
    queryKey: ["part-units", "part", partId],
    queryFn: () => listPartUnits({ part_id: partId! }),
    enabled: open && partId != null,
  });
  const reasonsQuery = useQuery({ queryKey: ["write-off-reasons", "parts"], queryFn: () => listWriteOffReasons("parts"), enabled: open });
  const area = Form.useWatch("area", form);
  const stageId = Form.useWatch("stage_id", form);
  const live = (unitsQuery.data ?? []).filter((u: PartUnit) => LIVE.has(u.status) && u.quantity_available > 0);
  const inScope = live.filter((u) => (!area || u.area === area) && (!stageId || u.stage_id === stageId));
  const available = r2(inScope.reduce((s, u) => s + u.quantity_available, 0));
  const areas = [...new Set(live.map((u) => u.area).filter((a): a is string => !!a))];
  const stages = [...new Map(live.filter((u) => !area || u.area === area).map((u) => [u.stage_id, u.stage_name])).entries()];

  const submit = async () => {
    const v = await form.validateFields();
    setBusy(true);
    try {
      const res = await writeOffPartFifo({
        part_id: partId!,
        quantity_pieces: v.qty!,
        reason: v.reason!,
        area: v.area ?? null,
        stage_id: v.stage_id ?? null,
        note: v.note?.trim() || undefined,
      });
      message.success(`Списано ${res.written_off} шт (партий: ${res.units})`);
      qc.invalidateQueries({ queryKey: ["part-units"] });
      qc.invalidateQueries({ queryKey: ["part-unit-events"] });
      form.resetFields();
      onClose();
    } catch (e) {
      message.error(apiErrorMessage(e, "Не удалось списать"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={partName ? `Списать п/ф — ${partName}` : "Списать п/ф"}
      okText="Списать"
      okButtonProps={{ danger: true, disabled: available <= 0 }}
      confirmLoading={busy}
      onOk={submit}
      onCancel={onClose}
      destroyOnHidden
    >
      <Form form={form} layout="vertical">
        <Form.Item name="area" label="Участок" extra="Пусто — с любого участка и со склада п/ф">
          <Select
            allowClear
            placeholder="все"
            options={areas.map((a) => ({ value: a, label: areaLabel(a) }))}
            onChange={() => form.setFieldValue("stage_id", undefined)}
          />
        </Form.Item>
        <Form.Item name="stage_id" label="Этап">
          <Select allowClear placeholder="все" options={stages.map(([id, name]) => ({ value: id, label: name }))} />
        </Form.Item>
        <Form.Item
          name="qty"
          label={`Сколько списать, шт (доступно ${available})`}
          rules={[
            { required: true, message: "Укажите количество" },
            { validator: (_, v) => (v == null || v <= available ? Promise.resolve() : Promise.reject(new Error(`Доступно только ${available} шт`))) },
          ]}
        >
          <InputNumber min={0.01} max={available || undefined} style={{ width: "100%" }} inputMode="decimal" />
        </Form.Item>
        <Form.Item name="reason" label="Причина" rules={[{ required: true, message: "Выберите причину" }]}>
          <Select loading={reasonsQuery.isLoading} options={(reasonsQuery.data ?? []).map((r) => ({ value: r.code, label: r.name }))} />
        </Form.Item>
        <Form.Item name="note" label="Комментарий">
          <Input maxLength={200} />
        </Form.Item>
      </Form>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Списывается с партий по порядку — сначала самые старые; каждая списанная часть видна в истории своей партии.
      </Typography.Text>
    </Modal>
  );
}
