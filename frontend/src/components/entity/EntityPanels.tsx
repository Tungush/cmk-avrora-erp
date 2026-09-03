import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Stack, Group, Text, Skeleton, Divider, Badge } from '@mantine/core';
import { useNavigate } from 'react-router-dom';
import api from '../../api/client';
import { formatDate, formatMoney, formatCompactMoney } from '../../utils/formatters';
import { Ref, useEntity, type EntityTarget } from '../EntityRef';
import { Mast } from '../Mast';

/**
 * Карточки сущностей для сквозной связанности (03.09.2026).
 *
 * Одна панель на вид сущности. Правило у всех одно: сверху — числа, ради
 * которых человек сюда кликнул, ниже — СВЯЗИ, и каждая связь тоже
 * кликабельна. Из материала видно, в каких изделиях он стоит; из изделия —
 * в каких заказах; из заказчика — его заказы и долг. Тупиков быть не должно.
 *
 * Панели грузятся лениво (React.lazy в EntityRef): они тянут за собой
 * запросы состава, норм и движений склада, которые главному экрану не нужны.
 */

const num = (n: unknown, d = 2) =>
  Number(n ?? 0).toLocaleString('ru-RU', { maximumFractionDigits: d });

/** Строка «показатель — значение» в шапке карточки */
function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="ent-stat">
      <div className="ent-stat__label">{label}</div>
      <div className="ent-stat__value" style={tone ? { color: tone } : undefined}>{value}</div>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <Stack gap={6}>
      <Group gap={8} align="baseline">
        <Text size="xs" fw={700} tt="uppercase" c="dimmed" style={{ letterSpacing: '0.07em' }}>
          {title}
        </Text>
        {count != null && <Text size="xs" c="dimmed" ff="var(--ff-num)">{count}</Text>}
      </Group>
      {children}
    </Stack>
  );
}

function Empty({ text }: { text: string }) {
  return <Text size="sm" c="dimmed" py={6}>{text}</Text>;
}

/** Строка связи: слева кликабельное имя, справа число */
function LinkRow({
  kind, id, label, sub, value,
}: {
  kind: Parameters<typeof Ref>[0]['kind'];
  id: string | null | undefined;
  label: string;
  sub?: string;
  value?: React.ReactNode;
}) {
  return (
    <div className="ent-row">
      <div style={{ minWidth: 0 }}>
        <Ref kind={kind} id={id} label={label} tone="text" size="sm">{label}</Ref>
        {sub && <div className="ent-row__sub">{sub}</div>}
      </div>
      {value != null && <div className="ent-row__value">{value}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- Изделие */

function ArticlePanel({ id }: { id: string }) {
  const article = useQuery({
    queryKey: ['articles', id],
    queryFn: () => api.get<any>(`/articles/${id}`).then((r) => r.data),
  });
  const bom = useQuery({
    queryKey: ['bom', id],
    queryFn: () => api.get<any[]>(`/articles/${id}/bom`).then((r) => r.data),
  });
  const costing = useQuery({
    queryKey: ['routing-costing', id],
    queryFn: () => api.get<any>(`/articles/${id}/routing/costing`).then((r) => r.data),
  });
  const usage = useQuery({
    queryKey: ['routing-usage', id],
    queryFn: () => api.get<any>(`/articles/${id}/routing/usage`).then((r) => r.data),
  });

  if (article.isLoading) return <Skeleton height={320} radius="md" />;
  const a = article.data ?? {};
  const items: any[] = Array.isArray(bom.data) ? bom.data : [];
  const res = costing.data?.result;

  return (
    <Stack gap="lg">
      <Group gap={10} wrap="nowrap" align="baseline">
        <Text ff="var(--ff-num)" fw={700} size="lg">{a.articleCode}</Text>
        <Text size="md" style={{ minWidth: 0 }}>{a.name}</Text>
      </Group>

      <div className="ent-stats">
        <Stat label="Себестоимость" value={res ? formatMoney(res.totalCost) : '—'} />
        <Stat label="Утверждённая цена" value={Number(a.approvedPrice) > 0 ? formatMoney(Number(a.approvedPrice)) : 'нет'} />
        <Stat label="Материалов в составе" value={items.length} />
        <Stat label="Трудоёмкость" value={res ? `${num(res.totalManHours, 3)} ч` : '—'} />
      </div>

      <Section title="Состав изделия" count={items.length}>
        {items.length === 0 ? (
          <Empty text="Состав не заведён — себестоимость материалов нулевая" />
        ) : (
          <div className="ent-list">
            {items.slice(0, 12).map((b) => (
              <LinkRow
                key={b.id}
                kind="material"
                id={b.materialId}
                label={`${b.material?.materialCode ?? '—'} · ${b.material?.name ?? ''}`}
                sub={`${num(b.qtyPerUnit, 4)} ${b.material?.unit ?? ''} на единицу`}
                value={formatMoney(Number(b.lineCost))}
              />
            ))}
            {items.length > 12 && <Text size="xs" c="dimmed">и ещё {items.length - 12}</Text>}
          </div>
        )}
      </Section>

      <Section title="Где применяется" count={usage.data?.ordersCount}>
        {!usage.data || usage.data.ordersCount === 0 ? (
          <Empty text="Изделие не встречается в активных заказах" />
        ) : (
          <div className="ent-list">
            {(usage.data.orders ?? []).slice(0, 8).map((o: any) => (
              <LinkRow
                key={o.orderId}
                kind="order"
                id={o.orderId}
                label={o.orderNumber}
                sub={`${o.customer ?? '—'} · вывоз ${formatDate(o.plannedShipmentDate)}`}
                value={`${num(o.qty, 0)} шт`}
              />
            ))}
          </div>
        )}
      </Section>
    </Stack>
  );
}

/* -------------------------------------------------------------- Материал */

function MaterialPanel({ id }: { id: string }) {
  const material = useQuery({
    queryKey: ['materials', id],
    queryFn: () => api.get<any>(`/materials/${id}`).then((r) => r.data),
  });
  const movements = useQuery({
    queryKey: ['material-movements', id],
    queryFn: () => api.get<any>(`/warehouse/materials/${id}/movements`).then((r) => r.data),
  });

  if (material.isLoading) return <Skeleton height={320} radius="md" />;
  const m = material.data ?? {};
  const moves: any[] = Array.isArray(movements.data) ? movements.data : (movements.data?.data ?? []);

  return (
    <Stack gap="lg">
      <Group gap={10} wrap="nowrap" align="baseline">
        <Text ff="var(--ff-num)" fw={700} size="lg">{m.materialCode}</Text>
        <Text size="md" style={{ minWidth: 0 }}>{m.name}</Text>
      </Group>

      <div className="ent-stats">
        <Stat label="Остаток" value={`${num(m.stockQty, 3)} ${m.unit ?? ''}`} />
        <Stat label="Учётная цена" value={formatMoney(Number(m.purchasePrice))} />
        <Stat
          label="Последний закуп"
          value={Number(m.lastPurchasePrice) > 0 ? formatMoney(Number(m.lastPurchasePrice)) : '—'}
        />
        <Stat label="Обновлена" value={formatDate(m.purchasePriceUpdatedAt) || '—'} />
      </div>

      <Section title="Движения склада" count={moves.length}>
        {moves.length === 0 ? (
          <Empty text="Движений по этому материалу нет" />
        ) : (
          <div className="ent-list">
            {moves.slice(0, 10).map((mv: any, i: number) => (
              <div className="ent-row" key={mv.id ?? i}>
                <div style={{ minWidth: 0 }}>
                  <Text size="sm">{mv.supplierName || mv.comment || mv.movementType || 'движение'}</Text>
                  <div className="ent-row__sub">
                    {formatDate(mv.movementDate)}
                    {mv.documentNumber ? ` · ${mv.documentNumber}` : ''}
                  </div>
                </div>
                <div className="ent-row__value">
                  {num(mv.qty, 3)} {m.unit ?? ''}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </Stack>
  );
}

/* -------------------------------------------------------------- Заказчик */

function CustomerPanel({ id, name }: { id: string; name: string | null }) {
  const debts = useQuery({
    queryKey: ['customer-debts'],
    queryFn: () => api.get<any>('/payment-documents/customer-debts').then((r) => r.data),
  });
  const orders = useQuery({
    queryKey: ['orders', { search: name, pageSize: 12 }],
    enabled: !!name,
    queryFn: () => api.get<any>('/orders', { params: { search: name, pageSize: 12 } }).then((r) => r.data),
  });

  const row = (debts.data?.customers ?? []).find((c: any) => c.customerId === id || c.customerName === name);
  const list: any[] = orders.data?.data ?? [];

  return (
    <Stack gap="lg">
      <Text size="lg" fw={600}>{name ?? 'Заказчик'}</Text>

      <div className="ent-stats">
        <Stat label="Должен нам" value={row ? formatCompactMoney(row.debt) : '—'}
          tone={row && row.debt > 0 ? 'var(--c-danger-ink)' : undefined} />
        <Stat label="Законтрактовано" value={row ? formatCompactMoney(row.contracted) : '—'} />
        <Stat label="Оплачено" value={row ? formatCompactMoney(row.paid) : '—'} />
        <Stat label="Заказов" value={row?.orders ?? list.length} />
      </div>

      <Section title="Заказы" count={orders.data?.meta?.total}>
        {list.length === 0 ? (
          <Empty text="Заказов не найдено" />
        ) : (
          <div className="ent-list">
            {list.map((o: any) => (
              <LinkRow
                key={o.id}
                kind="order"
                id={o.id}
                label={o.orderNumber}
                sub={`вывоз ${formatDate(o.plannedShipmentDate)}${o.overdueDays > 0 ? ` · просрочка ${o.overdueDays} дн` : ''}`}
                value={o.onecTotalAmount ? formatCompactMoney(Number(o.onecTotalAmount)) : undefined}
              />
            ))}
          </div>
        )}
      </Section>
    </Stack>
  );
}

/* ---------------------------------------------------------------- Объект */

function SitePanel({ id }: { id: string }) {
  const sites = useQuery({
    queryKey: ['order-sites'],
    queryFn: () => api.get<any>('/orders/sites').then((r) => r.data),
  });
  const orders = useQuery({
    queryKey: ['orders', { search: id, pageSize: 12 }],
    queryFn: () => api.get<any>('/orders', { params: { search: id, pageSize: 12 } }).then((r) => r.data),
  });

  const s = (sites.data?.data ?? []).find((x: any) => x.site === id);
  const list: any[] = orders.data?.data ?? [];
  const progress = s && s.linesCount > 0 ? s.doneLines / s.linesCount : 0;

  return (
    <Stack gap="lg">
      <Group gap="md" wrap="nowrap" align="center">
        <Mast height={92} sections={6} progress={progress} stroke={1.6} />
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Text size="lg" fw={600}>{(id || '').replace(/^KZ-/, '').replace(/_/g, ' · ')}</Text>
          <Text size="sm" c="dimmed">{s?.customerName ?? ''}</Text>
        </Stack>
      </Group>

      <div className="ent-stats">
        <Stat label="Изготовлено" value={s ? `${s.doneLines} / ${s.linesCount}` : '—'} />
        <Stat label="Заказов" value={s?.ordersCount ?? '—'} />
        <Stat label="Сумма" value={s ? formatCompactMoney(Number(s.amount)) : '—'} />
        <Stat
          label="Просрочка"
          value={s && s.maxOverdueDays > 0 ? `${s.maxOverdueDays} дн` : 'нет'}
          tone={s && s.maxOverdueDays > 0 ? 'var(--c-danger-ink)' : undefined}
        />
      </div>

      <Section title="Заказы площадки" count={orders.data?.meta?.total}>
        {list.length === 0 ? (
          <Empty text="Заказов по площадке не найдено" />
        ) : (
          <div className="ent-list">
            {list.map((o: any) => (
              <LinkRow
                key={o.id}
                kind="order"
                id={o.id}
                label={o.orderNumber}
                sub={`${o.customer?.name ?? '—'} · вывоз ${formatDate(o.plannedShipmentDate)}`}
              />
            ))}
          </div>
        )}
      </Section>
    </Stack>
  );
}

/* ------------------------------------------------------------ Поставщик */

function SupplierPanel({ id, name }: { id: string; name: string | null }) {
  const dash = useQuery({
    queryKey: ['purchases-dashboard'],
    queryFn: () => api.get<any>('/purchases/dashboard').then((r) => r.data),
  });
  const s = (dash.data?.suppliers ?? []).find((x: any) => x.id === id || x.name === name);
  const docs = (dash.data?.unpaidDocs ?? []).filter((d: any) => d.supplierId === id || d.supplier === name);

  return (
    <Stack gap="lg">
      <Text size="lg" fw={600}>{name ?? s?.name ?? 'Поставщик'}</Text>

      <div className="ent-stats">
        <Stat label="Мы должны" value={s ? formatCompactMoney(s.unpaid) : '—'}
          tone={s && s.unpaid > 0 ? 'var(--c-danger-ink)' : undefined} />
        <Stat label="Закуплено" value={s ? formatCompactMoney(s.total) : '—'} />
        <Stat label="Документов" value={s?.docs ?? '—'} />
        <Stat label="Последний" value={s ? formatDate(s.lastDate) : '—'} />
      </div>

      <Section title="Неоплаченные документы" count={docs.length}>
        {docs.length === 0 ? (
          <Empty text="Неоплаченных документов нет" />
        ) : (
          <div className="ent-list">
            {docs.slice(0, 10).map((d: any) => (
              <div className="ent-row" key={d.id}>
                <div style={{ minWidth: 0 }}>
                  <Text size="sm" ff="var(--ff-num)">{d.doNumber}</Text>
                  <div className="ent-row__sub">{d.ageDays} дн с {formatDate(d.doDate)}</div>
                </div>
                <div className="ent-row__value">{formatMoney(d.unpaidAmount, d.currency)}</div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </Stack>
  );
}

/* ------------------------------------------------------------ Подрядчик */

function ContractorPanel({ id, name }: { id: string; name: string | null }) {
  const work = useQuery({
    queryKey: ['contractor-work-all', id, false],
    queryFn: () => api.get<any>('/contractor-work', { params: { contractorId: id } }).then((r) => r.data),
  });
  const rows: any[] = work.data?.data ?? [];
  const stat = (work.data?.byContractor ?? []).find((c: any) => c.id === id);

  return (
    <Stack gap="lg">
      <Text size="lg" fw={600}>{name ?? stat?.name ?? 'Подрядчик'}</Text>

      <div className="ent-stats">
        <Stat label="Отдано на сторону" value={stat ? formatCompactMoney(stat.amount) : '—'} />
        <Stat label="Принято" value={stat?.accepted ?? '—'} />
        <Stat label="Открыто" value={stat?.open ?? '—'} />
        <Stat label="Строк" value={rows.length} />
      </div>

      <Section title="Работы по заказам" count={rows.length}>
        {rows.length === 0 ? (
          <Empty text="Работ не найдено" />
        ) : (
          <div className="ent-list">
            {rows.slice(0, 12).map((r: any) => (
              <LinkRow
                key={r.id}
                kind="order"
                id={r.order?.id}
                label={r.order?.orderNumber ?? '—'}
                sub={`${r.routingStage} · ${r.isAccepted ? 'принято' : 'ждёт приёмки'}`}
                value={r.amount != null ? formatMoney(Number(r.amount)) : undefined}
              />
            ))}
          </div>
        )}
      </Section>
    </Stack>
  );
}

/* ------------------------------------------------------------------------ */

export default function EntityPanels({
  target, fallbackLabel,
}: {
  target: EntityTarget;
  fallbackLabel: string | null;
}) {
  switch (target.kind) {
    case 'article': return <ArticlePanel id={target.id} />;
    case 'material': return <MaterialPanel id={target.id} />;
    case 'customer': return <CustomerPanel id={target.id} name={fallbackLabel} />;
    case 'site': return <SitePanel id={target.id} />;
    case 'supplier': return <SupplierPanel id={target.id} name={fallbackLabel} />;
    case 'contractor': return <ContractorPanel id={target.id} name={fallbackLabel} />;
    default: return <Empty text="Карточка этого вида пока не собрана" />;
  }
}
