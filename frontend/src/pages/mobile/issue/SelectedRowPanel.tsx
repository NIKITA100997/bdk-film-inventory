import {
  Alert,
  Button,
  Card,
  Collapse,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import dayjs from "dayjs";
import {
  printLabel,
  skuLabel,
  type MaterialUnit,
} from "../../../api/units";
import ResponsiveTable from "../../../components/ResponsiveTable";
import { isWidthMatch } from "../../../api/widthAnalogs";
import { rollNo } from "../../../utils/lotNo";
import { makeDonorUnit } from "./model";
import { type IssueState } from "./useIssue";

/** Панель выбранной строки очереди «Выдачи участку» (06.10: из Issue.tsx). */
export default function SelectedRowPanel({ s }: { s: IssueState }) {
  const { navigate, canIssue, canOverrideMaterial, selected, substituteSkuId, setSubstituteSkuId, result, lastIssued, setCuttingSession, skusQuery, widthAnalogGroups, areaLabel, confirmIfWrongWarehouse, selectedSku, selectedStripWidth, findMutation, substituteSku, substituteAvailableQuery, availableQuery, exactMatch, neededM2, availableM2, shortfallM2, openShortageModal, directMutation, finishSingleCut, remainderSuggestion, placeRemainderMutation, finishAndReset } = s;
  // Раздел про разбор задания единой таблицей — прежняя правая панель
  // (точное совпадение/донор-рекомендация/замена материала/карточка
  // "Выдано") без изменений в логике, просто вызывается теперь из
  // expandedRowRender одиночной (негрупповой) строки-нужды вместо
  // отдельной колонки сбоку — разворот строки эквивалентен прежнему
  // "выбрать строку" (см. selectRowForExpand).
  return (
    <>
      {selected && !lastIssued && (
        <Card>
          <Typography.Title level={5}>{selected.line.part_name ?? "Деталь"}</Typography.Title>
          <table style={{ width: "100%", fontSize: 13, marginBottom: 14 }}>
            <tbody>
              <tr>
                <td style={{ color: "#8A8C99", paddingRight: 12 }}>Задание</td>
                <td style={{ fontWeight: 600 }}>
                  {selected.task.product_model_name ?? selected.task.name} · {areaLabel(selected.task.area)}
                </td>
              </tr>
              <tr>
                <td style={{ color: "#8A8C99" }}>Плёнка</td>
                <td style={{ fontWeight: 600 }}>
                  {selected.line.material}, {selected.line.color}, {selected.line.thickness} мм
                </td>
              </tr>
              <tr>
                <td style={{ color: "#8A8C99" }}>Штрипс</td>
                <td style={{ fontWeight: 700, color: "#2C4A73" }}>{selectedStripWidth} мм</td>
              </tr>
              <tr>
                <td style={{ color: "#8A8C99" }}>Длина на штрипс</td>
                <td style={{ fontWeight: 600 }}>{selected.line.length_m} м</td>
              </tr>
              {selected.assignment && (
                <tr>
                  <td style={{ color: "#8A8C99" }}>Смена</td>
                  <td style={{ fontWeight: 600 }}>
                    {dayjs(selected.assignment.date).format("DD.MM.YYYY")}, {selected.assignment.line_name}, {selected.assignment.employee_names}
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {!selectedSku && (
            <Typography.Text type="warning">
              Такой номенклатуры материала нет в справочнике — выдача невозможна, обратитесь к начальнику склада.
            </Typography.Text>
          )}

          {selectedSku && shortfallM2 > 0 && (
            // message+action в один ряд (стандартный Alert) на узкой
            // боковой панели планшета сжимал текст в колонку по
            // одной букве — action всегда пытается влезть рядом с
            // текстом. description+кнопка блоком друг под другом
            // этого не делают ни при какой ширине.
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="Не хватает остатка на складе"
              description={
                <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
                  <span>
                    Не хватает ~{shortfallM2} м² на весь остаток строки — на складе{" "}
                    {Math.round(availableM2 * 100) / 100} м², нужно {Math.round(neededM2 * 100) / 100} м²
                  </span>
                  <Button size="small" type="primary" onClick={openShortageModal}>
                    Подать заявку на закупку
                  </Button>
                </div>
              }
            />
          )}

          {!canIssue && (
            <Typography.Text type="secondary">
              Подбор и выдача штрипса — задача склада, здесь недоступны. Если нужно принять возврат — используйте
              баннер «Готово к возврату» выше или кнопку возврата в самой строке.
            </Typography.Text>
          )}

          {canIssue && (availableQuery.isLoading || findMutation.isPending) && (
            <Typography.Text type="secondary">Подбираем штрипс…</Typography.Text>
          )}

          {canIssue && exactMatch && (
            <div style={{ background: "#E7F5EE", border: "1px solid #B7E0CD", borderRadius: 10, padding: 12, marginBottom: 12 }}>
              <div style={{ fontWeight: 700, color: "#146B4E" }}>Есть точный штрипс {rollNo(exactMatch.id)}</div>
              <div style={{ fontSize: 12.5, marginTop: 4 }}>
                {exactMatch.width_mm} мм × {exactMatch.length_m} м
                {exactMatch.location_code ? ` · ${exactMatch.location_code}` : ""}
              </div>
              <Button
                type="primary"
                block
                style={{ marginTop: 10 }}
                loading={directMutation.isPending}
                onClick={() =>
                  confirmIfWrongWarehouse(exactMatch.warehouse_name, selected?.task.area, () =>
                    directMutation.mutate({ unitId: exactMatch.id }),
                  )
                }
              >
                Выдать
              </Button>
            </div>
          )}

          {canIssue && result?.outcome === "not_found" && (
            <div style={{ background: "#FBEAE7", border: "1px solid #E3B5AC", borderRadius: 10, padding: 12, marginBottom: 12 }}>
              <div style={{ fontWeight: 700, color: "#B8483C" }}>Точного штрипса и донора нет на своём складе</div>
              {result.elsewhere_warehouse_name ? (
                <>
                  <div style={{ fontSize: 12.5, color: "#8C4238", marginTop: 4 }}>
                    Материал есть на складе «{result.elsewhere_warehouse_name}» — подготовьте (нарежьте) там и отправьте
                    через «Перемещения между складами», затем выдайте уже с домашнего склада.
                  </div>
                  <Button size="small" style={{ marginTop: 8 }} onClick={() => navigate("/warehouse-transfers")}>
                    Перейти к перемещениям
                  </Button>
                </>
              ) : (
                <div style={{ fontSize: 12.5, color: "#8C4238", marginTop: 4 }}>Режьте новый рулон вручную через карточку единицы.</div>
              )}
            </div>
          )}

          {canIssue && result?.outcome === "donor_suggested" && result.donor && (
            <div style={{ background: "#FBF0E3", border: "1px solid #ECC79B", borderRadius: 10, padding: 12, marginBottom: 12 }}>
              <div style={{ fontWeight: 700, color: "#A8631E" }}>
                ⚡ Точного штрипса нет — есть донор {rollNo(result.donor.unit_id)}
              </div>
              <div style={{ fontSize: 12.5, marginTop: 4 }}>
                {result.donor.width_mm} мм, класс{" "}
                <Tooltip title="ABC по расходу: A — самые ходовые ширины (80% расхода), B — следующие до 95%, C — редкие, донор режут в первую очередь именно из C/B">
                  <span style={{ textDecoration: "underline dotted" }}>{result.donor.width_class}</span>
                </Tooltip>
                {result.donor.days_in_storage !== undefined && result.donor.days_in_storage > 0 && (
                  <Tag color="volcano" style={{ marginLeft: 6 }}>лежалый {result.donor.days_in_storage} дн.</Tag>
                )}
                <br />
                Отрежем {result.donor.recommended_cut_mm} мм, отход {result.donor.waste_mm} мм.
              </div>
              <Button
                type="primary"
                block
                style={{ marginTop: 10 }}
                onClick={() => {
                  if (!selectedSku || !selected) return;
                  setCuttingSession({
                    donor: makeDonorUnit(
                      result.donor!.unit_id,
                      result.donor!.width_mm,
                      result.donor!.length_m,
                      result.donor!.warehouse_name,
                      selectedSku,
                    ),
                    widthCuts: [
                      {
                        width_mm: result.donor!.recommended_cut_mm,
                        area: selected.task.area,
                        production_task_line_id: selected.line.id,
                        label: selected.line.part_name ?? "Деталь",
                        locked: true,
                      },
                    ],
                    onDone: finishSingleCut,
                  });
                }}
              >
                ⚡ Разрезать и выдать
              </Button>
            </div>
          )}

          {canIssue && (
          <Collapse
            ghost
            size="small"
            items={[
              {
                key: "stock",
                label: `Показать остатки на складе по этой номенклатуре (${availableQuery.data?.length ?? 0})`,
                children: (
                  <ResponsiveTable<MaterialUnit>
                    size="small"
                    rowKey="id"
                    loading={availableQuery.isLoading}
                    dataSource={availableQuery.data ?? []}
                    pagination={false}
                    scroll={{ x: "max-content" }}
                    locale={{ emptyText: "Ничего нет на хранении" }}
                    columns={[
                      { title: "№", dataIndex: "id", render: (v: number) => rollNo(v) },
                      { title: "Ширина×длина", render: (_, u) => `${u.width_mm} мм × ${u.length_m} м` },
                      { title: "Ячейка", dataIndex: "location_code", render: (v) => v ?? "—" },
                      {
                        title: "",
                        render: (_, u) =>
                          // Аналог (см. "Аналоги ширин штрипса") считается совпадением
                          // раньше, чем сравнение ">" — иначе донор аналоговой, но
                          // числом большей ширины (290 вместо нужных 285) предлагался
                          // бы резать, хотя по факту это тот же штрипс, выдаём целиком.
                          isWidthMatch(widthAnalogGroups, u.width_mm, selectedStripWidth) ? (
                            <Button
                              size="small"
                              type="primary"
                              loading={directMutation.isPending}
                              onClick={() => confirmIfWrongWarehouse(u.warehouse_name, selected?.task.area, () => directMutation.mutate({ unitId: u.id }))}
                            >
                              Выдать целиком
                            </Button>
                          ) : u.width_mm > selectedStripWidth ? (
                            <Button
                              size="small"
                              onClick={() => {
                                if (!selected) return;
                                setCuttingSession({
                                  donor: u,
                                  widthCuts: [
                                    {
                                      width_mm: selectedStripWidth,
                                      area: selected.task.area,
                                      production_task_line_id: selected.line.id,
                                      label: selected.line.part_name ?? "Деталь",
                                      locked: true,
                                    },
                                  ],
                                  onDone: finishSingleCut,
                                });
                              }}
                            >
                              Разрезать на {selectedStripWidth} мм
                            </Button>
                          ) : (
                            <Tag color="warning">уже {selectedStripWidth} мм больше</Tag>
                          ),
                      },
                    ]}
                  />
                ),
              },
              ...(canOverrideMaterial
                ? [
                    {
                      key: "substitute",
                      label: "🔁 Выдать другим материалом (замена)",
                      children: (
                        <Space direction="vertical" style={{ width: "100%" }} size="small">
                          <Typography.Text type="secondary">
                            Если нужной номенклатуры сейчас не хватает — выберите другой материал/цвет/толщину; сервер
                            запомнит замену прямо в строке задания.
                          </Typography.Text>
                          <Select
                            showSearch
                            allowClear
                            style={{ width: "100%" }}
                            placeholder="Материал, цвет, толщина"
                            value={substituteSkuId}
                            onChange={setSubstituteSkuId}
                            options={(skusQuery.data ?? []).map((s) => ({ value: s.id, label: skuLabel(s) }))}
                            filterOption={(input, option) =>
                              (option?.label as string).toLowerCase().includes(input.toLowerCase())
                            }
                          />
                          {substituteSku && (
                            <ResponsiveTable<MaterialUnit>
                              size="small"
                              rowKey="id"
                              loading={substituteAvailableQuery.isLoading}
                              dataSource={substituteAvailableQuery.data ?? []}
                              pagination={false}
                              scroll={{ x: "max-content" }}
                              locale={{ emptyText: "Ничего нет на хранении по этой номенклатуре" }}
                              columns={[
                                { title: "№", dataIndex: "id", render: (v: number) => rollNo(v) },
                                { title: "Ширина×длина", render: (_, u) => `${u.width_mm} мм × ${u.length_m} м` },
                                { title: "Ячейка", dataIndex: "location_code", render: (v) => v ?? "—" },
                                {
                                  title: "",
                                  render: (_, u) =>
                                    isWidthMatch(widthAnalogGroups, u.width_mm, selectedStripWidth) ? (
                                      <Button
                                        size="small"
                                        type="primary"
                                        loading={directMutation.isPending}
                                        onClick={() =>
                                          confirmIfWrongWarehouse(u.warehouse_name, selected?.task.area, () =>
                                            directMutation.mutate({ unitId: u.id, override: true }),
                                          )
                                        }
                                      >
                                        Выдать целиком
                                      </Button>
                                    ) : u.width_mm > selectedStripWidth ? (
                                      <Button
                                        size="small"
                                        onClick={() => {
                                          if (!selected) return;
                                          setCuttingSession({
                                            donor: u,
                                            widthCuts: [
                                              {
                                                width_mm: selectedStripWidth,
                                                area: selected.task.area,
                                                production_task_line_id: selected.line.id,
                                                label: selected.line.part_name ?? "Деталь",
                                                locked: true,
                                              },
                                            ],
                                            onDone: finishSingleCut,
                                          });
                                        }}
                                      >
                                        Разрезать на {selectedStripWidth} мм
                                      </Button>
                                    ) : (
                                      <Tag color="warning">меньше нужной ширины ({selectedStripWidth} мм)</Tag>
                                    ),
                                },
                              ]}
                            />
                          )}
                        </Space>
                      ),
                    },
                  ]
                : []),
            ]}
          />
          )}
        </Card>
      )}

      {lastIssued && (
        <Card style={{ background: "#E7F5EE", borderColor: "#B7E0CD" }}>
          <Space align="center" style={{ marginBottom: 4 }}>
            <span
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                background: "#1D9E75",
                color: "#fff",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              ✓
            </span>
            <Typography.Text strong style={{ color: "#146B4E", fontSize: 15 }}>
              Выдано {rollNo(lastIssued.unit.id)} — {lastIssued.unit.width_mm} мм × {lastIssued.unit.length_m} м
            </Typography.Text>
          </Space>
          {lastIssued.remainder && (
            <div style={{ marginLeft: 40, fontSize: 12.5, color: "#2E6B54", marginBottom: 14 }}>
              Донор разрезан, остаток {rollNo(lastIssued.remainder.id)} обновлён
            </div>
          )}

          <Space direction="vertical" style={{ width: "100%", marginTop: 10 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                background: "#fff",
                border: "1px solid #C7E5D6",
                borderRadius: 9,
                padding: "10px 12px",
              }}
            >
              <span>🏷️ Бирка на выданный штрипс</span>
              <Button size="small" onClick={() => printLabel(lastIssued.unit.id)}>Печать</Button>
            </div>

            {lastIssued.remainder && !lastIssued.remainderPlaced && (
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  background: "#fff",
                  border: "1px solid #C7E5D6",
                  borderRadius: 9,
                  padding: "10px 12px",
                }}
              >
                <span>
                  📦 Остаток {rollNo(lastIssued.remainder.id)}, {lastIssued.remainder.width_mm} мм
                  {remainderSuggestion.data && (
                    <>
                      {" — рекомендуем "}
                      <Tag color="orange">{remainderSuggestion.data}</Tag>
                    </>
                  )}
                </span>
                <Button
                  size="small"
                  type="primary"
                  disabled={!remainderSuggestion.data}
                  loading={placeRemainderMutation.isPending}
                  onClick={() => placeRemainderMutation.mutate(remainderSuggestion.data!)}
                >
                  Разместить
                </Button>
              </div>
            )}
            {lastIssued.remainder && lastIssued.remainderPlaced && (
              <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                Остаток размещён.
              </Typography.Text>
            )}
          </Space>

          <Button block style={{ marginTop: 14 }} onClick={finishAndReset}>
            Готово — к следующей позиции
          </Button>
        </Card>
      )}
    </>
  );

}
