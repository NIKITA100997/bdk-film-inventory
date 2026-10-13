import { useState } from "react";
import { Button, Image, Select, Space, Tag, Tooltip, Typography, Upload, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { addItemAnalog, deleteItemAnalog, deleteItemPhoto, listItemAnalogs, listItems, uploadItemPhoto } from "../api/items";
import { skuPhotoUrl } from "../api/dictionaries";
import { useAuth } from "../auth/AuthContext";
import { hasPerm } from "../auth/permissions";
import { apiErrorMessage } from "../utils/apiError";

const n = (v: number) => String(Math.round(v * 1000) / 1000);

/** Фото и аналоги позиции (14.10) — как у плёнки, для детали п/ф, материала,
 * изделия: чем можно заменить и сколько этого есть на складе. */
export default function ItemAnalogsPhoto({ itemId, photoPath }: { itemId: number; photoPath: string | null | undefined }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canEdit = hasPerm(user, "production_tasks.manage", "materials.manage", "part_units.manage", "purchasing.manage");
  const analogsQuery = useQuery({ queryKey: ["item-analogs", itemId], queryFn: () => listItemAnalogs(itemId) });
  const [adding, setAdding] = useState(false);
  const itemsQuery = useQuery({ queryKey: ["items", false], queryFn: () => listItems({ include_inactive: false }), enabled: adding });
  const setAnalogs = (d: Awaited<ReturnType<typeof listItemAnalogs>>) => qc.setQueryData(["item-analogs", itemId], d);
  const add = useMutation({
    mutationFn: (id: number) => addItemAnalog(itemId, id, null),
    onSuccess: (d) => {
      setAnalogs(d);
      setAdding(false);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось добавить аналог")),
  });
  const del = useMutation({ mutationFn: (linkId: number) => deleteItemAnalog(itemId, linkId), onSuccess: setAnalogs });
  const photo = useMutation({
    mutationFn: (f: File | null) => (f ? uploadItemPhoto(itemId, f) : deleteItemPhoto(itemId)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["techcard", itemId] }),
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить фото")),
  });
  const analogs = analogsQuery.data ?? [];
  const url = skuPhotoUrl(photoPath ?? null);
  if (!canEdit && !analogs.length && !url) return null;
  return (
    <Space wrap size={[12, 6]} align="center">
      <Space size={6} align="center">
        <Typography.Text type="secondary">Фото:</Typography.Text>
        {url ? <Image src={url} height={40} style={{ borderRadius: 4 }} /> : <Typography.Text type="secondary">нет</Typography.Text>}
        {canEdit && (
          <Upload
            accept="image/jpeg,image/png,image/webp"
            showUploadList={false}
            beforeUpload={(f) => {
              photo.mutate(f);
              return false;
            }}
          >
            <Button size="small" loading={photo.isPending}>
              {url ? "Заменить" : "Загрузить"}
            </Button>
          </Upload>
        )}
        {canEdit && url && (
          <Button size="small" type="link" danger onClick={() => photo.mutate(null)}>
            Убрать
          </Button>
        )}
      </Space>
      <Space size={6} wrap align="center">
        <Typography.Text type="secondary">Аналоги:</Typography.Text>
        {!analogs.length && <Typography.Text type="secondary">нет</Typography.Text>}
        {analogs.map((a) => (
          <Tooltip key={a.link_id} title={`${a.kind_name}${a.note ? ` · ${a.note}` : ""}`}>
            <Tag
              color={a.stock && a.stock > 0 ? "green" : undefined}
              closable={canEdit}
              onClose={(e) => {
                e.preventDefault();
                del.mutate(a.link_id);
              }}
              style={{ cursor: "pointer" }}
              onClick={() => navigate(`/item/${a.item_id}`)}
            >
              {a.name}
              {a.stock != null ? ` · ${n(a.stock)} ${a.unit}` : ""}
            </Tag>
          </Tooltip>
        ))}
        {canEdit &&
          (adding ? (
            <Select
              size="small"
              showSearch
              autoFocus
              defaultOpen
              optionFilterProp="label"
              placeholder="Чем можно заменить"
              style={{ width: 320 }}
              loading={itemsQuery.isLoading}
              onBlur={() => setAdding(false)}
              onChange={(v: number) => add.mutate(v)}
              options={(itemsQuery.data ?? [])
                .filter((i) => !i.is_model && i.id !== itemId && i.kind_code !== "plenka")
                .map((i) => ({ value: i.id, label: `${i.name} · ${i.kind_name}` }))}
            />
          ) : (
            <Button size="small" onClick={() => setAdding(true)}>
              + аналог
            </Button>
          ))}
      </Space>
    </Space>
  );
}
