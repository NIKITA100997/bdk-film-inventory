import { useState } from "react";
import { Checkbox, Modal, Space, Typography, message } from "antd";
import { getTasksPrintData } from "../../../api/productionOrders";
import { printTaskSheets } from "../../../utils/printTasks";

export interface PrintableTask {
  id: number;
  area: string;
  area_name: string | null;
}

/** Пакетная печать заданий: выбрать участки — лист на участок со всеми
 * строками выбранных заданий этого участка. */
export default function PrintTasksModal({ tasks, title, onClose }: { tasks: PrintableTask[]; title: string; onClose: () => void }) {
  const areas = [...new Map(tasks.map((t) => [t.area, t.area_name ?? t.area])).entries()].sort((a, b) => a[1].localeCompare(b[1], "ru"));
  const [picked, setPicked] = useState<string[]>(areas.map(([a]) => a));
  const [busy, setBusy] = useState(false);
  const run = async () => {
    const ids = tasks.filter((t) => picked.includes(t.area)).map((t) => t.id);
    if (!ids.length) return;
    setBusy(true);
    try {
      printTaskSheets(await getTasksPrintData(ids), title);
      onClose();
    } catch {
      message.error("Не удалось собрать задания для печати");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open title="Печать заданий по участкам" okText={`Печать (${picked.length})`} cancelText="Отмена" confirmLoading={busy} okButtonProps={{ disabled: !picked.length }} onOk={run} onCancel={onClose}>
      <Space direction="vertical" style={{ width: "100%" }}>
        <Typography.Text type="secondary">Лист на участок: все строки выбранных заданий, срок, плёнка, программа и указание; графы «Сделано / Брак / Подпись» — от руки.</Typography.Text>
        <Checkbox
          checked={picked.length === areas.length}
          indeterminate={picked.length > 0 && picked.length < areas.length}
          onChange={(e) => setPicked(e.target.checked ? areas.map(([a]) => a) : [])}
        >
          Все участки
        </Checkbox>
        <Checkbox.Group value={picked} onChange={(v) => setPicked(v as string[])} style={{ display: "grid", gap: 6, paddingLeft: 16 }}>
          {areas.map(([a, name]) => (
            <Checkbox key={a} value={a}>
              {name} <Typography.Text type="secondary">({tasks.filter((t) => t.area === a).length})</Typography.Text>
            </Checkbox>
          ))}
        </Checkbox.Group>
      </Space>
    </Modal>
  );
}
