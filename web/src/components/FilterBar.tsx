"use client";

import { useEffect, useMemo, useState } from "react";

export type FilterDef =
  | { key: string; type: "search"; label: string }
  | { key: string; type: "select"; label: string; options: [string, string][] }
  | { key: string; type: "chips"; options: [string, string][]; default?: string };

export type FilterValues = Record<string, string>;

/** Filter state + a query string built from it (empty values left out). */
export function useFilters(initial: FilterValues = {}) {
  const [values, setValues] = useState<FilterValues>(initial);
  const set = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }));
  const clear = () => setValues(initial);
  const query = useMemo(() => {
    const p = new URLSearchParams();
    Object.entries(values).forEach(([k, v]) => v && p.set(k, v));
    return p.toString();
  }, [values]);
  return { values, set, clear, query, active: Object.entries(values).some(([k, v]) => v && v !== (initial[k] ?? "")) };
}

function SearchBox({ value, label, onChange }: { value: string; label: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text === value) return;
    const t = setTimeout(() => onChange(text), 300);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  return <input className="search" placeholder={label} value={text} onChange={(e) => setText(e.target.value)} />;
}

export default function FilterBar({
  defs, values, onChange, onClear, active, shown, total,
}: {
  defs: FilterDef[];
  values: FilterValues;
  onChange: (key: string, value: string) => void;
  onClear: () => void;
  active: boolean;
  shown?: number;
  total?: number;
}) {
  return (
    <div className="filters">
      {defs.map((d) => {
        const v = values[d.key] ?? "";
        if (d.type === "search") return <SearchBox key={d.key} value={v} label={d.label} onChange={(x) => onChange(d.key, x)} />;
        if (d.type === "chips")
          return (
            <div className="chips" key={d.key}>
              {d.options.map(([val, label]) => (
                <span key={val} className={`chip ${(v || d.default || "") === val ? "on" : ""}`} onClick={() => onChange(d.key, val)}>
                  {label}
                </span>
              ))}
            </div>
          );
        return (
          <select key={d.key} value={v} onChange={(e) => onChange(d.key, e.target.value)}>
            <option value="">{d.label}</option>
            {d.options.map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </select>
        );
      })}
      {active && <button className="link small" onClick={onClear}>Clear filters</button>}
      {shown !== undefined && <span className="count">Showing {shown}{total !== undefined ? ` of ${total}` : ""}</span>}
    </div>
  );
}
