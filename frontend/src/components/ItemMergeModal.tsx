import { useState } from "react";
import { Alert, Button, Descriptions, Modal, Select, Space, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { listItems, mergeItem, type MergeResult } from "../api/items";
import { apiErrorMessage } from "../utils/apiError";

/** Слить дубль с основной позицией (14.10) — для детали п/ф, материала,
 * изделия: сначала пробный прогон (что и сколько переедет), потом «Слить».
 * Дубль уходит в архив, его название становится синонимом основной. */
export default function ItemMergeModal({
  itemId,
  itemName,
  kindCode,
  onClose,
  defaultInto,
  stay = false,
}: {
  itemId: number;
  itemName: string;
  kindCode: string;
  onClose: () => void;
  /** основная позиция подставлена (из списка дубликатов) */
  defaultInto?: number;
  /** не переходить в карточку основной после слияния */
  stay?: boolean;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const itemsQuery = useQuery({ queryKey: ["items", false], queryFn: () => listItems({ include_inactive: false }) });
  const [into, setInto] = useState<number | undefined>(defaultInto);
  const [preview, setPreview] = useState<MergeResult | null>(null);
  const dry = useMutation({
    mutationFn: () => mergeItem(itemId, into!, false),
    onSuccess: setPreview,
    onError: (e) => {
      setPreview(null);
      message.error(apiErrorMessage(e, "Слить нельзя"));
    },
  });
  const apply = useMutation({
    mutationFn: () => mergeItem(itemId, into!, true),
    onSuccess: () => {
      for (const k of ["items", "techcard", "part-units", "unified-lots", "material-stock", "item-aliases", "dict-autocomplete"]) qc.invalidateQueries({ queryKey: [k] });
      message.success(`«${itemName}» слита`);
      qc.invalidateQueries({ queryKey: ["parts"] });
      onClose();
      if (!stay) navigate(`/item/${into}`);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось слить")),
  });
  const options = (itemsQuery.data ?? [])
    .filter((i) => i.kind_code === kindCode && !i.is_model && i.id !== itemId)
    .map((i) => ({ value: i.id, label: i.name }));
  const moved = Object.entries(preview?.moved ?? {});
  return (
    <Modal
      open
      width={620}
      title={`Слить дубль «${itemName}»`}
      onCancel={onClose}
      footer={
        <Space>
          <Button onClick={onClose}>Отмена</Button>
          <Button disabled={!into} loading={dry.isPending} onClick={() => dry.mutate()}>
            Проверить
          </Button>
          <Button type="primary" danger disabled={!preview || !into} loading={apply.isPending} onClick={() => apply.mutate()}>
            Слить
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" style={{ width: "100%" }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Эта позиция — дубль. Всё, что на неё ссылается (партии, строки заданий и заказов, резервы, движения, цены, состав,
          синонимы), переедет на основную; этапы сопоставятся по порядку или названию. Дубль уйдёт в архив, его название станет
          синонимом основной — тексты из нарядов и 1С дальше узнаются как основная.
        </Typography.Paragraph>
        <Select
          showSearch
          optionFilterProp="label"
          placeholder="Основная позиция — в неё слить"
          loading={itemsQuery.isLoading}
          options={options}
          value={into}
          onChange={(v) => {
            setInto(v);
            setPreview(null);
          }}
          style={{ width: "100%" }}
        />
        {preview && (
          <Alert
            type="info"
            showIcon
            message={`«${preview.src}» → «${preview.dst}»`}
            description={
              <>
                {moved.length ? (
                  <Descriptions size="small" column={1}>
                    {moved.map(([k, v]) => (
                      <Descriptions.Item key={k} label={k}>
                        {v}
                      </Descriptions.Item>
                    ))}
                  </Descriptions>
                ) : (
                  <Typography.Text>Ссылок на дубль нет — он просто уйдёт в архив.</Typography.Text>
                )}
                {preview.notes.map((n) => (
                  <div key={n}>
                    <Typography.Text type="secondary">{n}</Typography.Text>
                  </div>
                ))}
              </>
            }
          />
        )}
      </Space>
    </Modal>
  );
}
