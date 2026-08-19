import React, { useMemo, useState } from 'react';
import {
  Table,
  Group,
  Stack,
  Text,
  TextInput,
  Card,
  Pagination,
  ScrollArea,
  Skeleton,
} from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';

interface SpreadsheetTableProps {
  sheetName: string;
  headers: string[];
  rows: Array<{
    id: string;
    rowNumber: number;
    cells: (string | null)[];
    data: Record<string, string | null>;
  }>;
  meta?: { page: number; pageSize: number; total: number };
  isLoading?: boolean;
  onPageChange?: (page: number) => void;
  title?: string;
  subtitle?: string;
}

/** Ширина колонки данных и закреплённой колонки с номером строки. */
const COL_WIDTH = 170;
const ROWNUM_WIDTH = 64;

const BORDER = '1px solid var(--mantine-color-gray-2)';

function formatCell(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  return value;
}

export function SpreadsheetTable({
  sheetName,
  headers,
  rows,
  meta,
  isLoading,
  onPageChange,
  title,
  subtitle,
}: SpreadsheetTableProps) {
  const [filter, setFilter] = useState('');

  const displayHeaders = useMemo(() => {
    if (headers?.length) return headers;
    const maxCols = rows.reduce((m, r) => Math.max(m, r.cells?.length || 0), 0);
    return Array.from({ length: Math.max(maxCols, 1) }, (_, i) => `col_${i + 1}`);
  }, [headers, rows]);

  const filteredRows = useMemo(() => {
    if (!filter.trim()) return rows;
    const q = filter.toLowerCase();
    return rows.filter((r) => {
      const cells = r.cells || [];
      return cells.some((c) => c && c.toLowerCase().includes(q));
    });
  }, [rows, filter]);

  const totalPages = meta ? Math.ceil(meta.total / meta.pageSize) : 1;
  const tableWidth = ROWNUM_WIDTH + displayHeaders.length * COL_WIDTH;

  const rowsContent = useMemo(() => {
    if (filteredRows.length === 0) {
      return (
        <Table.Tr>
          <Table.Td colSpan={displayHeaders.length + 1} p={64}>
            <Text c="dimmed" fw={600} ta="center">
              Нет данных
            </Text>
          </Table.Td>
        </Table.Tr>
      );
    }

    return filteredRows.map((row) => (
      <Table.Tr key={row.id}>
        <Table.Td
          p={12}
          fz="xs"
          ff="monospace"
          c="dimmed"
          fw={600}
          ta="center"
          style={{
            // то же закрепление, что и в заголовке — иначе колонка «уезжает» при горизонтальном скролле
            position: 'sticky',
            left: 0,
            zIndex: 1,
            background: 'var(--mantine-color-gray-0)',
            borderRight: BORDER,
          }}
        >
          {row.rowNumber}
        </Table.Td>
        {displayHeaders.map((h, i) => {
          const display = formatCell(row.data?.[h] ?? row.cells?.[i] ?? null);
          return (
            <Table.Td
              key={`${row.id}-${i}`}
              p={12}
              fz="xs"
              title={display}
              style={{
                borderRight: i < displayHeaders.length - 1 ? BORDER : undefined,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {display}
            </Table.Td>
          );
        })}
      </Table.Tr>
    ));
  }, [filteredRows, displayHeaders]);

  return (
    <Stack gap="md" h="100%" style={{ minWidth: 0 }}>
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
        <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
          <Text
            fw={900}
            style={{ fontSize: 'clamp(20px, 2.4vw, 28px)', letterSpacing: '-0.02em', lineHeight: 1.15 }}
          >
            {title || sheetName}
          </Text>
          <Text size="sm" c="dimmed">
            {subtitle || `${meta?.total ?? rows.length} строк · ${displayHeaders.length} столбцов`}
          </Text>
        </Stack>
        <TextInput
          placeholder="Фильтр по текущей странице..."
          leftSection={<IconSearch size={16} />}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          size="md"
          radius="xl"
          style={{ width: 320, maxWidth: '100%' }}
        />
      </Group>

      <Card
        withBorder
        padding={0}
        radius="lg"
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 400,
          minWidth: 0,
          overflow: 'hidden',
        }}
      >
        {isLoading ? (
          <Stack p="md" gap="sm" style={{ flex: 1 }}>
            {[...Array(10)].map((_, i) => (
              <Skeleton key={i} height={40} radius="md" />
            ))}
          </Stack>
        ) : (
          <ScrollArea style={{ flex: 1 }} h={620} offsetScrollbars scrollbarSize={8}>
            <Table
              withRowBorders
              horizontalSpacing={0}
              verticalSpacing={0}
              stickyHeader
              highlightOnHover
              // fixed + colgroup гарантируют, что шапка и тело не разъедутся по ширине
              style={{ width: tableWidth, minWidth: '100%', tableLayout: 'fixed' }}
            >
              <colgroup>
                <col style={{ width: ROWNUM_WIDTH }} />
                {displayHeaders.map((h, i) => (
                  <col key={`col-${h}-${i}`} style={{ width: COL_WIDTH }} />
                ))}
              </colgroup>

              <Table.Thead bg="var(--mantine-color-default-hover)" style={{ borderBottom: BORDER }}>
                <Table.Tr>
                  <Table.Th
                    p={12}
                    fz="xs"
                    fw={700}
                    c="dimmed"
                    tt="uppercase"
                    style={{
                      position: 'sticky',
                      left: 0,
                      zIndex: 3,
                      background: 'var(--mantine-color-gray-1)',
                      borderRight: BORDER,
                      letterSpacing: '0.05em',
                    }}
                  >
                    #
                  </Table.Th>
                  {displayHeaders.map((h, i) => (
                    <Table.Th
                      key={`${h}-${i}`}
                      p={12}
                      fz="xs"
                      fw={700}
                      c="dimmed"
                      tt="uppercase"
                      title={h}
                      style={{
                        borderRight: i < displayHeaders.length - 1 ? BORDER : undefined,
                        letterSpacing: '0.05em',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {h}
                    </Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>{rowsContent}</Table.Tbody>
            </Table>
          </ScrollArea>
        )}

        {meta && onPageChange && totalPages > 1 && (
          <Group justify="space-between" wrap="wrap" gap="sm" p="md" style={{ borderTop: BORDER }}>
            <Text size="xs" c="dimmed" fw={500}>
              Страница {meta.page} из {totalPages} · всего {meta.total.toLocaleString('ru-RU')} строк
            </Text>
            <Pagination
              value={meta.page}
              onChange={onPageChange}
              total={totalPages}
              siblings={1}
              boundaries={1}
              size="md"
              radius="md"
            />
          </Group>
        )}
      </Card>
    </Stack>
  );
}
