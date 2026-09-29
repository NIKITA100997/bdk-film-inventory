import { Alert, Space, Table, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { getPanelFilm, type PanelFilmRow } from "../api/purchasing";
import { lookupItem } from "../api/items";

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/** Плёнка под ламинацию панелей заказанных дверей: по каждой панели — сколько
 * нужно по открытым заказам и заданиям, уже ламинировано, осталось и сколько
 * плёнки. Без закреплённой плёнки (ПЭТ 2Д/3Д, разная толщина) — наверху, в
 * резерв не идёт, пока плёнку не выберут у детали. */
export default function PanelFilmTable() {
  const navigate = useNavigate();
  const query = useQuery({ queryKey: ["panel-film"], queryFn: getPanelFilm });
  const rows = query.data ?? [];
  const unpinned = rows.filter((r) => !r.film);
  const byFilm = new Map<string, number>();
  for (const r of rows) if (r.film) byFilm.set(r.film, (byFilm.get(r.film) ?? 0) + r.area_m2);
  const openPart = async (partId: number) => {
    try {
      navigate(`/item/${await lookupItem({ part_id: partId })}?tab=techcard`);
    } catch {
      /* позиция не нашлась — остаёмся */
    }
  };
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
        Ламинация панелей щитовых дверей: панелей к ламинации = нужно по открытым заказам и заданиям − уже ламинированные;
        плёнки = панелей × длина × ширина плёнки: штрипс детали, если задан; на широкоформатной окутке (Фабрика) — ширина
        панели + 7 мм; на прессах режут в размер — ширина панели. Это уже входит в
        «Резерв на задания» по плёнке.
      </Typography.Paragraph>
      {unpinned.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`У ${unpinned.length} панелей не выбрана плёнка — в резерв не попали`}
          description="Закрепите плёнку за панелью (ПЭТ 2Д/3Д, толщина) в «Номенклатура → Детали п/ф» — потребность посчитается."
        />
      )}
      {byFilm.size > 0 && (
        <Space size={[6, 6]} wrap>
          <Typography.Text strong>Итого по плёнке:</Typography.Text>
          {[...byFilm.entries()].map(([film, area]) => (
            <Tag key={film} color="blue">
              {film} — {fmt(area)} м²
            </Tag>
          ))}
        </Space>
      )}
      <Table<PanelFilmRow>
        size="small"
        rowKey="part_id"
        loading={query.isLoading}
        dataSource={rows}
        pagination={{ pageSize: 30, hideOnSinglePage: true }}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: "Под открытые заказы дверей ламинировать нечего" }}
        columns={[
          { title: "Панель", render: (_, r) => <a onClick={() => openPart(r.part_id)}>{r.part_name}</a> },
          { title: "Нужно, шт", render: (_, r) => fmt(r.need_pieces) },
          { title: "Ламинировано", render: (_, r) => fmt(r.laminated) },
          { title: "К ламинации", render: (_, r) => <b>{fmt(r.to_laminate)}</b> },
          {
            title: "Плёнка",
            render: (_, r) => (r.film ? r.film : <Tag color="orange">не выбрана</Tag>),
          },
          {
            title: "Ширина × длина",
            render: (_, r) => (
              <span>
                {r.film_width_mm} мм × {r.length_m} м
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {" "}
                  ({r.width_rule})
                </Typography.Text>
              </span>
            ),
          },
          { title: "Плёнки, м²", render: (_, r) => <b>{fmt(r.area_m2)}</b> },
        ]}
      />
    </Space>
  );
}
