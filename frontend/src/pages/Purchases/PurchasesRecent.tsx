import React from 'react';
import { Card, Table, Text, Badge, Skeleton, Group } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { purchasesApi } from '../../api/purchases';
import { ReceiptRef } from '../../components/ReceiptCard/ReceiptCardProvider';
import { Ref } from '../../components/EntityRef';
import { formatMoney, formatDate } from '../../utils/formatters';
import { useFitHeight } from '../../components/FitScreen';
import { MastLoader } from '../../components/Mast';

const STATUS_LABELS: Record<string, string> = {
  UNPAID: 'Не оплачен', PARTIALLY_PAID: 'Частично', PAID: 'Оплачен', EXECUTED: 'Исполнен',
};
const STATUS_COLORS: Record<string, string> = {
  UNPAID: 'danger', PARTIALLY_PAID: 'warn', PAID: 'ok', EXECUTED: 'ok',
};

/**
 * Выписка последних заказов поставщику под сводкой (04.09.2026).
 *
 * Раздел заканчивался четырьмя карточками, и ниже оставалось 322 px
 * пустоты — 36 % экрана. В эталоне второй ряд занимает реестр, и это
 * правильно: снабженец, увидев «должны 462 млн», следующим движением
 * хочет посмотреть по каким документам.
 *
 * Полный реестр сюда не ставится намеренно: он тащит панель фильтров
 * (поиск, направление, два переключателя, счётчики) высотой около 90 px,
 * и на строки не осталось бы ничего. Здесь выписка без фильтров, а
 * полный реестр — по ссылке в заголовке.
 *
 * Строк ровно столько, сколько влезло: высота меряется, а не задаётся
 * числом.
 */
export function PurchasesRecent({ onGoRegistry }: { onGoRegistry: () => void }) {
  const fit = useFitHeight(8, 120);

  const { data, isLoading } = useQuery({
    queryKey: ['purchases-docs', 'recent'],
    queryFn: () => purchasesApi.documents({ page: 1, pageSize: 30 }).then((r) => r.data),
  });

  const rows = data?.data ?? [];
  const total = data?.meta?.total ?? 0;

  return (
    <Card withBorder={false} radius="lg" padding={0} className="recent-card">
      <div className="recent-card__head">
        <Text component="h2" fw={700} fz={15} style={{ margin: 0, letterSpacing: '-0.01em' }}>
          Последние заказы поставщику
        </Text>
        <button type="button" className="recent-card__more" onClick={onGoRegistry}>
          Все {total ? total.toLocaleString('ru-RU') : ''} <IconArrowRight aria-hidden size={14} />
        </button>
      </div>

      <div
        ref={fit.ref as any}
        className="recent-card__scroll"
        style={{ maxHeight: fit.height }}
      >
        {isLoading ? (
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {[...Array(5)].map((_, i) => <Skeleton key={i} height={34} radius="sm" />)}
          </div>
        ) : rows.length === 0 ? (
          <MastLoader height={110} sections={3} title="Заказов поставщику нет" />
        ) : (
          <Table highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>№ ДО</Table.Th>
                <Table.Th>Дата</Table.Th>
                <Table.Th>Поставщик</Table.Th>
                <Table.Th ta="right">Сумма</Table.Th>
                <Table.Th ta="right">Остаток</Table.Th>
                <Table.Th>Статус</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((d: any) => (
                <Table.Tr key={d.id}>
                  <Table.Td><ReceiptRef id={d.id} number={d.doNumber} size="sm" /></Table.Td>
                  <Table.Td ff="monospace" style={{ whiteSpace: 'nowrap' }}>{formatDate(d.doDate)}</Table.Td>
                  <Table.Td>
                    <Text size="sm" lineClamp={1}>
                      <Ref kind="supplier" id={d.supplierId ?? d.supplier} label={d.supplier} tone="text" size="sm">
                        {d.supplier}
                      </Ref>
                    </Text>
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace" fw={600} style={{ whiteSpace: 'nowrap' }}>
                    {formatMoney(d.totalAmount, d.currency)}
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace" c={d.unpaidAmount > 0 ? 'danger.7' : undefined}
                    style={{ whiteSpace: 'nowrap' }}>
                    {d.unpaidAmount > 0 ? formatMoney(d.unpaidAmount, d.currency) : '—'}
                  </Table.Td>
                  <Table.Td>
                    <Badge variant="light" color={STATUS_COLORS[d.status] ?? 'gray'}>
                      {STATUS_LABELS[d.status] ?? d.status}
                    </Badge>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </div>
    </Card>
  );
}
