import { useEffect, useState } from "react";
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Typography,
  Descriptions,
  Alert,
  Tag,
  List,
  Space,
  Modal,
  Select,
  message,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import {
  getUnit,
  splitUnit,
  cutUnit,
  returnUnit,
  getReturnPreview,
  placeUnit,
  writeOffUnit,
  getUnitEvents,
  printLabel,
  skuLabel,
  type MaterialUnit,
} from "../../api/units";
import { suggestLocation } from "../../api/storage";
import { listUsers } from "../../api/users";
import { listAreas } from "../../api/areas";
import { listWriteOffReasons } from "../../api/writeOffReasons";
import QrScanButton from "../../components/QrScanButton";

type ActionKind = "place" | "split" | "cut" | "return" | "writeoff" | null;

const statusLabels: Record<string, string> = {
  Принят: "Принят",
  На_хранении: "На хранении",
  Выдан_участку: "Выдан участку",
  Списан: "Списан",
};

function availableActions(unit: MaterialUnit): Exclude<ActionKind, null>[] {
  if (unit.status === "Принят") return ["place"];
  if (unit.status === "На_хранении") return ["split", "cut", "place", "writeoff"];
  if (unit.status === "Выдан_участку") {
    return unit.area === "tselnolistovye_dveri" ? ["cut", "return"] : ["return"];
  }
  return [];
}

const actionLabels: Record<Exclude<ActionKind, null>, string> = {
  place: "Разместить / переместить",
  split: "Разделить",
  cut: "Раскрой",
  return: "Вернуть",
  writeoff: "Списать",
};

export default function UnitCard() {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const [unit, setUnit] = useState<MaterialUnit | null>(null);
  const [action, setAction] = useState<ActionKind>(null);
  const [writeOffOpen, setWriteOffOpen] = useState(false);
  const [scanForm] = Form.useForm<{ id: number }>();
  const [placeForm] = Form.useForm<{ location_code: string }>();
  const [splitForm] = Form.useForm<{ separate_width_mm: number; new_unit_location?: string }>();
  const [cutForm] = Form.useForm<{ cut_length_m: number; remainder_location?: string }>();
  const [returnForm] = Form.useForm<{ actual_length_m: number }>();
  const [writeOffForm] = Form.useForm<{ reason: string; note?: string }>();
  const separateWidth = Form.useWatch("separate_width_mm", splitForm);

  const usersQuery = useQuery({ queryKey: ["users"], queryFn: listUsers });
  const writeOffReasonsQuery = useQuery({ queryKey: ["write-off-reasons"], queryFn: listWriteOffReasons });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaLabel = (code: string) => areasQuery.data?.find((a) => a.code === code)?.name ?? code;
  const eventsQuery = useQuery({
    queryKey: ["unit-events", unit?.id],
    queryFn: () => getUnitEvents(unit!.id),
    enabled: !!unit,
  });

  const placeSuggestion = useQuery({
    queryKey: ["suggest-location", "place", unit?.material_sku.id, unit?.is_strip],
    queryFn: () => suggestLocation({ material_sku_id: unit!.material_sku.id, is_strip: unit!.is_strip }),
    enabled: !!unit && action === "place",
  });
  const splitSuggestion = useQuery({
    queryKey: ["suggest-location", "split", unit?.material_sku.id, separateWidth, unit?.id],
    // Отделяемый кусок — всегда штрипс (раздел про приёмку отдельных
    // штрипсов: любой кусок, отрезанный от донора, MaterialUnit.is_strip=True).
    queryFn: () => suggestLocation({ material_sku_id: unit!.material_sku.id, is_strip: true }),
    enabled: !!unit && action === "split" && !!separateWidth && separateWidth > 0 && separateWidth < unit.width_mm,
  });
  const cutSuggestion = useQuery({
    queryKey: ["suggest-location", "cut", unit?.material_sku.id, unit?.is_strip],
    queryFn: () => suggestLocation({ material_sku_id: unit!.material_sku.id, is_strip: unit!.is_strip }),
    enabled: !!unit && action === "cut",
  });
  const returnPreviewQuery = useQuery({
    queryKey: ["return-preview", unit?.id],
    queryFn: () => getReturnPreview(unit!.id),
    enabled: !!unit && action === "return" && !!unit.production_task_line_id,
  });

  const scanMutation = useMutation({
    mutationFn: (id: number) => getUnit(id),
    onSuccess: (u) => {
      setUnit(u);
      setAction(null);
    },
    onError: () => message.error("Единица не найдена"),
  });

  useEffect(() => {
    const preselectId = (location.state as { unitId?: number } | null)?.unitId;
    if (preselectId) scanMutation.mutate(preselectId);
    // scanMutation.mutate имеет стабильную идентичность между рендерами (react-query) — не в зависимостях намеренно
  }, [location.state]);

  const placeMutation = useMutation({
    mutationFn: (values: { location_code: string }) => placeUnit(unit!.id, values.location_code),
    onSuccess: (u) => {
      setUnit(u);
      setAction(null);
      placeForm.resetFields();
      message.success("Адрес сохранён");
    },
    onError: () => message.error("Не удалось разместить"),
  });

  const splitMutation = useMutation({
    mutationFn: (values: { separate_width_mm: number; new_unit_location?: string }) => splitUnit(unit!.id, values),
    onSuccess: (res) => {
      setUnit(res.parent);
      setAction(null);
      splitForm.resetFields();
      if (res.new_unit) {
        message.success(
          <>
            Новый штрипс №{res.new_unit.id}: {res.new_unit.width_mm} мм, {res.new_unit.length_m} м —{" "}
            <a onClick={() => printLabel(res.new_unit!.id)}>печать бирки</a>
          </>,
        );
      } else {
        message.success("Рулон разделён");
      }
    },
    onError: () => message.error("Не удалось разделить — проверьте ширину и статус единицы"),
  });

  const cutMutation = useMutation({
    mutationFn: (values: { cut_length_m: number; remainder_location?: string }) => cutUnit(unit!.id, values),
    onSuccess: (u) => {
      setUnit(u);
      setAction(null);
      cutForm.resetFields();
      message.success(
        u.length_m > 0 ? `Останется ${u.length_m} м — тот же ID №${u.id}` : `Единица №${u.id} полностью использована`,
      );
    },
    onError: () => message.error("Не удалось выполнить раскрой — проверьте длину и статус единицы"),
  });

  const returnMutation = useMutation({
    mutationFn: (values: { actual_length_m: number }) => returnUnit(unit!.id, values),
    onSuccess: (u) => {
      setUnit(u);
      // Раздел про возврат остатка — сразу переходим к размещению
      // (placeSuggestion уже подхватит новую ширину/остаток единицы), а
      // не закрываем карточку: один поток "вернули → куда положить →
      // напечатали бирку" вместо трёх отдельных действий.
      setAction("place");
      returnForm.resetFields();
      message.success(
        <>
          Остаток возвращён на хранение —{" "}
          <a onClick={() => printLabel(u.id, { kind: "cutting_issue" })}>печать бирки</a>
        </>,
      );
    },
    onError: () => message.error("Не удалось оформить возврат"),
  });

  const writeOffMutation = useMutation({
    mutationFn: (values: { reason: string; note?: string }) =>
      writeOffUnit(unit!.id, values.reason, values.note),
    onSuccess: (u) => {
      setUnit(u);
      setAction(null);
      setWriteOffOpen(false);
      writeOffForm.resetFields();
      qc.invalidateQueries({ queryKey: ["unit-events", u.id] });
      message.success("Единица списана");
    },
    onError: () => message.error("Не удалось списать"),
  });

  const userName = (id: number) => usersQuery.data?.find((u) => u.id === id)?.full_name ?? `#${id}`;
  const reasonName = (code: string) => writeOffReasonsQuery.data?.find((r) => r.code === code)?.name ?? code;

  return (
    <Card>
      <Typography.Title level={4}>Карточка единицы</Typography.Title>

      {!unit && (
        <Form
          form={scanForm}
          layout="vertical"
          onFinish={(v) => scanMutation.mutate(v.id)}
          style={{ marginTop: 16 }}
        >
          <Form.Item name="id" label="ID единицы (по бирке/QR)" rules={[{ required: true }]}>
            <InputNumber size="large" autoFocus style={{ width: "100%" }} placeholder="Введите ID или отсканируйте" />
          </Form.Item>
          <Space style={{ width: "100%" }}>
            <Button size="large" type="primary" htmlType="submit" loading={scanMutation.isPending}>
              Найти по ID
            </Button>
            <QrScanButton
              size="large"
              type="default"
              buttonText="Сканировать QR"
              onScan={(code) => {
                const parsedId = parseInt(code.replace(/\D/g, ""), 10);
                if (parsedId) scanMutation.mutate(parsedId);
                else message.error("QR не содержит числового ID единицы");
              }}
            />
          </Space>
        </Form>
      )}

      {unit && (
        <>
          <Descriptions column={1} size="small" style={{ marginBottom: 16 }} bordered>
            <Descriptions.Item label="ID">№ {unit.id}</Descriptions.Item>
            <Descriptions.Item label="Материал">
              <a
                onClick={() =>
                  navigate("/materials", {
                    state: {
                      material: unit.material_sku.material.name,
                      color: unit.material_sku.color.name,
                      thickness: unit.material_sku.thickness.value_mm,
                    },
                  })
                }
              >
                {skuLabel(unit.material_sku)}
              </a>
            </Descriptions.Item>
            <Descriptions.Item label="Ширина×длина">
              {unit.width_mm} мм × {unit.length_m} м
            </Descriptions.Item>
            <Descriptions.Item label="Статус">
              <Tag color="blue">{statusLabels[unit.status] ?? unit.status}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Где сейчас">
              {unit.location_code ?? (unit.area ? areaLabel(unit.area) : "—")}
            </Descriptions.Item>
            <Descriptions.Item label="УПД / паллета">
              {unit.upd_number} / {unit.pallet_number}
            </Descriptions.Item>
            {unit.parent_id && <Descriptions.Item label="Из рулона">№ {unit.parent_id}</Descriptions.Item>}
          </Descriptions>

          {!action && (
            <Space direction="vertical" style={{ width: "100%" }} size="middle">
              <Space wrap size="middle">
                {availableActions(unit).map((a) =>
                  a === "writeoff" ? (
                    <Button key={a} size="large" danger onClick={() => setWriteOffOpen(true)}>
                      {actionLabels[a]}
                    </Button>
                  ) : (
                    <Button size="large" key={a} type="primary" onClick={() => setAction(a)}>
                      {actionLabels[a]}
                    </Button>
                  ),
                )}
                {unit.status === "На_хранении" && (
                  <Button
                    size="large"
                    onClick={() =>
                      navigate("/m/issue", {
                        state: {
                          material: unit.material_sku.material.name,
                          color: unit.material_sku.color.name,
                          thickness: unit.material_sku.thickness.value_mm,
                          manufacturer: unit.material_sku.manufacturer.name,
                        },
                      })
                    }
                  >
                    Выдать участку
                  </Button>
                )}
                <Button onClick={() => printLabel(unit.id)}>Печать бирки</Button>
                <Button
                  onClick={() => {
                    setUnit(null);
                    scanForm.resetFields();
                  }}
                >
                  Другая единица
                </Button>
              </Space>
            </Space>
          )}

          {action === "place" && (
            <Form form={placeForm} layout="vertical" onFinish={(v) => placeMutation.mutate(v)} style={{ marginTop: 16 }}>
              {placeSuggestion.data && (
                <Alert
                  style={{ marginBottom: 16 }}
                  type="success"
                  showIcon
                  message={`Рекомендуем: ${placeSuggestion.data}`}
                  action={
                    <Button size="small" onClick={() => placeForm.setFieldValue("location_code", placeSuggestion.data)}>
                      Подставить
                    </Button>
                  }
                />
              )}
              <Form.Item
                name="location_code"
                label="Адрес ячейки"
                rules={[{ required: true }]}
                initialValue={unit.location_code ?? undefined}
              >
                <Input placeholder="Р-3-07 или Ш-2-04-06" autoFocus />
              </Form.Item>
              <Button type="primary" htmlType="submit" block loading={placeMutation.isPending}>
                Сохранить адрес
              </Button>
              <Button block style={{ marginTop: 8 }} onClick={() => setAction(null)}>
                Отмена
              </Button>
            </Form>
          )}

          {action === "split" && (
            <Form form={splitForm} layout="vertical" onFinish={(v) => splitMutation.mutate(v)} style={{ marginTop: 16 }}>
              <Form.Item name="separate_width_mm" label="Ширина отделяемой части, мм" rules={[{ required: true }]}>
                <InputNumber min={1} max={unit.width_mm - 1} style={{ width: "100%" }} />
              </Form.Item>
              {splitSuggestion.data && (
                <Alert
                  style={{ marginBottom: 16 }}
                  type="success"
                  showIcon
                  message={`Рекомендуем адрес: ${splitSuggestion.data}`}
                  action={
                    <Button size="small" onClick={() => splitForm.setFieldValue("new_unit_location", splitSuggestion.data)}>
                      Подставить
                    </Button>
                  }
                />
              )}
              <Form.Item name="new_unit_location" label="Ячейка для отделяемой части (опционально)">
                <Input placeholder="Ш-2-04-06" />
              </Form.Item>
              <Button type="primary" htmlType="submit" block loading={splitMutation.isPending}>
                Разделить
              </Button>
              <Button block style={{ marginTop: 8 }} onClick={() => setAction(null)}>
                Отмена
              </Button>
            </Form>
          )}

          {action === "cut" && (
            <Form form={cutForm} layout="vertical" onFinish={(v) => cutMutation.mutate(v)} style={{ marginTop: 16 }}>
              {cutSuggestion.data && (
                <Alert
                  style={{ marginBottom: 16 }}
                  type="success"
                  showIcon
                  message={`Рекомендуем адрес для остатка: ${cutSuggestion.data}`}
                  description="Подставлено ниже — можно оставить как есть или указать другой (например, стеллаж Б)."
                />
              )}
              <Form.Item name="cut_length_m" label="Отрезать, м" rules={[{ required: true }]}>
                <InputNumber min={0.01} max={unit.length_m} step={0.01} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item
                name="remainder_location"
                label="Ячейка для остатка (опционально)"
                initialValue={cutSuggestion.data ?? undefined}
              >
                <Input placeholder="Б-1-02" />
              </Form.Item>
              <Button type="primary" htmlType="submit" block loading={cutMutation.isPending}>
                Списать отрезок без бирки
              </Button>
              <Button block style={{ marginTop: 8 }} onClick={() => setAction(null)}>
                Отмена
              </Button>
            </Form>
          )}

          {action === "return" && (
            <Form
              form={returnForm}
              layout="vertical"
              onFinish={(v) => {
                const expected = returnPreviewQuery.data?.expected_return_length_m;
                if (expected != null) {
                  const tolerance = Math.max(0.1, expected * 0.05);
                  if (Math.abs(v.actual_length_m - expected) > tolerance) {
                    Modal.confirm({
                      title: "Длина заметно отличается от расчётной",
                      content: `Введено ${v.actual_length_m} м, по расчёту должно остаться ${expected} м (хорошие и брак за смену уже учтены). Всё равно сохранить?`,
                      okText: "Сохранить как есть",
                      cancelText: "Отмена",
                      onOk: () => returnMutation.mutate(v),
                    });
                    return;
                  }
                }
                returnMutation.mutate(v);
              }}
              style={{ marginTop: 16 }}
              initialValues={{ actual_length_m: unit.length_m }}
            >
              {returnPreviewQuery.data?.expected_return_length_m != null && (
                <Alert
                  style={{ marginBottom: 16 }}
                  type="info"
                  showIcon
                  message={`По расчёту должно остаться: ${returnPreviewQuery.data.expected_return_length_m} м (хороших ${returnPreviewQuery.data.good_pieces} шт, брака ${returnPreviewQuery.data.defect_pieces} шт)`}
                  action={
                    <Button
                      size="small"
                      onClick={() =>
                        returnForm.setFieldValue("actual_length_m", returnPreviewQuery.data!.expected_return_length_m)
                      }
                    >
                      Подставить
                    </Button>
                  }
                />
              )}
              <Form.Item name="actual_length_m" label="Фактическая текущая длина, м" rules={[{ required: true }]}>
                <InputNumber min={0} step={0.01} style={{ width: "100%" }} />
              </Form.Item>
              <Button type="primary" htmlType="submit" block loading={returnMutation.isPending}>
                Вернуть на склад
              </Button>
              <Button block style={{ marginTop: 8 }} onClick={() => setAction(null)}>
                Отмена
              </Button>
            </Form>
          )}

          <Typography.Title level={5} style={{ marginTop: 24 }}>
            История
          </Typography.Title>
          <List
            size="small"
            loading={eventsQuery.isLoading}
            dataSource={eventsQuery.data ?? []}
            locale={{ emptyText: "Событий пока нет" }}
            renderItem={(ev) => (
              <List.Item>
                <Space direction="vertical" size={0}>
                  <span>
                    <Tag>{ev.event_type.replace(/_/g, " ")}</Tag>
                    {new Date(ev.timestamp).toLocaleString("ru-RU")} — {userName(ev.user_id)}
                  </span>
                  {(ev.from_cell || ev.to_cell) && (
                    <Typography.Text type="secondary">
                      {ev.from_cell ?? "—"} → {ev.to_cell ?? "—"}
                    </Typography.Text>
                  )}
                  {ev.write_off_reason && (
                    <Typography.Text type="secondary">
                      Причина: {reasonName(ev.write_off_reason)}
                      {ev.write_off_note ? ` — ${ev.write_off_note}` : ""}
                    </Typography.Text>
                  )}
                </Space>
              </List.Item>
            )}
          />
        </>
      )}

      <Modal
        title="Списать единицу"
        open={writeOffOpen}
        onCancel={() => setWriteOffOpen(false)}
        onOk={() => writeOffForm.submit()}
        okButtonProps={{ danger: true, loading: writeOffMutation.isPending }}
        okText="Списать"
        destroyOnHidden
      >
        <Alert
          style={{ marginBottom: 16 }}
          type="warning"
          showIcon
          message="Отменить нельзя — используйте, если материал испорчен или физически отсутствует."
        />
        <Form form={writeOffForm} layout="vertical" onFinish={(v) => writeOffMutation.mutate(v)}>
          <Form.Item name="reason" label="Причина" rules={[{ required: true }]}>
            <Select
              loading={writeOffReasonsQuery.isLoading}
              options={(writeOffReasonsQuery.data ?? []).map((r) => ({ value: r.code, label: r.name }))}
              placeholder="Выберите причину"
            />
          </Form.Item>
          <Form.Item name="note" label="Заметка (опционально)">
            <Input.TextArea rows={2} placeholder="Детали для претензии поставщику" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
