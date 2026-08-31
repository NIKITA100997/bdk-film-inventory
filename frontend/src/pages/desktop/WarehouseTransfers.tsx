import { useState } from "react";
import { Card, Tabs, Button, Space, Tag, Typography, Empty, message } from "antd";
import { isAxiosError } from "axios";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import ResponsiveTable from "../../components/ResponsiveTable";
import {
  listWarehouseTransfers,
  removeTransferLine,
  shipTransfer,
  receiveTransferLine,
  receiveAllTransferLines,
  type WarehouseTransfer,
  type WarehouseTransferLine,
} from "../../api/warehouseTransfers";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

function TransferGroup({
  transfer,
  children,
}: {
  transfer: WarehouseTransfer;
  children: React.ReactNode;
}) {
  return (
    <Card
      size="small"
      title={`${transfer.from_warehouse_name} → ${transfer.to_warehouse_name} (${transfer.lines.length} шт.)`}
      style={{ marginBottom: 16 }}
      extra={<Typography.Text type="secondary">Создано {new Date(transfer.created_at).toLocaleDateString("ru-RU")}</Typography.Text>}
    >
      {children}
    </Card>
  );
}

function linesColumns(extra: (line: WarehouseTransferLine) => React.ReactNode) {
  return [
    { title: "№", dataIndex: ["unit", "id"], render: (_: unknown, l: WarehouseTransferLine) => l.unit.id },
    {
      title: "Материал",
      render: (_: unknown, l: WarehouseTransferLine) =>
        `${l.unit.material_sku.material.name}, ${l.unit.material_sku.color.name}, ${l.unit.material_sku.thickness.value_mm} мм`,
    },
    { title: "Ширина×длина", render: (_: unknown, l: WarehouseTransferLine) => `${l.unit.width_mm} мм × ${l.unit.length_m} м` },
    { title: "", render: (_: unknown, l: WarehouseTransferLine) => extra(l) },
  ];
}

function HubTab() {
  const qc = useQueryClient();
  const transfersQuery = useQuery({
    queryKey: ["warehouse-transfers", "sobiraetsya"],
    queryFn: () => listWarehouseTransfers({ status_filter: "sobiraetsya" }),
  });

  const removeMutation = useMutation({
    mutationFn: ({ transferId, lineId }: { transferId: number; lineId: number }) => removeTransferLine(transferId, lineId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["warehouse-transfers"] });
      message.success("Убрано из хаба");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось убрать")),
  });

  const shipMutation = useMutation({
    mutationFn: (transferId: number) => shipTransfer(transferId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["warehouse-transfers"] });
      message.success("Партия отправлена");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось отправить партию")),
  });

  const transfers = transfersQuery.data ?? [];
  if (!transfersQuery.isLoading && transfers.length === 0) {
    return <Empty description="В хабе пока пусто — добавьте единицы через карточку единицы или резку с назначением «Перемещение»" />;
  }

  return (
    <Space direction="vertical" style={{ width: "100%" }} size="middle">
      {transfers.map((t) => (
        <TransferGroup key={t.id} transfer={t}>
          <ResponsiveTable<WarehouseTransferLine>
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={t.lines}
            columns={linesColumns((l) => (
              <Button size="small" danger onClick={() => removeMutation.mutate({ transferId: t.id, lineId: l.id })}>
                ✕
              </Button>
            ))}
          />
          <Button
            type="primary"
            style={{ marginTop: 12 }}
            loading={shipMutation.isPending}
            onClick={() => shipMutation.mutate(t.id)}
          >
            Отправить партию ({t.lines.length} шт.)
          </Button>
        </TransferGroup>
      ))}
    </Space>
  );
}

function InTransitTab() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const transfersQuery = useQuery({
    queryKey: ["warehouse-transfers", "otpravleno"],
    queryFn: () => listWarehouseTransfers({ status_filter: "otpravleno" }),
  });

  const receiveMutation = useMutation({
    mutationFn: ({ transferId, lineId }: { transferId: number; lineId: number }) => receiveTransferLine(transferId, lineId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["warehouse-transfers"] });
      message.success("Принято — разместите через «Стеллажи → Без места»");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось принять")),
  });

  const receiveAllMutation = useMutation({
    mutationFn: (transferId: number) => receiveAllTransferLines(transferId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["warehouse-transfers"] });
      message.success("Партия принята — разместите через «Стеллажи → Без места»");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось принять партию")),
  });

  const transfers = transfersQuery.data ?? [];
  if (!transfersQuery.isLoading && transfers.length === 0) {
    return <Empty description="Ничего в пути" />;
  }

  return (
    <Space direction="vertical" style={{ width: "100%" }} size="middle">
      {transfers.map((t) => {
        const openLines = t.lines.filter((l) => !l.received_at);
        return (
          <TransferGroup key={t.id} transfer={t}>
            <ResponsiveTable<WarehouseTransferLine>
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={t.lines}
              columns={linesColumns((l) =>
                l.received_at ? (
                  <Tag color="green">Принято</Tag>
                ) : (
                  <Button size="small" type="primary" onClick={() => receiveMutation.mutate({ transferId: t.id, lineId: l.id })}>
                    Принять
                  </Button>
                ),
              )}
            />
            {openLines.length > 0 && (
              <Button type="primary" style={{ marginTop: 12 }} loading={receiveAllMutation.isPending} onClick={() => receiveAllMutation.mutate(t.id)}>
                Принять всё ({openLines.length} шт.)
              </Button>
            )}
            {openLines.length === 0 && (
              <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
                Все единицы приняты — разместите их через{" "}
                <a onClick={() => navigate("/storage")}>«Стеллажи → Без места»</a>.
              </Typography.Paragraph>
            )}
          </TransferGroup>
        );
      })}
    </Space>
  );
}

function HistoryTab() {
  const transfersQuery = useQuery({
    queryKey: ["warehouse-transfers", "prinyato"],
    queryFn: () => listWarehouseTransfers({ status_filter: "prinyato" }),
  });
  const transfers = transfersQuery.data ?? [];

  return (
    <ResponsiveTable<WarehouseTransfer>
      size="small"
      rowKey="id"
      loading={transfersQuery.isLoading}
      pagination={false}
      dataSource={transfers}
      locale={{ emptyText: "Пока ничего не завершено" }}
      columns={[
        { title: "Откуда", dataIndex: "from_warehouse_name" },
        { title: "Куда", dataIndex: "to_warehouse_name" },
        { title: "Единиц", render: (_, t) => t.lines.length },
        { title: "Отправлено", render: (_, t) => (t.shipped_at ? new Date(t.shipped_at).toLocaleDateString("ru-RU") : "—") },
        { title: "Принято", render: (_, t) => (t.received_at ? new Date(t.received_at).toLocaleDateString("ru-RU") : "—") },
      ]}
    />
  );
}

/** Перемещение между складами (раздел про хаб на Северном → отправку на
 * Фабрику) — три вкладки, тот же паттерн, что "Закупки плёнки"
 * (Purchasing.tsx): "Хаб" — партии, ещё собираемые (единицы уже
 * добавлены — через резку с назначением "Перемещение" или напрямую с
 * карточки единицы, — но физически ещё на складе отправления, из
 * оборота уже исключены статусом В_перемещении), "В пути" — уже
 * отправленные, ждут приёмки на другом складе, "История" — принятые
 * полностью. Приёмка не включает выбор ячейки — принятая единица просто
 * становится "На хранении" без адреса и попадает в уже существующий
 * экран "Стеллажи → Без места" (не дублируем ту логику здесь). */
export default function WarehouseTransfers() {
  const [activeTab, setActiveTab] = useState("hub");
  return (
    <Card title="Перемещения между складами">
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          { key: "hub", label: "Хаб (к отправке)", children: <HubTab /> },
          { key: "transit", label: "В пути", children: <InTransitTab /> },
          { key: "history", label: "История", children: <HistoryTab /> },
        ]}
      />
    </Card>
  );
}
