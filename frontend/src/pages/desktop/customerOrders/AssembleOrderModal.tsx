import { useState } from "react";
import { Alert, Button, Checkbox, Modal, Space, Spin, Table, Tag, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { assembleOrder, getAssemblePreview, type AssembleDonor } from "../../../api/customerOrders";
import { apiErrorMessage } from "../../../utils/apiError";

interface Props {
  orderId: number | null;
  open: boolean;
  onClose: () => void;
}

export default function AssembleOrderModal({ orderId, open, onClose }: Props) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Record<number, number>>({});

  const previewQ = useQuery({
    queryKey: ["assemble-preview", orderId],
    queryFn: () => getAssemblePreview(orderId!),
    enabled: open && orderId !== null,
  });

  const assembleMut = useMutation({
    mutationFn: () => {
      const transfers = Object.entries(selected).map(([polId, targetColId]) => ({
        production_order_line_id: Number(polId),
        target_customer_order_line_id: targetColId,
      }));
      return assembleOrder(orderId!, transfers);
    },
    onSuccess: (res) => {
      message.success(`Перераспределено позиций: ${res.moved}`);
      setSelected({});
      qc.invalidateQueries({ queryKey: ["customer-orders"] });
      qc.invalidateQueries({ queryKey: ["customer-order", orderId] });
      qc.invalidateQueries({ queryKey: ["assemble-preview", orderId] });
      qc.invalidateQueries({ queryKey: ["production-monitor"] });
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Ошибка при сборе заказа")),
  });

  const toggleDonor = (polId: number, targetColId: number, checked: boolean) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (checked) next[polId] = targetColId;
      else delete next[polId];
      return next;
    });
  };

  const lines = previewQ.data?.lines ?? [];
  const selectedCount = Object.keys(selected).length;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={`Сбор заказа ${previewQ.data?.invoice_no ? `№ ${previewQ.data.invoice_no}` : ""}`}
      width={780}
      footer={
        <Space>
          <Button onClick={onClose}>Отмена</Button>
          <Button
            type="primary"
            disabled={selectedCount === 0}
            loading={assembleMut.isPending}
            onClick={() => assembleMut.mutate()}
          >
            Перенести выбранные ({selectedCount})
          </Button>
        </Space>
      }
    >
      {previewQ.isLoading ? (
        <div style={{ textAlign: "center", padding: 24 }}>
          <Spin />
        </div>
      ) : lines.length === 0 ? (
        <Alert type="info" message="В заказе нет позиций" />
      ) : (
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          {lines.map((line) => (
            <div key={line.customer_order_line_id} style={{ border: "1px solid #f0f0f0", borderRadius: 6, padding: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <b>{line.item_name ?? "Позиция"}</b>
                <span>
                  Нужно: <b>{line.needed_qty}</b> · Привязано: <b>{line.linked_qty}</b> ·{" "}
                  {line.deficit > 0 ? (
                    <Tag color="red">Дефицит: {line.deficit}</Tag>
                  ) : (
                    <Tag color="green">Укомплектовано</Tag>
                  )}
                </span>
              </div>
              {line.deficit > 0 && (
                line.donors.length === 0 ? (
                  <div style={{ color: "#8c8c8c", fontSize: 12 }}>Нет подходящих позиций в других счетах/запусках</div>
                ) : (
                  <Table<AssembleDonor>
                    size="small"
                    pagination={false}
                    rowKey="production_order_line_id"
                    dataSource={line.donors}
                    columns={[
                      {
                        title: "",
                        width: 40,
                        render: (_, d) => (
                          <Checkbox
                            checked={selected[d.production_order_line_id] === line.customer_order_line_id}
                            onChange={(e) => toggleDonor(d.production_order_line_id, line.customer_order_line_id, e.target.checked)}
                          />
                        ),
                      },
                      { title: "Счёт-донор", dataIndex: "invoice_no", render: (v) => v || "Без счёта" },
                      { title: "Клиент", dataIndex: "customer", render: (v) => v || "—" },
                      { title: "Запуск #", dataIndex: "production_order_id", width: 90 },
                      { title: "Кол-во", dataIndex: "quantity", width: 80 },
                      { title: "Упаковано ГП", dataIndex: "packed_qty", width: 110 },
                    ]}
                  />
                )
              )}
            </div>
          ))}
        </Space>
      )}
    </Modal>
  );
}
