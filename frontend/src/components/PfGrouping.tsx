import type { ReactNode } from "react";
import { Select, Space, Switch, TreeSelect, Typography } from "antd";
import { groupTree, type ItemGroup } from "../api/items";
import { DIRECTIONS, STAGES, toOptions } from "../utils/itemAttrs";
import type { PfFilter, PfSection } from "./pfGroupingState";

export function PfFilterBar({ value, onChange, groups }: { value: PfFilter; onChange: (f: PfFilter) => void; groups: ItemGroup[] }) {
  return (
    <Space wrap size={[12, 8]}>
      <Select
        allowClear
        placeholder="Направление"
        style={{ width: 180 }}
        value={value.direction}
        onChange={(v) => onChange({ ...value, direction: v })}
        options={toOptions(DIRECTIONS)}
      />
      <TreeSelect
        allowClear
        showSearch
        treeNodeFilterProp="title"
        placeholder="Группа"
        style={{ width: 220 }}
        value={value.group}
        onChange={(v) => onChange({ ...value, group: v ?? undefined })}
        treeData={groupTree(groups, "pf")}
        treeDefaultExpandAll
      />
      <Select
        allowClear
        placeholder="Стадия"
        style={{ width: 180 }}
        value={value.stage}
        onChange={(v) => onChange({ ...value, stage: v })}
        options={toOptions(STAGES)}
      />
      <Space size={6}>
        <Switch size="small" checked={value.grouped} onChange={(v) => onChange({ ...value, grouped: v })} />
        <Typography.Text>По группам</Typography.Text>
      </Space>
    </Space>
  );
}

/** Секции одна под другой: заголовок группы (с числом строк и итогом) и таблица её строк. */
export function PfSections<T>({
  sections,
  render,
  total,
}: {
  sections: PfSection<T>[];
  render: (rows: T[], key: string) => ReactNode;
  total?: (rows: T[]) => string;
}) {
  if (sections.length === 1 && sections[0].title === null) return <>{render(sections[0].rows, "all")}</>;
  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      {sections.map((s) => (
        <div key={s.key}>
          <Typography.Title level={5} style={{ margin: "0 0 8px" }}>
            {s.title}{" "}
            <Typography.Text type="secondary" style={{ fontWeight: 400, fontSize: 13 }}>
              · {s.rows.length} поз.{total ? ` · ${total(s.rows)}` : ""}
            </Typography.Text>
          </Typography.Title>
          {render(s.rows, s.key)}
        </div>
      ))}
    </Space>
  );
}
