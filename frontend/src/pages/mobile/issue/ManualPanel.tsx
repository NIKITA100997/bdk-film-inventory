import {
  Button,
  Form,
  InputNumber,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
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
  return (
              <Space direction="vertical" style={{ width: "100%" }}>
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
                    <ResponsiveTable<MaterialUnit>
                      size="small"
                      rowKey="id"
                      loading={manualAvailableQuery.isLoading}
                      dataSource={manualAvailableQuery.data ?? []}
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
