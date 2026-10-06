import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Segmented,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import Statistic from "../../components/Statistic";
import dayjs from "dayjs";
import ActionIcon from "../../components/ActionIcon";
import { printReport } from "../../utils/printReport";
import {
  printLabel,
  printLabelsBatch,
  skuLabel,
} from "../../api/units";
import ResponsiveTable from "../../components/ResponsiveTable";
import CuttingForm from "../../components/CuttingForm";
import ManualCuttingPlanModal from "../../components/ManualCuttingPlanModal";
import { rollNo } from "../../utils/lotNo";
import { statusFilterOptions, type TableRow, findSku, neededLengthM } from "./issue/model";
import { GroupStatusReporter } from "./issue/GroupPanels";
import { AcceptStockAction, AcceptReturnButton } from "./issue/ReturnActions";
import DetailModalBody from "./issue/DetailModalBody";
import QueueCards from "./issue/QueueCards";
import ManualPanel from "./issue/ManualPanel";
import { useIssue } from "./issue/useIssue";

/** «Выдача участку» (06.10: разделён — логика в issue/useIssue, куски
 * разметки — issue/*; здесь только сборка экрана). */
export default function Issue() {
  const s = useIssue();
  const { canReturn, canIssue, canManage, areaFilter, setAreaFilter, taskFilter, setTaskFilter, statusFilter, setStatusFilter, search, setSearch, queueView, pickQueueView, cardTab, setCardTab, cardGroup, setCardGroup, manualOpen, setManualOpen, cuttingSession, setCuttingSession, cuttingBatch, setCuttingBatch, cuttingBatchOpen, setCuttingBatchOpen, slipModalOpen, setSlipModalOpen, slipTaskId, setSlipTaskId, addToCuttingBatch, removeFromCuttingBatch, stockDecisions, setStockDecisions, addStockDecision, removeStockDecision, decidedLineIds, executingAll, lineInfoMap, reportGroupInfos, manualPickerTarget, setManualPickerTarget, detailRow, executeAllDecisions, shortageModalOpen, setShortageModalOpen, shortageForm, occurredAt, setOccurredAt, skusQuery, tasksQuery, areaLabel, areaRequiresDailyPlan, areaOptions, taskOptions, confirmIfWrongWarehouse, overdueCount, todayCount, weekRowsNeedingMaterial, areasWaiting, pendingReturnByTask, shopFloorRequestMutation, closeLineMutation, issuedNoteForLine, lineActuals, UnitLink, renderStatusPill, findStockSiblingCandidates, filteredTableRows, cuttingGroups, groupRowsByRowKey, printFactorySlip, openDetail, closeDetail, decisionsCount } = s;
  return (
    <div>
      <Space align="center" style={{ marginBottom: 8 }} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          Выдача участку
        </Typography.Title>
        {(cuttingBatch.length > 0 || stockDecisions.length > 0) && (
          <Button size="small" type="primary" onClick={() => setCuttingBatchOpen(true)}>
            🕒 Решения ({cuttingBatch.length + stockDecisions.length})
          </Button>
        )}
        <Button size="small" onClick={() => setSlipModalOpen(true)}>
          📋 Сопроводительный лист
        </Button>
        {canIssue && (
          <Button size="small" type="primary" ghost onClick={() => setManualOpen(true)}>
            ✋ Выдать без задания
          </Button>
        )}
        <Segmented
          size="small"
          value={queueView}
          onChange={(v) => pickQueueView(v as "cards" | "table")}
          options={[
            { value: "cards", label: "Карточки" },
            { value: "table", label: "Таблица" },
          ]}
        />
      </Space>

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={12} md={6}>
          <Card size="small">
            <Statistic title="Запрошено сегодня" value={todayCount} valueStyle={{ color: "#C97A2B" }} />
          </Card>
        </Col>
        <Col xs={12} sm={12} md={6}>
          <Card size="small" style={overdueCount > 0 ? { background: "#FBEAE7", borderColor: "#E3B5AC" } : undefined}>
            <Statistic title="Просрочено" value={overdueCount} valueStyle={{ color: overdueCount > 0 ? "#B8483C" : undefined }} />
          </Card>
        </Col>
        <Col xs={12} sm={12} md={6}>
          <Card size="small">
            <Statistic title="Строк не распределено на сегодня" value={weekRowsNeedingMaterial.length} />
          </Card>
        </Col>
        <Col xs={12} sm={12} md={6}>
          <Card size="small">
            <Statistic title="Участков ждут выдачи" value={areasWaiting} />
          </Card>
        </Col>
      </Row>

      {pendingReturnByTask.length > 0 && (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 16 }}
          message={`🏁 Готово к возврату — ${pendingReturnByTask.length} ${pendingReturnByTask.length === 1 ? "задание" : "задания"}`}
          description={
            <Space direction="vertical" size={10} style={{ width: "100%" }}>
              {pendingReturnByTask.map(({ task, units }) => {
                // Раздел про "штрипсы с остатком 0 в баннере" — среди
                // готовых к возврату часто больше половины уже
                // израсходованы в ноль физически (нечего нести на склад,
                // только закрыть запись — см. AcceptReturnModal, там для
                // них само подставляется "списать сразу"); разделяем
                // строку, чтобы сразу было видно, где реально нужно
                // сходить и забрать остаток, а где просто формальность.
                const withLeftover = units.filter((u) => Number(u.length_m) > 0);
                const empty = units.filter((u) => Number(u.length_m) === 0);
                return (
                  <div key={task.id}>
                    <Typography.Text strong>
                      {task.product_model_name ?? task.name ?? `Задание №${task.id}`} · {areaLabel(task.area)}
                    </Typography.Text>
                    {withLeftover.length > 0 && (
                      <div>
                        <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                          Заберите остаток со участка: {withLeftover.map((u) => `${rollNo(u.id)} (${u.width_mm}×${u.length_m} м)`).join(", ")}
                        </Typography.Text>
                      </div>
                    )}
                    {empty.length > 0 && (
                      <div>
                        <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                          Израсходованы в ноль, нести нечего — только закрыть запись: {empty.map((u) => `${rollNo(u.id)}`).join(", ")}
                        </Typography.Text>
                      </div>
                    )}
                    {canReturn && (
                      <Space size={4} wrap style={{ marginTop: 4 }}>
                        {units.map((u) => (
                          <AcceptReturnButton key={u.id} unit={u} />
                        ))}
                      </Space>
                    )}
                  </div>
                );
              })}
            </Space>
          }
        />
      )}

      {/* wrap + maxWidth:100% на каждом поле — раньше три поля с
          фиксированной шириной (220+320+200 = 740px) не помещались на
          телефоне ни в одну строку, ни по отдельности (поиск один шире
          самого экрана), и уезжали за правый край без переноса. */}
      <Space wrap size={[12, 12]} style={{ marginBottom: 16, width: "100%" }}>
        <Select
          allowClear
          placeholder="Все участки"
          style={{ width: 220, maxWidth: "100%" }}
          options={areaOptions}
          value={areaFilter}
          onChange={setAreaFilter}
        />
        <Select
          allowClear
          showSearch
          placeholder="Все задания"
          style={{ width: 260, maxWidth: "100%" }}
          options={taskOptions}
          optionFilterProp="label"
          value={taskFilter}
          onChange={setTaskFilter}
        />
        {queueView === "table" && (
        <Select
          allowClear
          placeholder="Все статусы"
          style={{ width: 200, maxWidth: "100%" }}
          options={statusFilterOptions}
          value={statusFilter}
          onChange={setStatusFilter}
        />
        )}
        <Input.Search
          placeholder="Деталь, задание, плёнка, ширина или № рулона"
          style={{ width: 320, maxWidth: "100%" }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
        />
        <DatePicker
          style={{ width: 200, maxWidth: "100%" }}
          format="DD.MM.YYYY"
          placeholder="Дата выдачи: сейчас"
          value={occurredAt}
          onChange={setOccurredAt}
          disabledDate={(d) => d.isAfter(dayjs(), "day")}
        />
      </Space>

      {/* Раздел про разбор задания единой таблицей — "невидимые" репортёры
          статуса, один на группу материал+цвет+толщина+участок (включая
          группы из одной строки — backend сам применяет ABC-осторожность
          именно тогда). Смонтированы всегда, не только для развёрнутой
          строки, чтобы колонка "Статус" была верна для ВСЕХ строк сразу,
          без необходимости открывать каждую по очереди. */}
      {cuttingGroups.map((g) => (
        <GroupStatusReporter
          key={g.key}
          sku={findSku(skusQuery.data, g.material, g.color, g.thickness)}
          rows={g.rows}
          onAddToBatch={addToCuttingBatch}
          onAddStockDecision={addStockDecision}
          onReport={reportGroupInfos}
        />
      ))}

      {queueView === "cards" && (
        <Space direction="vertical" size="middle" style={{ width: "100%", paddingBottom: decisionsCount ? 72 : 0 }}>
          <Segmented
            block
            size="large"
            value={cardTab}
            onChange={(v) => setCardTab(v as "need" | "decided" | "issued")}
            options={[
              { value: "need", label: "Нужно выдать" },
              { value: "decided", label: `Решено${decidedLineIds.size ? ` (${decidedLineIds.size})` : ""}` },
              { value: "issued", label: "Выдано" },
            ]}
          />
          <Space wrap>
            <Typography.Text type="secondary">Группировать:</Typography.Text>
            <Segmented
              value={cardGroup}
              onChange={(v) => setCardGroup(v as "task" | "film")}
              options={[
                { value: "task", label: "По заданию" },
                { value: "film", label: "По плёнке" },
              ]}
            />
          </Space>
          {<QueueCards s={s} />}
          {decisionsCount > 0 && (
            <div
              style={{
                position: "fixed",
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 20,
                background: "#fff",
                borderTop: "1px solid rgba(0,0,0,.08)",
                boxShadow: "0 -8px 20px -14px rgba(0,0,0,.5)",
                padding: "10px 16px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
              }}
            >
              <Typography.Text strong>
                Решения: {decisionsCount} — выдать {stockDecisions.length}, резать {cuttingBatch.length}
              </Typography.Text>
              <Button type="primary" size="large" onClick={() => setCuttingBatchOpen(true)}>
                Открыть и выполнить
              </Button>
            </div>
          )}
        </Space>
      )}

      {queueView === "table" && (
      <ResponsiveTable<TableRow>
        tableKey="issue-queue"
        lockedColumns={["actions"]}
        rowKey="key"
        dataSource={filteredTableRows}
        size="small"
        pagination={{ pageSize: 30 }}
        scroll={{ x: 1220 }}
        tableLayout="fixed"
        locale={{ emptyText: "Ничего не найдено по текущему фильтру" }}
        columns={[
          {
            title: (
              <Tooltip title="Когда актуально: 📅 распределено на сегодня · ⚠️ просрочено · ➖ ещё не распределено по дням · 🏭 весь участок, без деления по дням · ✋ выдано вручную">
                Когда
              </Tooltip>
            ),
            key: "badge",
            width: 56,
            // планшет (06.10): что за строка — всегда на виду, действия — справа
            fixed: "left",
            render: (_, row) =>
              row.kind === "manual" ? (
                <Tooltip title="Выдано вручную — без привязки к заданию">
                  <Tag style={{ margin: 0 }}>✋</Tag>
                </Tooltip>
              ) : row.variant === "today" ? (
                row.overdue ? (
                  <Tooltip title={`Просрочено — было распределено на ${dayjs(row.assignment!.date).format("DD.MM")}`}>
                    <Tag color="error" style={{ margin: 0 }}>
                      ⚠️
                    </Tag>
                  </Tooltip>
                ) : (
                  <Tooltip title="Распределено на сегодня">
                    <Tag color="orange" style={{ margin: 0 }}>
                      📅
                    </Tag>
                  </Tooltip>
                )
              ) : areaRequiresDailyPlan(row.task.area) ? (
                <Tooltip title="Ещё не распределено по дням">
                  <Tag style={{ margin: 0 }}>➖</Tag>
                </Tooltip>
              ) : (
                <Tooltip title="Без деления по дням — весь участок">
                  <Tag color="blue" style={{ margin: 0 }}>
                    🏭
                  </Tag>
                </Tooltip>
              ),
          },
          {
            title: "Статус",
            key: "status",
            width: 108,
            fixed: "left",
            render: (_, row) =>
              row.kind === "manual" ? (
                <Tag color="green">✅ вручную</Tag>
              ) : (
                renderStatusPill(
                  decidedLineIds.has(row.line.id) ? { kind: "decided" } : lineInfoMap.get(row.line.id)?.status,
                  issuedNoteForLine(row.line),
                )
              ),
          },
          {
            title: "Деталь",
            key: "part",
            width: 190,
            fixed: "left",
            render: (_, row) => (row.kind === "manual" ? "—" : (row.line.part_name ?? "Деталь без названия")),
          },
          {
            title: "Задание / участок",
            key: "task",
            width: 170,
            render: (_, row) =>
              row.kind === "manual" ? (
                <>Без задания · {row.unit.area ? areaLabel(row.unit.area) : "—"}</>
              ) : (
                <>
                  {row.task.product_model_name ?? row.task.name ?? `Задание №${row.task.id}`} · {areaLabel(row.task.area)}
                  {row.assignment && (
                    <div style={{ fontSize: 11.5, color: "#8A8C99" }}>
                      {row.assignment.line_name} · {row.assignment.employee_names}
                    </div>
                  )}
                </>
              ),
          },
          {
            title: "Материал",
            key: "material",
            width: 160,
            render: (_, row) =>
              row.kind === "manual" ? skuLabel(row.unit.material_sku) : `${row.line.material}, ${row.line.color}, ${row.line.thickness} мм`,
          },
          {
            title: "Штрипс",
            key: "width",
            width: 72,
            render: (_, row) => (row.kind === "manual" ? row.unit.width_mm : row.line.strip_width_mm || row.line.width_mm),
          },
          {
            title: "Нужно / факт",
            key: "need",
            width: 170,
            render: (_, row) => {
              if (row.kind === "manual") return `${row.unit.length_m} м`;
              const issuedNote = issuedNoteForLine(row.line);
              if (issuedNote) {
                // Раздел про рабочий экран участка — здесь показываем не
                // "0 м нужно" (бесполезно, раз уже выдано целиком), а факт:
                // сколько выдано / сколько реально израсходовано по отчётам
                // / сколько ещё физически должно вернуться на склад.
                const { consumed, stillOut, backInStock, stillOutUnits, backInStockUnits } = lineActuals(row.line);
                return (
                  <div style={{ fontSize: 11.5, lineHeight: 1.6 }}>
                    <div>Выдано: {row.line.issued_length_m} м</div>
                    <div>Расход: {consumed} м</div>
                    {stillOut > 0 && (
                      <div style={{ color: "#D46B08" }}>
                        К сдаче: {stillOut} м ·{" "}
                        {stillOutUnits.map((u, i) => (
                          <span key={u.id}>
                            {i > 0 && ", "}
                            <UnitLink id={u.id} />
                          </span>
                        ))}
                      </div>
                    )}
                    {backInStock > 0 && (
                      <div style={{ color: "#389E0D" }}>
                        Возврат принят: {backInStock} м ·{" "}
                        {backInStockUnits.map((u, i) => (
                          <span key={u.id}>
                            {i > 0 && ", "}
                            <UnitLink id={u.id} />
                          </span>
                        ))}
                      </div>
                    )}
                    {row.line.remaining_pieces <= 0 && <div style={{ color: "#8A8C99" }}>🏁 работа завершена</div>}
                  </div>
                );
              }
              return row.assignment ? (
                <>
                  {row.assignment.quantity_pieces} шт ({neededLengthM(row).toFixed(2)} м)
                </>
              ) : (
                `${row.line.shortfall_length_m} м`
              );
            },
          },
          {
            title: "Действия",
            key: "actions",
            width: 150,
            fixed: "right",
            render: (_, row) => {
              if (row.kind === "manual") {
                return (
                  <Space size={4} wrap>
                    <ActionIcon tip="Печать этикетки" onClick={() => printLabel(row.unit.id, { kind: "cutting_issue" })}>
                      🖨
                    </ActionIcon>
                    {canReturn && (
                      <AcceptReturnButton
                        unit={{
                          id: row.unit.id,
                          width_mm: row.unit.width_mm,
                          length_m: row.unit.length_m,
                          material_sku_id: row.unit.material_sku.id,
                          parent_id: row.unit.parent_id,
                          is_strip: row.unit.is_strip,
                          status: row.unit.status,
                          area: row.unit.area,
                        }}
                      />
                    )}
                  </Space>
                );
              }
              const issuedNote = issuedNoteForLine(row.line);
              if (issuedNote) {
                return (
                  <Space size={4} wrap>
                    {row.line.issued_units.length > 0 && (
                      <ActionIcon
                        tip={`Печать этикеток (${row.line.issued_units.length})`}
                        onClick={() =>
                          printLabelsBatch(
                            row.line.issued_units.map((u) => u.id),
                            { kind: "cutting_issue" },
                          )
                        }
                      >
                        🖨
                      </ActionIcon>
                    )}
                    {canReturn && row.line.issued_units.map((u) => <AcceptReturnButton key={u.id} unit={u} />)}
                    {/* Раздел про закрытие строки задания по выдаче — видна
                        именно здесь, где сейчас "🏭 на складе, ждёт довыдачи":
                        для строк, где всё уже физически улажено вне этого
                        экрана (issued_units пуст, но issued_length_m > 0
                        не даёт строке пропасть), это единственный способ
                        убрать её из списка. */}
                    {canManage && (
                      <Button size="small" loading={closeLineMutation.isPending} onClick={() => closeLineMutation.mutate({ taskId: row.task.id, lineId: row.line.id, isClosed: true })}>
                        Закрыть по выдаче
                      </Button>
                    )}
                  </Space>
                );
              }
              const info = lineInfoMap.get(row.line.id);
              const groupRows = groupRowsByRowKey.get(row.key);
              const sku = findSku(skusQuery.data, row.line.material, row.line.color, row.line.thickness);
              const decided = decidedLineIds.has(row.line.id);
              if (decided) {
                return (
                  <Tooltip title="Уже в решениях, ждёт выполнения">
                    <Typography.Text type="secondary" style={{ fontSize: 15 }}>
                      🕒
                    </Typography.Text>
                  </Tooltip>
                );
              }
              const stockMatch = info?.status.kind === "stock" ? info.status.match : null;
              return (
                <Space size={4} wrap>
                  {canIssue && info?.acceptStock && stockMatch && (
                    <AcceptStockAction
                      unitId={stockMatch.unit_id}
                      onAccept={info.acceptStock}
                      siblings={findStockSiblingCandidates(row)}
                    />
                  )}
                  {canIssue && info?.acceptCut && (
                    <ActionIcon
                      tone="outline"
                      tip={info.donorUnitId ? `В резку — донор ${rollNo(info.donorUnitId)}` : "Добавить в план резки"}
                      onClick={info.acceptCut}
                    >
                      ✂️
                    </ActionIcon>
                  )}
                  {canIssue && groupRows && sku && (
                    <ActionIcon tip="Свой донор и раскрой" onClick={() => setManualPickerTarget({ sku, rows: groupRows })}>
                      🔧
                    </ActionIcon>
                  )}
                  <ActionIcon tip="Ещё — подробная карточка" onClick={() => openDetail(row)}>
                    ⋯
                  </ActionIcon>
                </Space>
              );
            },
          },
        ]}
      />
      )}

      {manualPickerTarget && (
        <ManualCuttingPlanModal
          open
          onClose={() => setManualPickerTarget(null)}
          sku={manualPickerTarget.sku}
          rows={manualPickerTarget.rows}
          onAddToBatch={addToCuttingBatch}
        />
      )}

      <Modal
        title={detailRow?.line.part_name ?? "Деталь"}
        open={!!detailRow}
        onCancel={closeDetail}
        footer={null}
        width={640}
        destroyOnHidden
      >
        {detailRow && <DetailModalBody s={s} row={detailRow} />}
      </Modal>

      {canIssue && (
        <Modal
          title="✋ Выдать без задания"
          open={manualOpen}
          onCancel={() => setManualOpen(false)}
          footer={null}
          width={680}
          destroyOnHidden
        >
          <ManualPanel s={s} />
        </Modal>
      )}
      {canIssue && queueView === "table" && (
      <Collapse
        ghost
        style={{ marginTop: 16 }}
        items={[
          {
            key: "manual",
            label: "Без привязки к заданию (ручной подбор)",
            children: (
              <ManualPanel s={s} />
            ),
          },
        ]}
      />
      )}


      <Modal
        title="Заявка на закупку — с цеха"
        open={shortageModalOpen}
        onCancel={() => setShortageModalOpen(false)}
        footer={null}
        destroyOnHidden
      >
        <Form
          layout="vertical"
          form={shortageForm}
          onFinish={(v) => shopFloorRequestMutation.mutate(v)}
        >
          <Form.Item name="material" label="Материал">
            <Input disabled />
          </Form.Item>
          <Form.Item name="color" label="Цвет">
            <Input disabled />
          </Form.Item>
          <Form.Item name="thickness" label="Толщина, мм">
            <InputNumber disabled style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="requested_area_m2" label="Запросить, м²" rules={[{ required: true }]}>
            <InputNumber min={0.01} step={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="note" label="Комментарий">
            <Input />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={shopFloorRequestMutation.isPending}>
            Отправить заявку
          </Button>
        </Form>
      </Modal>

      {cuttingSession && (
        <Modal
          title={`Резать донора ${rollNo(cuttingSession.donor.id)}`}
          open
          onCancel={() => setCuttingSession(null)}
          footer={null}
          destroyOnHidden
          width={560}
        >
          <CuttingForm
            donor={cuttingSession.donor}
            initialWidthCuts={cuttingSession.widthCuts}
            areaOptions={areaOptions}
            confirmDestination={confirmIfWrongWarehouse}
            onDone={cuttingSession.onDone}
            onCancel={() => setCuttingSession(null)}
          />
        </Modal>
      )}

      <Modal
        title="Решения по выдаче и резке"
        open={cuttingBatchOpen}
        onCancel={() => setCuttingBatchOpen(false)}
        footer={null}
        width={720}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">
          Ничего из этого ещё не выполнено физически — решения только
          накоплены. «Выполнить всё» разом выдаст со склада и разрежет
          доноров; «Печать» — план для резчиков (сами доноры и раскрой уже
          решены здесь, резчики только режут по листу).
        </Typography.Paragraph>

        {stockDecisions.length > 0 && (
          <>
            <Typography.Title level={5} style={{ marginTop: 8 }}>
              Выдать со склада
            </Typography.Title>
            <ResponsiveTable
              tableKey="stock-decisions"
              rowKey={(r) => r.lineId}
              size="small"
              pagination={false}
              dataSource={stockDecisions}
              scroll={{ x: "max-content" }}
              columns={[
                { title: "№ штрипса", render: (_, r) => r.unitId },
                { title: "Ширина, мм", render: (_, r) => r.widthMm },
                { title: "Деталь", render: (_, r) => r.label },
                { title: "Участок", render: (_, r) => areaLabel(r.area) },
                {
                  title: "",
                  render: (_, r) => (
                    <Button size="small" danger onClick={() => removeStockDecision(r.lineId)}>
                      Убрать
                    </Button>
                  ),
                },
              ]}
            />
          </>
        )}

        {cuttingBatch.length > 0 && (
          <>
            <Typography.Title level={5} style={{ marginTop: 16 }}>
              Резать
            </Typography.Title>
            <ResponsiveTable
              tableKey="cutting-batch"
              rowKey={(r) => `${r.entry.donorUnitId}-${r.widthMm}-${r.label}`}
              size="small"
              pagination={false}
              dataSource={cuttingBatch.flatMap((e) => e.pieces.map((p) => ({ ...p, entry: e })))}
              scroll={{ x: "max-content" }}
              columns={[
                { title: "№ рулона/штрипса", render: (_, r) => r.entry.donorUnitId },
                { title: "Ширина рулона, мм", render: (_, r) => r.entry.donorWidthMm },
                { title: "Длина рулона, м", render: (_, r) => r.entry.donorLengthM },
                { title: "Ширина реза, мм", render: (_, r) => r.widthMm },
                { title: "Деталь/задание", render: (_, r) => r.label },
                { title: "Участок", render: (_, r) => areaLabel(r.area) },
                { title: "Место хран. остатка", render: (_, r) => r.entry.remainderLocationCode ?? "—" },
                { title: "Отход, мм", render: (_, r) => r.entry.wasteMm },
                {
                  title: "",
                  render: (_, r) => (
                    <Button size="small" danger onClick={() => removeFromCuttingBatch(r.entry.donorUnitId)}>
                      Убрать
                    </Button>
                  ),
                },
              ]}
            />
          </>
        )}

        {stockDecisions.length === 0 && cuttingBatch.length === 0 ? (
          <Typography.Text type="secondary">Список решений пуст.</Typography.Text>
        ) : (
          <Space style={{ marginTop: 16 }} wrap>
            <Button type="primary" loading={executingAll} onClick={executeAllDecisions}>
              ✅ Выполнить всё ({cuttingBatch.length + stockDecisions.length})
            </Button>
            {cuttingBatch.length > 0 && (
              <Button
                onClick={() =>
                  printReport(
                    "Список на резку",
                    [
                      { key: "donor", header: "№ рулона/штрипса" },
                      { key: "donorWidth", header: "Ширина рулона, мм" },
                      { key: "donorLength", header: "Длина рулона, м" },
                      { key: "width", header: "Ширина реза, мм" },
                      { key: "label", header: "Деталь/задание" },
                      { key: "area", header: "Участок" },
                      { key: "remainder", header: "Место хран. остатка" },
                      { key: "waste", header: "Отход, мм" },
                    ],
                    cuttingBatch.flatMap((e) =>
                      e.pieces.map((p) => ({
                        donor: e.donorUnitId,
                        donorWidth: e.donorWidthMm,
                        donorLength: e.donorLengthM,
                        width: p.widthMm,
                        label: p.label,
                        area: areaLabel(p.area),
                        remainder: e.remainderLocationCode ?? "—",
                        waste: e.wasteMm,
                      })),
                    ),
                  )
                }
              >
                🖨 Печать списка на резку
              </Button>
            )}
            <Button
              danger
              onClick={() => {
                setCuttingBatch([]);
                setStockDecisions([]);
              }}
            >
              Очистить всё
            </Button>
          </Space>
        )}
      </Modal>

      <Modal title="Сопроводительный лист" open={slipModalOpen} onCancel={() => setSlipModalOpen(false)} footer={null} destroyOnHidden>
        <Typography.Paragraph type="secondary">
          По одному заданию за раз — деталь/количество/материал и явный номер
          рулона/штрипса против каждой (реальный, если уже выдано/разрезано;
          номер донора с пометкой «план», если решение принято, но резка ещё
          не выполнена).
        </Typography.Paragraph>
        <Space wrap>
          <Select
            style={{ width: 280 }}
            placeholder="Выберите задание"
            options={taskOptions}
            optionFilterProp="label"
            showSearch
            value={slipTaskId}
            onChange={setSlipTaskId}
          />
          <Button
            type="primary"
            disabled={!slipTaskId}
            onClick={() => {
              const task = tasksQuery.data?.find((t) => t.id === slipTaskId);
              if (task) printFactorySlip(task);
            }}
          >
            🖨 Печать
          </Button>
        </Space>
      </Modal>
    </div>
  );
}
