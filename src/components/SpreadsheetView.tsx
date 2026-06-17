"use client";

import { useState } from "react";

export type Sheet = { name: string; columns: string[]; rows: string[][] };

export default function SpreadsheetView({ sheets }: { sheets: Sheet[] }) {
  const [active, setActive] = useState(0);
  if (!sheets?.length) return <p className="empty">No sheet data.</p>;
  const s = sheets[Math.min(active, sheets.length - 1)];
  const colCount = Math.max(s.columns.length, ...s.rows.map((r) => r.length), 1);
  const cols = Array.from({ length: colCount }, (_, i) => s.columns[i] ?? `Col ${i + 1}`);

  return (
    <div>
      {sheets.length > 1 && (
        <div className="sheet-tabs">
          {sheets.map((sh, i) => (
            <button
              key={i}
              className={`sheet-tab${i === active ? " on" : ""}`}
              onClick={() => setActive(i)}
            >
              {sh.name}
            </button>
          ))}
        </div>
      )}
      <div className="sheet-scroll">
        <table className="sheet-table">
          <thead>
            <tr>
              <th style={{ color: "var(--text-faint)" }}>#</th>
              {cols.map((c, i) => (
                <th key={i}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.rows.map((row, ri) => (
              <tr key={ri}>
                <td style={{ color: "var(--text-faint)" }}>{ri + 1}</td>
                {cols.map((_, ci) => (
                  <td key={ci}>{row[ci] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
