import { useState } from "react";
import { Card, Typography, Table, Button, Form, Input, Select, Modal, InputNumber, Space, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createCell,
  createRack,
  createShelf,
  listCells,
  listRacks,
  listShelves,
  type Rack,
  type Shelf,
} from "../../api/storage";

export default function Settings() {
  const qc = useQueryClient();
  const [selectedRack, setSelectedRack] = useState<Rack | null>(null);
  const [selectedShelf, setSelectedShelf] = useState<Shelf | null>(null);
  const [rackModalOpen, setRackModalOpen] = useState(false);
  const [shelfModalOpen, setShelfModalOpen] = useState(false);
  const [cellModalOpen, setCellModalOpen] = useState(false);

  const racksQuery = useQuery({ queryKey: ["racks"], queryFn: listRacks });
  const shelvesQuery = useQuery({
    queryKey: ["shelves", selectedRack?.id],
    queryFn: () => listShelves(selectedRack!.id),
    enabled: !!selectedRack,
  });
  const cellsQuery = useQuery({
    queryKey: ["cells", selectedShelf?.id],
    queryFn: () => listCells(selectedShelf!.id),
    enabled: !!selectedShelf,
  });

  const createRackMutation = useMutation({
    mutationFn: createRack,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["racks"] });
      setRackModalOpen(false);
      message.success("Стеллаж добавлен");
    },
  });
  const createShelfMutation = useMutation({
    mutationFn: (payload: { number: number; macro_zone?: string }) => createShelf(selectedRack!.id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shelves", selectedRack?.id] });
      setShelfModalOpen(false);
      message.success("Полка добавлена");
    },
  });
  const createCellMutation = useMutation({
    mutationFn: (payload: { number: number }) => createCell(selectedShelf!.id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cells", selectedShelf?.id] });
      setCellModalOpen(false);
      message.success("Ячейка добавлена");
    },
  });

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Typography.Title level={4}>Настройки — справочник стеллажей и ячеек</Typography.Title>

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
          onRow={(rack) => ({
            onClick: () => {
              setSelectedRack(rack);
              setSelectedShelf(null);
            },
          })}
          columns={[
            { title: "Код", dataIndex: "code" },
            { title: "Тип", dataIndex: "type", render: (t: string) => (t === "roll" ? "Рулонный" : "Штрипсовый") },
          ]}
        />
      </Card>

      {selectedRack && (
        <Card
          title={`Полки стеллажа ${selectedRack.code}`}
          extra={
            <Button type="primary" onClick={() => setShelfModalOpen(true)}>
              Добавить полку
            </Button>
          }
        >
          <Table
            rowKey="id"
            loading={shelvesQuery.isLoading}
            dataSource={shelvesQuery.data ?? []}
            pagination={false}
            onRow={(shelf) => ({ onClick: () => setSelectedShelf(shelf) })}
            columns={[
              { title: "№ полки", dataIndex: "number" },
              { title: "Макрозона", dataIndex: "macro_zone" },
            ]}
          />
        </Card>
      )}

      {selectedRack?.type === "strip" && selectedShelf && (
        <Card
          title={`Ячейки полки № ${selectedShelf.number}`}
          extra={
            <Button type="primary" onClick={() => setCellModalOpen(true)}>
              Добавить ячейку
            </Button>
          }
        >
          <Table
            rowKey="id"
            loading={cellsQuery.isLoading}
            dataSource={cellsQuery.data ?? []}
            pagination={false}
            columns={[{ title: "№ ячейки", dataIndex: "number" }]}
          />
        </Card>
      )}

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
          <Button type="primary" htmlType="submit" loading={createRackMutation.isPending}>
            Создать
          </Button>
        </Form>
      </Modal>

      <Modal
        title="Новая полка"
        open={shelfModalOpen}
        onCancel={() => setShelfModalOpen(false)}
        footer={null}
        destroyOnHidden
      >
        <Form layout="vertical" onFinish={(v) => createShelfMutation.mutate(v)}>
          <Form.Item name="number" label="Номер полки" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="macro_zone" label="Макрозона (материал+цвет)">
            <Input />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={createShelfMutation.isPending}>
            Создать
          </Button>
        </Form>
      </Modal>

      <Modal
        title="Новая ячейка"
        open={cellModalOpen}
        onCancel={() => setCellModalOpen(false)}
        footer={null}
        destroyOnHidden
      >
        <Form layout="vertical" onFinish={(v) => createCellMutation.mutate(v)}>
          <Form.Item name="number" label="Номер ячейки" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={createCellMutation.isPending}>
            Создать
          </Button>
        </Form>
      </Modal>
    </Space>
  );
}
