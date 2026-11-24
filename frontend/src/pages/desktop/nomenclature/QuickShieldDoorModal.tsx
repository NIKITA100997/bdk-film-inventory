import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Row,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from "antd";
import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  ArrowRightOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createItemByType,
  listItemTypes,
  previewTypeRules,
  type ItemProperty,
  type PropertyValue,
} from "../../../api/itemTypes";
import NewFilmColorButton from "../../../components/NewFilmColorButton";
import { optionLabel } from "../../../utils/optionLabel";
import { apiErrorMessage } from "../../../utils/apiError";

const QUICK_WIDTHS = [600, 700, 800, 900];
const QUICK_HEIGHTS = [2000, 2030, 2100, 2200];
const GLASS_PRESETS = ["есть", "Черное", "Зеркало Графит", "Матовое"];

/**
 * Быстрое создание отдельной щитовой двери (24.11).
 * Позволяет за 3 клика выбрать модель, размер, цвет и конструктивные опции,
 * с живым предпросмотром наименования, проверкой на дубликаты
 * и автоматическим формированием техкарты и полуфабрикатов.
 */
export default function QuickShieldDoorModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();

  // Получаем список типов изделий и находим тип «Щитовая дверь»
  const typesQuery = useQuery({ queryKey: ["item-types"], queryFn: () => listItemTypes() });
  const shieldType = useMemo(
    () =>
      (typesQuery.data ?? []).find(
        (t) => (t.direction === "shield" && t.kind_code === "izdelie") || t.id === 12,
      ),
    [typesQuery.data],
  );

  // Свойства типа по коду
  const propByCode = useMemo(() => {
    const map = new Map<string, ItemProperty>();
    for (const p of shieldType?.properties ?? []) {
      map.set(p.code, p);
    }
    return map;
  }, [shieldType]);

  const seriesProp = propByCode.get("серия");
  const colorProp = propByCode.get("цвет");
  const edgeProp = propByCode.get("кромка");
  const widthProp = propByCode.get("ширина");
  const heightProp = propByCode.get("высота");
  const moldProp = propByCode.get("молдинг");
  const lockProp = propByCode.get("замок");
  const glassProp = propByCode.get("стекло");
  const preLamProp = propByCode.get("до_ламинации");

  // Состояния формы
  const [seriesOptId, setSeriesOptId] = useState<number | undefined>();
  const [width, setWidth] = useState<number>(800);
  const [height, setHeight] = useState<number>(2000);
  const [colorOptId, setColorOptId] = useState<number | undefined>();
  const [edgeOptId, setEdgeOptId] = useState<number | undefined>();
  const [molding, setMolding] = useState<boolean>(false);
  const [lock, setLock] = useState<boolean>(false);
  const [hasGlass, setHasGlass] = useState<boolean>(false);
  const [glassText, setGlassText] = useState<string>("есть");
  const [preLam, setPreLam] = useState<boolean>(false);
  const [openCardAfter, setOpenCardAfter] = useState<boolean>(true);

  // Опция серии
  const selectedSeries = useMemo(
    () => seriesProp?.options.find((o) => o.id === seriesOptId),
    [seriesProp, seriesOptId],
  );

  // При выборе серии автоматически выставляем кромку по умолчанию (abs или aluminum)
  useEffect(() => {
    if (!selectedSeries || !edgeProp) return;
    const defaultEdgeCode = (selectedSeries.params?.кромка as string) || "abs";
    const matchingEdge = edgeProp.options.find(
      (o) => o.value.toLowerCase() === defaultEdgeCode.toLowerCase(),
    );
    if (matchingEdge && edgeOptId === undefined) {
      setEdgeOptId(matchingEdge.id);
    }
  }, [selectedSeries, edgeProp, edgeOptId]);

  // Сборка значений свойств в словарь { property_id: value }
  const values = useMemo(() => {
    const v: Record<string, PropertyValue> = {};
    if (seriesProp && seriesOptId != null) v[String(seriesProp.id)] = seriesOptId;
    if (widthProp && width != null) v[String(widthProp.id)] = width;
    if (heightProp && height != null) v[String(heightProp.id)] = height;
    if (colorProp && colorOptId != null) v[String(colorProp.id)] = colorOptId;
    if (edgeProp && edgeOptId != null) v[String(edgeProp.id)] = edgeOptId;
    if (moldProp) v[String(moldProp.id)] = molding;
    if (lockProp) v[String(lockProp.id)] = lock;
    if (glassProp) v[String(glassProp.id)] = hasGlass ? glassText.trim() || "есть" : "";
    if (preLamProp) v[String(preLamProp.id)] = preLam;
    return v;
  }, [
    seriesProp,
    seriesOptId,
    widthProp,
    width,
    heightProp,
    height,
    colorProp,
    colorOptId,
    edgeProp,
    edgeOptId,
    moldProp,
    molding,
    lockProp,
    lock,
    glassProp,
    hasGlass,
    glassText,
    preLamProp,
    preLam,
  ]);

  // Готовность формы для расчета превью
  const isFormValid = !!(seriesOptId && width && height && colorOptId && edgeOptId);

  // Живое превью правил типа
  const previewQuery = useQuery({
    queryKey: ["quick-shield-preview", shieldType?.id, values],
    queryFn: () => previewTypeRules(shieldType!.id, { values }),
    enabled: !!shieldType?.id && isFormValid,
  });

  const preview = previewQuery.data;
  const isExisting = !!preview?.existing_item_id;

  // Мутация создания
  const createMutation = useMutation({
    mutationFn: () => createItemByType(shieldType!.id, values),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["items"] });
      qc.invalidateQueries({ queryKey: ["item-types"] });
      if (res.created) {
        message.success(`Создана позиция: «${res.name}»`);
      } else {
        message.info(`Позиция уже была в базе: «${res.name}»`);
      }
      onClose();
      if (openCardAfter) {
        navigate(`/item/${res.item_id}`);
      }
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось создать щитовую дверь")),
  });

  return (
    <Modal
      open
      width={840}
      title={
        <Space size={8}>
          <span>✨ Создать щитовую дверь</span>
          <Tag color="blue">Тип: Щитовая дверь</Tag>
        </Space>
      }
      onCancel={onClose}
      footer={
        <Space>
          <Button onClick={onClose}>Отмена</Button>
          {isExisting ? (
            <Button
              type="primary"
              icon={<ArrowRightOutlined />}
              onClick={() => {
                onClose();
                navigate(`/item/${preview!.existing_item_id}`);
              }}
            >
              Открыть существующую (№{preview!.existing_item_id})
            </Button>
          ) : (
            <Button
              type="primary"
              disabled={!isFormValid || !preview?.name || (preview?.errors.length ?? 0) > 0}
              loading={createMutation.isPending}
              icon={<CheckCircleOutlined />}
              onClick={() => createMutation.mutate()}
            >
              Создать дверь
            </Button>
          )}
        </Space>
      }
    >
      <Form layout="vertical" size="middle" style={{ marginTop: 8 }}>
        <Row gutter={16}>
          {/* Левая колонка: Базовые характеристики */}
          <Col span={12}>
            <Form.Item label="Серия (модель)" required>
              <Select
                showSearch
                placeholder="Выберите серию двери…"
                value={seriesOptId}
                onChange={(id) => {
                  setSeriesOptId(id);
                  const opt = seriesProp?.options.find((o) => o.id === id);
                  const defaultEdge = (opt?.params?.кромка as string) || "abs";
                  const edgeMatch = edgeProp?.options.find(
                    (o) => o.value.toLowerCase() === defaultEdge.toLowerCase(),
                  );
                  if (edgeMatch) setEdgeOptId(edgeMatch.id);
                }}
                optionFilterProp="label"
                options={
                  seriesProp?.options
                    .filter((o) => o.is_active)
                    .map((o) => ({
                      value: o.id,
                      label: `${o.value} (каркас ${o.params?.толщина_каркаса ?? 24} мм, панель ${o.params?.толщина_панели ?? 6} мм)`,
                    })) ?? []
                }
              />
            </Form.Item>

            <Form.Item label="Цвет двери (плёнка)" required>
              <Select
                showSearch
                placeholder="Выберите цвет или плёнку…"
                value={colorOptId}
                onChange={setColorOptId}
                optionFilterProp="label"
                options={
                  colorProp?.options
                    .filter((o) => o.is_active)
                    .map((o) => ({
                      value: o.id,
                      label: optionLabel(o),
                    })) ?? []
                }
              />
              {colorProp && (
                <div style={{ marginTop: 4 }}>
                  <NewFilmColorButton
                    property={colorProp}
                    onCreated={(newOptId) => setColorOptId(newOptId)}
                  />
                </div>
              )}
            </Form.Item>

            <Row gutter={12}>
              <Col span={12}>
                <Form.Item label="Ширина (мм)" required>
                  <InputNumber
                    min={200}
                    max={1200}
                    step={10}
                    style={{ width: "100%" }}
                    value={width}
                    onChange={(v) => v && setWidth(v)}
                  />
                  <Space orientation="horizontal" size={4} style={{ marginTop: 4 }} wrap>
                    {QUICK_WIDTHS.map((qw) => (
                      <Button
                        key={qw}
                        size="small"
                        type={width === qw ? "primary" : "default"}
                        onClick={() => setWidth(qw)}
                        style={{ padding: "0 6px", fontSize: 11 }}
                      >
                        {qw}
                      </Button>
                    ))}
                  </Space>
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label="Высота (мм)" required>
                  <InputNumber
                    min={1500}
                    max={2500}
                    step={10}
                    style={{ width: "100%" }}
                    value={height}
                    onChange={(v) => v && setHeight(v)}
                  />
                  <Space orientation="horizontal" size={4} style={{ marginTop: 4 }} wrap>
                    {QUICK_HEIGHTS.map((qh) => (
                      <Button
                        key={qh}
                        size="small"
                        type={height === qh ? "primary" : "default"}
                        onClick={() => setHeight(qh)}
                        style={{ padding: "0 6px", fontSize: 11 }}
                      >
                        {qh}
                      </Button>
                    ))}
                  </Space>
                </Form.Item>
              </Col>
            </Row>

            <Form.Item label="Кромка" required>
              <Radio.Group
                value={edgeOptId}
                onChange={(e) => setEdgeOptId(e.target.value)}
                style={{ width: "100%" }}
              >
                <Space direction="vertical">
                  {edgeProp?.options.map((o) => (
                    <Radio key={o.id} value={o.id}>
                      {o.value === "abs"
                        ? "ABS кромка (стандарт)"
                        : o.value === "aluminum"
                        ? "Алюминиевый профиль (кромка)"
                        : optionLabel(o)}
                    </Radio>
                  ))}
                </Space>
              </Radio.Group>
            </Form.Item>
          </Col>

          {/* Правая колонка: Конструкция и Опции */}
          <Col span={12}>
            <Card size="small" title="Особенности конструкции" style={{ marginBottom: 16 }}>
              <Space orientation="vertical" size="small" style={{ width: "100%" }}>
                <Checkbox checked={molding} onChange={(e) => setMolding(e.target.checked)}>
                  С молдингом (вставка)
                </Checkbox>
                <Checkbox checked={lock} onChange={(e) => setLock(e.target.checked)}>
                  Фрезеровка под замок (врезка)
                </Checkbox>
                <div>
                  <Checkbox checked={hasGlass} onChange={(e) => setHasGlass(e.target.checked)}>
                    Остекление (со стеклом)
                  </Checkbox>
                  {hasGlass && (
                    <div style={{ marginTop: 6, marginLeft: 24 }}>
                      <Input
                        size="small"
                        placeholder="Укажите тип стекла (напр. Черное, Зеркало Графит)"
                        value={glassText}
                        onChange={(e) => setGlassText(e.target.value)}
                        style={{ marginBottom: 4 }}
                      />
                      <Space size={4} wrap>
                        {GLASS_PRESETS.map((gp) => (
                          <Button
                            key={gp}
                            size="small"
                            type={glassText === gp ? "link" : "text"}
                            onClick={() => setGlassText(gp)}
                            style={{ padding: "0 4px", fontSize: 11 }}
                          >
                            {gp}
                          </Button>
                        ))}
                      </Space>
                    </div>
                  )}
                </div>
                <Checkbox checked={preLam} onChange={(e) => setPreLam(e.target.checked)}>
                  Фрезеровка до ламинации (под зеркало / М9)
                </Checkbox>
              </Space>
            </Card>

            <Checkbox
              checked={openCardAfter}
              onChange={(e) => setOpenCardAfter(e.target.checked)}
              style={{ fontSize: 13 }}
            >
              Открыть карточку позиции после создания
            </Checkbox>
          </Col>
        </Row>

        <Divider style={{ margin: "14px 0" }} />

        {/* Блок предпросмотра (Live Preview) */}
        <div style={{ background: "#fafafa", padding: 14, borderRadius: 8, border: "1px solid #f0f0f0" }}>
          <Typography.Text strong style={{ fontSize: 13 }}>
            Предпросмотр позиции и состава:
          </Typography.Text>

          {!isFormValid ? (
            <Typography.Text type="secondary" style={{ display: "block", marginTop: 6 }}>
              Заполните серию, цвет и размер для предварительного расчёта…
            </Typography.Text>
          ) : previewQuery.isLoading ? (
            <div style={{ padding: 12, textAlign: "center" }}>
              <Spin size="small" /> <Typography.Text type="secondary">Расчёт техкарты…</Typography.Text>
            </div>
          ) : preview ? (
            <Space orientation="vertical" size={10} style={{ width: "100%", marginTop: 8 }}>
              {/* Наименование и статус дубликата */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <Typography.Text strong style={{ fontSize: 14, color: "#1677ff" }}>
                  {preview.name}
                </Typography.Text>
                {isExisting ? (
                  <Tag color="orange" icon={<ExclamationCircleOutlined />}>
                    Уже существует (ID {preview.existing_item_id})
                  </Tag>
                ) : (
                  <Tag color="green" icon={<CheckCircleOutlined />}>
                    Новая позиция
                  </Tag>
                )}
              </div>

              {isExisting && (
                <Alert
                  type="warning"
                  showIcon
                  message={`Такая дверь уже заведена в номенклатуре: «${preview.existing_item_name ?? preview.name}» (ID: ${preview.existing_item_id}). Создавать дубликат не требуется.`}
                />
              )}

              {preview.errors.length > 0 && (
                <Alert
                  type="error"
                  showIcon
                  message="Ошибки в правилах:"
                  description={preview.errors.join("; ")}
                />
              )}

              {/* Состав полуфабрикатов (BOM) */}
              {(preview.components ?? []).length > 0 && (
                <div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Автоматический состав полуфабрикатов (П/Ф):
                  </Typography.Text>
                  <Space wrap size={[6, 6]} style={{ marginTop: 4 }}>
                    {preview.components.map((c, i) => (
                      <Tag key={i} color={c.exists ? "default" : "blue"} style={{ fontSize: 12 }}>
                        {c.name} — {c.qty} шт.
                      </Tag>
                    ))}
                  </Space>
                </div>
              )}

              {/* Маршрут изготовления */}
              {(preview.operations ?? []).length > 0 && (
                <div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Маршрут операций:
                  </Typography.Text>
                  <div style={{ marginTop: 4 }}>
                    {preview.operations.map((op, idx) => (
                      <span key={idx}>
                        <Tag>{op.name}</Tag>
                        {idx < preview.operations.length - 1 && <span style={{ color: "#bfbfbf", marginRight: 8 }}>→</span>}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </Space>
          ) : null}
        </div>
      </Form>
    </Modal>
  );
}
