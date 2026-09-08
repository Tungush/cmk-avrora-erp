import React, { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button, Card, Group, Modal, Stack, Table, Text, TextInput, ThemeIcon,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconCheck, IconFileSpreadsheet, IconUpload } from '@tabler/icons-react';
import api from '../../api/client';
import { apiErrorMessage } from '../../api/errors';
import { formatCurrency } from '../../utils/formatters';

interface ImportedLine {
  sheetName: string; contractNumber: string; name: string;
  limitAmount: number; usedAmount: number;
  tranches: number; scheduleRows: number; payments: number; created?: boolean;
}
interface ImportResult {
  file: string; lines: ImportedLine[]; skipped: string[] | null;
  paymentSheet?: string; applied: boolean;
}

/**
 * Загрузка выгрузки банка прямо в разделе (07.09.2026, просьба владельца:
 * «пользователь должен импортировать таблицу, а сервис — сам её разобрать»).
 *
 * Два шага намеренно: сначала разбор без записи, человек видит, что нашлось
 * в файле, и только потом соглашается. Файл банка приходит руками из личного
 * кабинета, ошибиться листом или версией легко, а лимиты и график —
 * это деньги.
 */
export function DamuImport() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('ДАМУ');
  const [preview, setPreview] = useState<ImportResult | null>(null);

  const send = (f: File, apply: boolean) => {
    const body = new FormData();
    body.append('file', f);
    body.append('name', name.trim() || 'ДАМУ');
    if (apply) body.append('apply', 'true');
    return api.post<ImportResult>('/credit-lines/import', body).then((r) => r.data);
  };

  const check = useMutation({
    mutationFn: (f: File) => send(f, false),
    onSuccess: (res) => setPreview(res),
    onError: (e) => notifications.show({
      title: 'Файл не разобран',
      message: apiErrorMessage(e),
      color: 'danger',
      icon: <IconAlertTriangle aria-hidden size={16} />,
    }),
  });

  const apply = useMutation({
    mutationFn: () => send(file!, true),
    onSuccess: (res) => {
      setPreview(null);
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      qc.invalidateQueries({ queryKey: ['credit-lines'] });
      const rows = res.lines.reduce((s, l) => s + l.scheduleRows, 0);
      notifications.show({
        title: 'Выгрузка загружена',
        message: `Линий ${res.lines.length}, плановых платежей ${rows}`,
        color: 'success',
        icon: <IconCheck aria-hidden size={16} />,
      });
    },
    onError: (e) => notifications.show({
      title: 'Не загружено',
      message: apiErrorMessage(e),
      color: 'danger',
      icon: <IconAlertTriangle aria-hidden size={16} />,
    }),
  });

  const pick = (f: File | null) => {
    setFile(f);
    if (f) check.mutate(f);
  };

  return (
    <>
      <Card withBorder radius="md" padding="md">
        <Group justify="space-between" wrap="wrap" gap="sm">
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon variant="light" color="gray" radius="md" size="lg">
              <IconFileSpreadsheet aria-hidden size={18} />
            </ThemeIcon>
            <Stack gap={2}>
              <Text fw={700} size="sm">Выгрузка из личного кабинета банка</Text>
              <Text size="xs" c="dimmed">
                Файл Excel с листами «график …» и «Лист1». Сервис разберёт его сам и покажет,
                что нашлось, до записи.
              </Text>
            </Stack>
          </Group>

          <Group gap="sm" wrap="nowrap">
            <TextInput
              size="sm"
              w={200}
              label={undefined}
              aria-label="Как называть линию"
              placeholder="Название, напр. ДАМУ 6% А77"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              style={{ display: 'none' }}
              onChange={(e) => pick(e.currentTarget.files?.[0] ?? null)}
            />
            <Button
              size="sm"
              leftSection={<IconUpload aria-hidden size={16} />}
              loading={check.isPending}
              onClick={() => fileRef.current?.click()}
            >
              Выбрать файл
            </Button>
          </Group>
        </Group>
      </Card>

      <Modal
        opened={preview !== null}
        onClose={() => { setPreview(null); setFile(null); if (fileRef.current) fileRef.current.value = ''; }}
        title="Что нашлось в файле"
        size="lg"
        radius="md"
      >
        {preview && (
          <Stack gap="md">
            <Text size="sm" c="dimmed">{preview.file}</Text>

            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Лист</Table.Th>
                  <Table.Th>Договор</Table.Th>
                  <Table.Th ta="right">Лимит</Table.Th>
                  <Table.Th ta="right">Траншей</Table.Th>
                  <Table.Th ta="right">План</Table.Th>
                  <Table.Th ta="right">Факт</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {preview.lines.map((l) => (
                  <Table.Tr key={l.contractNumber + l.sheetName}>
                    <Table.Td><Text size="sm">{l.sheetName}</Text></Table.Td>
                    <Table.Td><Text size="sm" ff="monospace">{l.contractNumber}</Text></Table.Td>
                    <Table.Td ta="right" ff="monospace">{formatCurrency(l.limitAmount)}</Table.Td>
                    <Table.Td ta="right" ff="monospace">{l.tranches}</Table.Td>
                    <Table.Td ta="right" ff="monospace">{l.scheduleRows}</Table.Td>
                    <Table.Td ta="right" ff="monospace">{l.payments}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>

            {preview.skipped && preview.skipped.length > 0 && (
              <Text size="sm" c="dimmed">
                Пропущены листы без лимита или номера договора: {preview.skipped.join(', ')}
              </Text>
            )}

            <Text size="sm" c="dimmed">
              Повторная загрузка того же файла ничего не задваивает: линия находится по номеру
              договора, лимит и остаток перезаписываются снимком на сегодня.
            </Text>

            <Group justify="flex-end" gap="sm">
              <Button variant="default" onClick={() => { setPreview(null); setFile(null); }}>
                Отмена
              </Button>
              <Button loading={apply.isPending} onClick={() => apply.mutate()}>
                Загрузить в базу
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}
