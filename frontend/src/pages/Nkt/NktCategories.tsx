import React, { useState } from 'react';
import { Button, Card, Group, Skeleton, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconDeviceFloppy, IconRefresh } from '@tabler/icons-react';
import { useNktCategories, useNktStatus, useSaveNktCategory, useSyncNktSchema } from '../../hooks/useNkt';
import { formatDate } from '../../utils/formatters';

/**
 * Соответствие «вид изделия → категория ОКТРУ» — то, без чего заявку
 * собрать невозможно: код категории задаёт набор обязательных
 * характеристик, и НКТ отдаёт его только по ОКТРУ.
 *
 * Вид — префикс артикула до дефиса. Колонка articles.series для этого не
 * годится: на 05.09.2026 она пуста у всех изделий, хотя префикс исправно
 * присваивается заявкой на номенклатуру.
 *
 * Заполнять начинают с самых массовых видов: закрыть n и z — это 1 897
 * изделий из 2 152.
 */
export function NktCategories() {
  const { data, isLoading } = useNktCategories();
  const { data: status } = useNktStatus();
  const saveCategory = useSaveNktCategory();
  const syncSchema = useSyncNktSchema();
  const [edits, setEdits] = useState<Record<string, { oktru: string; oktruName: string; tnvedDefault: string }>>({});

  const rowOf = (prefix: string, base: { oktru: string; oktruName: string; tnvedDefault: string }) =>
    edits[prefix] ?? base;

  const patch = (prefix: string, base: { oktru: string; oktruName: string; tnvedDefault: string }, p: Partial<typeof base>) =>
    setEdits((e) => ({ ...e, [prefix]: { ...rowOf(prefix, base), ...p } }));

  const onSave = async (prefix: string, v: { oktru: string; oktruName: string; tnvedDefault: string }) => {
    await saveCategory.mutateAsync({ prefix, ...v, isActive: true });
    setEdits((e) => { const n = { ...e }; delete n[prefix]; return n; });
    notifications.show({ title: 'Категория сохранена', message: `Вид «${prefix}» → ОКТРУ ${v.oktru}`, color: 'success' });
  };

  return (
    <div className="nkt">
      <Group justify="space-between" align="center" className="nkt__bar" wrap="wrap">
        <Text size="sm" c="dimmed" style={{ maxWidth: 640 }}>
          Код ОКТРУ задаёт набор обязательных характеристик заявки. Пока он не назначен виду,
          изделия этого вида остаются без паспорта и в НКТ не уходят.
        </Text>
        <Group gap="sm">
          <Text size="sm" c="dimmed">
            {status?.configured
              ? `Схема: ${status.attributes} характеристик, ${status.dictionaryValues} значений справочников${status.schemaSyncedAt ? ` · ${status.schemaSyncedAt}` : ''}`
              : 'Ключ НКТ не задан — схему выгрузить нечем'}
          </Text>
          <Button
            size="sm" variant="light" leftSection={<IconRefresh aria-hidden size={16} />}
            disabled={!status?.configured} loading={syncSchema.isPending}
            onClick={() => syncSchema.mutate(undefined, {
              onSuccess: () => notifications.show({ title: 'Схема обновлена', message: 'Характеристики и справочники выгружены из НКТ', color: 'success' }),
            })}
          >
            Обновить схему из НКТ
          </Button>
        </Group>
      </Group>

      <Card withBorder radius="lg" padding={0} className="nkt__card">
        <div className="nkt__wrap nkt__wrap--scroll">
          <table className="dense nkt__table">
            <thead>
              <tr>
                <th style={{ width: 90 }}>Вид</th>
                <th style={{ width: 90 }} className="num">Изделий</th>
                <th style={{ width: 170 }}>Код ОКТРУ</th>
                <th>Наименование категории</th>
                <th style={{ width: 170 }}>ТН ВЭД по умолчанию</th>
                <th style={{ width: 130 }} />
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                [...Array(6)].map((_, i) => <tr key={i}><td colSpan={6}><Skeleton height={16} radius="sm" /></td></tr>)
              ) : (data ?? []).map((c) => {
                const base = { oktru: c.oktru, oktruName: c.oktruName, tnvedDefault: c.tnvedDefault };
                const v = rowOf(c.codePrefix, base);
                const dirty = !!edits[c.codePrefix];
                return (
                  <tr key={c.codePrefix}>
                    <td className="num nkt__code" style={{ textAlign: 'left' }}>{c.codePrefix}</td>
                    <td className="num">{c.articles.toLocaleString('ru-RU')}</td>
                    <td>
                      <TextInput
                        size="xs" variant="unstyled" placeholder="например 25.99.29"
                        value={v.oktru} onChange={(e) => patch(c.codePrefix, base, { oktru: e.target.value })}
                      />
                    </td>
                    <td>
                      <TextInput
                        size="xs" variant="unstyled" placeholder="для контроля глазами"
                        value={v.oktruName} onChange={(e) => patch(c.codePrefix, base, { oktruName: e.target.value })}
                      />
                    </td>
                    <td>
                      <TextInput
                        size="xs" variant="unstyled" placeholder="необязательно"
                        value={v.tnvedDefault} onChange={(e) => patch(c.codePrefix, base, { tnvedDefault: e.target.value })}
                      />
                    </td>
                    <td>
                      {dirty && (
                        <Button
                          size="compact-xs" leftSection={<IconDeviceFloppy aria-hidden size={14} />}
                          disabled={!v.oktru.trim()} loading={saveCategory.isPending}
                          onClick={() => onSave(c.codePrefix, v)}
                        >
                          Сохранить
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
