import { useMemo, useState } from "react";
import {
  Card,
  Table,
  Tag,
  Button,
  Modal,
  Form,
  Input,
  InputNumber,
  DatePicker,
  Select,
  Space,
  Row,
  Col,
  List,
  Divider,
  Typography,
  message,
  type FormInstance,
} from "antd";
import dayjs, { type Dayjs } from "dayjs";
import Statistic from "../../components/Statistic";
import { toOccurredAtIso } from "../../utils/occurredAt";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listSessions,
  startSession,
  scanUnit,
  closeSession,
  resolveShortage,
  getUnresolvedShortages,
  getSessionScans,
  type InventoryScopeType,
  type InventorySession,
  type ScanResult,
  type CloseSessionResult,
} from "../../api/inventory";
import { listRacks } from "../../api/storage";
import { listMaterialSkus } from "../../api/dictionaries";
import { skuLabel, type MaterialSku } from "../../api/units";
import { listUsers } from "../../api/users";
import DictAutoComplete from "../../components/DictAutoComplete";
import QrScanButton from "../../components/QrScanButton";

const scopeOptions = [
  { value: "rack", label: "Стеллаж" },
  { value: "warehouse", label: "Весь склад" },
  { value: "material_sku", label: "Позиция материала" },
];

/** Инвентаризация — раздел про склад: раньше это были два разных экрана
 * (десктопный "сессии" и мобильный "сканирование" на отдельном
 * непунктированном в меню маршруте) с задвоенным кодом; начать сессию
 * можно было и на десктопе, но перейти к сканированию после этого было
 * некуда. Теперь один экран — список сессий разворачивается прямо в
 * строке: "в процессе" открывает сканирование тут же (с любого
 * устройства, QR-сканер работает и в браузере телефона, и на десктопе),
 * "закрыта" показывает итоги. */
export default function InventoryDesktop() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [scopeType, setScopeType] = useState<InventoryScopeType>("rack");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [closeResult, setCloseResult] = useState<CloseSessionResult | null>(null);
  const [unitIdKnown, setUnitIdKnown] = useState(true);
  const [scanForm] = Form.useForm();
  // Раздел про дату операции задним числом — одно поле на всю сессию
  // инвентаризации (не на каждый скан отдельно): пересчёт обычно вносят
  // в систему уже после самого обхода.
  const [occurredAt, setOccurredAt] = useState<Dayjs | null>(null);

  const sessionsQuery = useQuery({ queryKey: ["inventory-sessions"], queryFn: listSessions });
  const racksQuery = useQuery({ queryKey: ["racks"], queryFn: () => listRacks() });
  const skusQuery = useQuery({ queryKey: ["material-skus"], queryFn: () => listMaterialSkus() });
  const usersQuery = useQuery({ queryKey: ["users"], queryFn: listUsers });

  const participantNames = (ids: number[]) =>
    (usersQuery.data ?? [])
      .filter((u) => ids.includes(u.id))
      .map((u) => u.full_name)
      .join(", ");

  const rackLabel = useMemo(() => {
    const map = new Map((racksQuery.data ?? []).map((r) => [r.id, r.code]));
    return (id: number | null) => (id != null ? (map.get(id) ?? `#${id}`) : "");
  }, [racksQuery.data]);

  const skuLabelById = useMemo(() => {
    const map = new Map((skusQuery.data ?? []).map((s) => [s.id, skuLabel(s)]));
    return (id: number | null) => (id != null ? (map.get(id) ?? `#${id}`) : "");
  }, [skusQuery.data]);

  const scopeLabel = (s: InventorySession) => {
    if (s.scope_type === "warehouse") return "Весь склад";
    if (s.scope_type === "rack") return `Стеллаж ${rackLabel(s.scope_ref_id)}`;
    return `Позиция ${skuLabelById(s.scope_ref_id)}`;
  };

  const toggleExpand = (session: InventorySession) => {
    if (expandedId === session.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(session.id);
    setCloseResult(null);
    scanForm.resetFields();
    setUnitIdKnown(true);
  };

  const startMutation = useMutation({
    mutationFn: startSession,
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ["inventory-sessions"] });
      setCreateOpen(false);
      setExpandedId(s.id);
      setCloseResult(null);
      message.success("Сессия открыта — сканируйте прямо здесь");
    },
    onError: () => message.error("Не удалось открыть сессию"),
  });

  const scanMutation = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      scanUnit(expandedId!, { ...values, occurred_at: toOccurredAtIso(occurredAt) } as never),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["inventory-sessions"] });
      qc.invalidateQueries({ queryKey: ["inventory-scans", expandedId] });
      scanForm.resetFields(["unit_id", "material", "color", "thickness", "manufacturer", "width_mm", "length_m"]);
      message.success(
        result.outcome === "confirmed" ? "На месте" : result.outcome === "moved" ? "Адрес скорректирован" : "Излишек — создана новая единица",
      );
    },
    onError: () => message.error("Не удалось обработать скан"),
  });

  const closeMutation = useMutation({
    mutationFn: (id: number) => closeSession(id, toOccurredAtIso(occurredAt)),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["inventory-sessions"] });
      setCloseResult(result);
      message.success("Сессия закрыта");
    },
    onError: () => message.error("Не удалось закрыть сессию"),
  });

  const resolveMutation = useMutation({
    mutationFn: ({ sessionId, unitId, action }: { sessionId: number; unitId: number; action: "spisat" | "vernut_v_poisk" }) =>
      resolveShortage(sessionId, unitId, action, toOccurredAtIso(occurredAt)),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["inventory-shortages", vars.sessionId] });
      message.success("Решение сохранено");
    },
  });

  const inProgressCount = (sessionsQuery.data ?? []).filter((s) => s.status === "in_progress").length;
  const unresolvedShortages = closeResult?.shortages.length ?? 0;

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Row gutter={[12, 12]}>
        <Col xs={24} sm={12} md={8}>
          <Card size="small">
            <Statistic title="Сессий в процессе" value={inProgressCount} valueStyle={inProgressCount ? { color: "#C97A2B" } : undefined} />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={8}>
          <Card size="small">
            <Statistic title="Всего сессий" value={sessionsQuery.data?.length ?? 0} />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={8}>
          <Card size="small" style={unresolvedShortages ? { background: "#FBEAE7", borderColor: "#E3B5AC" } : undefined}>
            <Statistic
              title="Недостачи не решены (последнее закрытие)"
              value={unresolvedShortages}
              valueStyle={unresolvedShortages ? { color: "#B8483C" } : undefined}
            />
          </Card>
        </Col>
      </Row>

      <Card
        title="Инвентаризация"
        extra={
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            + Начать сессию
          </Button>
        }
      >
        <Table<InventorySession>
          rowKey="id"
          loading={sessionsQuery.isLoading}
          dataSource={sessionsQuery.data ?? []}
          scroll={{ x: "max-content" }}
          onRow={(s) => ({ onClick: () => toggleExpand(s), style: { cursor: "pointer" } })}
          expandable={{
            expandedRowKeys: expandedId != null ? [expandedId] : [],
            showExpandColumn: false,
            expandedRowRender: (s) => (
              <SessionPanel
                session={s}
                scanForm={scanForm}
                unitIdKnown={unitIdKnown}
                setUnitIdKnown={setUnitIdKnown}
                skus={skusQuery.data ?? []}
                scanMutation={scanMutation}
                closeMutation={closeMutation}
                closeResult={closeResult?.session.id === s.id ? closeResult : null}
                resolveMutation={resolveMutation}
                occurredAt={occurredAt}
                setOccurredAt={setOccurredAt}
              />
            ),
          }}
          pagination={{ pageSize: 10 }}
          columns={[
            { title: "№", dataIndex: "id", width: 60 },
            { title: "Область", render: (_, s) => scopeLabel(s) },
            {
              title: "Статус",
              dataIndex: "status",
              render: (v: string) => (v === "in_progress" ? <Tag color="blue">В процессе</Tag> : <Tag>Закрыта</Tag>),
            },
            { title: "Ожидалось", dataIndex: "expected_count" },
            { title: "Отсканировано", dataIndex: "scanned_count" },
            { title: "Участники", render: (_, s) => participantNames(s.participant_ids) || "—" },
            { title: "Начата", dataIndex: "started_at", render: (v: string) => new Date(v).toLocaleString("ru-RU") },
            {
              title: "Закрыта",
              dataIndex: "closed_at",
              render: (v: string | null) => (v ? new Date(v).toLocaleString("ru-RU") : "—"),
            },
            {
              title: "",
              render: (_, s) => (
                <a onClick={(e) => { e.stopPropagation(); toggleExpand(s); }}>
                  {expandedId === s.id ? "Свернуть" : s.status === "in_progress" ? "Сканировать →" : "Открыть →"}
                </a>
              ),
            },
          ]}
        />
      </Card>

      <Modal title="Новая сессия инвентаризации" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null} destroyOnHidden>
        <Form
          layout="vertical"
          onFinish={(v) =>
            startMutation.mutate({
              scope_type: v.scope_type,
              scope_ref_id: v.scope_ref_id,
              participant_ids: v.participant_ids,
            })
          }
        >
          <Form.Item name="scope_type" label="Область" rules={[{ required: true }]} initialValue="rack">
            <Select options={scopeOptions} onChange={(v) => setScopeType(v)} />
          </Form.Item>
          {scopeType === "rack" && (
            <Form.Item name="scope_ref_id" label="Стеллаж" rules={[{ required: true }]}>
              <Select loading={racksQuery.isLoading} options={(racksQuery.data ?? []).map((r) => ({ value: r.id, label: r.code }))} />
            </Form.Item>
          )}
          {scopeType === "material_sku" && (
            <Form.Item name="scope_ref_id" label="Позиция материала" rules={[{ required: true }]}>
              <Select
                loading={skusQuery.isLoading}
                options={(skusQuery.data ?? []).map((s) => ({ value: s.id, label: skuLabel(s) }))}
              />
            </Form.Item>
          )}
          <Form.Item name="participant_ids" label="Участники (кроме вас — вы добавляетесь автоматически)">
            <Select
              mode="multiple"
              loading={usersQuery.isLoading}
              options={(usersQuery.data ?? []).map((u) => ({ value: u.id, label: u.full_name }))}
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={startMutation.isPending}>
            Открыть и начать сканировать →
          </Button>
        </Form>
      </Modal>
    </Space>
  );
}

function SessionPanel({
  session,
  scanForm,
  unitIdKnown,
  setUnitIdKnown,
  skus,
  scanMutation,
  closeMutation,
  closeResult,
  resolveMutation,
  occurredAt,
  setOccurredAt,
}: {
  session: InventorySession;
  scanForm: FormInstance;
  unitIdKnown: boolean;
  setUnitIdKnown: (v: (prev: boolean) => boolean) => void;
  skus: MaterialSku[];
  scanMutation: ReturnType<typeof useMutation<ScanResult, unknown, Record<string, unknown>>>;
  closeMutation: ReturnType<typeof useMutation<CloseSessionResult, unknown, number>>;
  closeResult: CloseSessionResult | null;
  resolveMutation: ReturnType<
    typeof useMutation<InventorySession, unknown, { sessionId: number; unitId: number; action: "spisat" | "vernut_v_poisk" }>
  >;
  occurredAt: Dayjs | null;
  setOccurredAt: (v: Dayjs | null) => void;
}) {
  const shortagesQuery = useQuery({
    queryKey: ["inventory-shortages", session.id],
    queryFn: () => getUnresolvedShortages(session.id),
    enabled: session.status === "closed",
  });
  // Раздел про сверку рулонов на окутке — тот же урок: "последние сканы"
  // читаются с сервера (переживают переход на другую страницу/перезагрузку),
  // не хранятся в памяти вкладки браузера.
  const scansQuery = useQuery({
    queryKey: ["inventory-scans", session.id],
    queryFn: () => getSessionScans(session.id),
    enabled: session.status === "in_progress",
  });
  // Раздел про быстрое добавление неучтённой единицы — вместо 4 отдельных
  // полей (материал/цвет/толщина/производитель) для уже существующего в
  // справочнике материала достаточно одного поиска по позиции (то же, что
  // уже есть в выборе области сканирования "Позиция материала"). Поля
  // ввода с нуля остаются — для реально нового материала, которого нет в
  // списке ни одной существующей позиции.
  const [useExistingSku, setUseExistingSku] = useState(true);

  return (
    <div style={{ maxWidth: 900 }}>
      {session.status === "in_progress" && !closeResult && (
        <Row gutter={[24, 16]}>
          <Col xs={24} md={12}>
            <Form
              form={scanForm}
              layout="vertical"
              onFinish={(v) => {
                const payload: Record<string, unknown> = { location_code: v.location_code };
                if (unitIdKnown && v.unit_id) payload.unit_id = v.unit_id;
                if (!unitIdKnown && useExistingSku && v.sku_id) {
                  const sku = skus.find((s) => s.id === v.sku_id);
                  if (!sku) {
                    message.error("Позиция не найдена — выберите из списка");
                    return;
                  }
                  Object.assign(payload, {
                    material: sku.material.name,
                    color: sku.color.name,
                    thickness: sku.thickness.value_mm,
                    manufacturer: sku.manufacturer.name,
                    width_mm: v.width_mm,
                    length_m: v.length_m,
                  });
                } else if (!unitIdKnown) {
                  Object.assign(payload, {
                    material: v.material,
                    color: v.color,
                    thickness: Number(v.thickness),
                    manufacturer: v.manufacturer,
                    width_mm: v.width_mm,
                    length_m: v.length_m,
                  });
                }
                scanMutation.mutate(payload);
              }}
            >
              <Form.Item label="Физический адрес, где сканируете">
                <Form.Item name="location_code" noStyle rules={[{ required: true }]}>
                  <Input
                    placeholder="Р-3-07"
                    addonAfter={
                      <QrScanButton
                        size="small"
                        type="text"
                        tooltip="Сканировать QR полки"
                        onScan={(code) => scanForm.setFieldsValue({ location_code: code })}
                      />
                    }
                  />
                </Form.Item>
              </Form.Item>
              <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: -8, marginBottom: 12 }}>
                Адрес остаётся между сканами — меняйте, только когда физически перешли на другую полку.
              </Typography.Text>

              <Button type="dashed" block style={{ marginBottom: 12 }} onClick={() => setUnitIdKnown((v) => !v)}>
                {unitIdKnown ? "ID не читается — создать как новую" : "Вернуться к вводу ID"}
              </Button>

              {unitIdKnown ? (
                <Form.Item name="unit_id" label="ID единицы (по бирке/QR)" rules={[{ required: true }]}>
                  <Space style={{ width: "100%" }}>
                    <InputNumber style={{ width: "100%" }} placeholder="Введите ID" autoFocus />
                    <QrScanButton
                      onScan={(code) => {
                        const parsedId = parseInt(code.replace(/\D/g, ""), 10);
                        if (parsedId) scanForm.setFieldsValue({ unit_id: parsedId });
                        else message.error("QR не содержит числового ID единицы");
                      }}
                    />
                  </Space>
                </Form.Item>
              ) : (
                <>
                  <Button type="link" size="small" style={{ padding: 0, marginBottom: 8 }} onClick={() => setUseExistingSku((v) => !v)}>
                    {useExistingSku ? "Такого материала нет в списке → ввести с нуля" : "← Выбрать из уже существующих позиций"}
                  </Button>
                  {useExistingSku ? (
                    <Form.Item name="sku_id" label="Позиция материала" rules={[{ required: true, message: "Выберите позицию" }]}>
                      <Select
                        showSearch
                        placeholder="Начните вводить материал, цвет…"
                        options={skus.map((s) => ({ value: s.id, label: skuLabel(s) }))}
                        filterOption={(input, option) => (option?.label ?? "").toString().toLowerCase().includes(input.toLowerCase())}
                      />
                    </Form.Item>
                  ) : (
                    <>
                      <Form.Item name="material" label="Материал" rules={[{ required: true }]}>
                        <DictAutoComplete kind="materials" />
                      </Form.Item>
                      <Form.Item name="color" label="Цвет" rules={[{ required: true }]}>
                        <DictAutoComplete kind="colors" />
                      </Form.Item>
                      <Form.Item name="thickness" label="Толщина, мм" rules={[{ required: true }]}>
                        <DictAutoComplete kind="thicknesses" />
                      </Form.Item>
                      <Form.Item name="manufacturer" label="Производитель" rules={[{ required: true }]}>
                        <DictAutoComplete kind="manufacturers" />
                      </Form.Item>
                    </>
                  )}
                  <Form.Item name="width_mm" label="Ширина, мм" rules={[{ required: true }]}>
                    <InputNumber min={1} style={{ width: "100%" }} />
                  </Form.Item>
                  <Form.Item name="length_m" label="Длина, м" rules={[{ required: true }]}>
                    <InputNumber min={0.1} step={0.1} style={{ width: "100%" }} />
                  </Form.Item>
                </>
              )}

              <Button type="primary" htmlType="submit" block loading={scanMutation.isPending}>
                📷 Отсканировать
              </Button>
            </Form>

            <div style={{ marginTop: 12 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                Дата операции для всей сессии (необязательно — по умолчанию сейчас)
              </Typography.Text>
              <DatePicker
                style={{ width: "100%", marginTop: 4 }}
                format="DD.MM.YYYY"
                placeholder="Сейчас"
                value={occurredAt}
                onChange={setOccurredAt}
                disabledDate={(d) => d.isAfter(dayjs(), "day")}
              />
            </div>

            <Button
              danger
              block
              style={{ marginTop: 12 }}
              loading={closeMutation.isPending}
              onClick={() => {
                Modal.confirm({
                  title: "Закрыть сессию инвентаризации?",
                  content: "Все не отсканированные единицы сформируют список недостач.",
                  okText: "Закрыть сессию",
                  okType: "danger",
                  cancelText: "Отмена",
                  onOk: () => closeMutation.mutate(session.id),
                });
              }}
            >
              Закрыть сессию
            </Button>
          </Col>

          <Col xs={24} md={12}>
            <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
              Последние сканы ({session.scanned_count} из {session.expected_count})
            </Typography.Text>
            <List
              size="small"
              loading={scansQuery.isLoading}
              style={{ marginTop: 8, maxHeight: 320, overflowY: "auto" }}
              dataSource={scansQuery.data ?? []}
              locale={{ emptyText: "Пока ничего не отсканировано" }}
              renderItem={(item) => (
                <List.Item key={item.event_id}>
                  <Tag color={item.outcome === "confirmed" ? "green" : item.outcome === "moved" ? "orange" : "blue"}>
                    {item.outcome === "confirmed" ? "На месте" : item.outcome === "moved" ? "Перемещено" : "Излишек"}
                  </Tag>
                  № {item.unit_id} — {item.width_mm} мм × {item.length_m} м
                  {item.to_cell && <span style={{ color: "#8c8c8c" }}> · {item.to_cell}</span>}
                </List.Item>
              )}
            />
            <Typography.Paragraph type="secondary" style={{ fontSize: 11.5, marginTop: 10 }}>
              Сканировать можно с любого устройства — с телефона камерой через QR или с компьютера склада вводом ID.
            </Typography.Paragraph>
          </Col>
        </Row>
      )}

      {session.status === "closed" && (
        <>
          <Divider style={{ margin: "8px 0 16px" }}>Итоги закрытия</Divider>
          {closeResult ? (
            <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
              <Col xs={12} sm={12} md={6}>
                <Statistic title="Подтверждено" value={closeResult.confirmed_count} />
              </Col>
              <Col xs={12} sm={12} md={6}>
                <Statistic title="Перемещено" value={closeResult.moved_count} />
              </Col>
              <Col xs={12} sm={12} md={6}>
                <Statistic title="Излишков" value={closeResult.surplus_count} />
              </Col>
              <Col xs={12} sm={12} md={6}>
                <Statistic
                  title="Недостач не решено"
                  value={shortagesQuery.data?.length ?? closeResult.shortages.length}
                  valueStyle={{ color: "#C97A2B" }}
                />
              </Col>
            </Row>
          ) : (
            <Typography.Paragraph type="secondary">
              Ожидалось {session.expected_count}, отсканировано {session.scanned_count}. Разбивка на
              подтверждённые/перемещённые/излишки видна только сразу после закрытия — а вот недостачи и решения по
              ним сохраняются и доступны здесь всегда, даже после перезагрузки страницы.
            </Typography.Paragraph>
          )}
          <Divider>Недостачи — решение по каждой</Divider>
          <List
            loading={shortagesQuery.isLoading}
            dataSource={shortagesQuery.data ?? []}
            locale={{ emptyText: "Недостач нет или все уже решены" }}
            renderItem={(s) => (
              <List.Item
                actions={[
                  <Button
                    key="write-off"
                    danger
                    size="small"
                    onClick={() => resolveMutation.mutate({ sessionId: session.id, unitId: s.id, action: "spisat" })}
                  >
                    Списать
                  </Button>,
                  <Button
                    key="keep"
                    size="small"
                    onClick={() => resolveMutation.mutate({ sessionId: session.id, unitId: s.id, action: "vernut_v_poisk" })}
                  >
                    Вернуть в поиск
                  </Button>,
                ]}
              >
                № {s.id} — {s.width_mm} мм × {s.length_m} м, числилась в {s.location_code}
              </List.Item>
            )}
          />
        </>
      )}
    </div>
  );
}
