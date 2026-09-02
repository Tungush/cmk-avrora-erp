/**
 * Экспорт таблицы в CSV (запрос бизнеса 31.08.2026: «вот этот список можно
 * экспортировать?»). BOM в начале обязателен — без него Excel на Windows
 * открывает кириллицу кракозябрами. Разделитель — точка с запятой: русская
 * локаль Excel по запятой не разбивает.
 */
export function exportCsv(
  filename: string,
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
) {
  const esc = (v: string | number | null | undefined): string => {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return /[";\n]/.test(s) ? `"${s}"` : s;
  };
  const lines = [headers.map(esc).join(';'), ...rows.map((r) => r.map(esc).join(';'))];
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
