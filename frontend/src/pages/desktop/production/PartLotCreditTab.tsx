import { useState } from "react";
import { Alert, Button, Input, InputNumber, Modal, Radio, Space, Switch, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import { apiClient } from "../../../api/client";
import ResponsiveTable from "../../../components/ResponsiveTable";
import { useAuth } from "../../../auth/AuthContext";
import { hasPerm } from "../../../auth/permissions";
import { apiErrorMessage } from "../../../utils/apiError";

interface CreditLine {
  task_line_id: number;
  task_id: number;
  task_name: string;
  area: string;
  planned: number;
  done: number;
  remaining: number;
  for_task_id: number | null;
}
interface UnassignedLot {
  id: number;
  part_id: number;
  part_name: string;
  quantity_pieces: number;
  stage_name: string;
  status: string;
  area: string | null;
  manufactured_at: string | null;
  created_at: string;
  lines: CreditLine[];
}

const listUnassigned = async (): Promise<UnassignedLot[]> => (await apiClient.get<UnassignedLot[]>("/part-lots/unassigned")).data;
const creditLot = async (id: number, p: { task_line_id: number; quantity_pieces: number }) =>
  (await apiClient.post<{ ok: boolean; task_id: number; remaining: number }>(`/part-lots/${id}/credit`, p)).data;

/** Партии п/ф без задания (14.10): оприходовали без заказа — выберите
 * партию и задание на эту деталь, партия засчитывается как сделанное по
 * заданию и остаётся в остатке (окутка расходует её как обычно). */
export default function PartLotCreditTab() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canCredit = hasPerm(user, "part_units.manage", "production_tasks.manage");
  const q = useQuery({ queryKey: ["part-lots-unassigned"], queryFn: listUnassigned });
  const [search, setSearch] = useState("");
  const [onlyMatching, setOnlyMatching] = useState(true);
  const [target, setTarget] = useState<UnassignedLot | null>(null);
  const [lineId, setLineId] = useState<number | null>(null);
  const [qty, setQty] = useState<number | null>(null);
  const credit = useMutation({
    mutationFn: () => creditLot(target!.id, { task_line_id: lineId!, quantity_pieces: qty! }),
    onSuccess: (r) => {
      for (const k of ["part-lots-unassigned", "pf-demand", "production-tasks", "production-orders", "production-order"]) qc.invalidateQueries({ queryKey: [k] });
      message.success(`Партия №${target!.id} засчитана в задание №${r.task_id}; по строке осталось ${r.remaining} шт`);
      setTarget(null);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось засчитать")),
  });
  const needle = search.trim().toLowerCase();
  const rows = (q.data ?? []).filter((l) => (!onlyMatching || l.lines.length > 0) && (!needle || `${l.id} ${l.part_name}`.toLowerCase().includes(needle)));
  const open = (l: UnassignedLot) => {
    setTarget(l);
    const first = l.lines[0];
    setLineId(first?.task_line_id ?? null);
    setQty(first ? Math.min(l.quantity_pieces, first.remaining) : l.quantity_pieces);
  };
  const line = target?.lines.find((x) => x.task_line_id === lineId);

  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Партии п/ф, заведённые без задания (сделали заранее, оприходовали вручную). Если под эту деталь есть открытое задание —
        засчитайте партию в него: задание считается сделанным на эти штуки, партия остаётся в остатке и уходит в работу как обычно.
      </Typography.Paragraph>
      <Space wrap>
        <Input.Search allowClear placeholder="№ партии, деталь" style={{ width: 260 }} value={search} onChange={(e) => setSearch(e.target.value)} />
        <Space size={6}>
          <Switch size="small" checked={onlyMatching} onChange={setOnlyMatching} />
          <Typography.Text>только где есть задание на эту деталь</Typography.Text>
        </Space>
      </Space>
      <ResponsiveTable<UnassignedLot>
        tableKey="part-lot-credit"
        lockedColumns={["Партия"]}
        size="small"
        rowKey="id"
        loading={q.isLoading}
        dataSource={rows}
        pagination={{ pageSize: 50 }}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: "Партий без задания нет" }}
        columns={[
          { title: "Партия", render: (_, l) => `№${l.id}` },
          { title: "Деталь", dataIndex: "part_name" },
          { title: "Шт", align: "right", dataIndex: "quantity_pieces" },
          { title: "Этап", render: (_, l) => <Tag>{l.stage_name}</Tag> },
          { title: "Заведена", render: (_, l) => dayjs(l.created_at).format("DD.MM.YYYY") },
          {
            title: "Задания на эту деталь",
            render: (_, l) =>
              l.lines.length ? (
                <Space direction="vertical" size={0}>
                  {l.lines.slice(0, 3).map((x) => (
                    <Typography.Text key={x.task_line_id} style={{ fontSize: 12 }}>
                      №{x.task_id} «{x.task_name}» — осталось {x.remaining}
                    </Typography.Text>
                  ))}
                  {l.lines.length > 3 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>ещё {l.lines.length - 3}</Typography.Text>}
                </Space>
              ) : (
                <Typography.Text type="secondary">нет открытых</Typography.Text>
              ),
          },
          {
            title: "",
            render: (_, l) =>
              canCredit && l.lines.length > 0 ? (
                <Button size="small" onClick={() => open(l)}>
                  Засчитать в задание…
                </Button>
              ) : null,
          },
        ]}
      />
      <Modal
        open={!!target}
        title={target ? `Партия №${target.id}: ${target.part_name}, ${target.quantity_pieces} шт` : ""}
        okText="Засчитать"
        cancelText="Отмена"
        onCancel={() => setTarget(null)}
        okButtonProps={{ disabled: !lineId || !qty || qty <= 0, loading: credit.isPending }}
        onOk={() => credit.mutate()}
      >
        {target && (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Radio.Group
              value={lineId}
              onChange={(e) => {
                setLineId(e.target.value);
                const x = target.lines.find((y) => y.task_line_id === e.target.value);
                if (x) setQty(Math.min(target.quantity_pieces, x.remaining));
              }}
            >
              <Space direction="vertical">
                {target.lines.map((x) => (
                  <Radio key={x.task_line_id} value={x.task_line_id}>
                    №{x.task_id} «{x.task_name}» — сделано {x.done} из {x.planned}, осталось {x.remaining}
                    {x.for_task_id ? <Tag style={{ marginInlineStart: 6 }}>п/ф под №{x.for_task_id}</Tag> : null}
                  </Radio>
                ))}
              </Space>
            </Radio.Group>
            <Space>
              <span>Засчитать, шт:</span>
              <InputNumber min={1} max={Math.min(target.quantity_pieces, line?.remaining ?? target.quantity_pieces)} value={qty} onChange={setQty} />
            </Space>
            <Alert
              type="info"
              showIcon
              message="Партия помечается этим заданием и остаётся в остатке. В выработку участка и себестоимость засчитанное не идёт — работа была раньше."
            />
          </Space>
        )}
      </Modal>
    </Space>
  );
}
