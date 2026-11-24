import { useState, useEffect } from "react";
import { Modal, Input, Radio, Button, Card, Typography, Tag, Space, Spin, Empty, Upload, Tabs, Popconfirm, Image, message } from "antd";
import {
  GlobalOutlined,
  CheckCircleFilled,
  SearchOutlined,
  InboxOutlined,
  DeleteOutlined,
  PictureOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  type TextureCandidate,
  getTextureCandidates,
  applySkuTexture,
  deleteSkuPhoto,
  skuPhotoUrl,
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
  const [activeTab, setActiveTab] = useState<"preset" | "upload">("preset");
  const [queryInput, setQueryInput] = useState(initialQuery);
  const [activeQuery, setActiveQuery] = useState(initialQuery);
  const [textureType, setTextureType] = useState<string>("all");
  const [selected, setSelected] = useState<TextureCandidate | null>(null);

  // Локальный файл для ручной загрузки
  const [customFileBase64, setCustomFileBase64] = useState<string | null>(null);
  const [customFileName, setCustomFileName] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      const q = `${sku.manufacturer?.name ?? ""} ${sku.color?.name ?? ""}`.trim();
      setQueryInput(q);
      setActiveQuery(q);
      setSelected(null);
      setCustomFileBase64(null);
      setCustomFileName(null);
      setActiveTab("preset");
    }
  }, [open, sku]);

  const candidatesQuery = useQuery({
    queryKey: ["texture-candidates", sku.id, activeQuery, textureType],
    queryFn: () => getTextureCandidates(sku.id, { query: activeQuery, texture_type: textureType }),
    enabled: open && activeTab === "preset",
  });

  const applyMutation = useMutation({
    mutationFn: (payload: { image_base64?: string; image_url?: string }) =>
      applySkuTexture(sku.id, payload),
    onSuccess: () => {
      message.success("Текстура успешно привязана к плёнке!");
      onApplied();
      onClose();
    },
    onError: (err: any) => {
      message.error(err?.response?.data?.detail ?? "Не удалось применить текстуру");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteSkuPhoto(sku.id),
    onSuccess: () => {
      message.success("Фото плёнки удалено");
      onApplied();
      onClose();
    },
    onError: () => {
      message.error("Не удалось удалить фото");
    },
  });

  const handleSearch = () => {
    setActiveQuery(queryInput.trim());
    setSelected(null);
  };

  const handleCustomFile = (file: File) => {
    if (!file.type.startsWith("image/")) {
      message.error("Пожалуйста, выберите файл изображения (JPEG, PNG или WebP)");
      return false;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const res = e.target?.result as string;
      setCustomFileBase64(res);
      setCustomFileName(file.name);
    };
    reader.readAsDataURL(file);
    return false;
  };

  const currentPhoto = skuPhotoUrl(sku.photo_path);

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
      width={760}
      destroyOnHidden
      footer={[
        currentPhoto && (
          <Popconfirm
            key="delete"
            title="Удалить привязанное фото?"
            onConfirm={() => deleteMutation.mutate()}
            okText="Удалить"
            cancelText="Отмена"
          >
            <Button danger icon={<DeleteOutlined />} loading={deleteMutation.isPending} style={{ float: "left" }}>
              Удалить текущее фото
            </Button>
          </Popconfirm>
        ),
        <Button key="cancel" onClick={onClose}>
          Отмена
        </Button>,
        activeTab === "preset" ? (
          <Button
            key="apply-preset"
            type="primary"
            disabled={!selected}
            loading={applyMutation.isPending}
            onClick={() =>
              selected &&
              applyMutation.mutate({
                image_base64: selected.data_base64 ?? undefined,
                image_url: selected.image_url ?? undefined,
              })
            }
          >
            Применить выбранный образец
          </Button>
        ) : (
          <Button
            key="apply-custom"
            type="primary"
            disabled={!customFileBase64}
            loading={applyMutation.isPending}
            onClick={() =>
              customFileBase64 &&
              applyMutation.mutate({
                image_base64: customFileBase64,
              })
            }
          >
            Сохранить загруженное фото
          </Button>
        ),
      ]}
    >
      <Tabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as "preset" | "upload")}
        items={[
          {
            key: "preset",
            label: (
              <span>
                <PictureOutlined /> Подбор образцов (Soft-touch & Каталоги)
              </span>
            ),
            children: (
              <div>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 12, fontSize: 12 }}>
                  Калиброванные гладкие soft-touch оттенки для ПЭТ-плёнок, древесные фактуры и каталожные образцы производителей.
                </Typography.Paragraph>

                <Space direction="vertical" style={{ width: "100%", marginBottom: 14 }} size={10}>
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
                    <Radio.Button value="smooth">Гладкий Soft-touch (ПЭТ / мат)</Radio.Button>
                    <Radio.Button value="wood">Древесные фактуры</Radio.Button>
                    <Radio.Button value="catalog">Каталоги поставщиков</Radio.Button>
                  </Radio.Group>
                </Space>

                <div style={{ minHeight: 280, maxHeight: 380, overflowY: "auto", padding: "4px 2px" }}>
                  {candidatesQuery.isLoading ? (
                    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: 260 }}>
                      <Spin tip="Ищем и калибруем образцы текстур..." />
                    </div>
                  ) : (candidatesQuery.data ?? []).length === 0 ? (
                    <Empty description="Образцы не найдены. Попробуйте изменить формулировку запроса или загрузить свой файл." />
                  ) : (
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                        gap: 12,
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
                              cursor: "pointer",
                            }}
                            styles={{ body: { padding: 8 } }}
                          >
                            {isSelected && (
                              <div
                                style={{
                                  position: "absolute",
                                  top: 6,
                                  right: 6,
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
                                height: 110,
                                borderRadius: 4,
                                overflow: "hidden",
                                marginBottom: 6,
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
                            <Typography.Text strong style={{ fontSize: 12, display: "block" }} ellipsis>
                              {cand.title}
                            </Typography.Text>
                            {cand.subtitle && (
                              <Typography.Text type="secondary" style={{ fontSize: 11, display: "block" }} ellipsis>
                                {cand.subtitle}
                              </Typography.Text>
                            )}
                            <div style={{ marginTop: 4 }}>
                              <Tag
                                color={
                                  cand.texture_type === "smooth"
                                    ? "purple"
                                    : cand.texture_type === "wood"
                                    ? "orange"
                                    : "blue"
                                }
                                style={{ margin: 0, fontSize: 10 }}
                              >
                                {cand.source_label}
                              </Tag>
                            </div>
                          </Card>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            ),
          },
          {
            key: "upload",
            label: (
              <span>
                <UploadOutlined /> Загрузить своё фото / файл
              </span>
            ),
            children: (
              <div style={{ padding: "10px 0" }}>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
                  Если у вас есть реальная фотография рулона с телефона или официальный файл текстуры от поставщика, загрузите его сюда:
                </Typography.Paragraph>

                <Upload.Dragger
                  accept="image/jpeg,image/png,image/webp"
                  multiple={false}
                  showUploadList={false}
                  beforeUpload={handleCustomFile}
                  style={{ padding: "20px 0", background: "#fafafa" }}
                >
                  <p className="ant-upload-drag-icon">
                    <InboxOutlined style={{ color: "#1677ff", fontSize: 42 }} />
                  </p>
                  <p className="ant-upload-text" style={{ fontSize: 14 }}>
                    Нажмите для выбора файла или перетащите фото сюда
                  </p>
                  <p className="ant-upload-hint" style={{ fontSize: 12 }}>
                    Поддерживаются форматы JPG, PNG, WebP
                  </p>
                </Upload.Dragger>

                {customFileBase64 && (
                  <div
                    style={{
                      marginTop: 16,
                      padding: 12,
                      background: "#f6ffed",
                      border: "1px solid #b7eb8f",
                      borderRadius: 6,
                      display: "flex",
                      alignItems: "center",
                      gap: 16,
                    }}
                  >
                    <Image
                      src={customFileBase64}
                      width={100}
                      height={100}
                      style={{ objectFit: "cover", borderRadius: 4 }}
                    />
                    <div>
                      <Typography.Text strong style={{ display: "block" }}>
                        Готово к сохранению: {customFileName}
                      </Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 4 }}>
                        Нажмите кнопку «Сохранить загруженное фото» внизу модального окна.
                      </Typography.Text>
                      <Button
                        size="small"
                        type="link"
                        danger
                        style={{ padding: 0, marginTop: 4 }}
                        onClick={() => {
                          setCustomFileBase64(null);
                          setCustomFileName(null);
                        }}
                      >
                        Отменить выбор файла
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ),
          },
        ]}
      />

      {currentPhoto && (
        <div
          style={{
            marginTop: 12,
            padding: "6px 12px",
            background: "#fafafa",
            border: "1px solid #f0f0f0",
            borderRadius: 6,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Space size={10}>
            <Image src={currentPhoto} width={36} height={36} style={{ objectFit: "cover", borderRadius: 4 }} />
            <span style={{ fontSize: 12, color: "#595959" }}>Сейчас в карточке прикреплено фото</span>
          </Space>
          <Tag color="green" style={{ margin: 0 }}>
            Фото активно
          </Tag>
        </div>
      )}
    </Modal>
  );
}
