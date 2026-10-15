import { useState } from "react";
import { Button, Checkbox, InputNumber, Modal, Space, Table, Typography, message } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { completeProductionTaskLines, type ProductionTask, type ProductionTaskLine } from "../../../api/production";
import { apiErrorMessage } from "../../../utils/apiError";

type Row = { line: ProductionTaskLine; already: number; done: number; close: boolean };
const n = (v: number) => Math.round(v * 100) / 100;
const lineName = (l: ProductionTaskLine) =>
  [l.part_name ?? l.operation_name ?? "Строка", [l.material, l.color].filter(Boolean).join(" ")].filter(Boolean).join(" · ");

/** «Закрыть по позициям» (15.10): у каждой строки — сколько сделано всего;
 * недостающее засчитывается без рулона и без списания (как «всё сделано»),
 * отмеченные строки закрываются. Все строки закрыты — задание в архив. */
export default function CloseByLinesModal({ task, onClose }: { task: ProductionTask; onClose: () => void }) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<Row[]>(() =>
    task.lines
      .filter((l) => !l.is_closed)
      .map((l) => {
        const already = n(l.produced_good_pieces + l.defect_pieces);
        return { line: l, already, done: Math.max(already, l.quantity_pieces), close: true };
      }),
  );
  const set = (id: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.line.id === id ? { ...r, ...patch } : r)));
  const all = (f: (r: Row) => Partial<Row>) => setRows((rs) => rs.map((r) => ({ ...r, ...f(r) })));
  const save = useMutation({
    mutationFn: () =>
      completeProductionTaskLines(
        task.id,
        rows.filter((r) => r.close).map((r) => ({ line_id: r.line.id, done_pieces: r.done, close: true })),
      ),
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      qc.invalidateQueries({ queryKey: ["production-orders"] });
      message.success(t.is_active ? "Строки закрыты, задание остаётся открытым" : "Все строки закрыты — задание в архиве");
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось закрыть")),
  });
  const toClose = rows.filter((r) => r.close).length;
  const added = rows.filter((r) => r.close).reduce((s, r) => s + Math.max(0, r.done - r.already), 0);
  return (
    <Modal
      open
      width={900}
      title="Закрыть по позициям"
      okText={`Закрыть строк: ${toClose}`}
      okButtonProps={{ disabled: toClose === 0 }}
      confirmLoading={save.isPending}
      onOk={() => save.mutate()}
      onCancel={onClose}
    >
      <Space direction="vertical" style={{ width: "100%" }}>
        <Typography.Text type="secondary">
          Укажите, сколько сделано всего по каждой позиции. Недостающее до этого числа засчитается без рулона и без списания плёнки и п/ф —
          как «Закрыть: всё сделано»; готовое изделие придёт на склад. Строки без галочки не трогаются и остаются открытыми.
        </Typography.Text>
        <Space wrap>
          <Button size="small" onClick={() => all((r) => ({ done: Math.max(r.already, r.line.quantity_pieces) }))}>
            Всем — по плану
          </Button>
          <Button size="small" onClick={() => all((r) => ({ done: r.already }))}>
            Всем — сколько уже отчитано
          </Button>
          <Button size="small" onClick={() => all(() => ({ close: true }))}>
            Отметить все
          </Button>
          <Button size="small" onClick={() => all(() => ({ close: false }))}>
            Снять все
          </Button>
        </Space>
        <Table<Row>
          size="small"
          rowKey={(r) => r.line.id}
          dataSource={rows}
          pagination={false}
          scroll={{ x: "max-content", y: 420 }}
          columns={[
            {
              title: "Закрыть",
              width: 70,
              render: (_, r) => <Checkbox checked={r.close} onChange={(e) => set(r.line.id, { close: e.target.checked })} aria-label="Закрыть строку" />,
            },
            { title: "Позиция", render: (_, r) => lineName(r.line) },
            { title: "План, шт", align: "right", render: (_, r) => n(r.line.quantity_pieces) },
            { title: "Отчитано, шт", align: "right", render: (_, r) => r.already },
            {
              title: "Сделано всего, шт",
              render: (_, r) => (
                <InputNumber
                  min={r.already}
                  disabled={!r.close}
                  value={r.done}
                  onChange={(v) => set(r.line.id, { done: v ?? r.already })}
                  style={{ width: 110 }}
                  aria-label="Сделано всего"
                />
              ),
            },
            {
              title: "Не сделано",
              align: "right",
              render: (_, r) => {
                const short = n(r.line.quantity_pieces - r.done);
                return short > 0 ? <Typography.Text type="warning">{short}</Typography.Text> : "—";
              },
            },
          ]}
        />
        <Typography.Text>
          Будет засчитано без отчёта: <b>{n(added)} шт</b>; закрыто строк: <b>{toClose}</b> из {rows.length}
          {toClose === rows.length ? " — задание уйдёт в архив" : ""}.
        </Typography.Text>
      </Space>
    </Modal>
  );
}
