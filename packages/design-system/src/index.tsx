import type { HTMLAttributes, ReactNode } from "react";

export type StatusTone = "neutral" | "success" | "danger";

export function StatusPill({
  tone,
  children,
}: {
  tone: StatusTone;
  children: ReactNode;
}) {
  return <span className={`status-pill status-pill--${tone}`}>{children}</span>;
}

export function Surface({
  className = "",
  ...props
}: HTMLAttributes<HTMLElement>) {
  return <section className={`surface ${className}`.trim()} {...props} />;
}

export function DefinitionRow({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="definition-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
