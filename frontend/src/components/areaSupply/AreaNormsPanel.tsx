import { useState } from "react";
import { Alert, Button, Form, InputNumber, Modal, Select, Space, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ResponsiveTable from "../ResponsiveTable";
import { useAuth } from "../../auth/AuthContext";
import { hasPerm } from "../../auth/permissions";
import { listAreas } from "../../api/areas";
import { listAreaNorms, putAreaNorm, type AreaNorm, type SupplyKind } from "../../api/areaSupply";
import { apiErrorMessage } from "../../utils/apiError";
import { KIND_LABEL, NewRequestModal, SupplyItemSelect, useOwnArea } from "./AreaRequestsPanel";

const num = (v: number) => Math.round(v * 100) / 100;

/** Неснижаемый остаток участка (15.10): сколько плёнки/п/ф должно лежать на
 * участке; ниже — «пополнить», одной кнопкой подать заявку на нехватку.
 * Материалы на участках не учитываются (остаток одним числом на склад) —
 * для них только заявки. */
export default function AreaNormsPanel({ kind }: { kind?: SupplyKind }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const own = useOwnArea();
  const canEdit = hasPerm(user, "production_tasks.manage");
  const canRequest = hasPerm(user, "production_tasks.report", "production_tasks.manage", "units.issue");
  const areas = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const q = useQuery({ queryKey: ["area-norms"], queryFn: () => listAreaNorms(), refetchInterval: 120000 });
  const [editing, setEditing] = useState<Partial<AreaNorm> | null>(null);
  const [requestFor, setRequestFor] = useState<AreaNorm | null>(null);
  const [form] = Form.useForm();
  const save = useMutation({
    mutationFn: (v: { area: string; item_id: number; min_qty: number }) => putAreaNorm(v),
    onSuccess: (_, v) => {
      qc.invalidateQueries({ queryKey: ["area-norms"] });
      message.success(v.min_qty > 0 ? "Неснижаемый остаток сохранён" : "Норма убрана");
      setEditing(null);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить")),
  });
  const rows = (q.data ?? []).filter((r) => !kind || r.kind === kind);
  const short = rows.filter((r) => r.short > 0);
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      {short.length > 0 && (
        <Alert type="warning" showIcon message={`Ниже неснижаемого: ${short.length} — ${short.map((r) => `${r.area_name}: ${r.label}`).slice(0, 4).join("; ")}${short.length > 4 ? "…" : ""}`} />
      )}
      {canEdit && (
        <Button
          onClick={() => {
            form.resetFields();
            form.setFieldsValue({ area: own ?? undefined });
            setEditing({});
          }}
        >
          Добавить норму
        </Button>
      )}
      <ResponsiveTable<AreaNorm>
        tableKey={`area-norms-${kind ?? "all"}`}
        exportTitle="Неснижаемый остаток участков"
        size="small"
        rowKey="id"
        loading={q.isLoading}
        dataSource={rows}
        pagination={false}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: "Норм нет — участки работают без неснижаемого остатка" }}
        columns={[
          { title: "Участок", dataIndex: "area_name" },
          {
            title: "Что",
            render: (_, r) => (
              <Space size={4}>
                {!kind && <Tag>{KIND_LABEL[r.kind]}</Tag>}
                {r.label}
              </Space>
            ),
          },
          { title: "Не меньше", align: "right", render: (_, r) => `${num(r.min_qty)} ${r.unit}` },
          { title: "На участке", align: "right", render: (_, r) => `${num(r.have)} ${r.unit}` },
          {
            title: "Пополнить",
            align: "right",
            render: (_, r) =>
              r.short > 0 ? <Typography.Text type="danger">{`${num(r.short)} ${r.unit}`}</Typography.Text> : <Tag color="green">в норме</Tag>,
          },
          {
            title: "",
            render: (_, r) => (
              <Space size={4}>
                {r.short > 0 &&
                  (r.open_request_id ? (
                    <Tag color="orange">заявка №{r.open_request_id}</Tag>
                  ) : (
                    canRequest && (
                      <Button size="small" type="primary" onClick={() => setRequestFor(r)}>
                        Заявка на {num(r.short)} {r.unit}
                      </Button>
                    )
                  ))}
                {canEdit && (
                  <Button
                    size="small"
                    type="text"
                    onClick={() => {
                      form.setFieldsValue({ area: r.area, item_id: r.item_id, min_qty: r.min_qty });
                      setEditing(r);
                    }}
                  >
                    Изменить
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />
      <Modal
        open={!!editing}
        title={editing?.id ? "Неснижаемый остаток" : "Новая норма участка"}
        okText="Сохранить"
        onCancel={() => setEditing(null)}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate({ area: v.area, item_id: v.item_id, min_qty: v.min_qty ?? 0 })}>
          <Form.Item name="area" label="Участок" rules={[{ required: true, message: "Выберите участок" }]}>
            <Select
              disabled={!!editing?.id || !!own}
              showSearch
              optionFilterProp="label"
              options={(areas.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }))}
            />
          </Form.Item>
          <Form.Item name="item_id" label="Позиция" rules={[{ required: true, message: "Выберите позицию" }]}>
            {editing?.id ? (
              <Typography.Text>{editing.label}</Typography.Text>
            ) : (
              <SupplyItemSelect kind={kind} measurableOnly onChange={(v) => form.setFieldValue("item_id", v)} />
            )}
          </Form.Item>
          <Form.Item
            name="min_qty"
            label="Не меньше (плёнка — м², п/ф — шт)"
            extra="0 — убрать норму"
            rules={[{ required: true, message: "Укажите количество" }]}
          >
            <InputNumber min={0} style={{ width: 160 }} />
          </Form.Item>
        </Form>
      </Modal>
      {requestFor && (
        <NewRequestModal
          open
          onClose={() => setRequestFor(null)}
          kind={requestFor.kind}
          initialLabel={requestFor.label}
          initialUnit={requestFor.unit}
          initial={{ area: requestFor.area, item_id: requestFor.item_id, qty: Math.ceil(requestFor.short), note: "ниже неснижаемого остатка" }}
        />
      )}
    </Space>
  );
}
