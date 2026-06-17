import ExcelJS from "exceljs";

export type Sheet = { name: string; columns: string[]; rows: string[][] };

// v1 preview caps so a giant model doesn't blow up the page or the DB row.
const MAX_ROWS = 200;
const MAX_COLS = 40;

export async function parseSpreadsheet(filename: string, buf: Buffer): Promise<Sheet[]> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".csv")) return [parseCsv(buf.toString("utf8"))];

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const sheets: Sheet[] = [];
  wb.eachSheet((ws) => {
    const rows: string[][] = [];
    const colCount = Math.min(ws.columnCount || 0, MAX_COLS);
    ws.eachRow((row) => {
      if (rows.length >= MAX_ROWS) return;
      const values: string[] = [];
      for (let c = 1; c <= colCount; c++) values.push(cellText(row.getCell(c).value));
      rows.push(values);
    });
    const [header, ...body] = rows;
    sheets.push({ name: ws.name, columns: header ?? [], rows: body });
  });
  return sheets;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (o.result !== undefined) return String(o.result);
    if (Array.isArray(o.richText)) return o.richText.map((r) => (r as { text: string }).text).join("");
    if (typeof o.hyperlink === "string") return o.hyperlink;
    return "";
  }
  return String(v);
}

function parseCsv(text: string): Sheet {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => l.length > 0)
    .slice(0, MAX_ROWS + 1);
  const rows = lines.map(parseCsvLine);
  const [header, ...body] = rows;
  return { name: "Sheet1", columns: header ?? [], rows: body };
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
