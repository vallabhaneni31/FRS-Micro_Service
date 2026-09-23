// Req 6.7 — Export downloads a CSV of the data currently shown on the view.
export interface CsvSection { title: string; rows: Record<string, unknown>[] }

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Build the CSV text: one titled block per section, blocks separated by a blank line. */
export function sectionsToCsv(sections: CsvSection[]): string {
  const blocks: string[] = [];
  for (const s of sections) {
    if (!s.rows.length) continue;
    const headers = Object.keys(s.rows[0]);
    blocks.push([cell(s.title), headers.map(cell).join(','), ...s.rows.map((r) => headers.map((h) => cell(r[h])).join(','))].join('\n'));
  }
  return blocks.join('\n\n');
}

export function downloadCsv(filename: string, sections: CsvSection[]): string {
  const text = sectionsToCsv(sections);
  if (typeof document === 'undefined' || !text) return text;
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return text;
}
