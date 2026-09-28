import { useState } from "react";
import { Tag, theme } from "antd";
import type { TreeNode } from "../api/modelBuilder";
import "./TechTree.css";

const KIND_LABEL: Record<string, string> = { plenka: "плёнка", pf: "п/ф", izdelie: "изделие", material: "материал" };
const KIND_COLOR: Record<string, string> = { plenka: "#1677ff", pf: "#fa8c16", izdelie: "#52c41a", material: "#13c2c2" };

const fmtQty = (n: number) => String(Math.round(n * 10000) / 10000);

/** Схема техкарты (mindmap): позиция → операции по участкам → что на
 * каждой расходуется → у компонента свои операции и состав. Пунктир —
 * позиции ещё нет, заведётся при создании. Клик по позиции сворачивает
 * её ветку; onOpen — перейти в карточку существующей позиции. */
export default function TechTree({
  root,
  expandDepth = 2,
  onOpen,
}: {
  root: TreeNode;
  expandDepth?: number;
  onOpen?: (itemId: number) => void;
}) {
  const { token } = theme.useToken();
  const vars = {
    "--tt-line": token.colorBorder,
    "--tt-border": token.colorBorderSecondary,
    "--tt-bg": token.colorBgContainer,
    "--tt-op-bg": token.colorFillQuaternary,
    "--tt-muted": token.colorTextSecondary,
    "--tt-warn": token.colorWarningText,
  } as React.CSSProperties;
  return (
    <div className="tt-root" style={vars}>
      <Branch node={root} depth={0} expandDepth={expandDepth} onOpen={onOpen} />
    </div>
  );
}

function Branch({
  node,
  depth,
  expandDepth,
  onOpen,
}: {
  node: TreeNode;
  depth: number;
  expandDepth: number;
  onOpen?: (itemId: number) => void;
}) {
  const [open, setOpen] = useState(depth < expandDepth);
  const hasChildren = node.operations.length > 0 || node.loose.length > 0;
  const color = KIND_COLOR[node.kind_code ?? ""] ?? "#8c8c8c";
  const childCount = node.operations.reduce((s, op) => s + op.components.length, 0) + node.loose.length;
  return (
    <div className="tt-branch">
      <div
        className="tt-node"
        data-toggle={hasChildren}
        data-new={!node.exists}
        style={{ borderLeftColor: color }}
        onClick={() => hasChildren && setOpen((v) => !v)}
        title={hasChildren ? (open ? "Свернуть" : "Развернуть") : undefined}
      >
        <div className="tt-node-name">
          {node.qty != null && <span style={{ color }}>{fmtQty(node.qty)} × </span>}
          {node.name}
        </div>
        <div className="tt-node-meta">
          {KIND_LABEL[node.kind_code ?? ""] ?? ""}
          {!node.exists && (
            <Tag color="green" style={{ marginLeft: 6, fontSize: 11, lineHeight: "16px" }}>
              будет создана
            </Tag>
          )}
          {node.exists && node.item_id != null && onOpen && (
            <a
              style={{ marginLeft: 6 }}
              onClick={(e) => {
                e.stopPropagation();
                onOpen(node.item_id as number);
              }}
            >
              карточка →
            </a>
          )}
          {hasChildren && !open && <span style={{ marginLeft: 6 }}>▸ {node.operations.length} оп., {childCount} комп.</span>}
        </div>
        {node.film && <div className="tt-node-meta">плёнка: {node.film}</div>}
        {node.warnings.map((w) => (
          <div key={w} className="tt-warn">
            ⚠ {w}
          </div>
        ))}
      </div>
      {hasChildren && open && (
        <div className="tt-children">
          {node.operations.map((op, i) => (
            <div key={`${op.name}-${i}`} className="tt-child">
              <div className="tt-branch">
                <div className="tt-op">
                  <b>
                    {i + 1}. {op.name}
                  </b>
                  {op.area_name == null ? " · общий запас" : op.area_name !== op.name ? ` · ${op.area_name}` : ""}
                </div>
                {op.components.length > 0 && (
                  <div className="tt-children">
                    {op.components.map((c, j) => (
                      <div key={`${c.name}-${j}`} className="tt-child">
                        <Branch node={c} depth={depth + 1} expandDepth={expandDepth} onOpen={onOpen} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {node.loose.map((c, j) => (
            <div key={`loose-${c.name}-${j}`} className="tt-child">
              <Branch node={c} depth={depth + 1} expandDepth={expandDepth} onOpen={onOpen} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
