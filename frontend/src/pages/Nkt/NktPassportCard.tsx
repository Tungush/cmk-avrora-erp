import React, { useEffect, useMemo, useState } from 'react';
import {
  Button, Card, Group, Select, Skeleton, Stack, Text, TextInput, Textarea, Tooltip,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft, IconCheck, IconExternalLink, IconRefresh, IconSend, IconX,
} from '@tabler/icons-react';
import { useNktAction, useNktCard, useNktLog, useSaveNktPassport, useValidateNkt } from '../../hooks/useNkt';
import { NKT_STATUS, nktApi, type NktIssue, type NktPassport, type NktSchemaAttr } from '../../api/nkt';
import { formatDateTime } from '../../utils/formatters';

/** Коды атрибутов НКТ, которым на карточке соответствует отдельная колонка */
const COLUMN_CODES = ['name_ru', 'name_kk', 'brand', 'tnved', 'gtin'] as const;
type ColumnCode = (typeof COLUMN_CODES)[number];
const COLUMN_FIELD: Record<ColumnCode, keyof NktPassport> = {
  name_ru: 'nameRu', name_kk: 'nameKk', brand: 'brand', tnved: 'tnved', gtin: 'gtin',
};

const GROUP_TITLE: Record<NktSchemaAttr['group'], string> = {
  BASE: 'Базовые характеристики',
  MAIN_EXT: 'Основные расширенные — без них не пройти модерацию',
  ADDITIONAL_EXT: 'Дополнительные характеристики категории',
};

/** Поле-справочник: значения приходят из кэша, выгруженного из самого НКТ */
function DictField({
  attr, value, onChange, error,
}: { attr: NktSchemaAttr; value: string; onChange: (v: string) => void; error?: string }) {
  const { data } = useQuery({
    queryKey: ['nkt', 'dict', attr.dictionaryCode],
    queryFn: () => nktApi.dictionary(attr.dictionaryCode).then((r) => r.data.data),
    enabled: !!attr.dictionaryCode,
    staleTime: 5 * 60_000,
  });
  const options = (data ?? []).map((o) => ({ value: o.value, label: `${o.label} · ${o.value}` }));
  return (
    <Select
      label={attr.nameRu}
      description={attr.descriptionRu || undefined}
      withAsterisk={attr.isRequired}
      data={options}
      value={value || null}
      onChange={(v) => onChange(v ?? '')}
      searchable
      clearable
      nothingFoundMessage={options.length ? 'Ничего не найдено' : 'Справочник ещё не выгружен из НКТ'}
      error={error}
      size="sm"
    />
  );
}

function Field({
  attr, value, onChange, error,
}: { attr: NktSchemaAttr; value: string; onChange: (v: string) => void; error?: string }) {
  const common = {
    label: attr.nameRu,
    description: attr.descriptionRu || undefined,
    withAsterisk: attr.isRequired,
    error,
    size: 'sm' as const,
  };
  if (attr.dataType === 'dictionary' || attr.dataType === 'multiDictionary') {
    return <DictField attr={attr} value={value} onChange={onChange} error={error} />;
  }
  if (attr.dataType === 'boolean') {
    return (
      <Select
        {...common}
        data={[{ value: 'true', label: 'Да' }, { value: 'false', label: 'Нет' }]}
        value={value || null}
        onChange={(v) => onChange(v ?? '')}
        clearable
      />
    );
  }
  if (attr.dataType === 'text') {
    return <Textarea {...common} autosize minRows={2} maxRows={5} value={value} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <TextInput
      {...common}
      type={attr.dataType === 'date' ? 'date' : 'text'}
      inputMode={attr.dataType === 'number' ? 'decimal' : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * Карточка изделия в НКТ — второй слой раздела: паспорт слева, положение
 * заявки и разбор справа.
 *
 * Паспорт заводится здесь, а не тянется из 1С: габариты, ГОСТы и вес
 * упаковки изделия ЦМК знает конструктор, и в 1С этих данных нет.
 * Форма рисуется по схеме, выгруженной из самого НКТ, — состав полей
 * задаёт каталог и меняет его без нас.
 */
export function NktPassportCard({ articleId, onBack }: { articleId: string; onBack: () => void }) {
  const { data, isLoading } = useNktCard(articleId);
  const save = useSaveNktPassport(articleId);
  const validate = useValidateNkt(articleId);
  const actions = useNktAction(articleId);
  const { data: log } = useNktLog(articleId);

  const [draft, setDraft] = useState<NktPassport | null>(null);
  const [issues, setIssues] = useState<NktIssue[] | null>(null);
  const [chosenNtin, setChosenNtin] = useState<string | null>(null);

  const card = data?.card;
  const schema = data?.schema ?? [];

  // Черновик подхватывает то, что вернул сервер: штрихкод он нормализует
  // по GS1, и в поле должно оказаться приведённое значение, а не введённое
  useEffect(() => {
    if (!card) return;
    setDraft({
      oktru: card.oktru, tnved: card.tnved, gtin: card.gtin,
      nameRu: card.nameRu, nameKk: card.nameKk, brand: card.brand,
      attributes: { ...card.attributes }, images: card.images ?? [],
    });
  }, [card?.id, card?.updatedAt]);

  // Список незаполненного сбрасывается только при переходе к ДРУГОМУ
  // изделию. Если сбрасывать его по updatedAt, проверка гаснет в тот же
  // миг, когда сохранение перечитывает карточку, — человек жмёт
  // «Сохранить и проверить» и не видит ответа
  useEffect(() => { setIssues(null); }, [card?.id]);

  const issueByCode = useMemo(() => {
    const m: Record<string, string> = {};
    (issues ?? []).forEach((i) => { m[i.code] = i.message; });
    return m;
  }, [issues]);

  if (isLoading || !card || !draft) {
    return <Card withBorder radius="lg" padding="lg"><Skeleton height={320} /></Card>;
  }

  const st = NKT_STATUS[card.status];
  const readOnly = card.status === 'HAS_NTIN';

  const valueOf = (code: string): string => {
    if ((COLUMN_CODES as readonly string[]).includes(code)) {
      return (draft[COLUMN_FIELD[code as ColumnCode]] as string) ?? '';
    }
    return draft.attributes[code] ?? '';
  };
  const setValue = (code: string, v: string) => {
    setDraft((d) => {
      if (!d) return d;
      if ((COLUMN_CODES as readonly string[]).includes(code)) {
        return { ...d, [COLUMN_FIELD[code as ColumnCode]]: v };
      }
      return { ...d, attributes: { ...d.attributes, [code]: v } };
    });
  };

  const groups: NktSchemaAttr['group'][] = ['BASE', 'MAIN_EXT', 'ADDITIONAL_EXT'];
  const hasGtinField = schema.some((a) => a.code === 'gtin');

  const onSave = async () => {
    await save.mutateAsync(draft);
    const res = await validate.mutateAsync();
    setIssues(res.issues);
    notifications.show({
      title: 'Паспорт сохранён',
      message: res.ok ? 'Все обязательные характеристики заполнены' : `Осталось незаполненного: ${res.issues.length}`,
      color: res.ok ? 'success' : 'warning',
    });
  };

  return (
    <div className="nkt-card">
      <Group justify="space-between" align="center" className="nkt-card__head" wrap="nowrap">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <Button variant="subtle" size="compact-sm" leftSection={<IconArrowLeft aria-hidden size={16} />} onClick={onBack}>
            К реестру
          </Button>
          <Text className="nkt-card__code" ff="var(--ff-num)">{card.articleCode}</Text>
          <Text fw={600} truncate>{card.articleName}</Text>
        </Group>
        <Group gap="xs" wrap="nowrap">
          <span className="nkt__state" data-hue={st.hue}>{st.label}</span>
          <Text size="sm" c="dimmed">{st.hint}</Text>
        </Group>
      </Group>

      <div className="nkt-card__body">
        {/* --- Паспорт --- */}
        <Card withBorder radius="lg" padding="md" className="nkt-card__pane">
          <Stack gap="sm" className="nkt-card__form">
            <Group gap="sm" grow align="flex-start">
              <TextInput
                label="Код категории ОКТРУ" withAsterisk size="sm"
                description="определяет набор обязательных характеристик"
                value={draft.oktru}
                onChange={(e) => setDraft({ ...draft, oktru: e.target.value })}
                error={issueByCode.oktru}
                disabled={readOnly}
              />
              {!hasGtinField && (
                <TextInput
                  label="Штрихкод GTIN" size="sm"
                  description={draft.gtin && !card.gtinValid ? 'контрольная сумма не сходится' : 'у изделий ЦМК обычно отсутствует'}
                  value={draft.gtin}
                  onChange={(e) => setDraft({ ...draft, gtin: e.target.value })}
                  disabled={readOnly}
                />
              )}
            </Group>

            {schema.length === 0 ? (
              <Text size="sm" c="dimmed">
                Схема характеристик не выгружена из НКТ. Задайте код ОКТРУ и запустите синхронизацию
                схемы — состав полей задаёт сам каталог.
              </Text>
            ) : groups.map((g) => {
              const attrs = schema.filter((a) => a.group === g);
              if (attrs.length === 0) return null;
              return (
                <Stack key={g} gap={8}>
                  <Text size="sm" fw={700} className="nkt-card__group">{GROUP_TITLE[g]}</Text>
                  <div className="nkt-card__grid">
                    {attrs.map((a) => (
                      <Field
                        key={a.code} attr={a}
                        value={valueOf(a.code)}
                        onChange={(v) => setValue(a.code, v)}
                        error={issueByCode[a.code]}
                      />
                    ))}
                  </div>
                </Stack>
              );
            })}
          </Stack>

          {/* Кнопки не уезжают вместе с формой: паспорт длиннее экрана, и
              «Сохранить» на дне прокрутки человек находит не сразу */}
          {!readOnly && (
            <Group gap="sm" className="nkt-card__actions">
              <Button size="sm" loading={save.isPending || validate.isPending} onClick={onSave}>
                Сохранить и проверить
              </Button>
              <Tooltip label="Изделие встанет в очередь: заявку соберёт и подаст фоновое задание" withArrow>
                <Button
                  size="sm" variant="light" leftSection={<IconSend aria-hidden size={16} />}
                  loading={actions.submit.isPending}
                  onClick={() => actions.submit.mutate()}
                >
                  Подать заявку
                </Button>
              </Tooltip>
              {(card.status === 'REWORK' || card.status === 'REJECTED') && card.requestId && (
                <Button
                  size="sm" variant="light" leftSection={<IconRefresh aria-hidden size={16} />}
                  loading={actions.resubmit.isPending}
                  onClick={() => actions.resubmit.mutate()}
                >
                  Отправить повторно
                </Button>
              )}
              {card.requestId && (
                <Button
                  size="sm" variant="subtle" color="danger" leftSection={<IconX aria-hidden size={16} />}
                  loading={actions.cancel.isPending}
                  onClick={() => actions.cancel.mutate()}
                >
                  Отозвать заявку
                </Button>
              )}
            </Group>
          )}
        </Card>

        {/* --- Состояние и разбор --- */}
        <Stack gap={12} className="nkt-card__side">
          {card.status === 'HAS_NTIN' && (
            <Card withBorder radius="lg" padding="md" className="nkt-card__ntin">
              <Text size="sm" c="dimmed">NTIN</Text>
              <Text className="nkt-card__ntinValue" ff="var(--ff-num)">{card.ntin}</Text>
              <Text size="sm" c="dimmed">
                {card.ntinSource === 'MANUAL' ? 'выбрана существующая карточка' : 'опубликована наша заявка'}
                {card.publishedAt ? ` · ${formatDateTime(card.publishedAt)}` : ''}
              </Text>
              {card.productUrl && (
                <Button
                  component="a" href={card.productUrl} target="_blank" rel="noreferrer"
                  size="compact-sm" variant="subtle" mt={6}
                  rightSection={<IconExternalLink aria-hidden size={14} />}
                >
                  Карточка в каталоге
                </Button>
              )}
            </Card>
          )}

          {(issues?.length ?? 0) > 0 && (
            <Card withBorder radius="lg" padding="md">
              <Text size="sm" fw={700} mb={6}>Чего не хватает для подачи</Text>
              <Stack gap={4}>
                {issues!.map((i) => (
                  <Text key={i.code} size="sm">
                    <b>{i.name || i.code}</b> — {i.message}
                  </Text>
                ))}
              </Stack>
            </Card>
          )}

          {card.duplicates && card.duplicates.length > 0 && (
            <Card withBorder radius="lg" padding="md">
              <Text size="sm" fw={700}>НКТ нашёл похожие карточки</Text>
              <Text size="sm" c="dimmed" mb={8}>
                Решение принимает человек: одинаково названные товары разных производителей — разные
                карточки, а чужой NTIN даёт ошибку при пробитии чека и маркировке.
              </Text>
              <Stack gap={6}>
                {card.duplicates.map((d) => (
                  <button
                    key={d.ntin} type="button" className="nkt-dup"
                    data-active={chosenNtin === d.ntin ? 'true' : undefined}
                    onClick={() => setChosenNtin(d.ntin)}
                  >
                    <span className="nkt-dup__name">{d.name}</span>
                    <span className="nkt-dup__meta">
                      {d.brand || '—'} · {d.gtin || 'без GTIN'} · {d.ntin}
                    </span>
                    <span className="nkt-dup__sim">{Math.round(d.similarity)} %</span>
                  </button>
                ))}
              </Stack>
              <Group gap="sm" mt="sm">
                <Button
                  size="sm" leftSection={<IconCheck aria-hidden size={16} />}
                  disabled={!chosenNtin} loading={actions.decide.isPending}
                  onClick={() => actions.decide.mutate({ decision: 'USE_EXISTING', ntin: chosenNtin! })}
                >
                  Это тот же товар
                </Button>
                <Button
                  size="sm" variant="light" loading={actions.decide.isPending}
                  onClick={() => actions.decide.mutate({ decision: 'CONTINUE' })}
                >
                  Другой товар — подать свою
                </Button>
              </Group>
            </Card>
          )}

          {(card.moderatorComment || (card.revisionDetails?.length ?? 0) > 0) && (
            <Card withBorder radius="lg" padding="md">
              <Text size="sm" fw={700} mb={6}>Замечания модератора</Text>
              {card.moderatorComment && (
                <Text size="sm" style={{ whiteSpace: 'pre-line' }}>{card.moderatorComment}</Text>
              )}
              {card.revisionDetails?.map((r) => (
                <Text key={r.attributeCode} size="sm" mt={6}>
                  <b>{r.attributeCode}</b> — {r.comment}
                </Text>
              ))}
            </Card>
          )}

          {card.lastError && card.status !== 'HAS_NTIN' && (
            <Card withBorder radius="lg" padding="md">
              <Text size="sm" fw={700} mb={4}>Последняя ошибка</Text>
              <Text size="sm" style={{ whiteSpace: 'pre-line' }}>{card.lastError}</Text>
            </Card>
          )}

          <Card withBorder radius="lg" padding="md" className="nkt-card__log">
            <Text size="sm" fw={700} mb={6}>Журнал обмена</Text>
            {(log?.length ?? 0) === 0 ? (
              <Text size="sm" c="dimmed">Обменов по изделию ещё не было</Text>
            ) : (
              <Stack gap={4}>
                {log!.slice(0, 12).map((e) => (
                  <Group key={e.id} gap={8} wrap="nowrap" justify="space-between">
                    <Text size="sm" truncate title={e.url}>{e.method}</Text>
                    <Group gap={8} wrap="nowrap">
                      <Text size="sm" ff="var(--ff-num)" c={e.httpCode >= 400 ? 'danger' : 'dimmed'}>
                        {e.httpCode || '—'}
                      </Text>
                      <Text size="sm" c="dimmed" ff="var(--ff-num)">{formatDateTime(e.createdAt)}</Text>
                    </Group>
                  </Group>
                ))}
              </Stack>
            )}
          </Card>
        </Stack>
      </div>
    </div>
  );
}
