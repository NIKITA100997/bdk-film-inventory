import { useEffect, useState } from "react";
import { Button, Card, Form, InputNumber, Select, Typography, Alert, Table, Space, Tag, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { isAxiosError } from "axios";
import {
  issueDonorAtomic,
  issueUnit,
  issueUnitDirect,
  searchUnits,
  skuLabel,
  type AreaValue,
  type IssueResult,
  type MaterialUnit,
} from "../../api/units";
import { listMaterialSkus } from "../../api/dictionaries";
import { listProductionTasks } from "../../api/production";
import { getOrderRequirements, listOrders, type OrderRequirement } from "../../api/orders";

const areaLabels: Record<string, string> = {
  okutka_tsargovykh: "Окутка царговых",
  shchitovye_dveri: "Щитовые двери",
  tselnolistovye_dveri: "Цельнолистовые двери",
};

const areaOptions: { value: AreaValue; label: string }[] = [
  { value: "okutka_tsargovykh", label: "Окутка царговых" },
  { value: "shchitovye_dveri", label: "Щитовые двери" },
  { value: "tselnolistovye_dveri", label: "Цельнолистовые двери" },
];

function issueErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

interface IssuePrefill {
  material?: string;
  color?: string;
  thickness?: number;
  manufacturer?: string;
  taskLineId?: number;
  area?: AreaValue;
  strip_width_mm?: number;
  length_m?: number;
}

export default function Issue() {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const prefill = (location.state as IssuePrefill | null) ?? undefined;

  const [skuId, setSkuId] = useState<number | null>(null);
  const [area, setArea] = useState<AreaValue | null>(prefill?.area ?? null);
  const [selectedOrderId, setSelectedOrderId] = useState<number | undefined>(undefined);
  const [taskLineId, setTaskLineId] = useState<number | undefined>(prefill?.taskLineId ?? undefined);
  const [result, setResult] = useState<IssueResult | null>(null);
  const [findForm] = Form.useForm<{ width_mm: number; length_m: number }>();

  const skusQuery = useQuery({ queryKey: ["material-skus"], queryFn: listMaterialSkus });
  const ordersQuery = useQuery({ queryKey: ["orders"], queryFn: listOrders });
  const tasksQuery = useQuery({ queryKey: ["production-tasks"], queryFn: listProductionTasks });
  const selectedSku = skusQuery.data?.find((s) => s.id === skuId) ?? null;

  const allTaskLines = (tasksQuery.data ?? []).flatMap((t) =>
    t.lines.filter((l) => l.remaining_pieces > 0).map((l) => ({ task: t, line: l })),
  );

  const orderRequirementsQuery = useQuery({
    queryKey: ["order-requirements", selectedOrderId],
    queryFn: () => getOrderRequirements(selectedOrderId!),
    enabled: !!selectedOrderId,
  });

  const handleTaskChange = (selectedLineId?: number) => {
    setTaskLineId(selectedLineId);
    setSelectedOrderId(undefined);
    if (!selectedLineId) return;
    const found = allTaskLines.find(({ line }) => line.id === selectedLineId);
    if (!found) return;
    const { task, line } = found;
    setArea(task.area);
    if (skusQuery.data) {
      const match = skusQuery.data.find(
        (s) =>
          s.material.name.toLowerCase() === line.material.toLowerCase() &&
          s.color.name.toLowerCase() === line.color.toLowerCase() &&
          Math.abs(s.thickness.value_mm - line.thickness) < 0.01,
      );
      if (match) setSkuId(match.id);
    }
    const sw = line.strip_width_mm || line.width_mm;
    findForm.setFieldsValue({ width_mm: sw, length_m: line.length_m });
    message.success(`Подтянуто задание: ${line.part_name ?? "Деталь"} — штрипс ${sw} мм, ${line.length_m} м`);
  };

  const handleOrderChange = (orderId?: number) => {
    setSelectedOrderId(orderId);
    // Заказ может покрывать несколько разных штрипсов сразу (раздел про
    // потребности по всему заказу) — не подтягиваем ничего автоматически,
    // оператор выбирает конкретную строку потребности ниже.
  };

  const handleRequirementSelect = (req: OrderRequirement) => {
    setTaskLineId(undefined);
    const match = skusQuery.data?.find(
      (s) =>
        s.material.name.toLowerCase() === req.material.toLowerCase() &&
        s.color.name.toLowerCase() === req.color.toLowerCase() &&
        Math.abs(s.thickness.value_mm - req.thickness) < 0.01,
    );
    if (match) setSkuId(match.id);
    findForm.setFieldsValue({ width_mm: req.strip_width_mm, length_m: req.length_m });
    message.success(`Подтянута потребность заказа: ${req.part_name ?? "деталь"} — штрипс ${req.strip_width_mm} мм, ${req.length_m} м`);
  };

  useEffect(() => {
    if (!prefill || !skusQuery.data) return;
    if (prefill.material && prefill.color && prefill.thickness) {
      const match = skusQuery.data.find(
        (s) =>
          s.material.name.toLowerCase() === prefill.material!.toLowerCase() &&
          s.color.name.toLowerCase() === prefill.color!.toLowerCase() &&
          Math.abs(s.thickness.value_mm - prefill.thickness!) < 0.01,
      );
      if (match) setSkuId(match.id);
    }
    if (prefill.strip_width_mm || prefill.length_m) {
      findForm.setFieldsValue({ width_mm: prefill.strip_width_mm, length_m: prefill.length_m });
    }
  }, [prefill, skusQuery.data, findForm]);

  const availableQuery = useQuery({
    queryKey: ["issue-available-units", skuId],
    queryFn: () =>
      searchUnits({
        material: selectedSku!.material.name,
        color: selectedSku!.color.name,
        thickness: selectedSku!.thickness.value_mm,
        manufacturer: selectedSku!.manufacturer.name,
        status: "На_хранении",
      }),
    enabled: !!selectedSku,
  });

  const directMutation = useMutation({
    mutationFn: (unitId: number) => issueUnitDirect(unitId, area!, selectedOrderId, taskLineId),
    onSuccess: (unit) => {
      message.success(`Выдана единица №${unit.id}`);
      qc.invalidateQueries({ queryKey: ["issue-available-units", skuId] });
      setResult({ outcome: "issued", unit, donor: null });
    },
    onError: (e) => message.error(issueErrorMessage(e, "Не удалось выдать")),
  });

  const findMutation = useMutation({
    mutationFn: (v: { width_mm: number; length_m: number }) =>
      issueUnit({
        material: selectedSku!.material.name,
        color: selectedSku!.color.name,
        thickness: selectedSku!.thickness.value_mm,
        manufacturer: selectedSku!.manufacturer.name,
        width_mm: v.width_mm,
        length_m: v.length_m,
        area: area!,
        order_id: selectedOrderId,
        production_task_line_id: taskLineId,
      }),
    onSuccess: (res) => {
      setResult(res);
      if (res.outcome === "issued") {
        message.success(`Выдана единица № ${res.unit!.id}`);
        qc.invalidateQueries({ queryKey: ["issue-available-units", skuId] });
      }
    },
    onError: (e) => message.error(issueErrorMessage(e, "Не удалось оформить выдачу")),
  });

  const atomicDonorMutation = useMutation({
    mutationFn: (values: { donor_unit_id: number; requested_width_mm: number; area: AreaValue }) =>
      issueDonorAtomic({ ...values, order_id: selectedOrderId, production_task_line_id: taskLineId }),
    onSuccess: (res) => {
      message.success(
        `Донор разрезан и выдан! Выдана единица №${res.issued_unit.id} (${res.issued_unit.width_mm} мм). Остаток №${res.remainder_unit?.id ?? "—"} обновлен на хранении.`,
      );
      qc.invalidateQueries({ queryKey: ["issue-available-units", skuId] });
      setResult({ outcome: "issued", unit: res.issued_unit, donor: null });
    },
    onError: (e) => message.error(issueErrorMessage(e, "Не удалось разрезать и выдать донора")),
  });

  return (
    <Card>
      <Typography.Title level={4}>Выдача участку</Typography.Title>

      <Space style={{ display: "flex", flexDirection: "column", width: "100%" }} size="large">
        <Card size="small" title="📋 Активные заявки и задания цеха на выдачу" style={{ background: "#fafafa" }}>
          <Table
            size="small"
            rowKey={(r) => r.line.id}
            dataSource={allTaskLines}
            pagination={{ pageSize: 5 }}
            scroll={{ x: "max-content" }}
            columns={[
              { title: "Задание / Модель", render: (_, r) => r.task.product_model_name ?? r.task.name ?? `Задание №${r.task.id}` },
              { title: "Деталь", render: (_, r) => r.line.part_name ?? "—" },
              { title: "Участок", render: (_, r) => areaLabels[r.task.area] ?? r.task.area },
              { title: "Материал плёнки", render: (_, r) => `${r.line.material}, ${r.line.color}, ${r.line.thickness} мм` },
              { title: "Штрипс", render: (_, r) => <Tag color="blue">{r.line.strip_width_mm || r.line.width_mm} мм</Tag> },
              { title: "Осталось", render: (_, r) => `${r.line.remaining_pieces} шт (${r.line.remaining_length_m} м)` },
              {
                title: "Выбор",
                render: (_, r) => (
                  <Button
                    size="small"
                    type="primary"
                    onClick={() => handleTaskChange(r.line.id)}
                  >
                    ⚡ Выбрать
                  </Button>
                ),
              },
            ]}
          />
        </Card>

        <Card size="small" title="📦 Потребности по заказу" style={{ background: "#fafafa" }}>
          <Select
            size="large"
            allowClear
            showSearch
            style={{ width: "100%", marginBottom: 12 }}
            placeholder="Заказ (опционально) — увидеть все нужные штрипсы разом"
            options={(ordersQuery.data ?? []).map((o) => ({ value: o.id, label: o.number }))}
            filterOption={(input, option) => String(option?.label ?? "").toLowerCase().includes(input.toLowerCase())}
            value={selectedOrderId}
            onChange={handleOrderChange}
          />
          {selectedOrderId && (
            <Table
              size="small"
              rowKey={(_, i) => String(i)}
              loading={orderRequirementsQuery.isLoading}
              dataSource={orderRequirementsQuery.data ?? []}
              pagination={false}
              scroll={{ x: "max-content" }}
              locale={{ emptyText: "По этому заказу нет незакрытых потребностей" }}
              columns={[
                { title: "Деталь", render: (_, r) => r.part_name ?? "—" },
                { title: "Материал плёнки", render: (_, r) => `${r.material}, ${r.color}, ${r.thickness} мм` },
                { title: "Штрипс", render: (_, r) => <Tag color="blue">{r.strip_width_mm} мм</Tag> },
                { title: "Нужно", render: (_, r) => `${r.remaining_pieces} шт (${r.remaining_length_m} м)` },
                {
                  title: "Выбор",
                  render: (_, r) => (
                    <Button size="small" type="primary" onClick={() => handleRequirementSelect(r)}>
                      ⚡ Выбрать
                    </Button>
                  ),
                },
              ]}
            />
          )}
        </Card>

        <Select
          size="large"
          style={{ width: "100%" }}
          showSearch
          placeholder="Позиция материала — материал, цвет, толщина, производитель"
          loading={skusQuery.isLoading}
          options={(skusQuery.data ?? []).map((s) => ({ value: s.id, label: skuLabel(s) }))}
          filterOption={(input, option) => String(option?.label ?? "").toLowerCase().includes(input.toLowerCase())}
          value={skuId ?? undefined}
          onChange={(v) => {
            setSkuId(v);
            setResult(null);
          }}
        />
        <Select
          size="large"
          placeholder="Участок выдачи"
          style={{ width: "100%" }}
          options={areaOptions}
          value={area ?? undefined}
          onChange={(v) => setArea(v)}
        />

        {selectedSku && (
          <>
            <Typography.Title level={5} style={{ marginBottom: 0 }}>
              В наличии на хранении
            </Typography.Title>
            <Table<MaterialUnit>
              size="middle"
              rowKey="id"
              loading={availableQuery.isLoading}
              dataSource={availableQuery.data ?? []}
              pagination={false}
              scroll={{ x: "max-content" }}
              locale={{ emptyText: "Ничего нет на хранении — укажите нужный размер ниже" }}
              columns={[
                { title: "Ширина×длина", render: (_, u) => `${u.width_mm} мм × ${u.length_m} м` },
                { title: "Ячейка", dataIndex: "location_code", render: (v) => v ?? "—" },
                {
                  title: "Действие выдачи",
                  render: (_, u) => {
                    const targetW = findForm.getFieldValue("width_mm");
                    if (targetW && u.width_mm > targetW) {
                      return (
                        <Button
                          size="middle"
                          type="primary"
                          disabled={!area}
                          loading={atomicDonorMutation.isPending}
                          onClick={() =>
                            atomicDonorMutation.mutate({
                              donor_unit_id: u.id,
                              requested_width_mm: targetW,
                              area: area!,
                            })
                          }
                        >
                          ⚡ Разрезать на {targetW} мм и выдать
                        </Button>
                      );
                    }
                    if (targetW && u.width_mm < targetW) {
                      return <Tag color="warning">Ширина {u.width_mm} меньше {targetW} мм</Tag>;
                    }
                    return (
                      <Button
                        size="middle"
                        type="primary"
                        disabled={!area}
                        loading={directMutation.isPending}
                        onClick={() => directMutation.mutate(u.id)}
                      >
                        Выдать рулон целиком
                      </Button>
                    );
                  },
                },
              ]}
            />

            <Typography.Title level={5} style={{ marginBottom: 0, marginTop: 8 }}>
              Или укажите нужный размер для автоподбора
            </Typography.Title>
            <Form form={findForm} layout="vertical" onFinish={(v) => findMutation.mutate(v)}>
              <Space style={{ width: "100%", flexWrap: "wrap" }}>
                <Form.Item name="width_mm" rules={[{ required: true }]} style={{ marginBottom: 0 }}>
                  <InputNumber size="large" placeholder="Ширина, мм" min={1} style={{ width: 160 }} />
                </Form.Item>
                <Form.Item name="length_m" rules={[{ required: true }]} style={{ marginBottom: 0 }}>
                  <InputNumber size="large" placeholder="Длина, м" min={0.1} step={0.1} style={{ width: 160 }} />
                </Form.Item>
                <Button
                  size="large"
                  type="primary"
                  htmlType="submit"
                  disabled={!area}
                  loading={findMutation.isPending}
                >
                  Найти и выдать
                </Button>
              </Space>
            </Form>
          </>
        )}
      </Space>

      {result?.outcome === "not_found" && (
        <Alert
          style={{ marginTop: 16 }}
          type="warning"
          showIcon
          message="Точного совпадения по ширине нет"
          description="Подходящего штрипса или донора на хранении не найдено. Режьте новый рулон."
        />
      )}

      {result?.outcome === "donor_suggested" && result.donor && (
        <Alert
          style={{ marginTop: 16 }}
          type="info"
          showIcon
          message={
            <Space flex-wrap="wrap">
              <span>Есть донор штрипс №{result.donor.unit_id}, ширина {result.donor.width_mm} мм (Класс {result.donor.width_class})</span>
              {result.donor.days_in_storage !== undefined && (
                <Tag color="volcano">⚠️ Лежалый остаток ({result.donor.days_in_storage} дн.)</Tag>
              )}
            </Space>
          }
          description={
            <Space direction="vertical" style={{ width: "100%", marginTop: 8 }}>
              <div>
                Рекомендуем отрезать <strong>{result.donor.recommended_cut_mm} мм</strong> (отход {result.donor.waste_mm} мм).
              </div>
              <Space flex-wrap="wrap">
                <Button
                  size="large"
                  type="primary"
                  loading={atomicDonorMutation.isPending}
                  onClick={() =>
                    atomicDonorMutation.mutate({
                      donor_unit_id: result.donor!.unit_id,
                      requested_width_mm: result.donor!.recommended_cut_mm,
                      area: area!,
                    })
                  }
                >
                  ⚡ Выдать донора в 1 клик (разрезать и выдать)
                </Button>
                <Button
                  size="large"
                  onClick={() => navigate("/m/unit-card", { state: { unitId: result.donor!.unit_id } })}
                >
                  Открыть карточку донора
                </Button>
              </Space>
            </Space>
          }
        />
      )}

      {result?.outcome === "issued" && result.unit && (
        <Alert
          style={{ marginTop: 16 }}
          type="success"
          showIcon
          message={`Успешно выдано: №${result.unit.id} — ${result.unit.width_mm} мм × ${result.unit.length_m} м`}
        />
      )}
    </Card>
  );
}
