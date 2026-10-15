import { Button, Card, Popconfirm, Space, Table, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getFilmReserveSettings,
  listFilmReservations,
  releaseFilmForCustomerOrder,
  reserveFilmForCustomerOrder,
} from "../../../api/filmReserve";
import { apiErrorMessage } from "../../../utils/apiError";

/** Резерв плёнки у срочного заказа клиента (15.10): до запуска закрепить
 * метры на рулонах склада; при запуске резерв переходит на строки заданий.
 * Карточки нет, если функция выключена в настройках. */
export default function FilmReserveCard({ orderId, canEdit }: { orderId: number; canEdit: boolean }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["film-reserve-settings"], queryFn: getFilmReserveSettings, retry: false });
  const on = !!settings.data?.enabled;
  const rows = useQuery({
    queryKey: ["film-reservations", "co", orderId],
    queryFn: () => listFilmReservations({ customer_order_id: orderId }),
    enabled: on,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["film-reservations"] });
    qc.invalidateQueries({ queryKey: ["film-issue-board"] });
  };
  const reserve = useMutation({
    mutationFn: () => reserveFilmForCustomerOrder(orderId),
    onSuccess: (r) => {
      refresh();
      if (r.lines === 0) message.info("Всё нужное уже закреплено");
      else if (r.short_m2 > 0) message.warning(`Закреплено ${r.reserved_m2} м², на складе не хватило ${r.short_m2} м²`);
      else message.success(`Закреплено ${r.reserved_m2} м²`);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не получилось зарезервировать")),
  });
  const release = useMutation({
    mutationFn: () => releaseFilmForCustomerOrder(orderId),
    onSuccess: (r) => {
      refresh();
      message.success(`Снято резервов: ${r.released}`);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не получилось снять")),
  });
  if (!on) return null;
  const list = rows.data ?? [];
  const total = list.reduce((s, r) => s + r.area_m2, 0);
  return (
    <Card
      size="small"
      title={`Резерв плёнки${list.length ? ` — ${total.toFixed(1)} м²` : ""}`}
      extra={
        canEdit && (
          <Space>
            <Button size="small" type="primary" loading={reserve.isPending} onClick={() => reserve.mutate()}>
              {list.length ? "Дозарезервировать" : "Зарезервировать плёнку"}
            </Button>
            {list.length > 0 && (
              <Popconfirm title="Снять весь резерв этого заказа?" onConfirm={() => release.mutate()}>
                <Button size="small" loading={release.isPending}>
                  Снять
                </Button>
              </Popconfirm>
            )}
          </Space>
        )
      }
    >
      {list.length === 0 ? (
        <Typography.Text type="secondary">
          Плёнка не закреплена. Для срочного заказа можно закрепить её до запуска — с запасом {settings.data?.extra_pct ?? 0} % на брак и
          пусковые.
        </Typography.Text>
      ) : (
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={list}
          scroll={{ x: "max-content" }}
          columns={[
            { title: "Рулон", dataIndex: "unit_label" },
            { title: "Место", dataIndex: "location_code", render: (v) => v ?? "—" },
            { title: "Метров рулона", dataIndex: "length_m", align: "right", render: (v: number) => v.toFixed(1) },
            { title: "Штрипс, мм", dataIndex: "strip_width_mm", align: "right", render: (v: number | null) => (v ? v : "—") },
            {
              title: "Метров штрипса",
              align: "right",
              render: (_, r) => (r.strip_width_mm ? ((r.area_m2 * 1000) / r.strip_width_mm).toFixed(1) : "—"),
            },
            { title: "м²", dataIndex: "area_m2", align: "right", render: (v: number) => v.toFixed(2) },
          ]}
        />
      )}
    </Card>
  );
}
