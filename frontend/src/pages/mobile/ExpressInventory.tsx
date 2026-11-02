import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Divider,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Radio,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Switch,
  Tag,
  Typography,
  message,
} from "antd";
import {
  CameraOutlined,
  CheckCircleOutlined,
  CheckOutlined,
  CloseCircleOutlined,
  CloseOutlined,
  CompassOutlined,
  EditOutlined,
  FileDoneOutlined,
  QrcodeOutlined,
  ReloadOutlined,
  RollbackOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import dayjs from "dayjs";
import { useAuth } from "../../auth/AuthContext";
import QrScanModal from "../../components/QrScanModal";
import {
  closePartCount,
  confirmCellPartCount,
  getPartCount,
  listCountPlaces,
  listPartCounts,
  relocatePartCountUnit,
  scanPartCountCode,
  setPartCountLine,
  startPartCount,
  type CountPlace,
  type PartCountDetail,
  type PartCountLine,
} from "../../api/partCounts";
import { apiErrorMessage } from "../../utils/apiError";
import { pfNo, rollNo } from "../../utils/lotNo";

const fmt = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 1000) / 1000}`.replace(".", ","));

export default function ExpressInventory() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const sessionParam = Number(params.get("session")) || null;

  // Список всех пересчётов
  const sessionsQuery = useQuery({
    queryKey: ["part-counts"],
    queryFn: listPartCounts,
  });

  const openSessions = useMemo(
    () => (sessionsQuery.data ?? []).filter((s) => s.status === "in_progress"),
    [sessionsQuery.data],
  );

  const activeSessionId = sessionParam || openSessions[0]?.id || null;

  // Если сессия выбрана, загружаем её детали
  const detailQuery = useQuery({
    queryKey: ["part-count", activeSessionId],
    queryFn: () => getPartCount(activeSessionId!),
    enabled: !!activeSessionId,
  });

  const [newModalOpen, setNewModalOpen] = useState(false);

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "12px 16px 80px" }}>
      {/* Шапка экрана экспресс-ревизии */}
      <Card
        style={{ marginBottom: 16, borderRadius: 12, boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }}
        bodyStyle={{ padding: "16px 20px" }}
      >
        <Row justify="space-between" align="middle" gutter={[12, 12]}>
          <Col xs={24} md={12}>
            <Space align="center" size={10} wrap>
              <Button type="text" icon={<RollbackOutlined />} onClick={() => navigate("/inventory")}>
                К общей инвентаризации
              </Button>
              <Typography.Title level={4} style={{ margin: 0 }}>
                📱 Экспресс-ревизия у стеллажа
              </Typography.Title>
            </Space>
          </Col>
          <Col xs={24} md={12} style={{ textAlign: "right" }}>
            <Space size={8} wrap>
              {openSessions.length > 1 && (
                <Select
                  value={activeSessionId}
                  onChange={(val) => setParams({ session: String(val) })}
                  style={{ minWidth: 220 }}
                  options={openSessions.map((s) => ({
                    value: s.id,
                    label: `№${s.id} · ${s.place_name} (${s.lines_counted}/${s.lines_total})`,
                  }))}
                />
              )}
              <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => setNewModalOpen(true)}>
                + Новая ревизия
              </Button>
            </Space>
          </Col>
        </Row>
      </Card>

      {/* Если нет открытых сессий */}
      {!activeSessionId && !sessionsQuery.isLoading && (
        <Card style={{ textAlign: "center", padding: 32, borderRadius: 12 }}>
          <Empty
            description="Сейчас нет активных инвентаризаций. Начните ревизию склада или участка, чтобы сканировать ячейки и рулоны у стеллажа."
          >
            <Button type="primary" size="large" icon={<ThunderboltOutlined />} onClick={() => setNewModalOpen(true)}>
              Начать экспресс-ревизию
            </Button>
          </Empty>
        </Card>
      )}

      {/* Активная сессия ревизии */}
      {detailQuery.isLoading && <Spin style={{ display: "block", margin: "48px auto" }} />}

      {detailQuery.data && (
        <ExpressSessionBoard
          detail={detailQuery.data}
          onUpdate={(updated) => {
            qc.setQueryData(["part-count", updated.id], updated);
            qc.invalidateQueries({ queryKey: ["part-counts"] });
          }}
        />
      )}

      {/* Модалка запуска новой ревизии */}
      {newModalOpen && (
        <NewExpressModal
          onClose={() => setNewModalOpen(false)}
          onStarted={(id) => {
            setNewModalOpen(false);
            setParams({ session: String(id) });
            qc.invalidateQueries({ queryKey: ["part-counts"] });
          }}
        />
      )}
    </div>
  );
}

// -------------------------------------------------------------
// Доска экспресс-ревизии для активной сессии
// -------------------------------------------------------------
function ExpressSessionBoard({
  detail,
  onUpdate,
}: {
  detail: PartCountDetail;
  onUpdate: (updated: PartCountDetail) => void;
}) {
  const [selectedCell, setSelectedCell] = useState<string>("ALL");
  const [filterMode, setFilterMode] = useState<"all" | "open" | "matched" | "diff">("all");
  const [scanInput, setScanInput] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [continuousScan, setContinuousScan] = useState(true);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [editLine, setEditLine] = useState<PartCountLine | null>(null);

  // Группировка строк по ячейкам
  const cellGroups = useMemo(() => {
    const map = new Map<string, PartCountLine[]>();
    for (const ln of detail.lines) {
      const cell = (ln.location_code || "БЕЗ ЯЧЕЙКИ").toUpperCase();
      const list = map.get(cell) ?? [];
      list.push(ln);
      map.set(cell, list);
    }
    // Сортировка по коду ячейки
    const sorted = [...map.entries()].sort(([a], [b]) => a.localeCompare(b, "ru", { numeric: true }));
    return sorted;
  }, [detail.lines]);

  // Строки выбранной ячейки
  const cellLines = useMemo(() => {
    if (selectedCell === "ALL") return detail.lines;
    return cellGroups.find(([c]) => c === selectedCell)?.[1] ?? [];
  }, [detail.lines, selectedCell, cellGroups]);

  // Фильтрация по статусу
  const visibleLines = useMemo(() => {
    return cellLines.filter((l) => {
      if (filterMode === "open") return l.counted_qty == null;
      if (filterMode === "matched") return l.counted_qty != null && l.diff === 0;
      if (filterMode === "diff") return l.counted_qty != null && l.diff !== 0;
      return true;
    });
  }, [cellLines, filterMode]);

  // Быстрые статистики ячейки
  const cellStats = useMemo(() => {
    const total = cellLines.length;
    const counted = cellLines.filter((l) => l.counted_qty != null).length;
    const matched = cellLines.filter((l) => l.counted_qty != null && l.diff === 0).length;
    const diffs = cellLines.filter((l) => l.counted_qty != null && l.diff !== 0).length;
    return { total, counted, matched, diffs, open: total - counted };
  }, [cellLines]);

  // Общие статистики сессии
  const sessionStats = useMemo(() => {
    const total = detail.lines_total;
    const counted = detail.lines_counted;
    const diffs = detail.lines_diff;
    const matched = counted - diffs;
    const percent = total > 0 ? Math.round((counted / total) * 100) : 100;
    return { total, counted, matched, diffs, percent };
  }, [detail]);

  // Мутация быстрого сканирования
  const scanMutation = useMutation({
    mutationFn: (barcode: string) =>
      scanPartCountCode(detail.id, {
        barcode,
        current_cell: selectedCell !== "ALL" && selectedCell !== "БЕЗ ЯЧЕЙКИ" ? selectedCell : undefined,
        auto_confirm: true,
      }),
    onSuccess: (res) => {
      onUpdate(res.session);
      if (res.action === "cell_selected" && res.cell_code) {
        setSelectedCell(res.cell_code);
        message.info(`📍 Выбрана ячейка ${res.cell_code}`);
      } else if (res.action === "unit_mismatch" || res.action === "part_unit_mismatch") {
        message.warning(res.message, 5);
      } else if (res.action === "unit_added" || res.action === "part_unit_added") {
        message.success(`➕ ${res.message}`, 4);
      } else if (res.action === "not_found") {
        message.error(res.message, 4);
      } else {
        message.success(res.message);
      }
      setScanInput("");
    },
    onError: (err) => message.error(apiErrorMessage(err, "Ошибка при сканировании")),
  });

  // Мутация подтверждения одного рулона (1 тап)
  const setLineMutation = useMutation({
    mutationFn: ({ lineId, qty }: { lineId: number; qty: number | null }) =>
      setPartCountLine(detail.id, lineId, qty),
    onSuccess: (updated) => {
      onUpdate(updated);
      message.success("Факт зафиксирован");
      setEditLine(null);
    },
    onError: (err) => message.error(apiErrorMessage(err, "Не удалось сохранить факт")),
  });

  // Мутация подтверждения всех в ячейке
  const confirmCellMutation = useMutation({
    mutationFn: (cellCode: string) => confirmCellPartCount(detail.id, cellCode),
    onSuccess: (updated) => {
      onUpdate(updated);
      message.success(`Все оставшиеся в ячейке ${selectedCell} подтверждены!`);
    },
    onError: (err) => message.error(apiErrorMessage(err, "Не удалось подтвердить ячейку")),
  });

  // Мутация перемещения единицы в текущую ячейку
  const relocateMutation = useMutation({
    mutationFn: ({ lineId, newCell }: { lineId: number; newCell: string }) =>
      relocatePartCountUnit(detail.id, lineId, newCell),
    onSuccess: (updated) => {
      onUpdate(updated);
      message.success(`Рулон перемещён в ячейку ${selectedCell}`);
    },
    onError: (err) => message.error(apiErrorMessage(err, "Не удалось переместить")),
  });

  // Завершение и закрытие пересчёта
  const closeMutation = useMutation({
    mutationFn: () => closePartCount(detail.id),
    onSuccess: (updated) => {
      onUpdate(updated);
      message.success("Инвентаризация закрыта! Перейдите к решениям по расхождениям.");
      setSummaryOpen(false);
    },
    onError: (err) => message.error(apiErrorMessage(err, "Не удалось закрыть ревизию")),
  });

  const handleScanCode = (code: string) => {
    if (!code.trim()) return;
    scanMutation.mutate(code.trim());
    if (!continuousScan) {
      setCameraOpen(false);
    }
  };

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      {/* Верхний прогресс-блок ревизии */}
      <Card bodyStyle={{ padding: 16 }} style={{ borderRadius: 12 }}>
        <Row gutter={[16, 16]} align="middle">
          <Col xs={24} sm={10}>
            <Space orientation="vertical" size={2} style={{ width: "100%" }}>
              <Space wrap align="center">
                <Tag color="blue" style={{ fontSize: 13, padding: "2px 8px" }}>
                  {detail.place_name}
                </Tag>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Инвентаризация №{detail.id} от {dayjs(detail.started_at).format("DD.MM HH:mm")}
                </Typography.Text>
              </Space>
              <div style={{ marginTop: 8 }}>
                <Progress
                  percent={sessionStats.percent}
                  strokeColor={{ "0%": "#108ee9", "100%": "#52c41a" }}
                  status="active"
                />
              </div>
            </Space>
          </Col>
          <Col xs={12} sm={4}>
            <Statistic title="Всего в листе" value={sessionStats.total} suffix="поз." />
          </Col>
          <Col xs={12} sm={4}>
            <Statistic
              title="Проверено"
              value={sessionStats.counted}
              valueStyle={{ color: "#52c41a" }}
              suffix={`/ ${sessionStats.total}`}
            />
          </Col>
          <Col xs={12} sm={3}>
            <Statistic
              title="Расхождений"
              value={sessionStats.diffs}
              valueStyle={{ color: sessionStats.diffs > 0 ? "#ff4d4f" : "#52c41a" }}
            />
          </Col>
          <Col xs={12} sm={3} style={{ textAlign: "right" }}>
            <Button
              type="primary"
              icon={<FileDoneOutlined />}
              onClick={() => setSummaryOpen(true)}
              style={{ width: "100%" }}
            >
              Итоги
            </Button>
          </Col>
        </Row>
      </Card>

      {/* Быстрое сканирование: строка ввода + крупная кнопка камеры */}
      <Card bodyStyle={{ padding: "12px 16px" }} style={{ borderRadius: 12, background: "#f8faff" }}>
        <Row gutter={[8, 8]} align="middle">
          <Col xs={18} sm={16}>
            <Input.Search
              size="large"
              placeholder="Сканируйте QR ячейки (Д-01) или бирку рулона (4385, ПЛ-4385, ПФ-193)"
              enterButton="Найти / Подтвердить"
              value={scanInput}
              loading={scanMutation.isPending}
              onChange={(e) => setScanInput(e.target.value)}
              onSearch={handleScanCode}
              prefix={<QrcodeOutlined style={{ color: "#1890ff", fontSize: 18 }} />}
            />
          </Col>
          <Col xs={6} sm={4}>
            <Button
              type="primary"
              size="large"
              icon={<CameraOutlined />}
              onClick={() => setCameraOpen(true)}
              style={{ width: "100%", height: 40, background: "#722ed1", borderColor: "#722ed1" }}
            >
              Камера
            </Button>
          </Col>
          <Col xs={24} sm={4} style={{ textAlign: "right" }}>
            <Space align="center" size={6}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Серия:
              </Typography.Text>
              <Switch
                checked={continuousScan}
                onChange={setContinuousScan}
                size="small"
                checkedChildren="Вкл"
                unCheckedChildren="Выкл"
              />
            </Space>
          </Col>
        </Row>
      </Card>

      {/* Выбор стеллажа / ячейки (Горизонтальные чипсы) */}
      <Card
        title={
          <Space align="center" size={8}>
            <CompassOutlined style={{ color: "#1890ff" }} />
            <span>Стеллаж и ячейка:</span>
          </Space>
        }
        bodyStyle={{ padding: "12px 16px" }}
        style={{ borderRadius: 12 }}
      >
        <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 6 }}>
          <Button
            type={selectedCell === "ALL" ? "primary" : "default"}
            shape="round"
            onClick={() => setSelectedCell("ALL")}
          >
            Все ячейки ({detail.lines.length})
          </Button>
          {cellGroups.map(([cell, lines]) => {
            const counted = lines.filter((l) => l.counted_qty != null).length;
            const isFull = counted === lines.length && lines.length > 0;
            const isSelected = selectedCell === cell;
            return (
              <Button
                key={cell}
                type={isSelected ? "primary" : "default"}
                shape="round"
                onClick={() => setSelectedCell(cell)}
                style={
                  !isSelected && isFull
                    ? { borderColor: "#52c41a", color: "#52c41a", background: "#f6ffed" }
                    : undefined
                }
              >
                {cell} ({counted}/{lines.length})
              </Button>
            );
          })}
        </div>

        {/* Панель текущей выбранной ячейки */}
        {selectedCell !== "ALL" && (
          <div
            style={{
              marginTop: 12,
              padding: "10px 14px",
              background: "#fafafa",
              borderRadius: 8,
              border: "1px dashed #d9d9d9",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            <Space size={12} wrap>
              <Typography.Text strong style={{ fontSize: 15 }}>
                📍 Ячейка {selectedCell}:
              </Typography.Text>
              <Tag color={cellStats.open === 0 ? "green" : "blue"}>
                Проверено: {cellStats.counted} из {cellStats.total}
              </Tag>
              {cellStats.diffs > 0 && <Tag color="red">Расхождений: {cellStats.diffs}</Tag>}
            </Space>

            {cellStats.open > 0 && (
              <Popconfirm
                title={`Подтвердить ${cellStats.open} оставшихся рулонов в ячейке ${selectedCell} как «сходится»?`}
                okText="Да, подтвердить"
                cancelText="Отмена"
                onConfirm={() => confirmCellMutation.mutate(selectedCell)}
              >
                <Button
                  type="primary"
                  ghost
                  icon={<CheckOutlined />}
                  loading={confirmCellMutation.isPending}
                >
                  Остальное в ячейке сходится ({cellStats.open} шт)
                </Button>
              </Popconfirm>
            )}
          </div>
        )}
      </Card>

      {/* Фильтр статуса карточек */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <Radio.Group
          value={filterMode}
          onChange={(e) => setFilterMode(e.target.value)}
          buttonStyle="solid"
          size="middle"
        >
          <Radio.Button value="all">Все ({cellLines.length})</Radio.Button>
          <Radio.Button value="open">Осталось проверить ({cellStats.open})</Radio.Button>
          <Radio.Button value="matched">Сошлось ({cellStats.matched})</Radio.Button>
          <Radio.Button value="diff">Расхождения ({cellStats.diffs})</Radio.Button>
        </Radio.Group>
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          Показано: {visibleLines.length} позиций
        </Typography.Text>
      </div>

      {/* Список крупных сенсорных карточек рулонов и партий */}
      {visibleLines.length === 0 ? (
        <Card style={{ textAlign: "center", padding: 32, borderRadius: 12 }}>
          <Empty description="В этой ячейке нет позиций с выбранным статусом" />
        </Card>
      ) : (
        <Row gutter={[12, 12]}>
          {visibleLines.map((line) => (
            <Col xs={24} sm={12} key={line.id}>
              <ExpressUnitCard
                line={line}
                currentCell={selectedCell}
                onConfirmFull={() => setLineMutation.mutate({ lineId: line.id, qty: line.expected_qty })}
                onSetZero={() => setLineMutation.mutate({ lineId: line.id, qty: 0 })}
                onOpenEdit={() => setEditLine(line)}
                onReset={() => setLineMutation.mutate({ lineId: line.id, qty: null })}
                onRelocate={() =>
                  relocateMutation.mutate({ lineId: line.id, newCell: selectedCell })
                }
                loading={setLineMutation.isPending || relocateMutation.isPending}
              />
            </Col>
          ))}
        </Row>
      )}

      {/* Модалка камеры (QR сканер) */}
      <QrScanModal
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onScan={handleScanCode}
        title="Сканирование ячейки или бирки рулона"
      />

      {/* Сенсорная цифровая клавиатура / модалка уточнения остатка */}
      {editLine && (
        <TouchQtyModal
          line={editLine}
          onClose={() => setEditLine(null)}
          onSave={(qty) => setLineMutation.mutate({ lineId: editLine.id, qty })}
        />
      )}

      {/* Сводная сличительная ведомость и закрытие */}
      {summaryOpen && (
        <SummaryModal
          detail={detail}
          onClose={() => setSummaryOpen(false)}
          onCloseSession={() => closeMutation.mutate()}
          closing={closeMutation.isPending}
        />
      )}
    </Space>
  );
}

// -------------------------------------------------------------
// Крупная сенсорная карточка позиции (рулон / партия)
// -------------------------------------------------------------
function ExpressUnitCard({
  line,
  currentCell,
  onConfirmFull,
  onSetZero,
  onOpenEdit,
  onReset,
  onRelocate,
  loading,
}: {
  line: PartCountLine;
  currentCell: string;
  onConfirmFull: () => void;
  onSetZero: () => void;
  onOpenEdit: () => void;
  onReset: () => void;
  onRelocate: () => void;
  loading: boolean;
}) {
  const isCounted = line.counted_qty != null;
  const isMatch = isCounted && line.diff === 0;
  const isDiff = isCounted && line.diff !== 0;

  // Проверка несоответствия ячейки
  const lineCell = (line.location_code || "").toUpperCase();
  const isMismatch =
    currentCell !== "ALL" && currentCell !== "БЕЗ ЯЧЕЙКИ" && lineCell && lineCell !== currentCell;

  const cardBorder = isMatch
    ? "2px solid #52c41a"
    : isDiff
      ? "2px solid #ff4d4f"
      : "1px solid #e8e8e8";

  const cardBg = isMatch ? "#f6ffed" : isDiff ? "#fff2f0" : "#ffffff";

  return (
    <Card
      style={{
        borderRadius: 12,
        border: cardBorder,
        background: cardBg,
        boxShadow: "0 2px 6px rgba(0,0,0,0.04)",
        transition: "all 0.2s ease",
      }}
      bodyStyle={{ padding: "14px 16px" }}
    >
      {/* Заголовок карточки: номер партии/рулона и статус */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <Space size={6} wrap>
          <Typography.Text strong style={{ fontSize: 16 }}>
            {line.kind === "plenka" ? rollNo(line.material_unit_id) : line.part_unit_id ? pfNo(line.part_unit_id) : line.name}
          </Typography.Text>
          {line.detail && (
            <Tag color="cyan" style={{ fontSize: 12 }}>
              {line.detail}
            </Tag>
          )}
          {line.location_code && (
            <Tag color="geekblue" style={{ fontSize: 12 }}>
              📍 {line.location_code}
            </Tag>
          )}
        </Space>

        {/* Статус-бейдж */}
        {!isCounted ? (
          <Badge status="default" text="Ожидает" />
        ) : isMatch ? (
          <Tag color="green" icon={<CheckCircleOutlined />} style={{ fontSize: 13, padding: "2px 8px" }}>
            Сошлось ({fmt(line.counted_qty)} {line.unit})
          </Tag>
        ) : (
          <Tag color="red" icon={<CloseCircleOutlined />} style={{ fontSize: 13, padding: "2px 8px" }}>
            {line.diff! < 0 ? `Недостача ${fmt(-line.diff!)}` : `Излишек +${fmt(line.diff!)}`} {line.unit}
          </Tag>
        )}
      </div>

      {/* Наименование и параметры */}
      <Typography.Paragraph
        ellipsis={{ rows: 2 }}
        style={{ marginBottom: 10, fontSize: 14, color: "#333", minHeight: 38 }}
      >
        {line.name}
        {line.stage_name && (
          <Typography.Text type="secondary"> · {line.stage_name}</Typography.Text>
        )}
      </Typography.Paragraph>

      {/* Числится по учёту vs Факт */}
      <Row gutter={8} style={{ marginBottom: 12, background: "rgba(0,0,0,0.02)", padding: "8px 10px", borderRadius: 8 }}>
        <Col span={12}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            По учёту:
          </Typography.Text>
          <div style={{ fontSize: 15, fontWeight: 600 }}>
            {fmt(line.expected_qty)} {line.unit}
          </div>
        </Col>
        <Col span={12}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Факт у стеллажа:
          </Typography.Text>
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: isMatch ? "#52c41a" : isDiff ? "#ff4d4f" : "#999",
            }}
          >
            {line.counted_qty != null ? `${fmt(line.counted_qty)} ${line.unit}` : "Не введён"}
          </div>
        </Col>
      </Row>

      {/* Предупреждение о пересортице по ячейке */}
      {isMismatch && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12, fontSize: 12 }}
          message={
            <span>
              По учёту числится в <b>{line.location_code}</b>, но найден в <b>{currentCell}</b>!
            </span>
          }
          action={
            <Button size="small" type="primary" onClick={onRelocate} loading={loading}>
              Переместить сюда
            </Button>
          }
        />
      )}

      {/* Крупные сенсорные кнопки действий (Touch Targets >= 44px) */}
      {!isCounted ? (
        <Row gutter={8}>
          <Col span={14}>
            <Button
              type="primary"
              size="large"
              icon={<CheckOutlined />}
              onClick={onConfirmFull}
              loading={loading}
              style={{
                width: "100%",
                height: 46,
                fontSize: 14,
                fontWeight: 600,
                background: "#52c41a",
                borderColor: "#52c41a",
                borderRadius: 8,
              }}
            >
              ✅ На месте ({fmt(line.expected_qty)})
            </Button>
          </Col>
          <Col span={6}>
            <Button
              size="large"
              icon={<EditOutlined />}
              onClick={onOpenEdit}
              disabled={loading}
              style={{ width: "100%", height: 46, fontSize: 13, borderRadius: 8 }}
            >
              Факт
            </Button>
          </Col>
          <Col span={4}>
            <Popconfirm
              title="Отметить как отсутствующий (0)?"
              okText="Да, 0"
              cancelText="Нет"
              onConfirm={onSetZero}
            >
              <Button
                danger
                size="large"
                icon={<CloseOutlined />}
                disabled={loading}
                style={{ width: "100%", height: 46, borderRadius: 8 }}
              />
            </Popconfirm>
          </Col>
        </Row>
      ) : (
        <Row gutter={8}>
          <Col span={14}>
            <Button
              size="large"
              icon={<EditOutlined />}
              onClick={onOpenEdit}
              disabled={loading}
              style={{ width: "100%", height: 44, borderRadius: 8 }}
            >
              Изменить факт ({fmt(line.counted_qty)})
            </Button>
          </Col>
          <Col span={10}>
            <Button
              size="large"
              type="text"
              icon={<ReloadOutlined />}
              onClick={onReset}
              disabled={loading}
              style={{ width: "100%", height: 44 }}
            >
              Сбросить
            </Button>
          </Col>
        </Row>
      )}
    </Card>
  );
}

// -------------------------------------------------------------
// Модалка сенсорного ввода остатка (Touch Keypad)
// -------------------------------------------------------------
function TouchQtyModal({
  line,
  onClose,
  onSave,
}: {
  line: PartCountLine;
  onClose: () => void;
  onSave: (qty: number) => void;
}) {
  const initial = line.counted_qty ?? line.expected_qty;
  const [val, setVal] = useState<number>(initial);

  const step = (delta: number) => {
    setVal((prev) => Math.max(0, Math.round((prev + delta) * 1000) / 1000));
  };

  return (
    <Modal
      open
      title={`Уточнение остатка · ${line.kind === "plenka" ? rollNo(line.material_unit_id) : line.name}`}
      okText="Сохранить факт"
      cancelText="Отмена"
      onCancel={onClose}
      onOk={() => onSave(val)}
      width={400}
      centered
      destroyOnClose
    >
      <div style={{ textAlign: "center", padding: "12px 0" }}>
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          По учёту: <b>{fmt(line.expected_qty)} {line.unit}</b>
        </Typography.Text>

        <div style={{ margin: "16px 0" }}>
          <InputNumber
            size="large"
            value={val}
            onChange={(v) => setVal(v ?? 0)}
            min={0}
            step={line.kind === "plenka" ? 1 : 1}
            style={{ width: 200, fontSize: 24, textAlign: "center" }}
            addonAfter={line.unit}
            autoFocus
          />
        </div>

        {/* Быстрые сенсорные кнопки приращения */}
        <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
          Быстрая корректировка остатка:
        </Typography.Text>
        <Space wrap size={8} style={{ justifyContent: "center" }}>
          <Button size="large" onClick={() => step(-10)}>
            -10
          </Button>
          <Button size="large" onClick={() => step(-5)}>
            -5
          </Button>
          <Button size="large" onClick={() => step(-1)}>
            -1
          </Button>
          <Button size="large" onClick={() => step(1)}>
            +1
          </Button>
          <Button size="large" onClick={() => step(5)}>
            +5
          </Button>
          <Button size="large" onClick={() => step(10)}>
            +10
          </Button>
        </Space>

        <div style={{ marginTop: 16 }}>
          <Space size={8}>
            <Button onClick={() => setVal(line.expected_qty)}>Целиком ({fmt(line.expected_qty)})</Button>
            <Button danger onClick={() => setVal(0)}>
              Списать в 0
            </Button>
          </Space>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------
// Модалка сличительной ведомости и завершения
// -------------------------------------------------------------
function SummaryModal({
  detail,
  onClose,
  onCloseSession,
  closing,
}: {
  detail: PartCountDetail;
  onClose: () => void;
  onCloseSession: () => void;
  closing: boolean;
}) {
  const diffs = detail.lines.filter((l) => l.counted_qty != null && l.diff !== 0);
  const left = detail.lines_total - detail.lines_counted;

  return (
    <Modal
      open
      title={`📋 Сличительная ведомость · Инвентаризация №${detail.id}`}
      width={700}
      onCancel={onClose}
      footer={[
        <Button key="back" onClick={onClose}>
          Продолжить сканирование
        </Button>,
        <Popconfirm
          key="close"
          title={
            left > 0
              ? `Осталось ${left} непроверенных позиций. По ним остаток останется прежним. Закрыть ревизию?`
              : "Закрыть инвентаризацию? После закрытия сформируются акты расхождений."
          }
          okText="Да, закрыть"
          cancelText="Отмена"
          onConfirm={onCloseSession}
        >
          <Button type="primary" loading={closing}>
            Завершить ревизию
          </Button>
        </Popconfirm>,
      ]}
    >
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        <Row gutter={16}>
          <Col span={8}>
            <Statistic title="Всего позиций" value={detail.lines_total} />
          </Col>
          <Col span={8}>
            <Statistic
              title="Проверено"
              value={detail.lines_counted}
              valueStyle={{ color: "#52c41a" }}
              suffix={`/ ${detail.lines_total}`}
            />
          </Col>
          <Col span={8}>
            <Statistic
              title="Расхождений"
              value={diffs.length}
              valueStyle={{ color: diffs.length > 0 ? "#ff4d4f" : "#52c41a" }}
            />
          </Col>
        </Row>

        <Divider style={{ margin: "12px 0" }} />

        {diffs.length === 0 ? (
          <Alert
            type="success"
            showIcon
            message="Все проверенные позиции полностью сошлись с учётными остатками!"
          />
        ) : (
          <div>
            <Typography.Title level={5} style={{ marginBottom: 8, color: "#cf1322" }}>
              Обнаруженные расхождения ({diffs.length}):
            </Typography.Title>
            <div style={{ maxHeight: 260, overflowY: "auto" }}>
              {diffs.map((l) => (
                <Card
                  key={l.id}
                  size="small"
                  style={{ marginBottom: 6, background: "#fff1f0", borderColor: "#ffa39e" }}
                >
                  <Row justify="space-between" align="middle">
                    <Col span={14}>
                      <Typography.Text strong>
                        {l.kind === "plenka" ? rollNo(l.material_unit_id) : l.name}
                      </Typography.Text>
                      {l.location_code && <Tag style={{ marginLeft: 6 }}>📍 {l.location_code}</Tag>}
                      <div style={{ fontSize: 12, color: "#666" }}>{l.name}</div>
                    </Col>
                    <Col span={10} style={{ textAlign: "right" }}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        Учёт: {fmt(l.expected_qty)} → Факт: {fmt(l.counted_qty)}
                      </Typography.Text>
                      <div>
                        <Tag color={l.diff! < 0 ? "red" : "orange"} style={{ fontWeight: 600 }}>
                          {l.diff! < 0 ? `Недостача ${fmt(-l.diff!)}` : `Излишек +${fmt(l.diff!)}`} {l.unit}
                        </Tag>
                      </div>
                    </Col>
                  </Row>
                </Card>
              ))}
            </div>
          </div>
        )}
      </Space>
    </Modal>
  );
}

// -------------------------------------------------------------
// Модалка открытия новой сессии для экспресс-ревизии
// -------------------------------------------------------------
function NewExpressModal({
  onClose,
  onStarted,
}: {
  onClose: () => void;
  onStarted: (id: number) => void;
}) {
  const { user } = useAuth();
  const [form] = Form.useForm<{ place: string; note?: string }>();
  const placesQuery = useQuery({ queryKey: ["count-places"], queryFn: listCountPlaces });
  const places = placesQuery.data ?? [];

  const grouped = useMemo(() => {
    const m = new Map<string, CountPlace[]>();
    for (const p of places) m.set(p.group, [...(m.get(p.group) ?? []), p]);
    return [...m.entries()].map(([label, ps]) => ({
      label,
      options: ps.map((p) => ({ value: `${p.place_type}|${p.place_ref ?? ""}`, label: p.name })),
    }));
  }, [places]);

  const defaultPlace = useMemo(() => {
    if (user?.area) {
      const match = places.find((p) => p.place_type === "area" && p.place_ref === user.area);
      if (match) return `${match.place_type}|${match.place_ref ?? ""}`;
    }
    return undefined;
  }, [user, places]);

  const start = useMutation({
    mutationFn: (v: { place: string; note?: string }) => {
      const [type, ref] = v.place.split("|");
      return startPartCount({
        place_type: type as any,
        place_ref: ref || null,
        scope: { group_ids: [], stages: [] },
        note: v.note || "Экспресс-ревизия с планшета",
      });
    },
    onSuccess: (d) => {
      message.success(`Ревизия №${d.id} начата!`);
      onStarted(d.id);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось начать инвентаризацию")),
  });

  return (
    <Modal
      open
      title="Начать экспресс-ревизию у стеллажа"
      okText="Начать ревизию"
      cancelText="Отмена"
      onCancel={onClose}
      onOk={() => form.submit()}
      okButtonProps={{ loading: start.isPending }}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ place: defaultPlace }}
        onFinish={(v) => start.mutate(v)}
      >
        <Form.Item
          name="place"
          label="Где проводим ревизию"
          rules={[{ required: true, message: "Выберите склад или участок" }]}
        >
          <Select
            size="large"
            showSearch
            optionFilterProp="label"
            placeholder="Выберите склад или участок"
            options={grouped}
          />
        </Form.Item>
        <Form.Item name="note" label="Заметка (необязательно)">
          <Input placeholder="Например: Стеллажи Д и А (еженедельная проверка)" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
