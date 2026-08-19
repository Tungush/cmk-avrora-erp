import React from 'react';
import { Table, Stack, Text, ThemeIcon, ScrollArea, Paper } from '@mantine/core';
import { IconInbox } from '@tabler/icons-react';

interface Column<T> {
  key: string;
  header: string;
  render?: (item: T) => React.ReactNode;
}

interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  keyExtractor: (item: T) => string;
  onRowClick?: (item: T) => void;
  emptyMessage?: string;
}

export function DataTable<T>({
  data,
  columns,
  keyExtractor,
  onRowClick,
  emptyMessage = 'Нет данных для отображения',
}: DataTableProps<T>) {
  return (
    <Paper withBorder radius="md" style={{ overflow: 'hidden' }}>
      <ScrollArea offsetScrollbars scrollbarSize={8}>
        <Table
          highlightOnHover={!!onRowClick}
          horizontalSpacing="md"
          verticalSpacing="sm"
          style={{ minWidth: columns.length * 160 }}
        >
        <Table.Thead bg="var(--mantine-color-default-hover)">
          <Table.Tr>
            {columns.map((col) => (
              <Table.Th
                key={col.key}
                fz="xs"
                fw={700}
                tt="uppercase"
                c="dimmed"
                style={{ letterSpacing: '0.06em' }}
              >
                {col.header}
              </Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {data.length === 0 ? (
            <Table.Tr>
              <Table.Td colSpan={columns.length} p={48}>
                <Stack align="center" gap="md">
                  <ThemeIcon variant="light" color="gray" size={56} radius="lg">
                    <IconInbox size={28} stroke={1.5} />
                  </ThemeIcon>
                  <Text size="sm" c="dimmed" fw={500}>
                    {emptyMessage}
                  </Text>
                </Stack>
              </Table.Td>
            </Table.Tr>
          ) : (
            data.map((item) => (
              <Table.Tr
                key={keyExtractor(item)}
                onClick={() => onRowClick?.(item)}
                style={onRowClick ? { cursor: 'pointer' } : undefined}
              >
                {columns.map((col) => (
                  <Table.Td key={col.key} fz="sm" fw={500}>
                    {col.render ? col.render(item) : ((item as Record<string, unknown>)[col.key] as React.ReactNode)}
                  </Table.Td>
                ))}
              </Table.Tr>
            ))
          )}
        </Table.Tbody>
      </Table>
      </ScrollArea>
    </Paper>
  );
}
