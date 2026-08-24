import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Modal, TextInput, Stack, Group, Text, Badge, Loader, Box, Kbd, UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue, useHotkeys } from '@mantine/hooks';
import { IconSearch, IconPackage, IconRuler2, IconBox } from '@tabler/icons-react';
import api from '../api/client';
import { useOrderCard } from './OrderCard/OrderCardProvider';
import { StatusBadge } from './StatusBadge';

interface SearchResult {
  query: string;
  orders: Array<{ id: string; orderNumber: string; subtitle: string; status: string; isArchived: boolean }>;
  articles: Array<{ id: string; articleCode: string; name: string; isActive: boolean }>;
  materials: Array<{ id: string; materialCode: string; name: string; unit: string; viaAlias: string | null }>;
}

/**
 * Общий поиск (решение 23.08.2026).
 *
 * Второй вход в карточку заказа и единственный, работающий там, где номер
 * заказа не нарисован. Заказ ищется по номеру, номеру 1С, заказчику,
 * конечному заказчику и объекту; материал — ещё и по алиасам, то есть
 * по словам, которыми его называют в цеху.
 */
export function GlobalSearch({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [debounced] = useDebouncedValue(q, 250);
  const { open: openOrder } = useOrderCard();
  const navigate = useNavigate();

  useEffect(() => { if (opened) setQ(''); }, [opened]);

  const { data, isFetching } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api.get<SearchResult>('/search', { params: { q: debounced } }).then((r) => r.data),
    enabled: opened && debounced.trim().length >= 2,
  });

  const pickOrder = (id: string) => { onClose(); openOrder(id); };
  const goto = (path: string) => { onClose(); navigate(path); };

  const nothing = data
    && data.orders.length === 0 && data.articles.length === 0 && data.materials.length === 0;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      withCloseButton={false}
      size="lg"
      padding={0}
      radius="md"
      yOffset="12vh"
    >
      <Box p="sm" style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
        <TextInput
          placeholder="Номер заказа, заказчик, объект, материал…"
          leftSection={isFetching ? <Loader size={16} /> : <IconSearch size={16} />}
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          variant="unstyled"
          size="md"
          autoFocus
        />
      </Box>

      <Stack gap={0} p="xs" mah="60vh" style={{ overflowY: 'auto' }}>
        {q.trim().length < 2 && (
          <Text size="sm" c="dimmed" ta="center" py="lg">
            Введите хотя бы два символа. Заказ ищется и по заказчику, и по объекту,
            материал — по тем словам, которыми его называют в цеху
          </Text>
        )}

        {nothing && (
          <Text size="sm" c="dimmed" ta="center" py="lg">Ничего не нашлось</Text>
        )}

        {data && data.orders.length > 0 && (
          <>
            <Text size="xs" fw={700} c="dimmed" tt="uppercase" px="xs" py={6}>Заказы</Text>
            {data.orders.map((o) => (
              <UnstyledButton key={o.id} onClick={() => pickOrder(o.id)} p="xs"
                style={{ borderRadius: 8 }}
                className="search-row"
              >
                <Group justify="space-between" wrap="nowrap">
                  <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                    <IconPackage size={16} style={{ flexShrink: 0, color: 'var(--mantine-color-dimmed)' }} />
                    <Box style={{ minWidth: 0 }}>
                      <Group gap={6} wrap="nowrap">
                        <Text size="sm" fw={700} ff="monospace" c="brand.7">{o.orderNumber}</Text>
                        {o.isArchived && (
                          <Badge size="xs" color="gray" variant="light">архив</Badge>
                        )}
                      </Group>
                      <Text size="xs" c="dimmed" lineClamp={1}>{o.subtitle || '—'}</Text>
                    </Box>
                  </Group>
                  <StatusBadge status={o.status} />
                </Group>
              </UnstyledButton>
            ))}
          </>
        )}

        {data && data.articles.length > 0 && (
          <>
            <Text size="xs" fw={700} c="dimmed" tt="uppercase" px="xs" py={6} mt={4}>Изделия</Text>
            {data.articles.map((a) => (
              <UnstyledButton key={a.id} onClick={() => goto('/specs')} p="xs"
                style={{ borderRadius: 8 }} className="search-row">
                <Group gap="sm" wrap="nowrap">
                  <IconRuler2 size={16} style={{ flexShrink: 0, color: 'var(--mantine-color-dimmed)' }} />
                  <Box style={{ minWidth: 0 }}>
                    <Text size="sm" ff="monospace">{a.articleCode}</Text>
                    <Text size="xs" c="dimmed" lineClamp={1}>{a.name}</Text>
                  </Box>
                </Group>
              </UnstyledButton>
            ))}
          </>
        )}

        {data && data.materials.length > 0 && (
          <>
            <Text size="xs" fw={700} c="dimmed" tt="uppercase" px="xs" py={6} mt={4}>Материалы</Text>
            {data.materials.map((m) => (
              <UnstyledButton key={m.id} onClick={() => goto('/warehouse')} p="xs"
                style={{ borderRadius: 8 }} className="search-row">
                <Group gap="sm" wrap="nowrap">
                  <IconBox size={16} style={{ flexShrink: 0, color: 'var(--mantine-color-dimmed)' }} />
                  <Box style={{ minWidth: 0 }}>
                    <Text size="sm" ff="monospace">{m.materialCode}</Text>
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      {m.name}
                      {m.viaAlias && (
                        <Text span c="brand.7"> · найдено по «{m.viaAlias}»</Text>
                      )}
                    </Text>
                  </Box>
                </Group>
              </UnstyledButton>
            ))}
          </>
        )}
      </Stack>

      <Group gap="xs" p="xs" justify="center"
        style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
        <Text size="xs" c="dimmed">Открыть поиск</Text>
        <Kbd size="xs">⌘</Kbd><Kbd size="xs">K</Kbd>
      </Group>
    </Modal>
  );
}

/** Горячая клавиша живёт отдельно, чтобы работать на любом экране */
export function useGlobalSearchHotkey(open: () => void) {
  useHotkeys([['mod+K', open], ['/', open]]);
}
