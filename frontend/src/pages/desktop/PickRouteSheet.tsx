import React, { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Card,
  Table,
  Tag,
  Button,
  Space,
  Input,
  Modal,
  Progress,
  Typography,
  Alert,
  Select,
  message,
} from "antd";
import {
  QrcodeOutlined,
  CheckCircleOutlined,
  PrinterOutlined,
  ReloadOutlined,
  EnvironmentOutlined,
} from "@ant-design/icons";
import { getPickRoute, verifyPickItem, type PickRouteItem, type PickRouteWave } from "../../api/pickRoute";
import { listAreas } from "../../api/areas";

const { Text, Title } = Typography;

export const PickRouteSheet: React.FC = () => {
  const [selectedArea, setSelectedArea] = useState<string | undefined>(undefined);
  const [verifiedMap, setVerifiedMap] = useState<Record<string, boolean>>({});
  const [activeScanItem, setActiveScanItem] = useState<PickRouteItem | null>(null);
  const [barcodeInput, setBarcodeInput] = useState<string>("");

  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const { data: wave, isLoading, isFetching, refetch } = useQuery<PickRouteWave>({
    queryKey: ["pickRoute", selectedArea],
    queryFn: () => getPickRoute(selectedArea),
  });

  const verifyMutation = useMutation({
    mutationFn: ({ barcode, lineId }: { barcode: string; lineId: number }) =>
      verifyPickItem(barcode, lineId),
    onSuccess: (res) => {
      if (res.verified) {
        message.success(res.message || "Рулон подтверждён!");
        if (activeScanItem) {
          setVerifiedMap((prev) => ({ ...prev, [activeScanItem.pick_id]: true }));
        }
        setActiveScanItem(null);
        setBarcodeInput("");
      } else {
        Modal.error({
          title: "Ошибка пересортицы!",
          content: res.error || "Отсканированный рулон не подходит под это задание.",
        });
      }
    },
    onError: (err: any) => {
      Modal.error({
        title: "Ошибка проверки",
        content: err?.response?.data?.detail || "Сбой при проверке рулона",
      });
    },
  });

  const items = wave?.items || [];
  const verifiedCount = items.filter((it) => verifiedMap[it.pick_id]).length;
  const progressPct = items.length > 0 ? Math.round((verifiedCount / items.length) * 100) : 0;

  const handleManualVerify = () => {
    if (!activeScanItem || !barcodeInput.trim()) return;
    verifyMutation.mutate({ barcode: barcodeInput.trim(), lineId: activeScanItem.task_line_id });
  };

  const columns = [
    {
      title: "№",
      key: "idx",
      width: 50,
      render: (_: any, __: any, index: number) => index + 1,
    },
    {
      title: "Ячейка / Стеллаж",
      dataIndex: "location_code",
      key: "location_code",
      width: 150,
      render: (loc: string) => (
        <Tag
          color="blue"
          style={{ fontSize: 13, fontWeight: "bold", padding: "4px 8px" }}
        >
          <EnvironmentOutlined style={{ marginRight: 4 }} />
          {loc}
        </Tag>
      ),
    },
    {
      title: "Декор / Плёнка",
      dataIndex: "decor_name",
      key: "decor_name",
      render: (text: string, r: PickRouteItem) => (
        <div>
          <Text strong style={{ fontSize: 13 }}>{text}</Text>
          <div style={{ fontSize: 11, color: "#8c8c8c" }}>
            Ширина: {Math.round(r.width_mm)} мм · Потребность: {r.length_needed_m.toFixed(1)} м
          </div>
        </div>
      ),
    },
    {
      title: "Рекомендуемый рулон",
      key: "unit",
      render: (_: any, r: PickRouteItem) => (
        <div>
          {r.unit_id ? (
            <Space>
              <Tag color="cyan">Рулон #{r.unit_id}</Tag>
              <Text type="secondary" style={{ fontSize: 11 }}>
                ({r.unit_length_m ? `${Math.round(r.unit_length_m)} м` : ""})
              </Text>
            </Space>
          ) : (
            <Tag color="orange">Требуется подбор</Tag>
          )}
        </div>
      ),
    },
    {
      title: "Куда выдать (Участок)",
      dataIndex: "target_area_name",
      key: "target_area_name",
      render: (text: string, r: PickRouteItem) => (
        <div>
          <Tag color="geekblue">{text}</Tag>
          <div style={{ fontSize: 11, color: "#8c8c8c" }}>{r.task_name}</div>
        </div>
      ),
    },
    {
      title: "Статус проверки",
      key: "status",
      width: 170,
      render: (_: any, r: PickRouteItem) => {
        const isDone = verifiedMap[r.pick_id];
        return isDone ? (
          <Tag color="success" icon={<CheckCircleOutlined />} style={{ padding: "4px 8px", fontSize: 12 }}>
            Сверен и снят
          </Tag>
        ) : (
          <Button
            size="small"
            type="primary"
            icon={<QrcodeOutlined />}
            onClick={() => {
              setActiveScanItem(r);
              setBarcodeInput(r.unit_id ? String(r.unit_id) : "");
            }}
          >
            Сверить QR
          </Button>
        );
      },
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "8px 0" }}>
      {/* Шапка с фильтрами и прогрессом волны */}
      <Card size="small">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <div>
            <Title level={4} style={{ margin: 0 }}>
              📋 Сменный маршрутный лист сборщика (Pick Route)
            </Title>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Позиции упорядочены по оптимальному маршруту обхода стеллажей склада
            </Text>
          </div>

          <Space wrap>
            <Select
              allowClear
              placeholder="Все участки"
              value={selectedArea}
              onChange={setSelectedArea}
              style={{ width: 220 }}
              options={(areasQuery.data || []).map((a) => ({ label: a.name, value: a.code }))}
            />

            <Button icon={<ReloadOutlined spin={isFetching} />} onClick={() => refetch()}>
              Обновить
            </Button>

            <Button icon={<PrinterOutlined />} onClick={() => window.print()}>
              Печать листа
            </Button>
          </Space>
        </div>

        {items.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <Text strong>Прогресс сборки волны:</Text>
              <Text strong style={{ color: progressPct === 100 ? "#52c41a" : "#1890ff" }}>
                Собрано {verifiedCount} из {items.length} рулонов ({progressPct}%)
              </Text>
            </div>
            <Progress
              percent={progressPct}
              status={progressPct === 100 ? "success" : "active"}
              strokeColor={{ "0%": "#108ee9", "100%": "#87d068" }}
            />
          </div>
        )}
      </Card>

      {wave?.distinct_racks_count && wave.distinct_racks_count > 0 ? (
        <Alert
          type="info"
          showIcon
          message={
            <span>
              В маршруте задействовано <strong>{wave.distinct_racks_count} стеллажей</strong>, суммарная длина плёнки к выдаче:{" "}
              <strong>{Math.round(wave.total_meters)} м</strong>.
            </span>
          }
        />
      ) : null}

      <Table
        rowKey="pick_id"
        loading={isLoading}
        columns={columns}
        dataSource={items}
        pagination={false}
        size="small"
      />

      {/* Модальное окно подтверждения сканирования */}
      <Modal
        title={
          <Space>
            <QrcodeOutlined style={{ color: "#1890ff" }} />
            <span>Контроль сканирования рулона со стеллажа</span>
          </Space>
        }
        open={!!activeScanItem}
        onCancel={() => {
          setActiveScanItem(null);
          setBarcodeInput("");
        }}
        onOk={handleManualVerify}
        confirmLoading={verifyMutation.isPending}
        okText="Подтвердить"
        cancelText="Отмена"
      >
        {activeScanItem && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Alert
              type="info"
              message={`Ячейка хранения: ${activeScanItem.location_code}`}
              description={
                <div>
                  <div><strong>Декор:</strong> {activeScanItem.decor_name}</div>
                  <div><strong>Ширина:</strong> {Math.round(activeScanItem.width_mm)} мм</div>
                  <div><strong>Участок:</strong> {activeScanItem.target_area_name} ({activeScanItem.task_name})</div>
                </div>
              }
            />

            <div>
              <Text strong>Отсканируйте QR-код или введите номер рулона:</Text>
              <Input
                autoFocus
                size="large"
                prefix={<QrcodeOutlined />}
                placeholder="Например: 777 или со сканера"
                value={barcodeInput}
                onChange={(e) => setBarcodeInput(e.target.value)}
                onPressEnter={handleManualVerify}
                style={{ marginTop: 6 }}
              />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default PickRouteSheet;
