import type { ReactNode } from "react";
import { Card, Empty, Segmented, Space, Typography } from "antd";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { hasPerm } from "../../auth/permissions";
import Receive from "./Receive";
import Issue from "./Issue";
import MaterialReceiveForm from "../../components/MaterialReceiveForm";
import PfIssueList from "../../components/PfIssueList";
import { RegisterPartUnitForm } from "../desktop/production/PartStock";

type Kind = { key: string; label: string; perms: string[]; render: () => ReactNode; own?: boolean };

/** «Приёмка» и «Выдача» для любой позиции (14.10): вид — переключателем
 * сверху (?kind=). Плёнка — прежние экраны как есть (у них свой заголовок);
 * материалы и п/ф — свои формы. Переключатель виден, если видов больше одного. */
function Hub({ title, kinds }: { title: string; kinds: Kind[] }) {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const allowed = kinds.filter((k) => hasPerm(user, ...k.perms));
  const cur = allowed.find((k) => k.key === params.get("kind")) ?? allowed[0];
  if (!cur) return <Empty description="Нет прав на этот раздел" />;
  const switcher =
    allowed.length > 1 ? (
      <Segmented
        size="large"
        value={cur.key}
        onChange={(v) => setParams(v === allowed[0].key ? {} : { kind: String(v) }, { replace: true })}
        options={allowed.map((k) => ({ value: k.key, label: k.label }))}
        style={{ marginBottom: 12 }}
      />
    ) : null;
  if (cur.own)
    return (
      <div>
        {switcher}
        {cur.render()}
      </div>
    );
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      {switcher}
      <Card>
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          {title}: {cur.label.toLowerCase()}
        </Typography.Title>
        {cur.render()}
      </Card>
    </Space>
  );
}

export function ReceiveHub() {
  return (
    <Hub
      title="Приёмка"
      kinds={[
        { key: "plenka", label: "Плёнка", perms: ["units.receive"], render: () => <Receive />, own: true },
        { key: "material", label: "Материалы", perms: ["units.receive", "materials.manage"], render: () => <MaterialReceiveForm /> },
        { key: "pf", label: "П/ф", perms: ["part_units.manage"], render: () => <RegisterPartUnitForm /> },
      ]}
    />
  );
}

export function IssueHub() {
  return (
    <Hub
      title="Выдача"
      kinds={[
        { key: "plenka", label: "Плёнка", perms: ["units.issue", "units.return"], render: () => <Issue />, own: true },
        { key: "pf", label: "П/ф", perms: ["part_units.manage"], render: () => <PfIssueList /> },
      ]}
    />
  );
}
