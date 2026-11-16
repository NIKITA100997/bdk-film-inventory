import React from "react";

export type UiBadgeColor =
  | "green"
  | "success"
  | "red"
  | "error"
  | "orange"
  | "warning"
  | "gold"
  | "blue"
  | "processing"
  | "cyan"
  | "geekblue"
  | "purple"
  | "default";

export interface UiBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  color?: UiBadgeColor | string;
  size?: "sm" | "default";
  children: React.ReactNode;
}

/**
 * Lightweight, zero-lag badge component replacing heavy Ant Design <Tag>
 * in dense tables, lists, and cards. Pure HTML/CSS without CSS-in-JS overhead.
 */
export function UiBadge({
  color = "default",
  size = "default",
  children,
  className = "",
  style,
  ...rest
}: UiBadgeProps) {
  let colorClass = "ui-badge-default";
  if (color === "green" || color === "success") colorClass = "ui-badge-success";
  else if (color === "red" || color === "error") colorClass = "ui-badge-error";
  else if (color === "orange" || color === "warning" || color === "gold") colorClass = "ui-badge-warning";
  else if (color === "blue" || color === "processing") colorClass = "ui-badge-processing";
  else if (color === "cyan") colorClass = "ui-badge-cyan";
  else if (color === "geekblue") colorClass = "ui-badge-geekblue";
  else if (color === "purple") colorClass = "ui-badge-purple";

  const sizeClass = size === "sm" ? "ui-badge-sm" : "";
  const fullClassName = `ui-badge ${colorClass} ${sizeClass} ${className}`.trim();

  return (
    <span className={fullClassName} style={style} {...rest}>
      {children}
    </span>
  );
}

export default UiBadge;
