import React, { createContext, useCallback, useContext, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Drawer, Group, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useOrderCard } from './OrderCard/OrderCardProvider';

/**
 * Сквозная связанность сервиса (03.09.2026).
 *
 * Владелец: «хочу, чтобы по всему сервису все объекты были взаимосвязаны;
 * при нажатии на каждый объект чтобы он открывался отдельно; всё должно
 * быть кликабельно».
 *
 * До этого кликабельным был только номер заказа. Артикул изделия, код
 * материала, имя заказчика, площадка, поставщик, подрядчик были мёртвым
 * текстом: увидел «Металлобаза Астана» в закупе — и дальше идёшь искать
 * её руками через поиск.
 *
 * Теперь любая сущность — <Ref kind="material" id={...} label={...} />,
 * а карточка открывается ШТОРКОЙ поверх текущего экрана. Уходить с
 * раздела нельзя: мастер не должен терять очередь, а закупщик — реестр.
 * Состояние живёт в адресе (?ent=material:abc123), поэтому ссылку можно
 * переслать, а «назад» закрывает карточку.
 *
 * Заказ остаётся на своём провайдере (OrderCardProvider): у него давно
 * своя шторка с фокусом на раздел карточки — здесь он просто
 * перенаправляется туда, чтобы у номера заказа было одно поведение.
 */

export type EntityKind =
  | 'order'
  | 'article'
  | 'material'
  | 'customer'
  | 'site'
  | 'supplier'
  | 'contractor';

export interface EntityTarget {
  kind: EntityKind;
  id: string;
  /** Человеческое имя — показать в шапке, пока данные грузятся */
  label?: string;
}

interface EntityApi {
  open: (t: EntityTarget) => void;
  close: () => void;
  opened: EntityTarget | null;
}

const Ctx = createContext<EntityApi | null>(null);

const PARAM = 'ent';

/** Заголовок шторки по виду сущности */
const KIND_TITLE: Record<EntityKind, string> = {
  order: 'Заказ',
  article: 'Изделие',
  material: 'Материал',
  customer: 'Заказчик',
  site: 'Объект',
  supplier: 'Поставщик',
  contractor: 'Подрядчик',
};

export function EntityProvider({ children }: { children: React.ReactNode }) {
  const [params, setParams] = useSearchParams();
  const isMobile = useMediaQuery('(max-width: 767px)');
  const { open: openOrder } = useOrderCard();

  const raw = params.get(PARAM);
  const opened = useMemo<EntityTarget | null>(() => {
    if (!raw) return null;
    const i = raw.indexOf(':');
    if (i < 0) return null;
    const kind = raw.slice(0, i) as EntityKind;
    const id = raw.slice(i + 1);
    if (!id || !(kind in KIND_TITLE)) return null;
    return { kind, id };
  }, [raw]);

  const open = useCallback((t: EntityTarget) => {
    // У заказа своя давняя шторка с фокусом на раздел — не плодим вторую
    if (t.kind === 'order') { openOrder(t.id); return; }
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set(PARAM, `${t.kind}:${t.id}`);
      if (t.label) next.set('entName', t.label); else next.delete('entName');
      return next;
    });
  }, [setParams, openOrder]);

  const close = useCallback(() => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete(PARAM);
      next.delete('entName');
      return next;
    }, { replace: true });
  }, [setParams]);

  const api = useMemo<EntityApi>(() => ({ open, close, opened }), [open, close, opened]);
  const label = params.get('entName');

  return (
    <Ctx.Provider value={api}>
      {children}
      <Drawer
        opened={opened !== null}
        onClose={close}
        position="right"
        size={isMobile ? '100%' : 'lg'}
        padding="md"
        keepMounted={false}
        title={
          opened && (
            <Group gap={10} wrap="nowrap" style={{ minWidth: 0 }}>
              <Text size="xs" fw={700} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.08em' }}>
                {KIND_TITLE[opened.kind]}
              </Text>
              {label && <Text fw={600} lineClamp={1}>{label}</Text>}
            </Group>
          )
        }
      >
        {opened && <EntityBody target={opened} fallbackLabel={label} />}
      </Drawer>
    </Ctx.Provider>
  );
}

/**
 * Тело шторки грузится по требованию: панели сущностей тяжёлые (состав,
 * нормы, движения склада), и держать их в бандле главного экрана незачем.
 */
const Panels = React.lazy(() => import('./entity/EntityPanels'));

function EntityBody({ target, fallbackLabel }: { target: EntityTarget; fallbackLabel: string | null }) {
  return (
    <React.Suspense fallback={<div style={{ padding: 24, color: 'var(--ref-muted)' }}>Загружаем…</div>}>
      <Panels target={target} fallbackLabel={fallbackLabel} />
    </React.Suspense>
  );
}

export function useEntity(): EntityApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useEntity вызван вне EntityProvider — провайдер стоит в Layout');
  return ctx;
}

/**
 * Кликабельная ссылка на сущность. Ставится ВЕЗДЕ, где раньше был мёртвый
 * текст: код изделия, код материала, имя заказчика, площадка, поставщик.
 *
 * `tone="code"` — для артикулов и кодов (моноширинный, цвет акцента),
 * `tone="text"` — для имён (обычный текст, подчёркивание пунктиром).
 */
export function Ref({
  kind, id, label, children, tone = 'text', size = 'sm', bold, title, onOpen,
}: {
  kind: EntityKind;
  id: string | null | undefined;
  /** Имя для шапки шторки; если не задано — берётся из children-текста */
  label?: string;
  children: React.ReactNode;
  tone?: 'code' | 'text';
  size?: string;
  bold?: boolean;
  title?: string;
  onOpen?: () => void;
}) {
  const { open } = useEntity();
  // Без id ссылка невозможна — показываем тот же текст, но не обещаем клик
  if (!id) return <Text span size={size} c={tone === 'code' ? 'brand.7' : undefined}>{children}</Text>;

  const text = label ?? (typeof children === 'string' ? children : undefined);
  return (
    <Text
      component="button"
      type="button"
      title={title ?? text}
      className={`ent-ref ent-ref--${tone}`}
      size={size}
      fw={(bold ?? tone === 'code') ? 700 : 500}
      ff={tone === 'code' ? 'var(--ff-num)' : undefined}
      onClick={(e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        onOpen?.();
        open({ kind, id, label: text });
      }}
    >
      {children}
    </Text>
  );
}
