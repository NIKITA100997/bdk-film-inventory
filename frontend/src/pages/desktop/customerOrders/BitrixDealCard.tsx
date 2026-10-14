import { useState } from "react";
import { Button, Card, Empty, Input, List, Modal, Popconfirm, Space, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { findBitrixDeals, setBitrixDeal, type CustomerOrder } from "../../../api/customerOrders";
import { apiErrorMessage } from "../../../utils/apiError";

/** Сделка Битрикс24 у заказа клиента (14.10): привязана сама (найдена по
 * номеру счёта или создана при отправке производству) или вручную —
 * выбрать из найденных, указать номер/ссылку, создать новую. Дальше
 * программа сама двигает её стадии и пишет в ленту принятие и переносы. */
export default function BitrixDealCard({ order, canEdit }: { order: CustomerOrder; canEdit: boolean }) {
  const qc = useQueryClient();
  const [pick, setPick] = useState(false);
  const [manual, setManual] = useState("");
  const found = useQuery({ queryKey: ["bitrix-deals", order.id], queryFn: () => findBitrixDeals(order.id), enabled: pick, retry: false });
  const set = useMutation({
    mutationFn: (p: { deal?: string; create?: boolean; unlink?: boolean }) => setBitrixDeal(order.id, p),
    onSuccess: (_, p) => {
      qc.invalidateQueries({ queryKey: ["customer-order", order.id] });
      qc.invalidateQueries({ queryKey: ["customer-orders"] });
      setPick(false);
      setManual("");
      message.success(p.unlink ? "Сделка отвязана" : p.create ? "Сделка создана в Битриксе" : "Сделка привязана");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не получилось")),
  });
  return (
    <Card size="small" title="Сделка в Битрикс24">
      {order.bitrix_deal_id ? (
        <Space wrap>
          <a href={order.bitrix_deal_url ?? undefined} target="_blank" rel="noreferrer">
            Сделка №{order.bitrix_deal_id} →
          </a>
          <Typography.Text type="secondary">стадии и даты сделки программа обновляет сама</Typography.Text>
          {canEdit && (
            <Popconfirm title="Отвязать сделку от заказа? В Битриксе она останется." onConfirm={() => set.mutate({ unlink: true })}>
              <Button size="small">Отвязать</Button>
            </Popconfirm>
          )}
        </Space>
      ) : (
        <Space wrap>
          <Typography.Text type="secondary">
            Не привязана{order.status === "draft" ? " — при отправке производству найдётся по номеру счёта или создастся" : ""}.
          </Typography.Text>
          {canEdit && (
            <>
              <Button size="small" onClick={() => setPick(true)}>
                Найти по счёту
              </Button>
              <Popconfirm title="Создать новую сделку в Битриксе по этому заказу?" onConfirm={() => set.mutate({ create: true })}>
                <Button size="small" loading={set.isPending && set.variables?.create}>
                  Создать сделку
                </Button>
              </Popconfirm>
            </>
          )}
        </Space>
      )}
      <Modal open={pick} title={`Сделки по счёту ${order.invoice_no}`} footer={null} onCancel={() => setPick(false)} destroyOnHidden>
        {found.isError ? (
          <Typography.Text type="danger">{apiErrorMessage(found.error, "Не удалось найти")}</Typography.Text>
        ) : !found.isLoading && !(found.data ?? []).length ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Сделок с этим номером счёта в названии нет" />
        ) : (
          <List
            loading={found.isLoading}
            dataSource={found.data ?? []}
            renderItem={(d) => (
              <List.Item
                actions={[
                  <Button key="l" type="primary" size="small" onClick={() => set.mutate({ deal: String(d.id) })}>
                    Привязать
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <a href={d.url ?? undefined} target="_blank" rel="noreferrer">
                      №{d.id} · {d.title}
                    </a>
                  }
                  description={`${d.created ?? ""}${d.amount ? ` · ${d.amount.toLocaleString("ru-RU")} ₽` : ""} · стадия ${d.stage}`}
                />
              </List.Item>
            )}
          />
        )}
        <Space.Compact style={{ width: "100%", marginTop: 12 }}>
          <Input placeholder="Или номер сделки / ссылка на неё" value={manual} onChange={(e) => setManual(e.target.value)} />
          <Button disabled={!manual.trim()} loading={set.isPending} onClick={() => set.mutate({ deal: manual.trim() })}>
            Привязать
          </Button>
        </Space.Compact>
      </Modal>
    </Card>
  );
}
