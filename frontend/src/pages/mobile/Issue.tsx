import { useEffect, useState } from "react";
import { Button, Card, Form, InputNumber, Select, Typography, Alert, Table, Space, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
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

const areaOptions: { value: AreaValue; label: string }[] = [
  { value: "okutka_tsargovykh", label: "Окутка царговых" },
  { value: "shchitovye_dveri", label: "Щитовые двери" },
  { value: "tselnolistovye_dveri", label: "Цельнолистовые двери" },
];

interface IssuePrefill {
  material?: string;
  color?: string;
  thickness?: number;
  manufacturer?: string;
}

export default function Issue() {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const prefill = (location.state as IssuePrefill | null) ?? undefined;

  const [skuId, setSkuId] = useState<number | null>(null);
  const [area, setArea] = useState<AreaValue | null>(null);
  const [taskLineId, setTaskLineId] = useState<number | undefined>(undefined);
  const [result, setResult] = useState<IssueResult | null>(null);
  const [findForm] = Form.useForm<{ width_mm: number; length_m: number }>();

  const skusQuery = useQuery({ queryKey: ["material-skus"], queryFn: listMaterialSkus });
  const selectedSku = skusQuery.data?.find((s) => s.id === skuId) ?? null;

  // Раздел про производственные задания — необязательная привязка выдачи к
  // строке задания (для прослеживаемости и видимости остатка "ещё нужно
  // довыдать" — брак в производстве уменьшает "засчитанное" произведённое,
  // строка с остатком > 0 естественно остаётся в списке).
  const tasksQuery = useQuery({ queryKey: ["production-tasks"], queryFn: listProductionTasks, enabled: !!area });
  const taskLineOptions = (tasksQuery.data ?? [])
    .filter((t) => t.area === area)
    .flatMap((t) =>
      t.lines
        .filter((l) => l.remaining_pieces > 0)
        .map((l) => ({
          value: l.id,
          label: `${t.product_model_name ?? t.name ?? "Задание"} — ${l.line_name} — ${l.material}, ${l.color}, ${l.thickness} мм — осталось ${l.remaining_pieces} шт`,
        })),
    );

  useEffect(() => {
    if (!prefill || !skusQuery.data || skuId !== null) return;
    const match = skusQuery.data.find(
      (s) =>
        s.material.name === prefill.material &&
        s.color.name === prefill.color &&
        s.thickness.value_mm === prefill.thickness &&
        s.manufacturer.name === prefill.manufacturer,
    );
    if (match) setSkuId(match.id);
  }, [prefill, skusQuery.data, skuId]);

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
    mutationFn: (unitId: number) => issueUnitDirect(unitId, area!, undefined, taskLineId),
    onSuccess: (unit) => {
      message.success(`Выдана единица №${unit.id}`);
      qc.invalidateQueries({ queryKey: ["issue-available-units", skuId] });
      setResult({ outcome: "issued", unit, donor: null });
    },
    onError: () => message.error("Не удалось выдать"),
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
        production_task_line_id: taskLineId,
      }),
    onSuccess: (res) => {
      setResult(res);
      if (res.outcome === "issued") {
        message.success(`Выдана единица № ${res.unit!.id}`);
        qc.invalidateQueries({ queryKey: ["issue-available-units", skuId] });
      }
    },
    onError: () => message.error("Не удалось оформить выдачу"),
  });

  const atomicDonorMutation = useMutation({
    mutationFn: (values: { donor_unit_id: number; requested_width_mm: number; area: AreaValue }) =>
      issueDonorAtomic({ ...values, production_task_line_id: taskLineId }),
    onSuccess: (res) => {
      message.success(
        `Донор разрезан и выдан! Выдана единица №${res.issued_unit.id} (${res.issued_unit.width_mm} мм). Остаток №${res.remainder_unit?.id ?? "—"} обновлен на хранении.`,
      );
      qc.invalidateQueries({ queryKey: ["issue-available-units", skuId] });
      setResult({ outcome: "issued", unit: res.issued_unit, donor: null });
    },
    onError: () => message.error("Не удалось разрезать и выдать донора"),
  });

  return (
    <Card>
      <Typography.Title level={4}>Выдача участку</Typography.Title>

      <Space direction="vertical" size="large" style={{ width: "100%" }}>
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
          placeholder="Выбрать участок выдачи"
          style={{ width: "100%" }}
          options={areaOptions}
          value={area ?? undefined}
          onChange={(v) => {
            setArea(v);
            setTaskLineId(undefined);
          }}
        />

        {area && (
          <Select
            size="large"
            allowClear
            placeholder="Производственное задание (опционально)"
            style={{ width: "100%" }}
            loading={tasksQuery.isLoading}
            options={taskLineOptions}
            value={taskLineId}
            onChange={setTaskLineId}
            notFoundContent="Нет открытых заданий с остатком на этом участке"
          />
        )}

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
                  title: "",
                  render: (_, u) => (
                    <Button
                      size="middle"
                      type="primary"
                      disabled={!area}
                      loading={directMutation.isPending}
                      onClick={() => directMutation.mutate(u.id)}
                    >
                      Выдать эту
                    </Button>
                  ),
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
          message={`Есть донор штрипс №${result.donor.unit_id}, ширина ${result.donor.width_mm} мм, класс ${result.donor.width_class}`}
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
