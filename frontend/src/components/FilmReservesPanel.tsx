import { useState } from "react";
import { Button, Input, Modal, Space, Table, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import { getFilmReserveSummary, listFilmReservations, releaseFilmReservation, type FilmReservation } from "../api/filmReserve";
import { useAuth } from "../auth/AuthContext";
import { hasPerm } from "../auth/permissions";
import { apiErrorMessage } from "../utils/apiError";
import { UnitLink } from "./EntityLink";

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Снять один резерв (начальник цеха) — с причиной, она остаётся в записи. */
export function useReleaseReservation() {
  const qc = useQueryClient();
  const [target, setTarget] = useState<FilmReservation | null>(null);
  const [note, setNote] = useState("");
  const m = useMutation({
    mutationFn: () => releaseFilmReservation(target!.id, note.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["film-reservations"] });
      qc.invalidateQueries({ queryKey: ["film-reserve-summary"] });
      qc.invalidateQueries({ queryKey: ["film-issue-board"] });
      message.success("Резерв снят");
      setTarget(null);
      setNote("");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось снять резерв")),
  });
  const modal = (
    <Modal
      open={!!target}
      title="Снять резерв"
      okText="Снять"
      okButtonProps={{ danger: true, disabled: !note.trim() }}
      confirmLoading={m.isPending}
      onOk={() => m.mutate()}
      onCancel={() => setTarget(null)}
      destroyOnClose
    >
      {target && (
        <Space direction="vertical" style={{ width: "100%" }}>
          <Typography.Text>
            {target.unit_label}: {r1(target.length_m)} м под {target.task_name ?? `заказ ${target.invoice_no ?? target.customer_order_id}`}
          </Typography.Text>
          <Input.TextArea
            autoFocus
            rows={2}
            maxLength={200}
            placeholder="Почему снимаете — например: рулон нужен срочному заказу"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Space>
      )}
    </Modal>
  );
  return { open: setTarget, modal };
}

/** Резерв плёнки на доске выдачи (15.10): по плёнке — на складе, в резерве,
 * свободно; список закреплённого с переходом к рулону; снять — начальник цеха. */
export default function FilmReservesPanel() {
  const { user } = useAuth();
  const canRelease = hasPerm(user, "film_reserve.override");
  const summary = useQuery({ queryKey: ["film-reserve-summary"], queryFn: getFilmReserveSummary });
  const list = useQuery({ queryKey: ["film-reservations", "all"], queryFn: () => listFilmReservations({}) });
  const [spec, setSpec] = useState<string | null>(null);
  const release = useReleaseReservation();
  const rows = (list.data ?? []).filter((r) => !spec || r.spec_key === spec);
  return (
    <Space direction="vertical" style={{ width: "100%" }} size="large">
      <Table
        size="small"
        rowKey="spec_key"
        loading={summary.isLoading}
        dataSource={summary.data ?? []}
        pagination={false}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: "Резервов нет" }}
        onRow={(r) => ({ onClick: () => setSpec(spec === r.spec_key ? null : r.spec_key), style: { cursor: "pointer" } })}
        rowClassName={(r) => (r.spec_key === spec ? "ant-table-row-selected" : "")}
        columns={[
          { title: "Плёнка", dataIndex: "film" },
          { title: "На складе, м²", dataIndex: "stock_m2", align: "right", render: r1 },
          { title: "В резерве, м²", dataIndex: "reserved_m2", align: "right", render: r1 },
          {
            title: "Свободно, м²",
            dataIndex: "free_m2",
            align: "right",
            render: (v: number) => <Typography.Text type={v <= 0 ? "danger" : undefined}>{r1(v)}</Typography.Text>,
          },
          { title: "Резервов", dataIndex: "reservations", align: "right" },
        ]}
      />
      <Typography.Text type="secondary">
        {spec ? "Показан резерв выбранной плёнки — нажмите строку ещё раз, чтобы показать весь." : "Нажмите плёнку, чтобы показать только её резерв."} В резерве — метры
        рулона с обрезью, поэтому больше, чем площадь штрипсов под заказ.
      </Typography.Text>
      <Table<FilmReservation>
        size="small"
        rowKey="id"
        loading={list.isLoading}
        dataSource={rows}
        pagination={{ pageSize: 50 }}
        scroll={{ x: "max-content" }}
        columns={[
          {
            title: "Рулон",
            render: (_, r) => (
              <Space size={6}>
                <UnitLink id={r.unit_id} />
                <span>{r.unit_label.replace(/^№\d+\s*/, "")}</span>
              </Space>
            ),
          },
          { title: "Место", dataIndex: "location_code", render: (v: string | null) => v ?? "—" },
          { title: "Метров рулона", dataIndex: "length_m", align: "right", render: r1 },
          { title: "Штрипс, мм", dataIndex: "strip_width_mm", align: "right", render: (v: number | null) => v ?? "—" },
          { title: "Под что", render: (_, r) => r.task_name ?? (r.invoice_no ? `заказ клиента ${r.invoice_no}` : "—") },
          { title: "С", dataIndex: "created_at", render: (v: string) => dayjs(v).format("DD.MM HH:mm") },
          ...(canRelease
            ? [
                {
                  title: "",
                  render: (_: unknown, r: FilmReservation) => (
                    <Button size="small" danger type="text" onClick={() => release.open(r)}>
                      Снять
                    </Button>
                  ),
                },
              ]
            : []),
        ]}
      />
      {release.modal}
    </Space>
  );
}
