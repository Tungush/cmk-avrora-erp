import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconClipboardList, IconUserQuestion, IconChecks, IconCoin } from '@tabler/icons-react';
import api from '../../api/client';
import { contractorRequestsApi } from '../../api/contractorRequests';
import { DigestCard, DigestGrid } from '../../components/Digest';
import { formatMoney, formatDate } from '../../utils/formatters';

/**
 * Сводка подряда (02.09.2026) — раздел открывается деньгами, которые
 * уходят наружу, а не двумя реестрами.
 *
 * Подряд — единственное место, где завод платит живыми деньгами за чужую
 * работу, и главный риск здесь двойной счёт: партия ушла в Битрикс, а по
 * заказам её не разнесли. Раньше эту цифру приходилось складывать глазами
 * по списку заявок; теперь она первая на экране.
 */

const num = (n: number) => Number(n || 0).toLocaleString('ru-RU');

export function ContractorDigest({ onGoTab }: { onGoTab: (tab: string) => void }) {
  const requests = useQuery({
    queryKey: ['contractor-requests', null, null],
    queryFn: () => contractorRequestsApi.list({}),
    refetchInterval: 60_000,
  });
  const work = useQuery({
    queryKey: ['contractor-work-all', null, false],
    queryFn: () => api.get<any>('/contractor-work').then((r) => r.data),
    refetchInterval: 60_000,
  });

  const rows: any[] = (requests.data as any)?.data ?? [];
  const unallocated = (requests.data as any)?.unallocated ?? { requests: 0, amount: 0 };
  const needAlloc = rows.filter((r) => r.needsAllocation);
  const noContractor = rows.filter((r) => !r.contractor);

  const workRows: any[] = (work.data as any)?.data ?? [];
  const byContractor: any[] = (work.data as any)?.byContractor ?? [];
  const pendingAccept = workRows.filter((r) => !r.isAccepted);
  const pendingAmount = pendingAccept.reduce((s, r) => s + Number(r.amount ?? 0), 0);
  const maxAlloc = Math.max(1, ...needAlloc.map((r) => Number(r.totalAmount ?? r.estimatedAmount ?? 0)));
  const maxContractor = Math.max(1, ...byContractor.map((c) => Number(c.amount ?? 0)));

  return (
    <DigestGrid>
      <DigestCard
        title="Не разнесено по заказам"
        tone={unallocated.requests > 0 ? 'danger' : 'ok'}
        icon={<IconClipboardList size={19} />}
        value={Number(unallocated.requests) || 0}
        caption={unallocated.requests > 0
          ? `заявок на ${formatMoney(unallocated.amount)} ₸ висят партией — себестоимость заказов занижена`
          : 'все заявки разнесены по заказам'}
        loading={requests.isLoading}
        items={needAlloc.slice(0, 4).map((r) => ({
          id: r.id,
          label: `${r.number} · ${r.contractor?.name ?? 'подрядчик не выбран'}`,
          value: `${formatMoney(r.totalAmount ?? r.estimatedAmount ?? 0)} ₸`,
          sub: `${r.stageLabel} · принято ${r.acceptedAt ? formatDate(r.acceptedAt) : '—'}`
            + (r.daysSinceAccepted != null ? ` · ${r.daysSinceAccepted} дн назад` : ''),
          share: Number(r.totalAmount ?? r.estimatedAmount ?? 0) / maxAlloc,
        }))}
        emptyText="Разносить нечего"
        action={{ label: 'Разнести', onClick: () => onGoTab('requests') }}
      />

      <DigestCard
        title="Без подрядчика"
        tone={noContractor.length > 0 ? 'warn' : 'ok'}
        icon={<IconUserQuestion size={19} />}
        value={noContractor.length}
        caption={noContractor.length > 0
          ? 'заявок заведено, но исполнитель не выбран — в Битрикс их не отправить'
          : 'у всех заявок есть исполнитель'}
        loading={requests.isLoading}
        items={noContractor.slice(0, 4).map((r) => ({
          id: r.id,
          label: `${r.number} · ${r.stageLabel}`,
          value: r.plannedQty != null ? `${num(r.plannedQty)} ${r.unit}` : '—',
          sub: `создана ${formatDate(r.createdAt)}`,
        }))}
        emptyText="Исполнители назначены"
        action={{ label: 'Заявки', onClick: () => onGoTab('requests') }}
      />

      <DigestCard
        title="Ждут приёмки"
        tone={pendingAccept.length > 0 ? 'warn' : 'ok'}
        icon={<IconChecks size={19} />}
        value={pendingAccept.length}
        caption={pendingAccept.length > 0
          ? `строк на ${formatMoney(pendingAmount)} ₸ — пока не приняты, платить не за что`
          : 'вся работа принята'}
        loading={work.isLoading}
        items={pendingAccept.slice(0, 4).map((r) => ({
          id: r.id,
          label: `${r.order?.orderNumber ?? '—'} · ${r.contractor?.name ?? '—'}`,
          value: r.amount != null ? `${formatMoney(r.amount)} ₸` : '—',
          sub: `${r.routingStage} · ${r.workLocation === 'OUR_SHOP' ? 'у нас в цехе' : 'на площадке подрядчика'}`,
        }))}
        emptyText="Непринятой работы нет"
        action={{ label: 'Разнесено по заказам', onClick: () => onGoTab('allocated') }}
      />

      <DigestCard
        title="Отдано на сторону"
        tone="brand"
        icon={<IconCoin size={19} />}
        value={byContractor.reduce((sum, c) => sum + Number(c.amount ?? 0), 0)}
        format={(v) => `${formatMoney(v)} ₸`}
        caption={`по ${num(byContractor.length)} подрядчикам`}
        loading={work.isLoading}
        items={[...byContractor]
          .sort((a, b) => Number(b.amount ?? 0) - Number(a.amount ?? 0))
          .slice(0, 4)
          .map((c) => ({
            id: c.id,
            label: c.name,
            value: `${formatMoney(c.amount)} ₸`,
            sub: `принято ${num(c.accepted)} · открыто ${num(c.open)}`,
            share: Number(c.amount ?? 0) / maxContractor,
          }))}
        emptyText="Подряда пока нет"
        action={{ label: 'Все работы', onClick: () => onGoTab('allocated') }}
      />
    </DigestGrid>
  );
}
