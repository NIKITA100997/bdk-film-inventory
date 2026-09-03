import { useState } from "react";
import { Card, Space, Typography, Form, InputNumber, Input, Select, Button, Checkbox, message, Modal } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ResponsiveTable from "../../../components/ResponsiveTable";
import PartSelect from "../../../components/PartSelect";
import {
  listPartUnits,
  createPartUnit,
  issuePartUnit,
  writeOffPartUnit,
  type PartUnit,
  type PartUnitStatus,
} from "../../../api/partUnits";
import { listProductionTasks } from "../../../api/production";
import { listAreas } from "../../../api/areas";
import { listWriteOffReasons } from "../../../api/writeOffReasons";
import { useAuth } from "../../../auth/AuthContext";
import type { Part } from "../../../api/dictionaries";

const STATUS_LABEL: Record<PartUnitStatus, string> = {
  На_хранении: "На хранении",
  Выдан_участку: "Выдан участку",
  Списан: "Списан",
};

interface MintFormValues {
  quantity_pieces: number;
  task_line_key?: string;
  issue: boolean;
  area?: string;
  note?: string;
}

/** Учёт производства деталей (раздел про физический учёт деталей, пилот:
 * окутка царговых) — деталь из задания больше не просто строка с числом,
 * а физическая партия (лот в штуках) со своим статусом (на хранении/
 * выдана участку/списана) и этапом обработки (свой список у каждой
 * детали — см. PartsAdmin.tsx). Регистрирует начальник цеха: резка
 * дерева/МДФ сегодня нигде не участок, поэтому отдельный экран, а не
 * часть заданий/отчётов конкретного участка. Партия, выданная участку,
 * дальше переходит на следующий этап (или списывается) прямо из отчёта
 * мастера (см. ReportModal.tsx/MasterQuickReportPanel.tsx). */
export default function PartUnits() {
  const { user } = useAuth();
  const canManage = !!user?.is_superuser || !!user?.permissions.includes("part_units.manage");
  const qc = useQueryClient();
  const [form] = Form.useForm<MintFormValues>();
  const [selectedPart, setSelectedPart] = useState<Part | null>(null);
  const [writeOffTarget, setWriteOffTarget] = useState<PartUnit | null>(null);
  const [writeOffForm] = Form.useForm<{ quantity_pieces: number; reason: string; note?: string }>();

  const unitsQuery = useQuery({ queryKey: ["part-units"], queryFn: () => listPartUnits() });
  const tasksQuery = useQuery({ queryKey: ["production-tasks"], queryFn: listProductionTasks });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaLabel = (code: string | null) => (code ? areasQuery.data?.find((a) => a.code === code)?.name ?? code : "—");
  const areaOptions = (areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }));
  const reasonsQuery = useQuery({ queryKey: ["write-off-reasons", "parts"], queryFn: () => listWriteOffReasons("parts") });

  const taskLineOptions = (tasksQuery.data ?? [])
    .filter((t) => t.is_active)
    .flatMap((t) =>
      t.lines.map((l) => ({
        value: `${t.id}:${l.id}`,
        label: `${t.product_model_name ?? t.name ?? `Задание №${t.id}`} — ${l.part_name ?? l.material}`,
      })),
    );

  const taskLineLabel = (id: number | null) => {
    if (id == null) return "—";
    for (const t of tasksQuery.data ?? []) {
      const line = t.lines.find((l) => l.id === id);
      if (line) return `${t.product_model_name ?? t.name ?? `Задание №${t.id}`} — ${line.part_name ?? line.material}`;
    }
    return `#${id}`;
  };

  const mintMutation = useMutation({
    mutationFn: (v: MintFormValues) => {
      const lineIdStr = v.task_line_key ? v.task_line_key.split(":")[1] : undefined;
      return createPartUnit({
        part_id: selectedPart!.id,
        quantity_pieces: v.quantity_pieces,
        production_task_line_id: lineIdStr ? Number(lineIdStr) : undefined,
        issue_to_area: v.issue ? v.area : null,
        note: v.note,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["part-units"] });
      message.success("Партия зарегистрирована");
      form.resetFields();
      setSelectedPart(null);
    },
    onError: () => message.error("Не удалось зарегистрировать партию — у детали настроены этапы?"),
  });

  const issueMutation = useMutation({
    mutationFn: ({ id, area }: { id: number; area: string }) => issuePartUnit(id, area),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["part-units"] });
      message.success("Партия выдана участку");
    },
    onError: () => message.error("Не удалось выдать партию"),
  });

  const writeOffMutation = useMutation({
    mutationFn: (v: { quantity_pieces: number; reason: string; note?: string }) => writeOffPartUnit(writeOffTarget!.id, v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["part-units"] });
      message.success("Партия списана");
      setWriteOffTarget(null);
      writeOffForm.resetFields();
    },
    onError: () => message.error("Не удалось списать партию"),
  });

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      {canManage && (
        <Card title="Зарегистрировать партию">
          <Form
            layout="vertical"
            form={form}
            onFinish={(v) => {
              if (!selectedPart) {
                message.warning("Выберите деталь");
                return;
              }
              mintMutation.mutate(v);
            }}
          >
            <Form.Item label="Деталь">
              <PartSelect onSelect={setSelectedPart} placeholder="Найдите деталь в справочнике" />
              {selectedPart && <Typography.Text type="secondary">Выбрано: {selectedPart.name}</Typography.Text>}
            </Form.Item>
            <Form.Item name="quantity_pieces" label="Количество, шт" rules={[{ required: true }]}>
              <InputNumber min={1} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="task_line_key" label="Строка задания (опционально)">
              <Select
                showSearch
                allowClear
                placeholder="Без привязки — безадресный запас"
                options={taskLineOptions}
                filterOption={(input, option) => (option?.label ?? "").toLowerCase().includes(input.toLowerCase())}
              />
            </Form.Item>
            <Form.Item name="issue" valuePropName="checked" initialValue={false}>
              <Checkbox>Сразу выдать участку</Checkbox>
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(prev, cur) => prev.issue !== cur.issue}>
              {({ getFieldValue }) =>
                getFieldValue("issue") && (
                  <Form.Item name="area" label="Участок" rules={[{ required: true }]}>
                    <Select options={areaOptions} placeholder="Выберите участок" />
                  </Form.Item>
                )
              }
            </Form.Item>
            <Form.Item name="note" label="Заметка (опционально)">
              <Input />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={mintMutation.isPending}>
              Зарегистрировать
            </Button>
          </Form>
        </Card>
      )}

      <Card title="Остатки партий">
        <ResponsiveTable<PartUnit>
          tableKey="part-units"
          lockedColumns={["Деталь"]}
          rowKey="id"
          loading={unitsQuery.isLoading}
          dataSource={unitsQuery.data ?? []}
          pagination={{ pageSize: 20 }}
          scroll={{ x: "max-content" }}
          columns={[
            { title: "Деталь", dataIndex: "part_name" },
            { title: "Кол-во, шт", dataIndex: "quantity_pieces" },
            { title: "Этап", dataIndex: "stage_name" },
            { title: "Статус", render: (_, u) => STATUS_LABEL[u.status] },
            { title: "Участок", render: (_, u) => areaLabel(u.area) },
            { title: "Задание", render: (_, u) => taskLineLabel(u.production_task_line_id) },
            {
              title: "Действия",
              render: (_, u) =>
                canManage && (
                  <Space size={4} wrap>
                    {u.status === "На_хранении" && (
                      <Select
                        size="small"
                        style={{ width: 160 }}
                        placeholder="Выдать участку"
                        options={areaOptions}
                        onChange={(area) => issueMutation.mutate({ id: u.id, area })}
                      />
                    )}
                    {u.status !== "Списан" && (
                      <Button size="small" danger onClick={() => setWriteOffTarget(u)}>
                        Списать
                      </Button>
                    )}
                  </Space>
                ),
            },
          ]}
        />
      </Card>

      <Modal
        title={`Списать партию «${writeOffTarget?.part_name ?? ""}»`}
        open={!!writeOffTarget}
        onCancel={() => setWriteOffTarget(null)}
        footer={null}
        destroyOnHidden
      >
        <Form
          layout="vertical"
          form={writeOffForm}
          initialValues={{ quantity_pieces: writeOffTarget?.quantity_pieces }}
          onFinish={(v) => writeOffMutation.mutate(v)}
        >
          <Form.Item
            name="quantity_pieces"
            label="Количество, шт"
            rules={[{ required: true }]}
          >
            <InputNumber min={0.01} max={writeOffTarget?.quantity_pieces} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="reason" label="Причина" rules={[{ required: true }]}>
            <Select loading={reasonsQuery.isLoading} options={(reasonsQuery.data ?? []).map((r) => ({ value: r.code, label: r.name }))} />
          </Form.Item>
          <Form.Item name="note" label="Заметка (опционально)">
            <Input />
          </Form.Item>
          <Button type="primary" danger htmlType="submit" block loading={writeOffMutation.isPending}>
            Списать
          </Button>
        </Form>
      </Modal>
    </Space>
  );
}
