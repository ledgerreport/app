// Minimal RFC 4180 CSV reading/writing for the batch mode: comma separator,
// double-quoted fields with "" escapes, CRLF or LF line ends, optional BOM.

export function parseCsv(text: string): string[][] {
  const input = text.startsWith("﻿") ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;

  const endField = () => {
    row.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    // Skip lines that are completely empty.
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (fieldStarted) throw new Error(`CSV: unexpected quote inside an unquoted field (row ${rows.length + 1})`);
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n") {
      endRow();
    } else if (ch === "\r") {
      if (input[i + 1] !== "\n") throw new Error(`CSV: stray carriage return (row ${rows.length + 1})`);
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (inQuotes) throw new Error("CSV: unterminated quoted field");
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

function escapeField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function formatCsv(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  return rows.map((r) => r.map(escapeField).join(",")).join("\n") + "\n";
}
