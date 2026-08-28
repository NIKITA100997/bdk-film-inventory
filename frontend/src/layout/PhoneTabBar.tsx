import { useState, type ReactNode } from "react";
import { Drawer } from "antd";
import { HomeOutlined, InboxOutlined, ExportOutlined, QrcodeOutlined, MenuOutlined } from "@ant-design/icons";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { navTree, isNavItemVisible, type NavItem } from "./navConfig";
import { runUnitOrMaterialSearch } from "../utils/unitSearch";
import FullScreenScanner from "../components/FullScreenScanner";

interface PhoneTab extends NavItem {
  icon: ReactNode;
}

// Раздел про телефонную версию — вручную подобранный список вкладок, не
// автогенерация из navTree (там нет ни иконок, ни отметки "топ-3", а
// "Скан" вообще не пункт меню — см. план). "Ещё" ниже показывает всё
// остальное из navTree, что не попало в этот список.
const PINNED_TABS: PhoneTab[] = [
  { key: "home", path: "/", label: "Сегодня", icon: <HomeOutlined /> },
  { key: "stock", path: "/stock", label: "Остатки", icon: <InboxOutlined /> },
  { key: "issue", path: "/m/issue", label: "Выдача", icon: <ExportOutlined />, permissions: ["units.issue"] },
];
const PINNED_PATHS = new Set(PINNED_TABS.map((t) => t.path));

interface PhoneTabBarProps {
  // "Ввести номер вручную" из полноэкранного сканера — открывает уже
  // существующий полноэкранный поиск в шапке (AppLayout.tsx, searchOpen),
  // а не заводит второй похожий механизм здесь.
  onManualSearchRequest: () => void;
}

export default function PhoneTabBar({ onManualSearchRequest }: PhoneTabBarProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [scannerOpen, setScannerOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  if (!user) return null;

  const visibleTabs = PINNED_TABS.filter((t) => isNavItemVisible(t, user));

  const moreBlocks = navTree
    .map((block) => ({
      block,
      items: block.items.filter((item) => !PINNED_PATHS.has(item.path) && isNavItemVisible(item, user)),
    }))
    .filter(({ items }) => items.length > 0);

  return (
    <>
      {/* position+zIndex — защитная мера: кнопка "Скан" приподнята над
          баром (marginTop: -18 у самого кружка), а без собственного
          stacking context могла оказаться визуально под содержимым
          Content, если внутри него что-то создаёт свой (антд-дропдауны,
          sticky-блоки и т.п.). */}
      <div
        style={{
          display: "flex",
          position: "relative",
          zIndex: 10,
          borderTop: "1px solid #EAE8E2",
          background: "#fff",
          flexShrink: 0,
          padding: "4px 2px 6px",
        }}
      >
        {visibleTabs.map((tab) => {
          const active = location.pathname === tab.path;
          return (
            <button
              key={tab.path}
              onClick={() => navigate(tab.path)}
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 2,
                background: "transparent",
                border: "none",
                padding: "4px 2px",
                color: active ? "#C97A2B" : "#8A8C99",
                fontSize: 10,
                fontWeight: 600,
              }}
            >
              <span style={{ fontSize: 18 }}>{tab.icon}</span>
              {tab.label}
            </button>
          );
        })}
        <button
          onClick={() => setScannerOpen(true)}
          aria-label="Сканировать QR"
          style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", background: "transparent", border: "none" }}
        >
          <span
            style={{
              width: 40,
              height: 40,
              borderRadius: "50%",
              background: "#C97A2B",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
              marginTop: -18,
              boxShadow: "0 4px 10px -2px rgba(201,122,43,0.5)",
            }}
          >
            <QrcodeOutlined />
          </span>
        </button>
        <button
          onClick={() => setMoreOpen(true)}
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 2,
            background: "transparent",
            border: "none",
            padding: "4px 2px",
            color: "#8A8C99",
            fontSize: 10,
            fontWeight: 600,
          }}
        >
          <span style={{ fontSize: 18 }}>
            <MenuOutlined />
          </span>
          Ещё
        </button>
      </div>

      <FullScreenScanner
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScan={(code) => runUnitOrMaterialSearch(code, navigate)}
        onManualEntry={onManualSearchRequest}
      />

      <Drawer title="Ещё" placement="bottom" open={moreOpen} onClose={() => setMoreOpen(false)} height="72%">
        {moreBlocks.map(({ block, items }) => (
          <div key={block.key} style={{ marginBottom: 18 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                color: "#8A8C99",
                marginBottom: 8,
              }}
            >
              {block.label}
            </div>
            {items.map((item) => (
              <div
                key={item.path}
                onClick={() => {
                  setMoreOpen(false);
                  navigate(item.path);
                }}
                style={{ padding: "13px 4px", borderBottom: "1px solid #EAE8E2", fontSize: 14.5 }}
              >
                {item.label}
              </div>
            ))}
          </div>
        ))}
      </Drawer>
    </>
  );
}
