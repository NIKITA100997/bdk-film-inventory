import { useState, useEffect } from "react";
import { Modal, Input, Radio, Button, Card, Typography, Tag, Space, Spin, Empty, message } from "antd";
import { GlobalOutlined, CheckCircleFilled, SearchOutlined } from "@ant-design/icons";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  type TextureCandidate,
  getTextureCandidates,
  applySkuTexture,
} from "../api/dictionaries";
import { skuLabel, type MaterialSku } from "../api/units";

interface Props {
  open: boolean;
  onClose: () => void;
  sku: MaterialSku;
  onApplied: () => void;
}

export default function TexturePickerModal({ open, onClose, sku, onApplied }: Props) {
  const initialQuery = `${sku.manufacturer?.name ?? ""} ${sku.color?.name ?? ""}`.trim();
  const [queryInput, setQueryInput] = useState(initialQuery);
  const [activeQuery, setActiveQuery] = useState(initialQuery);
  const [textureType, setTextureType] = useState<string>("all");
  const [selected, setSelected] = useState<TextureCandidate | null>(null);

  useEffect(() => {
    if (open) {
      const q = `${sku.manufacturer?.name ?? ""} ${sku.color?.name ?? ""}`.trim();
      setQueryInput(q);
      setActiveQuery(q);
      setSelected(null);
    }
  }, [open, sku]);

  const candidatesQuery = useQuery({
    queryKey: ["texture-candidates", sku.id, activeQuery, textureType],
    queryFn: () => getTextureCandidates(sku.id, { query: activeQuery, texture_type: textureType }),
    enabled: open,
  });

  const applyMutation = useMutation({
    mutationFn: (cand: TextureCandidate) =>
      applySkuTexture(sku.id, {
        image_base64: cand.data_base64 ?? undefined,
        image_url: cand.image_url ?? undefined,
      }),
    onSuccess: () => {
      message.success("Текстура успешно привязана к плёнке!");
      onApplied();
      onClose();
    },
    onError: (err: any) => {
      message.error(err?.response?.data?.detail ?? "Не удалось применить текстуру");
    },
  });

  const handleSearch = () => {
    setActiveQuery(queryInput.trim());
    setSelected(null);
  };

  return (
    <Modal
      title={
        <Space>
          <GlobalOutlined style={{ color: "#1677ff" }} />
          <span>Подбор текстуры: {skuLabel(sku)}</span>
        </Space>
      }
      open={open}
      onCancel={onClose}
      width={720}
      destroyOnHidden
      footer={[
        <Button key="cancel" onClick={onClose}>
          Отмена
        </Button>,
        <Button
          key="apply"
          type="primary"
          disabled={!selected}
          loading={applyMutation.isPending}
          onClick={() => selected && applyMutation.mutate(selected)}
        >
          Применить выбранный образец
        </Button>,
      ]}
    >
      <div style={{ marginBottom: 16 }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          Автоматический подбор калиброванных гладких soft-touch оттенков и каталожных образцов производителей для позиции.
        </Typography.Paragraph>

        <Space direction="vertical" style={{ width: "100%" }} size={10}>
          <div style={{ display: "flex", gap: 8 }}>
            <Input
              value={queryInput}
              onChange={(e) => setQueryInput(e.target.value)}
              onPressEnter={handleSearch}
              placeholder="Поисковый запрос (например: Greenwood Санторини)"
              prefix={<SearchOutlined style={{ color: "#bfbfbf" }} />}
            />
            <Button type="primary" onClick={handleSearch} loading={candidatesQuery.isFetching}>
              Найти
            </Button>
          </div>

          <Radio.Group
            value={textureType}
            onChange={(e) => {
              setTextureType(e.target.value);
              setSelected(null);
            }}
            optionType="button"
            buttonStyle="solid"
            size="small"
          >
            <Radio.Button value="all">Все варианты</Radio.Button>
            <Radio.Button value="smooth">Гладкий soft-touch (ПЭТ / мат)</Radio.Button>
            <Radio.Button value="catalog">Каталоги поставщиков</Radio.Button>
          </Radio.Group>
        </Space>
      </div>

      <div style={{ minHeight: 280, maxHeight: 420, overflowY: "auto", padding: "4px 2px" }}>
        {candidatesQuery.isLoading ? (
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: 260 }}>
            <Spin tip="Ищем и калибруем образцы текстур..." />
          </div>
        ) : (candidatesQuery.data ?? []).length === 0 ? (
          <Empty description="Образцы не найдены. Попробуйте изменить формулировку запроса." />
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
              gap: 14,
            }}
          >
            {(candidatesQuery.data ?? []).map((cand) => {
              const isSelected = selected?.id === cand.id;
              return (
                <Card
                  key={cand.id}
                  hoverable
                  onClick={() => setSelected(cand)}
                  style={{
                    border: isSelected ? "2px solid #1677ff" : "1px solid #d9d9d9",
                    borderRadius: 8,
                    overflow: "hidden",
                    position: "relative",
                  }}
                  styles={{ body: { padding: 10 } }}
                >
                  {isSelected && (
                    <div
                      style={{
                        position: "absolute",
                        top: 8,
                        right: 8,
                        zIndex: 2,
                        background: "#fff",
                        borderRadius: "50%",
                        lineHeight: 1,
                      }}
                    >
                      <CheckCircleFilled style={{ color: "#1677ff", fontSize: 20 }} />
                    </div>
                  )}
                  <div
                    style={{
                      width: "100%",
                      height: 120,
                      borderRadius: 6,
                      overflow: "hidden",
                      marginBottom: 8,
                      background: "#fafafa",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <img
                      src={cand.preview_url}
                      alt={cand.title}
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  </div>
                  <Typography.Text strong style={{ fontSize: 13, display: "block" }} ellipsis>
                    {cand.title}
                  </Typography.Text>
                  {cand.subtitle && (
                    <Typography.Text type="secondary" style={{ fontSize: 11, display: "block" }} ellipsis>
                      {cand.subtitle}
                    </Typography.Text>
                  )}
                  <div style={{ marginTop: 6 }}>
                    <Tag color={cand.texture_type === "smooth" ? "purple" : "blue"} style={{ margin: 0, fontSize: 10 }}>
                      {cand.source_label}
                    </Tag>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
