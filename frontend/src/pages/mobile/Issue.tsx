import { useEffect, useState } from "react";
import { Button, Card, Form, InputNumber, Select, Typography, Alert, Table, Space, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import {
  issueUnit,
  issueUnitDirect,
  searchUnits,
  skuLabel,
  type AreaValue,
  type IssueResult,
  type MaterialUnit,
} from "../../api/units";
import { listMaterialSkus } from "../../api/dictionaries";

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

/** Выдача участку (3 раздел обратной связи) — одна позиция вместо четырёх
 * раздельных выпадающих списков материал/цвет/толщина/производитель.
 * После выбора позиции сразу видно, что реально есть на хранении — можно
 * выдать конкретный рулон/штрипс напрямую, а можно запросить нужный размер
 * и получить либо точное совпадение, либо предложение донора (как раньше). */
export default function Issue() {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const prefill = (location.state as IssuePrefill | null) ?? undefined;

  const [skuId, setSkuId] = useState<number | null>(null);
  const [area, setArea] = useState<AreaValue | null>(null);
  const [result, setResult] = useState<IssueResult | null>(null);
  const [findForm] = Form.useForm<{ width_mm: number; length_m: number }>();

  const skusQuery = useQuery({ queryKey: ["material-skus"], queryFn: listMaterialSkus });
  const selectedSku = skusQuery.data?.find((s) => s.id === skuId) ?? null;

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
    mutationFn: (unitId: number) => issueUnitDirect(unitId, area!),
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

  return (
    <Card>
      <Typography.Title level={4}>Выдача участку</Typography.Title>

      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Select
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
          placeholder="Участок"
          style={{ width: "100%" }}
          options={areaOptions}
          value={area ?? undefined}
          onChange={setArea}
        />

        {selectedSku && (
          <>
            <Typography.Title level={5} style={{ marginBottom: 0 }}>
              В наличии
            </Typography.Title>
            <Table<MaterialUnit>
              size="small"
              rowKey="id"
              loading={availableQuery.isLoading}
              dataSource={availableQuery.data ?? []}
              pagination={false}
              locale={{ emptyText: "Ничего нет на хранении — попробуйте найти по размеру ниже" }}
              columns={[
                { title: "Ширина×длина", render: (_, u) => `${u.width_mm} мм × ${u.length_m} м` },
                { title: "Ячейка", dataIndex: "location_code", render: (v) => v ?? "—" },
                {
                  title: "",
                  render: (_, u) => (
                    <Button
                      size="small"
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
              Или укажите нужный размер
            </Typography.Title>
            <Form form={findForm} layout="inline" onFinish={(v) => findMutation.mutate(v)}>
              <Form.Item name="width_mm" rules={[{ required: true }]}>
                <InputNumber placeholder="Ширина, мм" min={1} />
              </Form.Item>
              <Form.Item name="length_m" rules={[{ required: true }]}>
                <InputNumber placeholder="Длина, м" min={0.1} step={0.1} />
              </Form.Item>
              <Button type="primary" htmlType="submit" disabled={!area} loading={findMutation.isPending}>
                Найти и выдать
              </Button>
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
          message={`Есть штрипс №${result.donor.unit_id}, ширина ${result.donor.width_mm} мм, класс ${result.donor.width_class} (используется редко)`}
          description={`Рекомендуем отрезать ${result.donor.recommended_cut_mm} мм, отход ${result.donor.waste_mm} мм. Оператор режет вручную через «Разделить рулон» и затем повторяет выдачу на полученный кусок.`}
          action={
            <Button
              size="small"
              type="primary"
              onClick={() => navigate("/m/unit-card", { state: { unitId: result.donor!.unit_id } })}
            >
              Разделить рулон
            </Button>
          }
        />
      )}

      {result?.outcome === "issued" && result.unit && (
        <Alert
          style={{ marginTop: 16 }}
          type="success"
          showIcon
          message={`Выдано: № ${result.unit.id} — ${result.unit.width_mm} мм × ${result.unit.length_m} м`}
        />
      )}
    </Card>
  );
}
