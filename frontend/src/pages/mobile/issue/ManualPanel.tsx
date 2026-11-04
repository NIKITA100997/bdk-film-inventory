import { useState, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Button,
  Form,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import {
  batchIssueToArea,
  skuLabel,
  type MaterialUnit,
} from "../../../api/units";
import ResponsiveTable from "../../../components/ResponsiveTable";
import { rollNo } from "../../../utils/lotNo";
import { makeDonorUnit } from "./model";
import { type IssueState } from "./useIssue";

/** «Выдать без задания» — ручной подбор (06.10: из Issue.tsx). */
export default function ManualPanel({ s }: { s: IssueState }) {
  const { navigate, qc, setCuttingSession, manualSkuId, setManualSkuId, manualArea, setManualArea, manualForm, manualDonor, setManualDonor, manualElsewhere, manualSkusQuery, areaOptions, confirmIfWrongWarehouse, finishSingleCut, manualSku, manualAvailableQuery, manualDirectMutation, manualFindMutation } = s;
  const [selectedUnitIds, setSelectedUnitIds] = useState<number[]>([]);
  const availableUnits = manualAvailableQuery.data ?? [];

  const selectedTotalM = useMemo(() => {
    const set = new Set(selectedUnitIds);
    return availableUnits.filter((u) => set.has(u.id)).reduce((sum, u) => sum + Number(u.length_m || 0), 0);
  }, [availableUnits, selectedUnitIds]);

  const batchIssueMutation = useMutation({
    mutationFn: async () => {
      if (!manualArea) throw new Error("Выберите участок выдачи");
      if (selectedUnitIds.length === 0) throw new Error("Выберите хотя бы один рулон или штрипс");
      return batchIssueToArea({
        unit_ids: selectedUnitIds,
        area: manualArea,
        note: "Массовое перемещение пачки в цех",
      });
    },
    onSuccess: (res) => {
      message.success(`Перемещено ${res.issued_count} шт. (${res.total_meters} м) на участок ${manualArea}`);
      setSelectedUnitIds([]);
      qc.invalidateQueries({ queryKey: ["manual-available"] });
      qc.invalidateQueries({ queryKey: ["units"] });
      qc.invalidateQueries({ queryKey: ["film-issue-board"] });
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
    },
    onError: (e: any) => message.error(e?.message || "Ошибка массового перемещения"),
  });

  return (
              <Space orientation="vertical" style={{ width: "100%" }}>
                <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                  Для случаев, когда плёнка не относится ни к одному заданию — проба, списание и т.п. Строгая
                  проверка соответствия здесь не действует.
                </Typography.Text>
                <Select
                  showSearch
                  style={{ width: "100%" }}
                  placeholder="Позиция материала"
                  loading={manualSkusQuery.isLoading}
                  options={(manualSkusQuery.data ?? []).map((s) => ({ value: s.id, label: skuLabel(s) }))}
                  filterOption={(input, option) => String(option?.label ?? "").toLowerCase().includes(input.toLowerCase())}
                  value={manualSkuId ?? undefined}
                  onChange={(v) => {
                    setManualSkuId(v);
                    setManualDonor(null);
                  }}
                />
                <Select
                  style={{ width: "100%" }}
                  placeholder="Участок выдачи"
                  options={areaOptions}
                  value={manualArea ?? undefined}
                  onChange={(v) => setManualArea(v)}
                />
                {manualSku && (
                  <>
                    {availableUnits.length > 0 && (
                      <Space size={8} wrap style={{ marginBottom: 8, marginTop: 4 }}>
                        <Button
                          size="small"
                          onClick={() => setSelectedUnitIds(availableUnits.map((u) => u.id))}
                        >
                          Выбрать все ({availableUnits.length} шт.)
                        </Button>
                        {selectedUnitIds.length > 0 && (
                          <Button size="small" onClick={() => setSelectedUnitIds([])}>
                            Снять выбор
                          </Button>
                        )}
                      </Space>
                    )}
                    <ResponsiveTable<MaterialUnit>
                      size="small"
                      rowKey="id"
                      loading={manualAvailableQuery.isLoading}
                      dataSource={manualAvailableQuery.data ?? []}
                      rowSelection={{
                        selectedRowKeys: selectedUnitIds,
                        onChange: (keys) => setSelectedUnitIds(keys as number[]),
                      }}
                      pagination={false}
                      scroll={{ x: "max-content" }}
                      locale={{ emptyText: "Ничего нет на хранении" }}
                      columns={[
                        { title: "№", dataIndex: "id", render: (v: number) => rollNo(v) },
                        { title: "Ширина×длина", render: (_, u) => `${u.width_mm} мм × ${u.length_m} м` },
                        { title: "Ячейка", dataIndex: "location_code", render: (v) => v ?? "—" },
                        {
                          title: "",
                          render: (_, u) => (
                            <Button
                              size="small"
                              type="primary"
                              disabled={!manualArea}
                              loading={manualDirectMutation.isPending}
                              onClick={() =>
                                confirmIfWrongWarehouse(u.warehouse_name, manualArea, () => manualDirectMutation.mutate(u.id))
                              }
                            >
                              Выдать целиком
                            </Button>
                          ),
                        },
                      ]}
                    />
                    {selectedUnitIds.length > 0 && (
                      <div
                        style={{
                          marginTop: 8,
                          marginBottom: 8,
                          padding: "10px 14px",
                          background: "#F6FFED",
                          border: "1px solid #B7EB8F",
                          borderRadius: 8,
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          flexWrap: "wrap",
                          gap: 8,
                        }}
                      >
                        <Space size={8} wrap>
                          <Typography.Text strong>Выбрано для отправки:</Typography.Text>
                          <Tag color="green" style={{ fontSize: 13, padding: "2px 8px" }}>
                            {selectedUnitIds.length} шт. · {Math.round(selectedTotalM * 10) / 10} м
                          </Tag>
                        </Space>
                        <Popconfirm
                          title={`Переместить пачку из ${selectedUnitIds.length} шт. (${Math.round(selectedTotalM * 10) / 10} м) на участок ${manualArea ?? "—"}?`}
                          disabled={!manualArea}
                          okText="Да, переместить"
                          cancelText="Отмена"
                          onConfirm={() => batchIssueMutation.mutate()}
                        >
                          <Button
                            type="primary"
                            disabled={!manualArea}
                            loading={batchIssueMutation.isPending}
                            style={{ background: "#389e0d" }}
                          >
                            🚀 Переместить пачку на {manualArea ?? "участок"}
                          </Button>
                        </Popconfirm>
                      </div>
                    )}
                    <Form form={manualForm} layout="inline" onFinish={(v) => manualFindMutation.mutate(v)}>
                      <Form.Item name="width_mm" rules={[{ required: true }]}>
                        <InputNumber placeholder="Ширина, мм" min={1} style={{ width: 120 }} />
                      </Form.Item>
                      <Form.Item name="length_m" rules={[{ required: true }]}>
                        <InputNumber placeholder="Длина, м" min={0.1} step={0.1} style={{ width: 120 }} />
                      </Form.Item>
                      <Button htmlType="submit" disabled={!manualArea} loading={manualFindMutation.isPending}>
                        Найти и выдать
                      </Button>
                    </Form>
                    {manualElsewhere && (
                      <div style={{ background: "#FBEAE7", border: "1px solid #E3B5AC", borderRadius: 10, padding: 12 }}>
                        <div style={{ fontWeight: 700, color: "#B8483C" }}>Материал есть на другом складе</div>
                        <div style={{ fontSize: 12.5, color: "#8C4238", marginTop: 4 }}>
                          Есть на складе «{manualElsewhere}» — подготовьте (нарежьте) там и отправьте через «Перемещения
                          между складами», затем выдайте уже с домашнего склада.
                        </div>
                        <Button size="small" style={{ marginTop: 8 }} onClick={() => navigate("/warehouse-transfers")}>
                          Перейти к перемещениям
                        </Button>
                      </div>
                    )}
                    {manualDonor && (
                      <div style={{ background: "#FBF0E3", border: "1px solid #ECC79B", borderRadius: 10, padding: 12 }}>
                        <div style={{ fontWeight: 700, color: "#A8631E" }}>
                          ⚡ Точного совпадения нет — есть донор {rollNo(manualDonor.unit_id)}
                        </div>
                        <div style={{ fontSize: 12.5, marginTop: 4 }}>
                          {manualDonor.width_mm} мм, класс{" "}
                          <Tooltip title="ABC по расходу: A — самые ходовые ширины (80% расхода), B — следующие до 95%, C — редкие, донор режут в первую очередь именно из C/B">
                            <span style={{ textDecoration: "underline dotted" }}>{manualDonor.width_class}</span>
                          </Tooltip>
                          {manualDonor.days_in_storage !== undefined && manualDonor.days_in_storage > 0 && (
                            <Tag color="volcano" style={{ marginLeft: 6 }}>лежалый {manualDonor.days_in_storage} дн.</Tag>
                          )}
                          <br />
                          Отрежем {manualDonor.recommended_cut_mm} мм, отход {manualDonor.waste_mm} мм.
                        </div>
                        <Button
                          type="primary"
                          block
                          style={{ marginTop: 10 }}
                          disabled={!manualArea}
                          onClick={() => {
                            if (!manualSku || !manualArea) return;
                            setCuttingSession({
                              donor: makeDonorUnit(
                                manualDonor.unit_id,
                                manualDonor.width_mm,
                                manualDonor.length_m,
                                manualDonor.warehouse_name,
                                manualSku,
                              ),
                              widthCuts: [
                                {
                                  width_mm: manualDonor.recommended_cut_mm,
                                  area: manualArea,
                                  label: "Ручной подбор",
                                  locked: false,
                                },
                              ],
                              onDone: (res) => {
                                finishSingleCut(res);
                                setManualDonor(null);
                                qc.invalidateQueries({ queryKey: ["issue-manual-available"] });
                              },
                            });
                          }}
                        >
                          ⚡ Разрезать и выдать
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </Space>
  );

}
