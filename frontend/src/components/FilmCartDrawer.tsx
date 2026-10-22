import { useState } from "react";
import { Alert, Button, DatePicker, Drawer, Empty, Input, InputNumber, Popconfirm, Select, Space, Table, Typography, message } from "antd";
import { DeleteOutlined } from "@ant-design/icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { Dayjs } from "dayjs";
import { sendFilmCart, type RollWidths } from "../api/purchasing";
import { apiErrorMessage } from "../utils/apiError";
import { filmCart, filmKey, lineArea, useFilmCart, type CartLine } from "../utils/filmCart";

/** Корзина заказа плёнки (22.10): метры и ширина рулона по каждой позиции,
 * «нужно к» и комментарий — и одной кнопкой заявка закупщику. */
export default function FilmCartDrawer({
  open,
  onClose,
  widthsByFilm,
}: {
  open: boolean;
  onClose: () => void;
  widthsByFilm: Map<string, RollWidths>;
}) {
  const lines = useFilmCart();
  const qc = useQueryClient();
  const [needBy, setNeedBy] = useState<Dayjs | null>(null);
  const [note, setNote] = useState("");
  const noWidth = lines.some((l) => !l.width_mm);
  const totalM = lines.reduce((s, l) => s + l.length_m, 0);
  const totalM2 = lines.reduce((s, l) => s + (lineArea(l) ?? 0), 0);

  const send = useMutation({
    mutationFn: () =>
      sendFilmCart({
        lines: lines.map((l) => ({ material: l.material, color: l.color, thickness: l.thickness, length_m: l.length_m, width_mm: l.width_mm! })),
        need_by: needBy ? needBy.format("YYYY-MM-DD") : null,
        note: note.trim() || null,
      }),
    onSuccess: (created) => {
      filmCart.clear();
      setNeedBy(null);
      setNote("");
      qc.invalidateQueries({ queryKey: ["purchase-requests"] });
      qc.invalidateQueries({ queryKey: ["purchasing-stock-overview"] });
      message.success(`Заявка отправлена закупщику: позиций ${created.length}`);
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось отправить заявку")),
  });

  return (
    <Drawer
      title={`Корзина заказа плёнки${lines.length ? ` · ${lines.length}` : ""}`}
      open={open}
      onClose={onClose}
      width={Math.min(820, window.innerWidth)}
      footer={
        lines.length > 0 && (
          <Space style={{ width: "100%", justifyContent: "space-between" }} wrap>
            <Popconfirm title="Очистить корзину?" onConfirm={() => filmCart.clear()}>
              <Button danger>Очистить</Button>
            </Popconfirm>
            <Button type="primary" disabled={noWidth} loading={send.isPending} onClick={() => send.mutate()}>
              Отправить заявку закупщику
            </Button>
          </Space>
        )
      }
    >
      {lines.length === 0 ? (
        <Empty description="Корзина пуста — в «Остатках» укажите метры у плёнки и нажмите «В корзину»" />
      ) : (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Table<CartLine & { idx: number }>
            size="small"
            pagination={false}
            rowKey={(r) => `${filmKey(r)}|${r.width_mm}|${r.idx}`}
            dataSource={lines.map((l, idx) => ({ ...l, idx }))}
            scroll={{ x: 600 }}
            columns={[
              { title: "Плёнка", render: (_, r) => `${r.material}, ${r.color}, ${r.thickness} мм` },
              {
                title: "Ширина рулона, мм",
                width: 150,
                render: (_, r) => {
                  const known = widthsByFilm.get(filmKey(r))?.widths ?? [];
                  return known.length ? (
                    <Select
                      size="small"
                      style={{ width: 120 }}
                      status={r.width_mm ? undefined : "error"}
                      placeholder="ширина"
                      value={r.width_mm ?? undefined}
                      onChange={(v) => filmCart.update(r.idx, { width_mm: v })}
                      options={[...new Set([...known, ...(r.width_mm ? [r.width_mm] : [])])].map((w) => ({ value: w, label: `${w}` }))}
                    />
                  ) : (
                    <InputNumber
                      size="small"
                      min={1}
                      style={{ width: 120 }}
                      status={r.width_mm ? undefined : "error"}
                      placeholder="ширина"
                      value={r.width_mm ?? undefined}
                      onChange={(v) => filmCart.update(r.idx, { width_mm: v ?? null })}
                    />
                  );
                },
              },
              {
                title: "Метров",
                width: 120,
                render: (_, r) => (
                  <InputNumber
                    size="small"
                    min={1}
                    style={{ width: 100 }}
                    value={r.length_m}
                    onChange={(v) => v && filmCart.update(r.idx, { length_m: v })}
                  />
                ),
              },
              { title: "м²", width: 80, align: "right", render: (_, r) => lineArea(r) ?? "—" },
              {
                width: 40,
                render: (_, r) => <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label="Убрать" onClick={() => filmCart.remove(r.idx)} />,
              },
            ]}
            summary={() => (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} colSpan={2}>
                  <Typography.Text strong>Итого</Typography.Text>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={2}>
                  <Typography.Text strong>{Math.round(totalM * 100) / 100} м</Typography.Text>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={3} align="right">
                  <Typography.Text strong>{Math.round(totalM2 * 100) / 100}</Typography.Text>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={4} />
              </Table.Summary.Row>
            )}
          />
          {noWidth && <Alert type="warning" showIcon message="Укажите ширину рулона у отмеченных позиций — без неё не посчитать м²." />}
          <Space wrap>
            <span>Нужно к:</span>
            <DatePicker format="DD.MM.YYYY" value={needBy} onChange={setNeedBy} placeholder="не срочно" />
          </Space>
          <Input.TextArea rows={2} maxLength={200} placeholder="Комментарий закупщику" value={note} onChange={(e) => setNote(e.target.value)} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Закупщик увидит заявки на <Link to="/purchasing">«Закупках»</Link> и сведёт их в заказ поставщику.
          </Typography.Text>
        </Space>
      )}
    </Drawer>
  );
}
