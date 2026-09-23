import { useState } from "react";
import { isAxiosError } from "axios";
import { Card, Tag, Button, Modal, Form, Input, InputNumber, Radio, Checkbox, Space, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ResponsiveTable from "../../components/ResponsiveTable";
import {
  listDoorSeries,
  createDoorSeries,
  updateDoorSeries,
  type DoorSeries,
  type DoorSeriesCreate,
} from "../../api/doorSeries";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

const EDGE_LABEL: Record<string, string> = { abs: "ABS", aluminum: "Алюминий" };

/** Серии щитовых дверей — по ним строка графика запуска получает свой
 * маршрут по этапам (Кромка ABS или алюминиевый профиль на Сборке,
 * Фрезеровка под замок) и размеры п/ф (толщина каркаса и щита). */
export default function DoorSeriesAdmin() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<DoorSeries | "new" | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [form] = Form.useForm<DoorSeriesCreate>();

  const seriesQuery = useQuery({ queryKey: ["door-series"], queryFn: listDoorSeries });

  const saveMutation = useMutation({
    mutationFn: (v: DoorSeriesCreate) =>
      editing && editing !== "new" ? updateDoorSeries(editing.id, v) : createDoorSeries(v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["door-series"] });
      message.success("Сохранено");
      setEditing(null);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить")),
  });
  const archiveMutation = useMutation({
    mutationFn: (s: DoorSeries) => updateDoorSeries(s.id, { is_active: !s.is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["door-series"] }),
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось изменить")),
  });

  const openForm = (target: DoorSeries | "new") => {
    setEditing(target);
    form.resetFields();
    if (target !== "new") {
      form.setFieldsValue({
        name: target.name,
        frame_thickness_mm: target.frame_thickness_mm,
        panel_mdf_thickness_mm: target.panel_mdf_thickness_mm,
        edge_type: target.edge_type,
        has_glass: target.has_glass,
        has_moulding: target.has_moulding,
        needs_lock_milling: target.needs_lock_milling,
        milling_program: target.milling_program,
      });
    }
  };

  const rows = (seriesQuery.data ?? []).filter((s) => showArchived || s.is_active);

  return (
    <Card
      title="Серии щитовых дверей"
      extra={
        <Space>
          <Checkbox checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)}>
            Показывать архивные
          </Checkbox>
          <Button type="primary" onClick={() => openForm("new")}>
            Добавить серию
          </Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary">
        Название — ровно как в колонке «Серия» графика запуска. Толщины — после шлифовки, по техкарте (каркас: А — 26,
        А10 — 22, В и Е — 24, Н — 26 мм; щит — 6 мм, у Н (ВО) — 8 мм).
      </Typography.Paragraph>
      <ResponsiveTable<DoorSeries>
        tableKey="door-series"
        lockedColumns={["Серия"]}
        rowKey="id"
        loading={seriesQuery.isLoading}
        dataSource={rows}
        pagination={false}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: "Серий пока нет — добавьте первую" }}
        columns={[
          { title: "Серия", dataIndex: "name" },
          { title: "Каркас, мм", dataIndex: "frame_thickness_mm" },
          { title: "Щит, мм", dataIndex: "panel_mdf_thickness_mm" },
          { title: "Кромка", dataIndex: "edge_type", render: (v: string) => EDGE_LABEL[v] ?? v },
          {
            title: "Состав",
            render: (_, s) => (
              <Space size={4} wrap>
                {s.has_glass && <Tag>стекло</Tag>}
                {s.has_moulding && <Tag>молдинг</Tag>}
                {s.needs_lock_milling && <Tag>фрез. под замок</Tag>}
              </Space>
            ),
          },
          { title: "Программа фрезеровки", dataIndex: "milling_program", render: (v: string | null) => v ?? "—" },
          {
            title: "Статус",
            dataIndex: "is_active",
            render: (v: boolean) => (v ? <Tag color="green">Активна</Tag> : <Tag>В архиве</Tag>),
          },
          {
            title: "",
            render: (_, s) => (
              <Space>
                <Button size="small" onClick={() => openForm(s)}>
                  Изменить
                </Button>
                <Button size="small" loading={archiveMutation.isPending} onClick={() => archiveMutation.mutate(s)}>
                  {s.is_active ? "В архив" : "Восстановить"}
                </Button>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing === "new" ? "Новая серия" : `Серия ${editing?.name ?? ""}`}
        open={editing !== null}
        onCancel={() => setEditing(null)}
        footer={null}
        destroyOnHidden
      >
        <Form
          layout="vertical"
          form={form}
          initialValues={{ has_glass: false, has_moulding: false, needs_lock_milling: false }}
          onFinish={(v) => saveMutation.mutate({ ...v, milling_program: v.milling_program?.trim() || null })}
        >
          <Form.Item name="name" label="Серия (как в графике)" rules={[{ required: true, whitespace: true }]}>
            <Input placeholder="А10" />
          </Form.Item>
          <Space size={12} style={{ display: "flex" }}>
            <Form.Item name="frame_thickness_mm" label="Каркас, мм" rules={[{ required: true }]}>
              <InputNumber min={1} step={1} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="panel_mdf_thickness_mm" label="Щит (МДФ), мм" rules={[{ required: true }]}>
              <InputNumber min={1} step={1} style={{ width: 140 }} />
            </Form.Item>
          </Space>
          <Form.Item
            name="edge_type"
            label="Кромка"
            rules={[{ required: true, message: "Выберите тип кромки" }]}
            extra="ABS — Сборка, затем отдельная Кромка. Алюминий — профиль ставится на Сборке, этапа Кромки нет."
          >
            <Radio.Group
              optionType="button"
              options={[
                { label: "ABS", value: "abs" },
                { label: "Алюминий", value: "aluminum" },
              ]}
            />
          </Form.Item>
          <Form.Item name="has_glass" valuePropName="checked" style={{ marginBottom: 4 }}>
            <Checkbox>Со стеклом</Checkbox>
          </Form.Item>
          <Form.Item name="has_moulding" valuePropName="checked" style={{ marginBottom: 4 }}>
            <Checkbox>С молдингом</Checkbox>
          </Form.Item>
          <Form.Item name="needs_lock_milling" valuePropName="checked">
            <Checkbox>Фрезеровка под замок</Checkbox>
          </Form.Item>
          <Form.Item name="milling_program" label="Программа фрезеровки периметра (опционально)">
            <Input placeholder="Б/Ф 8мм" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={saveMutation.isPending}>
            Сохранить
          </Button>
        </Form>
      </Modal>
    </Card>
  );
}
