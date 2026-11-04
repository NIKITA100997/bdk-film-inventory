import { useMemo } from "react";
import { Card, Grid, Segmented, Select, Space, Typography } from "antd";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../../auth/AuthContext";
import { hasPerm } from "../../../auth/permissions";
import CustomerOrders from "./CustomerOrders";
import IntakeTab from "./IntakeTab";
import ProductionOrders from "../production/ProductionOrders";
import OrderReadiness from "../OrderReadiness";
import OrderDeadlines from "../production/OrderDeadlines";
import { ShipmentsBody } from "../Shipments";
import BitrixDeals from "./BitrixDeals";

interface SectionDef {
  key: string;
  label: string;
  shortLabel: string;
  icon: string;
  children: React.ReactNode;
}

export default function CustomerOrdersHub() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const screens = Grid.useBreakpoint();
  const isTabletOrNarrow = !screens.lg;

  const sections: SectionDef[] = useMemo(
    () => [
      ...(hasPerm(
        user,
        "production_tasks.manage",
        "production_tasks.view",
        "production_tasks.report",
        "orders.request",
        "sales_calculator.view",
        "plan.approve"
      )
        ? [
            {
              key: "orders",
              label: "Счета и заказы покупателей",
              shortLabel: "Счета 1С",
              icon: "📋",
              children: <CustomerOrders />,
            },
          ]
        : []),
      ...(hasPerm(
        user,
        "sales_calculator.view",
        "production_tasks.manage",
        "production_tasks.view",
        "production_tasks.report"
      )
        ? [
            {
              key: "readiness",
              label: "Готовность к отгрузке",
              shortLabel: "Готовность",
              icon: "📊",
              children: <OrderReadiness />,
            },
          ]
        : []),
      ...(hasPerm(
        user,
        "production_tasks.manage",
        "production_tasks.view",
        "orders.request",
        "sales_calculator.view",
        "plan.approve"
      )
        ? [
            {
              key: "deadlines",
              label: "Сроки и риски отгрузки",
              shortLabel: "Сроки",
              icon: "⏳",
              children: <OrderDeadlines />,
            },
          ]
        : []),
      ...(hasPerm(user, "production_tasks.manage")
        ? [
            {
              key: "production",
              label: "Заказы в цехе (производство)",
              shortLabel: "В цехе",
              icon: "🏭",
              children: <ProductionOrders />,
            },
          ]
        : []),
      ...(hasPerm(user, "production_tasks.manage", "orders.request")
        ? [
            {
              key: "bitrix",
              label: "Сделки CRM Битрикс24",
              shortLabel: "Битрикс24",
              icon: "🏢",
              children: <BitrixDeals />,
            },
          ]
        : []),
      ...(hasPerm(user, "fg.ship", "fg.invoices")
        ? [
            {
              key: "shipping",
              label: "Отгрузка со склада ГП",
              shortLabel: "Отгрузка",
              icon: "🚚",
              children: <ShipmentsBody />,
            },
          ]
        : []),
      ...(hasPerm(user, "production_tasks.manage")
        ? [
            {
              key: "intake",
              label: "Приём в производство",
              shortLabel: "Приёмка",
              icon: "📥",
              children: <IntakeTab />,
            },
          ]
        : []),
    ],
    [user]
  );

  const wanted = params.get("section") ?? params.get("tab");
  const activeKey = sections.some((s) => s.key === wanted)
    ? (wanted as string)
    : sections[0]?.key;

  const setSection = (key: string) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("section", key);
        next.delete("tab");
        return next;
      },
      { replace: true }
    );
  };

  const activeSection = sections.find((s) => s.key === activeKey);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Компактная адаптивная шапка Хаба Заказов */}
      <Card
        size="small"
        styles={{ body: { padding: "8px 16px" } }}
        style={{
          borderRadius: 8,
          boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
          marginBottom: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <Space align="center" size={8}>
            <span style={{ fontSize: 18 }}>📑</span>
            <Typography.Title level={5} style={{ margin: 0, whiteSpace: "nowrap" }}>
              Заказы
            </Typography.Title>
          </Space>

          {/* На планшетах и узких экранах — удобный выпадающий список или Segmented */}
          {isTabletOrNarrow ? (
            <Select
              value={activeKey}
              onChange={setSection}
              style={{ width: 230 }}
              options={sections.map((s) => ({
                value: s.key,
                label: `${s.icon} ${s.label}`,
              }))}
            />
          ) : (
            <Segmented
              value={activeKey}
              onChange={(val) => setSection(val as string)}
              options={sections.map((s) => ({
                value: s.key,
                label: (
                  <span style={{ padding: "0 4px", fontSize: 13, fontWeight: 500 }}>
                    {s.icon} {s.shortLabel}
                  </span>
                ),
              }))}
            />
          )}
        </div>
      </Card>

      {/* Контент активного раздела */}
      <div>{activeSection?.children}</div>
    </div>
  );
}
