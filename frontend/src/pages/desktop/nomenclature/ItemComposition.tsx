import { useState, type ReactNode } from "react";
import { Alert, Button, Checkbox, Modal, Select, Space, Tag, Typography, message } from "antd";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listItems, setItemComponents, type TechCard } from "../../../api/items";
import { apiErrorMessage } from "../../../utils/apiError";

type Input = TechCard["inputs"][number];

/** Группы состава: строка без «или» — сама по себе, строки одной группы
 * «или» — вместе (варианты друг друга). */
function groupInputs(inputs: Input[]): Input[][] {
  const out: Input[][] = [];
  const byAlt = new Map<number, Input[]>();
  for (const i of inputs) {
    if (i.alt_group == null) out.push([i]);
    else if (byAlt.has(i.alt_group)) byAlt.get(i.alt_group)!.push(i);
    else {
      const g = [i];
      byAlt.set(i.alt_group, g);
      out.push(g);
    }
  }
  return out;
}

type Op = TechCard["operations"][number];

/** Вкладка «Состав» позиции (05.10): маршрут по участкам цепочкой; работы —
 * операции с участком, видом, расценкой, сроком и тем, что на них
 * расходуется; из чего делается (с вариантами «или» и браком); во что
 * входит. Заменить заготовку — прямо у строки состава. */
export default function ItemComposition({ card, canEdit }: { card: TechCard; canEdit: boolean }) {
  const navigate = useNavigate();
  const [replacing, setReplacing] = useState<Input | null>(null);
  const [editing, setEditing] = useState<"components" | "route" | null>(null);
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const area = (code: string | null) => areasQuery.data?.find((a) => a.code === code);
  // все строки состава, в т.ч. без позиции (плёнка — выбирается в задании)
  const inputs = card.inputs;
  const groups = groupInputs(inputs);
  const ops = card.operations;
  // цепочка участков: подряд идущие операции одного участка — одним звеном
  const chain: { area: string | null; name: string; ops: string[] }[] = [];
  for (const o of ops) {
    const last = chain[chain.length - 1];
    if (last && last.area === o.area) last.ops.push(o.name);
    else chain.push({ area: o.area, name: o.area ? (o.area_name ?? o.area) : "общий запас", ops: [o.name] });
  }
  const consumedAt = (o: Op) => inputs.filter((i) => i.stage_id != null && i.stage_id === o.id);
  const unbound = inputs.filter((i) => i.stage_id == null);

  if (card.source_type === "sku") return <UsedIn card={card} />;

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <section>
        <Space style={{ justifyContent: "space-between", width: "100%" }}>
          <Typography.Title level={5} style={{ margin: 0 }}>
            Маршрут по участкам
          </Typography.Title>
          {canEdit && (
            <Button size="small" onClick={() => setEditing("route")}>
              Изменить маршрут
            </Button>
          )}
        </Space>
        {chain.length === 0 ? (
          <Typography.Text type="secondary">Операции не заданы — в заказ позиция не запустится.</Typography.Text>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 8 }}>
            {chain.map((c, i) => (
              <Space key={i} size={6}>
                {i > 0 && <Typography.Text type="secondary">→</Typography.Text>}
                <div style={{ border: "1px solid rgba(128,128,128,.35)", borderRadius: 8, padding: "4px 10px", lineHeight: 1.3 }}>
                  <div style={{ fontWeight: 600 }}>{c.name}</div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {c.ops.join(", ")}
                  </Typography.Text>
                </div>
              </Space>
            ))}
          </div>
        )}
      </section>

      {ops.length > 0 && (
        <section>
          <Typography.Title level={5}>Работы</Typography.Title>
          <Table<Op>
            size="small"
            rowKey={(o) => String(o.id ?? o.sequence_order)}
            pagination={false}
            dataSource={ops}
            scroll={{ x: "max-content" }}
            columns={[
              { title: "№", width: 44, render: (_, o) => o.sequence_order },
              { title: "Работа", render: (_, o) => <b>{o.name}</b> },
              {
                title: "Участок",
                render: (_, o) => (o.area ? (o.area_name ?? o.area) : <Typography.Text type="secondary">общий запас</Typography.Text>),
              },
              {
                title: "Вид",
                render: (_, o) =>
                  o.role ? (
                    <Tag color={o.role === "film" ? "blue" : "gold"}>{OPERATION_ROLE_LABEL[o.role]}</Tag>
                  ) : (
                    <Typography.Text type="secondary">обычная</Typography.Text>
                  ),
              },
              { title: "Срок, раб. дн.", render: (_, o) => area(o.area)?.lead_days ?? "—" },
              {
                title: "Расходуется на этой работе",
                render: (_, o) => {
                  const list = consumedAt(o);
                  return list.length ? (
                    <Space direction="vertical" size={0}>
                      {list.map((i, k) => (
                        <span key={k}>
                          {i.component_item_id ? <a onClick={() => navigate(`/item/${i.component_item_id}`)}>{i.name}</a> : i.name}
                          <Typography.Text type="secondary">
                            {" "}
                            · {i.qty_per_unit ?? "—"} {i.unit}
                          </Typography.Text>
                        </span>
                      ))}
                    </Space>
                  ) : (
                    <Typography.Text type="secondary">—</Typography.Text>
                  );
                },
              },
            ]}
          />
          {unbound.length > 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
              Без привязки к работе: {unbound.length} — расходуются на первой операции.
            </Typography.Text>
          )}
        </section>
      )}

      <section>
        <Space style={{ justifyContent: "space-between", width: "100%" }}>
          <Typography.Title level={5} style={{ margin: 0 }}>
            Из чего делается
          </Typography.Title>
          {canEdit && (
            <Button size="small" onClick={() => setEditing("components")}>
              {inputs.length ? "Изменить состав" : "Указать состав"}
            </Button>
          )}
        </Space>
        {inputs.length === 0 ? (
          <Typography.Text type="secondary">Не указано — позиция не расходует другие позиции (или состав ещё не заведён).</Typography.Text>
        ) : (
          <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
            {groups.map((g, gi) => (
              <div key={gi} style={{ border: "1px solid rgba(0,0,0,.08)", borderRadius: 8, padding: "8px 12px", display: "grid", gap: 6 }}>
                {g.length > 1 && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Любой из вариантов — по порядку, не хватает первого — добирается из следующего
                  </Typography.Text>
                )}
                {g.map((i, k) => (
                  <Space key={k} style={{ justifyContent: "space-between", width: "100%" }} wrap>
                    <Space size={6} wrap>
                      {g.length > 1 && <Tag>{k === 0 ? "основной" : "или"}</Tag>}
                      {i.component_item_id ? (
                        <a onClick={() => navigate(`/item/${i.component_item_id}`)}>{i.name}</a>
                      ) : (
                        <span>{i.name}</span>
                      )}
                      {i.from_defect && <Tag color="volcano">только брак</Tag>}
                      <Typography.Text type="secondary">
                        {i.qty_per_unit ?? "—"} {i.unit} на 1 шт{i.operation_name ? ` · на «${i.operation_name}»` : ""}
                      </Typography.Text>
                      {i.source === "bom" && <Tag>из BOM модели</Tag>}
                      {i.source === "rule" && <Tag color="purple">по правилу типа</Tag>}
                      {i.note && <Typography.Text type="secondary">· {i.note}</Typography.Text>}
                    </Space>
                    {canEdit && i.source === "manual" && (
                      <Button size="small" onClick={() => setReplacing(i)}>
                        Заменить…
                      </Button>
                    )}
                  </Space>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>

      <UsedIn card={card} />
      {replacing && <ReplaceModal card={card} target={replacing} onClose={() => setReplacing(null)} />}
      {editing === "components" && <ComponentsEditorModal card={card} onClose={() => setEditing(null)} />}
      {editing === "route" && <RouteEditorModal card={card} onClose={() => setEditing(null)} />}
    </Space>
  );
}

/** Во что входит позиция — в составы каких позиций и сколько на штуку. */
function UsedIn({ card }: { card: TechCard }) {
  const navigate = useNavigate();
  return (
    <section>
      <Typography.Title level={5}>Во что входит</Typography.Title>
      {card.used_in.length === 0 ? (
        <Typography.Text type="secondary">Ни в одном составе не используется.</Typography.Text>
      ) : (
        <Space wrap size={[6, 6]}>
          {card.used_in.map((u, k) => (
            <Tag key={k} style={{ cursor: u.item_id ? "pointer" : undefined }} onClick={() => u.item_id && navigate(`/item/${u.item_id}`)}>
              {u.name}
              {u.qty_per_unit != null ? ` · ${u.qty_per_unit} на шт` : ""}
            </Tag>
          ))}
        </Space>
      )}
    </section>
  );
}

/** Заменить компонент состава: норма, операция, «или» и «брак» остаются
 * как были. Галочка «оставить прежний вариантом» — новый становится
 * основным, прежний — запасным «или». */
function ReplaceModal({ card, target, onClose }: { card: TechCard; target: Input; onClose: () => void }) {
  const qc = useQueryClient();
  const [newId, setNewId] = useState<number | null>(null);
  const [keepOld, setKeepOld] = useState(false);
  const itemsQuery = useQuery({ queryKey: ["items", false], queryFn: () => listItems({ include_inactive: false }) });
  const options = (itemsQuery.data ?? [])
    .filter((i) => i.id !== card.item_id && i.id !== target.component_item_id && !i.is_model)
    .map((i) => ({ value: i.id, label: `${i.name} · ${i.kind_name}` }));

  const mutation = useMutation({
    mutationFn: () => {
      const manual = card.inputs.filter((i) => i.source === "manual" && i.component_item_id != null);
      const usedGroups = manual.map((i) => i.alt_group ?? 0);
      const group = keepOld ? (target.alt_group ?? Math.max(0, ...usedGroups) + 1) : target.alt_group;
      const rows = manual.flatMap((i) => {
        const row = {
          component_item_id: i.component_item_id as number,
          qty_per_unit: i.qty_per_unit ?? 1,
          stage_id: i.stage_id,
          alt_group: i.alt_group,
          from_defect: i.from_defect,
        };
        if (i !== target) return [row];
        const fresh = { ...row, component_item_id: newId as number, alt_group: group, from_defect: keepOld ? false : i.from_defect };
        return keepOld ? [fresh, { ...row, alt_group: group }] : [fresh];
      });
      return setItemComponents(card.item_id, rows);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["techcard"] });
      qc.invalidateQueries({ queryKey: ["item-tree"] });
      message.success("Состав изменён");
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось изменить состав")),
  });

  return (
    <Modal
      open
      title={`Заменить «${target.name}»`}
      okText="Заменить"
      cancelText="Отмена"
      onCancel={onClose}
      okButtonProps={{ disabled: !newId, loading: mutation.isPending }}
      onOk={() => mutation.mutate()}
      destroyOnHidden
    >
      <Space direction="vertical" style={{ width: "100%" }}>
        <Typography.Text>
          {card.name}: {target.qty_per_unit} {target.unit} на 1 шт{target.operation_name ? `, на «${target.operation_name}»` : ""}.
        </Typography.Text>
        <Select
          showSearch
          optionFilterProp="label"
          placeholder="Из чего делать теперь"
          style={{ width: "100%" }}
          loading={itemsQuery.isLoading}
          value={newId ?? undefined}
          options={options}
          onChange={setNewId}
        />
        <Checkbox checked={keepOld} onChange={(e) => setKeepOld(e.target.checked)}>
          Оставить «{target.name}» запасным вариантом («или»)
        </Checkbox>
        <Alert
          type="info"
          showIcon
          message="Новые задания и расчёт потребности пойдут по новому составу. Уже запущенные задания и детали на складе не меняются."
        />
      </Space>
    </Modal>
  );
}

