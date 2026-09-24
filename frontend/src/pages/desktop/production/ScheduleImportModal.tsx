import { useState } from "react";
import { isAxiosError } from "axios";
import { Alert, Button, Input, Modal, Select, Space, Table, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listItemTypes } from "../../../api/itemTypes";
import { importOrderFromSchedule, type ProductionOrder, type ScheduleImportRow } from "../../../api/productionOrders";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

/** График запуска (лист «График» из Excel, колонки: Дата отгрузки, № счёта,
 * Серия, Размер, Цвет, Наименование, Кол-во дверей) → черновик заказа.
 * Строка — позиция по типу (находится или создаётся с техкартой по
 * правилам типа) и строка заказа. Сначала «Разобрать» — предпросмотр. */
export default function ScheduleImportModal({ onClose, onCreated }: { onClose: () => void; onCreated: (o: ProductionOrder) => void }) {
  const qc = useQueryClient();
  const typesQuery = useQuery({ queryKey: ["item-types"], queryFn: () => listItemTypes() });
  const gpTypes = (typesQuery.data ?? []).filter((t) => t.kind_code === "izdelie" && t.is_active && t.name_template);
  const [typeId, setTypeId] = useState<number | undefined>();
  const effectiveType = typeId ?? gpTypes.find((t) => t.name === "Щитовая дверь")?.id ?? gpTypes[0]?.id;
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<{ rows: ScheduleImportRow[]; parse_errors: string[] } | null>(null);

  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      importOrderFromSchedule({ text, type_id: effectiveType as number, name: name.trim() || null, dry_run: dryRun }),
    onSuccess: (res, dryRun) => {
      setPreview(res);
      if (!dryRun && res.order) {
        qc.invalidateQueries({ queryKey: ["production-orders"] });
        qc.invalidateQueries({ queryKey: ["items"] });
        message.success(`Черновик заказа №${res.order.id} создан: ${res.order.lines.length} строк`);
        onCreated(res.order);
      }
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось разобрать график")),
  });
  const bad = preview ? preview.rows.filter((r) => r.errors.length > 0).length + preview.parse_errors.length : 0;
  const totalDoors = preview ? preview.rows.reduce((s, r) => s + r.qty, 0) : 0;
  const newItems = preview ? new Set(preview.rows.filter((r) => !r.exists && r.item_name).map((r) => r.item_name)).size : 0;

  return (
    <Modal
      open
      width={1100}
      title="Заказ из графика запуска"
      onCancel={onClose}
      footer={
        <Space>
          <Button onClick={onClose}>Закрыть</Button>
          <Button disabled={!text.trim() || !effectiveType} loading={run.isPending && run.variables === true} onClick={() => run.mutate(true)}>
            Разобрать
          </Button>
          <Button
            type="primary"
            disabled={!preview || bad > 0 || preview.rows.length === 0}
            loading={run.isPending && run.variables === false}
            onClick={() => run.mutate(false)}
          >
            Создать черновик заказа
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Typography.Text type="secondary">
          Скопируйте строки листа «График» из Excel (Дата отгрузки, № счёта, Серия, Размер, Цвет, Наименование, Кол-во
          дверей) и вставьте сюда. Серия, размер, цвет, стекло, молдинг, замок и кромка берутся из строки; двери и их
          каркасы/панели находятся или заводятся по правилам типа.
        </Typography.Text>
        <Space wrap>
          <Select
            style={{ width: 240 }}
            placeholder="Тип изделия"
            value={effectiveType}
            onChange={(v) => {
              setTypeId(v);
              setPreview(null);
            }}
            options={gpTypes.map((t) => ({ value: t.id, label: t.name }))}
          />
          <Input style={{ width: 360 }} placeholder="Название заказа (по умолчанию — по дате отгрузки)" value={name} onChange={(e) => setName(e.target.value)} />
        </Space>
        <Input.TextArea
          rows={6}
          value={text}
          placeholder="Вставьте строки графика…"
          style={{ fontFamily: "monospace", fontSize: 12 }}
          onChange={(e) => {
            setText(e.target.value);
            setPreview(null);
          }}
        />
        {preview && (
          <>
            {bad > 0 ? (
              <Alert type="error" showIcon message={`Строк с ошибками: ${bad} — поправьте в графике или настройке типа, заказ не создаётся`} />
            ) : (
              <Alert
                type="success"
                showIcon
                message={`Строк: ${preview.rows.length}, дверей: ${totalDoors}; новых позиций: ${newItems} — заведутся с техкартой по правилам типа`}
              />
            )}
            {preview.parse_errors.map((e) => (
              <Typography.Text key={e} type="danger">
                {e}
              </Typography.Text>
            ))}
            <Table<ScheduleImportRow>
              size="small"
              rowKey={(_, i) => String(i)}
              pagination={{ pageSize: 50 }}
              scroll={{ y: 360, x: "max-content" }}
              dataSource={preview.rows}
              columns={[
                { title: "Счёт", dataIndex: "invoice_no" },
                { title: "Серия", dataIndex: "series" },
                { title: "Размер", dataIndex: "size" },
                { title: "Цвет", dataIndex: "color" },
                { title: "Кол-во", dataIndex: "qty" },
                {
                  title: "Позиция",
                  render: (_, r) =>
                    r.errors.length > 0 ? (
                      <Typography.Text type="danger">{r.errors.join("; ")}</Typography.Text>
                    ) : (
                      <Space size={4} wrap>
                        <span>{r.item_name}</span>
                        {r.exists ? <Tag>есть</Tag> : <Tag color="green">новая</Tag>}
                      </Space>
                    ),
                },
                {
                  title: "Наименование в графике",
                  render: (_, r) => (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {r.name_text}
                    </Typography.Text>
                  ),
                },
              ]}
            />
          </>
        )}
      </Space>
    </Modal>
  );
}
