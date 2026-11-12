import { useState } from "react";
import {
  Button,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { ThunderboltOutlined } from "@ant-design/icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issueUnitDirect, searchUnits, type MaterialUnit } from "../../api/units";
import { UnitLink } from "../../components/EntityLink";
import QrScanButton from "../../components/QrScanButton";
import { apiErrorMessage } from "../../utils/apiError";

const { Text } = Typography;

interface IssueModalProps {
  open: boolean;
  onClose: () => void;
  // Если строка задания задана — выдача под потребность; иначе — свободная выдача
  targetLine?: {
    lineId: number;
    taskId: number;
    taskName: string;
    area: string;
    areaName: string;
    film: string;
    stripWidthMm: number;
    toIssueM: number;
  } | null;
  defaultArea?: string | null;
  areas?: Array<{ area: string; area_name: string }>;
}

export default function IssueRollModal({
  open,
  onClose,
  targetLine,
  defaultArea,
  areas = [],
}: IssueModalProps) {
  const qc = useQueryClient();
  const [selectedArea, setSelectedArea] = useState<string | null>(
    targetLine?.area ?? defaultArea ?? (areas[0]?.area ?? null)
  );
  const [manualRollId, setManualRollId] = useState<number | null>(null);

  // Поиск подходящих рулонов на складе под строку задания
  const availableQuery = useQuery({
    queryKey: ["warehouse-available-rolls", targetLine?.film, targetLine?.stripWidthMm],
    queryFn: async () => {
      // Ищем рулоны на хранении
      const units = await searchUnits({
        status: "На_хранении",
        unassigned_only: true,
      });
      if (!targetLine) return units;
      // Фильтруем по совпадению ширины и декора
      const targetWidth = targetLine.stripWidthMm;
      return units.filter((u) => {
        // Проверка совпадения ширины штрипса/рулона (с допуском 5 мм)
        const widthMatch = Math.abs(u.width_mm - targetWidth) <= 5;
        // Проверка по названию плёнки
        const filmTitle = `${u.material_sku?.material?.name ?? ""} ${u.material_sku?.color?.name ?? ""}`.trim();
        const filmMatch =
          !targetLine.film ||
          targetLine.film.toLowerCase().includes(filmTitle.toLowerCase()) ||
          filmTitle.toLowerCase().includes(targetLine.film.toLowerCase());
        return widthMatch || filmMatch;
      });
    },
    enabled: open,
  });

  const issueDirectMutation = useMutation({
    mutationFn: async ({ unitId, lineId, area }: { unitId: number; lineId?: number; area: string }) => {
      return await issueUnitDirect(unitId, area, lineId);
    },
    onSuccess: (unit) => {
      message.success(`Рулон №${unit.id} успешно выдан на участок!`);
      qc.invalidateQueries({ queryKey: ["film-issue-board"] });
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      onClose();
    },
    onError: (err) => {
      message.error(apiErrorMessage(err, "Не удалось выдать рулон"));
    },
  });

  const autoFifoMutation = useMutation({
    mutationFn: async () => {
      if (!targetLine) return;
      const candidates = availableQuery.data ?? [];
      if (!candidates.length) {
        throw new Error("На складе нет свободных рулонов этой плёнки.");
      }
      // Самый старый рулон по FIFO (минимальный ID / дата прихода)
      const oldest = candidates.reduce((prev, curr) => (curr.id < prev.id ? curr : prev));
      return await issueUnitDirect(oldest.id, targetLine.area, targetLine.lineId);
    },
    onSuccess: (unit) => {
      if (unit) {
        message.success(`Рулон №${unit.id} подобран по FIFO и выдан участку!`);
        qc.invalidateQueries({ queryKey: ["film-issue-board"] });
        qc.invalidateQueries({ queryKey: ["production-tasks"] });
        onClose();
      }
    },
    onError: (err) => {
      message.error(apiErrorMessage(err, "Ошибка подбора рулона"));
    },
  });

  const areaCode = targetLine?.area ?? selectedArea;
  const isLineMode = !!targetLine;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={720}
      title={
        isLineMode
          ? `⚡ Выдача плёнки под задание: ${targetLine?.taskName}`
          : "➕ Свободная выдача рулона на участок (вручную)"
      }
      destroyOnHidden
    >
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        {isLineMode ? (
          <div style={{ background: "#f5f5f5", padding: "10px 14px", borderRadius: 8 }}>
            <Space size={16} wrap>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>Участок-получатель:</Text>
                <div><Text strong>{targetLine?.areaName}</Text></div>
              </div>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>Плёнка:</Text>
                <div><Text strong>{targetLine?.film}</Text></div>
              </div>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>Штрипс:</Text>
                <div><Tag color="blue">{targetLine?.stripWidthMm} мм</Tag></div>
              </div>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>К выдаче:</Text>
                <div><Text strong style={{ color: "#cf1322" }}>{Math.round(targetLine?.toIssueM ?? 0)} м</Text></div>
              </div>
            </Space>
          </div>
        ) : (
          <div>
            <Text style={{ fontSize: 13, marginBottom: 4, display: "block" }}>
              Выберите участок-получатель:
            </Text>
            <Select
              style={{ width: "100%" }}
              placeholder="Участок"
              value={selectedArea ?? undefined}
              onChange={(val) => setSelectedArea(val)}
              options={areas.map((a) => ({ value: a.area, label: a.area_name }))}
            />
          </div>
        )}

        {/* Быстрый ввод / сканирование номера рулона */}
        <div style={{ background: "#fafafa", padding: "12px", borderRadius: 8, border: "1px dashed #d9d9d9" }}>
          <Text strong style={{ fontSize: 13, display: "block", marginBottom: 6 }}>
            {isLineMode ? "Ввести или отсканировать конкретный рулон:" : "Номер рулона со склада:"}
          </Text>
          <Space wrap align="center">
            <InputNumber
              placeholder="№ рулона / ID"
              style={{ width: 160 }}
              value={manualRollId}
              onChange={(val) => setManualRollId(val)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && manualRollId && areaCode) {
                  issueDirectMutation.mutate({
                    unitId: manualRollId,
                    lineId: targetLine?.lineId,
                    area: areaCode,
                  });
                }
              }}
            />
            <QrScanButton
              size="middle"
              tooltip="Сканировать QR с бирки рулона"
              onScan={(code) => {
                const num = parseInt(code.replace(/\D/g, ""), 10);
                if (!isNaN(num)) {
                  setManualRollId(num);
                  if (areaCode) {
                    issueDirectMutation.mutate({
                      unitId: num,
                      lineId: targetLine?.lineId,
                      area: areaCode,
                    });
                  }
                }
              }}
            />
            <Button
              type="primary"
              disabled={!manualRollId || !areaCode}
              loading={issueDirectMutation.isPending}
              onClick={() => {
                if (manualRollId && areaCode) {
                  issueDirectMutation.mutate({
                    unitId: manualRollId,
                    lineId: targetLine?.lineId,
                    area: areaCode,
                  });
                }
              }}
            >
              Выдать рулон
            </Button>
            {isLineMode && (
              <Button
                icon={<ThunderboltOutlined style={{ color: "#faad14" }} />}
                loading={autoFifoMutation.isPending}
                disabled={!(availableQuery.data ?? []).length}
                onClick={() => autoFifoMutation.mutate()}
              >
                Автоподбор FIFO
              </Button>
            )}
          </Space>
        </div>

        {/* Подходящие рулоны на складе */}
        {isLineMode && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <Text strong style={{ fontSize: 13 }}>
                Рулоны в наличии на складе (подходящие по ширине и декору):
              </Text>
              {availableQuery.isFetching && <Spin size="small" />}
            </div>

            <Table<MaterialUnit>
              size="small"
              rowKey="id"
              dataSource={availableQuery.data ?? []}
              loading={availableQuery.isLoading}
              pagination={{ pageSize: 5 }}
              columns={[
                {
                  title: "№ рулона",
                  dataIndex: "id",
                  render: (id: number) => <UnitLink id={id} />,
                },
                {
                  title: "Плёнка",
                  render: (_, u) =>
                    `${u.material_sku?.material?.name ?? ""} ${u.material_sku?.color?.name ?? ""}`.trim() || "—",
                },
                {
                  title: "Ширина",
                  dataIndex: "width_mm",
                  align: "right",
                  render: (w: number) => `${w} мм`,
                },
                {
                  title: "Остаток",
                  dataIndex: "length_m",
                  align: "right",
                  render: (l: number) => `${Math.round(l)} м`,
                },
                {
                  title: "Ячейка",
                  dataIndex: "location_code",
                  render: (loc: string | null) => (loc ? <Tag color="geekblue">{loc}</Tag> : "—"),
                },
                {
                  title: "Действие",
                  align: "right",
                  render: (_, u) => (
                    <Button
                      size="small"
                      type="primary"
                      ghost
                      loading={issueDirectMutation.isPending}
                      onClick={() => {
                        if (areaCode) {
                          issueDirectMutation.mutate({
                            unitId: u.id,
                            lineId: targetLine?.lineId,
                            area: areaCode,
                          });
                        }
                      }}
                    >
                      Выдать
                    </Button>
                  ),
                },
              ]}
              locale={{
                emptyText: "На складе нет свободных рулонов этой ширины. Требуется нарезка нового рулона или свободная выдача.",
              }}
            />
          </div>
        )}
      </Space>
    </Modal>
  );
}
