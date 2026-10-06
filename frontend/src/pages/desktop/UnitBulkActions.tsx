import { useState } from "react";
import { isAxiosError } from "axios";
import { Alert, Button, InputNumber, List, Modal, Select, Space, Table, Typography, message } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listAreas } from "../../api/areas";
import { listProductionTasks, type ProductionTask } from "../../api/production";
import { listWarehouses } from "../../api/storage";
import { addUnitToTransfer } from "../../api/warehouseTransfers";
import { deleteUnit, issueUnitDirect, linkTaskLine, returnUnit, type MaterialUnit } from "../../api/units";
import { LinkTaskLineForm } from "../../components/TaskLineLinkControls";
import { rollNo } from "../../utils/lotNo";

/** Массовые действия с выбранными единицами плёнки в «Остатках». Каждое —
 * то же одиночное действие по каждой единице по очереди (все проверки и
 * правила — те же: автоперемещение при выдаче не со своего склада, досчёт
 * расхода при возврате и т.п.). Не прошедшие не мешают остальным — итог
 * показывается списком: что сделано, что нет и почему. */

export type BulkAction = "issue" | "return" | "transfer" | "link" | "delete";

interface Outcome {
  id: number;
  error: string | null;
}

function errorText(e: unknown): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return "ошибка";
}

async function runEach(ids: number[], fn: (id: number) => Promise<unknown>): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const id of ids) {
    try {
      await fn(id);
      out.push({ id, error: null });
    } catch (e) {
      out.push({ id, error: errorText(e) });
    }
  }
  return out;
}

function showOutcome(title: string, outcomes: Outcome[]) {
  const failed = outcomes.filter((o) => o.error);
  const done = outcomes.length - failed.length;
  if (failed.length === 0) {
    message.success(`${title}: ${done} из ${outcomes.length}`);
    return;
  }
  Modal.warning({
    title: `${title}: сделано ${done} из ${outcomes.length}`,
    width: 560,
    content: (
      <List
        size="small"
        dataSource={failed}
        renderItem={(o) => (
          <List.Item>
            <b>{rollNo(o.id)}</b>&nbsp;— {o.error}
          </List.Item>
        )}
      />
    ),
  });
}

const TITLES: Record<BulkAction, string> = {
  issue: "Выдать участку",
  return: "Вернуть на склад",
  transfer: "Переместить на другой склад",
  link: "Привязать к строке задания",
  delete: "Удалить / запросить удаление",
};

export default function UnitBulkActionModal({
  action,
  units,
  isSuperuser,
  onClose,
  onDone,
}: {
  action: BulkAction;
  units: MaterialUnit[];
  isSuperuser: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const run = async (fn: (id: number) => Promise<unknown>, ids = units.map((u) => u.id)) => {
    setBusy(true);
    const outcomes = await runEach(ids, fn);
    setBusy(false);
    qc.invalidateQueries({ queryKey: ["materials-explorer"] });
    qc.invalidateQueries({ queryKey: ["warehouse-transfers"] });
    showOutcome(TITLES[action], outcomes);
    if (outcomes.some((o) => !o.error)) onDone();
    onClose();
  };
  const title = `${TITLES[action]} — выбрано ${units.length}`;
  return (
    <Modal title={title} open onCancel={onClose} footer={null} destroyOnHidden width={action === "return" ? 720 : 560}>
      {action === "issue" && <IssueBody units={units} busy={busy} run={run} />}
      {action === "return" && <ReturnBody units={units} busy={busy} run={run} />}
      {action === "transfer" && <TransferBody busy={busy} run={run} />}
      {action === "link" && <LinkBody busy={busy} run={run} />}
      {action === "delete" && (
        <Space direction="vertical" style={{ width: "100%" }}>
          <Alert
            type="warning"
            showIcon
            message={
              isSuperuser
                ? "Единицы будут удалены насовсем — только если заведены по ошибке. Отменить нельзя."
                : "Администратору уйдёт запрос на удаление каждой выбранной единицы."
            }
          />
          <Button danger type="primary" block loading={busy} onClick={() => run((id) => deleteUnit(id))}>
            {isSuperuser ? `Удалить ${units.length}` : `Запросить удаление ${units.length}`}
          </Button>
        </Space>
      )}
    </Modal>
  );
}

type Run = (fn: (id: number) => Promise<unknown>, ids?: number[]) => Promise<void>;

const taskRef = (t: ProductionTask) => (t.external_order_ref ? `№${t.external_order_ref}` : t.name || `#${t.id}`);

function IssueBody({ units, busy, run }: { units: MaterialUnit[]; busy: boolean; run: Run }) {
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const tasksQuery = useQuery({ queryKey: ["production-tasks"], queryFn: listProductionTasks });
  const [area, setArea] = useState<string | undefined>();
  const [taskId, setTaskId] = useState<number | undefined>();
  const [lineId, setLineId] = useState<number | undefined>();
  const tasks = (tasksQuery.data ?? []).filter((t) => t.is_active && (!area || t.area === area));
  const task = tasks.find((t) => t.id === taskId);
  const notStored = units.filter((u) => u.status !== "На_хранении").length;
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
        Как «Выдать» в карточке: единица со склада другой площадки уйдёт в перемещение. Со строкой задания проверяется,
        что материал и ширина подходят.
      </Typography.Paragraph>
      {notStored > 0 && <Alert type="info" showIcon message={`Не на хранении: ${notStored} — их выдать нельзя, будут пропущены с пометкой.`} />}
      <Select
        placeholder="Участок"
        style={{ width: "100%" }}
        value={area}
        onChange={(v) => {
          setArea(v);
          setTaskId(undefined);
          setLineId(undefined);
        }}
        options={(areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }))}
        showSearch
        optionFilterProp="label"
      />
      <Select
        allowClear
        placeholder="Задание (необязательно)"
        style={{ width: "100%" }}
        disabled={!area}
        value={taskId}
        onChange={(v) => {
          setTaskId(v);
          setLineId(undefined);
        }}
        options={tasks.map((t) => ({ value: t.id, label: taskRef(t) }))}
        showSearch
        optionFilterProp="label"
      />
      <Select
        allowClear
        placeholder="Строка задания (необязательно)"
        style={{ width: "100%" }}
        disabled={!task}
        value={lineId}
        onChange={setLineId}
        options={(task?.lines ?? [])
          .filter((l) => l.material !== null)
          .map((l) => ({ value: l.id, label: `${l.part_name ?? ""} ${l.color}, ${l.width_mm}×${l.length_m} м`.trim() }))}
        showSearch
        optionFilterProp="label"
      />
      <Button type="primary" block disabled={!area} loading={busy} onClick={() => run((id) => issueUnitDirect(id, area!, lineId))}>
        Выдать {units.length}
      </Button>
    </Space>
  );
}

function ReturnBody({ units, busy, run }: { units: MaterialUnit[]; busy: boolean; run: Run }) {
  const issued = units.filter((u) => u.status === "Выдан_участку");
  const [lengths, setLengths] = useState<Record<number, number | null>>(() =>
    Object.fromEntries(issued.map((u) => [u.id, u.length_m])),
  );
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
        Укажите, сколько метров реально вернулось по каждой. Меньше выданного — остаток станет штрипсом, разница
        досчитается в расход по заданию, как при одиночном возврате.
      </Typography.Paragraph>
      {issued.length < units.length && (
        <Alert type="info" showIcon message={`Не выданы участку: ${units.length - issued.length} — их вернуть нельзя, пропущены.`} />
      )}
      <Table<MaterialUnit>
        size="small"
        rowKey="id"
        pagination={false}
        scroll={{ y: 360 }}
        dataSource={issued}
        columns={[
          { title: "№", dataIndex: "id", width: 90, render: (v: number) => rollNo(v) },
          { title: "Материал", render: (_, u) => `${u.material_sku.material.name}, ${u.material_sku.color.name}, ${u.width_mm} мм` },
          { title: "Было, м", dataIndex: "length_m", width: 90 },
          {
            title: "Вернулось, м",
            width: 130,
            render: (_, u) => (
              <InputNumber
                min={0}
                max={u.length_m}
                step={0.1}
                value={lengths[u.id]}
                onChange={(v) => setLengths((s) => ({ ...s, [u.id]: v }))}
              />
            ),
          },
        ]}
      />
      <Button
        type="primary"
        block
        disabled={issued.length === 0 || issued.some((u) => lengths[u.id] == null)}
        loading={busy}
        onClick={() => run((id) => returnUnit(id, { actual_length_m: lengths[id] as number }), issued.map((u) => u.id))}
      >
        Вернуть {issued.length}
      </Button>
    </Space>
  );
}

function TransferBody({ busy, run }: { busy: boolean; run: Run }) {
  const warehousesQuery = useQuery({ queryKey: ["warehouses"], queryFn: listWarehouses });
  const [to, setTo] = useState<number | undefined>();
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
        Выбранные попадут в собирающееся перемещение на этот склад (одно на пару «откуда — куда»). Отправить его — в
        «Перемещениях между складами».
      </Typography.Paragraph>
      <Select
        placeholder="На какой склад"
        style={{ width: "100%" }}
        value={to}
        onChange={setTo}
        options={(warehousesQuery.data ?? []).map((w) => ({ value: w.id, label: w.name }))}
      />
      <Button type="primary" block disabled={to == null} loading={busy} onClick={() => run((id) => addUnitToTransfer({ unit_id: id, to_warehouse_id: to! }))}>
        Добавить в перемещение
      </Button>
    </Space>
  );
}

function LinkBody({ busy, run }: { busy: boolean; run: Run }) {
  const tasksQuery = useQuery({ queryKey: ["production-tasks"], queryFn: listProductionTasks });
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
        Привязка задним числом, как в карточке единицы: у каждой проверяется, что материал и ширина подходят строке.
      </Typography.Paragraph>
      <LinkTaskLineForm
        tasks={(tasksQuery.data ?? []).filter((t) => t.is_active)}
        orderRef={taskRef}
        loading={busy}
        onSubmit={(lineId) => run((id) => linkTaskLine(id, lineId))}
      />
    </Space>
  );
}
