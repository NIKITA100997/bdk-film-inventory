import { useState } from "react";
import { Card, Typography, Table, Button, Form, Input, Select, Modal, InputNumber, Space, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createMacroZoneRule,
  createRack,
  listMacroZoneRules,
  listRacks,
  type MacroZoneRuleCreate,
  type Rack,
} from "../../api/storage";
import { getCalcSettings, updateCalcSettings } from "../../api/abc";

export default function Settings() {
  const qc = useQueryClient();
  const [selectedRack, setSelectedRack] = useState<Rack | null>(null);
  const [rackModalOpen, setRackModalOpen] = useState(false);
  const [ruleModalOpen, setRuleModalOpen] = useState(false);

  const racksQuery = useQuery({ queryKey: ["racks"], queryFn: listRacks });
  const rulesQuery = useQuery({
    queryKey: ["macro-zone-rules", selectedRack?.id],
    queryFn: () => listMacroZoneRules(selectedRack!.id),
    enabled: !!selectedRack,
  });

  const createRackMutation = useMutation({
    mutationFn: createRack,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["racks"] });
      setRackModalOpen(false);
      message.success("Стеллаж добавлен");
    },
  });
  const createRuleMutation = useMutation({
    mutationFn: (payload: MacroZoneRuleCreate) => createMacroZoneRule(selectedRack!.id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["macro-zone-rules", selectedRack?.id] });
      setRuleModalOpen(false);
      message.success("Правило добавлено");
    },
    onError: () => message.error("Не удалось создать правило — проверьте, что значения есть в справочниках"),
  });

  const calcSettingsQuery = useQuery({ queryKey: ["calc-settings"], queryFn: getCalcSettings });
  const calcSettingsMutation = useMutation({
    mutationFn: updateCalcSettings,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["calc-settings"] });
      message.success("Настройки сохранены");
    },
  });

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Typography.Title level={4}>Настройки — стеллажи и макрозонирование</Typography.Title>

      <Card
        title="Стеллажи"
        extra={
          <Button type="primary" onClick={() => setRackModalOpen(true)}>
            Добавить стеллаж
          </Button>
        }
      >
        <Table
          rowKey="id"
          loading={racksQuery.isLoading}
          dataSource={racksQuery.data ?? []}
          pagination={false}
          onRow={(rack) => ({ onClick: () => setSelectedRack(rack) })}
          columns={[
            { title: "Код", dataIndex: "code" },
            { title: "Тип", dataIndex: "type", render: (t: string) => (t === "roll" ? "Рулонный" : "Штрипсовый") },
            { title: "Число полок", dataIndex: "shelf_count" },
          ]}
        />
      </Card>

      {selectedRack && (
        <Card
          title={`Макрозонирование стеллажа ${selectedRack.code} (${selectedRack.shelf_count} полок)`}
          extra={
            <Button type="primary" onClick={() => setRuleModalOpen(true)}>
              Добавить правило
            </Button>
          }
        >
          <Table
            rowKey="id"
            loading={rulesQuery.isLoading}
            dataSource={rulesQuery.data ?? []}
            pagination={false}
            columns={[
              { title: "Полки", render: (_, r) => `${r.from_shelf}–${r.to_shelf}` },
              { title: "Материал", dataIndex: "material_id", render: (v) => v ?? "любой" },
              { title: "Цвет", dataIndex: "color_id", render: (v) => v ?? "любой" },
              { title: "Толщина", dataIndex: "thickness_id", render: (v) => v ?? "любая" },
              { title: "Производитель", dataIndex: "manufacturer_id", render: (v) => v ?? "любой" },
            ]}
          />
        </Card>
      )}

      <Card title="Настройки расчётов" loading={calcSettingsQuery.isLoading}>
        {calcSettingsQuery.data && (
          <Form
            layout="inline"
            initialValues={calcSettingsQuery.data}
            onFinish={(v) => calcSettingsMutation.mutate(v)}
          >
            <Form.Item name="min_useful_width_mm" label="Минимальная полезная ширина, мм" rules={[{ required: true }]}>
              <InputNumber min={1} />
            </Form.Item>
            <Form.Item name="abc_recalc_period_days" label="Период пересчёта ABC, дни" rules={[{ required: true }]}>
              <InputNumber min={1} />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={calcSettingsMutation.isPending}>
              Сохранить
            </Button>
          </Form>
        )}
      </Card>

      <Modal
        title="Новый стеллаж"
        open={rackModalOpen}
        onCancel={() => setRackModalOpen(false)}
        footer={null}
        destroyOnHidden
      >
        <Form layout="vertical" onFinish={(v) => createRackMutation.mutate(v)}>
          <Form.Item name="code" label="Код (например, Р-3 или Ш-2)" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="type" label="Тип" rules={[{ required: true }]} initialValue="roll">
            <Select
              options={[
                { value: "roll", label: "Рулонный" },
                { value: "strip", label: "Штрипсовый" },
              ]}
            />
          </Form.Item>
          <Form.Item name="shelf_count" label="Число полок" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={createRackMutation.isPending}>
            Создать
          </Button>
        </Form>
      </Modal>

      <Modal
        title="Новое правило зонирования"
        open={ruleModalOpen}
        onCancel={() => setRuleModalOpen(false)}
        footer={null}
        destroyOnHidden
      >
        <Form layout="vertical" onFinish={(v) => createRuleMutation.mutate(v)}>
          <Form.Item name="from_shelf" label="От полки" rules={[{ required: true }]}>
            <InputNumber min={1} max={selectedRack?.shelf_count} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="to_shelf" label="До полки" rules={[{ required: true }]}>
            <InputNumber min={1} max={selectedRack?.shelf_count} style={{ width: "100%" }} />
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            Пустое поле = «любое значение». Значения должны уже существовать в справочниках (заводятся при приёмке).
          </Typography.Paragraph>
          <Form.Item name="material" label="Материал">
            <Input placeholder="ПВХ плёнка" />
          </Form.Item>
          <Form.Item name="color" label="Цвет">
            <Input placeholder="Дуб беленый" />
          </Form.Item>
          <Form.Item name="thickness" label="Толщина, мм">
            <InputNumber min={0} step={0.01} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="manufacturer" label="Производитель">
            <Input placeholder="Классен" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={createRuleMutation.isPending}>
            Создать
          </Button>
        </Form>
      </Modal>
    </Space>
  );
}
