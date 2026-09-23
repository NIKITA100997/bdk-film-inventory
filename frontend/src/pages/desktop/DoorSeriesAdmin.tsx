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

/** Серии щитовых дверей — по ним строка графика запуска получает размеры
 * п/ф (толщина каркаса и щита) и кромку по умолчанию. */
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
        Базовые серии, как в «Данных для формул». Варианты из графика (В-10.2, Е-14.2) относятся к базовой серии
        автоматически. Толщины — после шлифовки, по техкарте. Кромка здесь — по умолчанию: стекло, молдинг,
        защёлку и изредка другую кромку берём из наименования каждой строки графика.
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
          { title: "Кромка по умолчанию", dataIndex: "edge_type", render: (v: string) => EDGE_LABEL[v] ?? v },
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
          onFinish={(v) => saveMutation.mutate(v)}
        >
          <Form.Item name="name" label="Серия" rules={[{ required: true, whitespace: true }]}>
            <Input placeholder="В-10" />
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
            label="Кромка по умолчанию"
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
          <Button type="primary" htmlType="submit" block loading={saveMutation.isPending}>
            Сохранить
          </Button>
        </Form>
      </Modal>
    </Card>
  );
}
