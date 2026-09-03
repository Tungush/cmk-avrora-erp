import React, { useEffect, useRef } from 'react';
import { Badge, Box, Card, Group, Skeleton, Stack, Text, TextInput } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { PaginationBar } from '../../components/PaginationBar';
import { FadeSwap } from '../../components/motion';
import type { Article } from '../../types';
import classes from './ArticleList.module.css';

/**
 * Высота строки списка, px. Страница больше не фиксирована числом:
 * сколько строк влезло в окно — столько и просим с сервера (02.09.2026).
 */
export const ARTICLE_ROW_H = 46;

/** Бейдж в строке списка: lg — это 13 px (меньше в системе не бывает), высота под строку */
const rowBadge = { size: 'lg', h: 22, px: 8, radius: 'xl', variant: 'light' } as const;

function ArticleRow({
  article: a, active, onSelect,
}: {
  article: Article;
  active: boolean;
  onSelect: (article: Article) => void;
}) {
  const noBom = !a.isMaterialResale && !a.bomItems?.length;
  return (
    <Box
      role="button"
      tabIndex={0}
      className={classes.row}
      data-active={active ? 'true' : undefined}
      onClick={() => onSelect(a)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(a); }
      }}
      px="sm"
      py={5}
      style={{ height: ARTICLE_ROW_H }}
    >
      <Group gap={8} wrap="nowrap" justify="space-between">
        <Text size="sm" ff="var(--ff-num)" c="var(--ref-coral-ink)" fw={700} style={{ whiteSpace: 'nowrap' }}>
          {a.articleCode}
        </Text>
        {a.isMaterialResale ? (
          <Badge {...rowBadge} color="gray">сырьё</Badge>
        ) : (
          noBom && <Badge {...rowBadge} color="warning">нет состава</Badge>
        )}
      </Group>
      <Text size="sm" lineClamp={1}>{a.name}</Text>
    </Box>
  );
}

interface ArticleListPaneProps {
  articles: Article[];
  loading: boolean;
  /** meta.total с сервера; undefined пока страница грузится */
  total?: number;
  page: number;
  onPageChange: (page: number) => void;
  search: string;
  onSearchChange: (value: string) => void;
  activeId: string | null;
  onSelect: (article: Article) => void;
  /** true — панели в столбик (< 1200 px): список ограничен по высоте и не прилипает */
  stacked: boolean;
  /** Сколько строк влезло в окно — столько и пришло с сервера */
  pageSize: number;
  /** Замеряемая область: по её высоте и считается pageSize */
  listRef?: React.Ref<HTMLDivElement>;
}

/**
 * Левая панель «Изделия»: поиск, 30 карточек на страницу с сервера и
 * компактная пагинация. Раньше было «Показано 30 из 2152» и кнопка
 * «ещё 100» — список рос до тысяч строк. Теперь страницы; выбранная
 * строка подсвечена и подъезжает в видимую область.
 */
export function ArticleListPane({
  articles, loading, total, page, onPageChange, search, onSearchChange, activeId, onSelect,
  stacked, pageSize, listRef: measureRef,
}: ArticleListPaneProps) {
  const listRef = useRef<HTMLDivElement>(null);
  // Пока грузится следующая страница, счётчик «из N» не должен мигать в «Нет изделий»
  const lastTotal = useRef(0);
  if (total != null) lastTotal.current = total;
  const shownTotal = total ?? lastTotal.current;

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeId, articles]);

  return (
    <Card
      withBorder
      radius="md"
      padding="sm"
      style={{
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      <TextInput
        placeholder="Поиск артикула..."
        leftSection={<IconSearch aria-hidden size={16} />}
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        mb="sm"
      />

      {/* Прокрутки нет: строк ровно столько, сколько поместилось */}
      <Box
        ref={measureRef}
        style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}
      >
        <div ref={listRef} style={{ height: '100%' }}>
        <FadeSwap swapKey={`${page}|${search}`}>
          <Stack gap={4}>
            {loading
              ? [...Array(Math.max(4, pageSize))].map((_, i) => <Skeleton key={i} height={ARTICLE_ROW_H - 4} radius="sm" />)
              : articles.map((a) => (
                  <ArticleRow key={a.id} article={a} active={a.id === activeId} onSelect={onSelect} />
                ))}
            {!loading && articles.length === 0 && (
              <Stack gap="xs" py="md" align="center">
                <Text size="sm" c="dimmed" ta="center">Артикула нет в справочнике</Text>
                {/* Заявка на номенклатуру подаётся из карточки сделки —
                    у позиции без артикула (решение 26.08.2026) */}
              </Stack>
            )}
          </Stack>
        </FadeSwap>
        </div>
      </Box>

      <Box mt="xs" pt={4} style={{ borderTop: '1px solid var(--gray-2)' }}>
        <PaginationBar
          page={page}
          total={shownTotal}
          pageSize={pageSize}
          onPageChange={onPageChange}
          variant="compact"
          noun="изделий"
        />
      </Box>
    </Card>
  );
}
