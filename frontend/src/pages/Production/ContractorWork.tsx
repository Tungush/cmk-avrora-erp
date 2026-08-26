import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Card, Stack, Group, Text, Badge, Table, Skeleton, Button, Select, Textarea,
  NumberInput, Modal, ThemeIcon, SimpleGrid, Tooltip, Tabs, Checkbox, Alert,
  ActionIcon, Switch, TextInput,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconTruck, IconCheck, IconAlertTriangle, IconBuildingFactory, IconSend,
  IconPlus, IconChevronDown, IconChevronRight, IconTrash, IconPencil,
  IconClipboardList, IconListDetails, IconUserPlus, IconX, IconFileInvoice,
} from '@tabler/icons-react';
import api from '../../api/client';
import { ordersApi } from '../../api/orders';
import {
  contractorRequestsApi, apiErrorMessage,
  RATE_UNITS, RATE_SUFFIXES, RATE_TYPE_LABELS,
  REQUEST_STATUS_LABELS, REQUEST_STATUS_COLORS,
} from '../../api/contractorRequests';
import type {
  AllocationSummary, RateTypeCode, RoutingStageCode, WorkLocationCode,
} from '../../api/contractorRequests';
import { useAuthStore } from '../../store/auth';
import {
  formatCurrency, formatDate, formatNumber, ROUTING_STAGE_LABELS,
} from '../../utils/formatters';
import { OrderRef } from '../../components/OrderCard/OrderCardProvider';

const STAGE_OPTIONS = (Object.keys(ROUTING_STAGE_LABELS) as RoutingStageCode[])
  .map((value) => ({ value, label: ROUTING_STAGE_LABELS[value] }));

const RATE_TYPE_OPTIONS = (Object.keys(RATE_TYPE_LABELS) as RateTypeCode[])
  .map((value) => ({ value, label: RATE_TYPE_LABELS[value] }));

const STATUS_FILTER_OPTIONS = (Object.keys(REQUEST_STATUS_LABELS) as Array<keyof typeof REQUEST_STATUS_LABELS>)
  .map((value) => ({ value, label: REQUEST_STATUS_LABELS[value] }));

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Короткие подписи для таблицы: полные — в раскрытой строке и в модалках */
const STAGE_SHORT: Record<string, string> = {
  CUTTING: 'Резка', ASSEMBLY: 'Сборка / сварка', PAINTING: 'Покраска',
};

/**
 * Копия splitAmount() бэкенда (common/contractor-requests.ts) — намеренно,
 * а не «примерно так же»: предпросмотр акта обязан показать те же копейки,
 * которые запишутся. Последняя ненулевая доля забирает остаток, иначе три
 * заказа по 1/3 от 1 000 000 ₸ дают 999 999,99 и вечное расхождение с актом.
 */
function splitAmount(total: number, qtys: number[]): number[] {
  const sum = qtys.reduce((s, q) => s + Math.max(0, q), 0);
  if (!(sum > 0)) return qtys.map(() => 0);
  const parts = qtys.map((q) => round2((total * Math.max(0, q)) / sum));
  let lastIdx = -1;
  for (let i = qtys.length - 1; i >= 0; i -= 1) {
    if (qtys[i] > 0) { lastIdx = i; break; }
  }
  if (lastIdx >= 0) {
    const others = parts.reduce((s, p, i) => (i === lastIdx ? s : s + p), 0);
    parts[lastIdx] = round2(total - others);
  }
  return parts;
}

const daysSince = (iso?: string | null): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
};

/** Русский счёт: 1 день, 2 дня, 5 дней — иначе цифра читается как ошибка */
const plural = (n: number, one: string, few: string, many: string): string => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b > 1 && b < 5) return few;
  return many;
};

const daysWord = (n: number): string => plural(n, 'день', 'дня', 'дней');

/**
 * Колонка действий прижата к правому краю: таблица шире экрана, а «Разнести»
 * — то, ради чего на неё и смотрят. Уехать за горизонт эта кнопка не должна.
 */
const stickyActions = (highlighted: boolean): React.CSSProperties => ({
  position: 'sticky',
  right: 0,
  background: highlighted ? 'var(--mantine-color-danger-0)' : 'var(--mantine-color-body)',
  borderLeft: '1px solid var(--mantine-color-gray-2)',
});

/**
 * Повторять запрос имеет смысл после обрыва связи, но не после «нельзя»:
 * 403 со второй попытки не станет 200, а человек всё это время смотрит
 * на скелет вместо ответа.
 */
const retryUnlessDenied = (failureCount: number, e: unknown) => {
  const status = (e as { response?: { status?: number } })?.response?.status;
  if (status === 403 || status === 404) return false;
  return failureCount < 1;
};

/** Пустое поле — это NULL для бэкенда, а не ноль: «ставку ещё не назвали» */
const numOrNull = (v: number | string): number | null => (Number(v) > 0 ? Number(v) : null);

/* ────────────────────────────────────────────────────────────────────────── */
/*  Завести подрядчика                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Подрядчика подобрали в Б24 — записать его надо здесь же, не уходя из
 * заявки: иначе поток упирается в «справочник только на чтение».
 */
function ContractorModal({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [binIin, setBinIin] = useState('');
  const [rateType, setRateType] = useState<RateTypeCode>('PER_UNIT');
  const [rate, setRate] = useState<number | string>('');
  const [atOurShop, setAtOurShop] = useState(false);

  const create = useMutation({
    mutationFn: () => contractorRequestsApi.createContractor({
      name: name.trim(),
      binIin: binIin.trim() || null,
      defaultRateType: rateType,
      defaultRate: numOrNull(rate),
      defaultWorkLocation: atOurShop ? 'OUR_SHOP' : 'CONTRACTOR_SITE',
    }),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['contractors'] });
      notifications.show({
        title: 'Подрядчик заведён',
        message: `«${c.name}» теперь можно ставить в заявки`,
        color: 'success',
        icon: <IconCheck size={16} />,
      });
      onCreated(c.id);
    },
    onError: (e) => notifications.show({
      title: 'Не сохранено',
      message: apiErrorMessage(e, 'Ошибка сохранения подрядчика'),
      color: 'danger',
      icon: <IconAlertTriangle size={16} />,
    }),
  });

  return (
    <Modal opened onClose={onClose} title={<Text fw={700}>Завести подрядчика</Text>} radius="md" centered>
      <Stack gap="md">
        <TextInput
          label="Название"
          placeholder="ТОО «Металлсервис»"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          autoFocus
          required
        />
        <TextInput
          label="БИН / ИИН"
          description="единственная связь с актами 1С — без него сверка по подрядчику не сойдётся"
          placeholder="123456789012"
          value={binIin}
          onChange={(e) => setBinIin(e.currentTarget.value)}
        />
        <Select
          label="Тип ставки по умолчанию"
          data={RATE_TYPE_OPTIONS}
          value={rateType}
          onChange={(v) => setRateType((v as RateTypeCode) ?? 'PER_UNIT')}
          allowDeselect={false}
        />
        <NumberInput
          label={`Ставка по умолчанию, ${RATE_SUFFIXES[rateType]}`}
          value={rate}
          onChange={setRate}
          min={0}
          decimalScale={2}
          thousandSeparator=" "
        />
        <Switch
          label="Обычно работают у нас в цеху"
          description="занимают наши посты и мощность, а не только деньги"
          checked={atOurShop}
          onChange={(e) => setAtOurShop(e.currentTarget.checked)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Отмена</Button>
          <Button
            loading={create.isPending}
            disabled={!name.trim()}
            onClick={() => create.mutate()}
          >
            Завести
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Новая заявка / правка заявки                                              */
/* ────────────────────────────────────────────────────────────────────────── */

function RequestFormModal({ editing, onClose }: {
  editing: AllocationSummary | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();

  // Описание и примечание живут только в карточке — список их не отдаёт
  const { data: detail } = useQuery({
    queryKey: ['contractor-request', editing?.id],
    queryFn: () => contractorRequestsApi.get(editing!.id),
    enabled: Boolean(editing),
  });

  const { data: contractors } = useQuery({
    queryKey: ['contractors'],
    queryFn: () => contractorRequestsApi.contractors(),
  });

  const [stage, setStage] = useState<RoutingStageCode>(editing?.routingStage ?? 'ASSEMBLY');
  const [description, setDescription] = useState('');
  const [note, setNote] = useState('');
  const [rateType, setRateType] = useState<RateTypeCode>(editing?.rateType ?? 'PER_UNIT');
  const [qty, setQty] = useState<number | string>(editing?.plannedQty ?? '');
  const [rate, setRate] = useState<number | string>(editing?.rate ?? '');
  const [estimate, setEstimate] = useState<number | string>(editing?.estimatedAmount ?? '');
  const [contractorId, setContractorId] = useState<string | null>(editing?.contractor?.id ?? null);
  const [atOurShop, setAtOurShop] = useState(editing?.workLocation === 'OUR_SHOP');
  const [hours, setHours] = useState<number | string>(editing?.plannedHours ?? '');
  const [contractorModal, setContractorModal] = useState(false);

  useEffect(() => {
    if (detail) {
      setDescription(detail.description);
      setNote(detail.note ?? '');
    }
  }, [detail]);

  // Сдельная ставка не содержит часов: без оценки labor.ts уронит расчёт
  // всего заказа (SHOP_HOURS_ESTIMATE_REQUIRED) уже на разнесении
  const needsHours = atOurShop && rateType !== 'PER_HOUR';
  const unit = RATE_UNITS[rateType];

  const save = useMutation({
    mutationFn: () => {
      if (editing) {
        return contractorRequestsApi.update(editing.id, {
          description: description.trim(),
          rateType,
          plannedQty: numOrNull(qty),
          rate: numOrNull(rate),
          estimatedAmount: numOrNull(estimate),
          contractorId,
          workLocation: (atOurShop ? 'OUR_SHOP' : 'CONTRACTOR_SITE') as WorkLocationCode,
          plannedHours: needsHours ? numOrNull(hours) : null,
          note: note.trim() || null,
        });
      }
      return contractorRequestsApi.create({
        routingStage: stage,
        description: description.trim(),
        rateType,
        plannedQty: numOrNull(qty),
        rate: numOrNull(rate),
        estimatedAmount: numOrNull(estimate),
        contractorId,
        workLocation: (atOurShop ? 'OUR_SHOP' : 'CONTRACTOR_SITE') as WorkLocationCode,
        plannedHours: needsHours ? numOrNull(hours) : null,
        note: note.trim() || null,
      });
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['contractor-requests'] });
      qc.invalidateQueries({ queryKey: ['contractor-request', r.id] });
      qc.invalidateQueries({ queryKey: ['contractor-request-descriptions'] });
      qc.invalidateQueries({ queryKey: ['contractor-work-all'] });
      notifications.show({
        title: editing ? 'Заявка обновлена' : `Заявка ${r.number} заведена`,
        message: editing
          ? 'Разнесённые строки пересчитаны по новой ставке'
          : 'Отметьте её галочкой и отправьте в Б24 вместе с остальными',
        color: 'success',
        icon: <IconCheck size={16} />,
      });
      onClose();
    },
    onError: (e) => notifications.show({
      title: 'Не сохранено',
      message: apiErrorMessage(e, 'Ошибка сохранения заявки'),
      color: 'danger',
      icon: <IconAlertTriangle size={16} />,
    }),
  });

  const canSave = description.trim().length > 0 && (!needsHours || Number(hours) > 0);

  return (
    <>
      <Modal
        opened
        onClose={onClose}
        title={<Text fw={700}>{editing ? `Заявка ${editing.number}` : 'Новая заявка на подряд'}</Text>}
        radius="md"
        size="lg"
        centered
      >
        <Stack gap="md">
          <Select
            label="Вид работ"
            description="из какого передела вычитать штат при разнесении"
            data={STAGE_OPTIONS}
            value={stage}
            onChange={(v) => setStage((v as RoutingStageCode) ?? 'ASSEMBLY')}
            allowDeselect={false}
            disabled={Boolean(editing)}
          />
          <Textarea
            label="Что за работа"
            description="по этому тексту заявку будут искать в Б24"
            placeholder="Покраска балок Б-1…Б-40, порошок RAL 7024"
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            minRows={2}
            autosize
            required
          />

          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
            <Select
              label="Тип ставки"
              data={RATE_TYPE_OPTIONS}
              value={rateType}
              onChange={(v) => setRateType((v as RateTypeCode) ?? 'PER_UNIT')}
              allowDeselect={false}
            />
            <NumberInput
              label={`Объём партии, ${unit}`}
              description="сколько всего отдаём"
              value={qty}
              onChange={setQty}
              min={0}
              decimalScale={3}
              thousandSeparator=" "
            />
            <NumberInput
              label={`Ставка, ${RATE_SUFFIXES[rateType]}`}
              description="можно оставить пустой — её назовут в Б24"
              value={rate}
              onChange={setRate}
              min={0}
              decimalScale={2}
              thousandSeparator=" "
            />
            <NumberInput
              label="Оценка суммы, ₸"
              description={rateType === 'FIXED' ? 'для фикса это и есть цена партии' : 'для сделки Б24'}
              value={estimate}
              onChange={setEstimate}
              min={0}
              decimalScale={2}
              thousandSeparator=" "
            />
          </SimpleGrid>

          <Group align="flex-end" gap="sm" wrap="nowrap">
            <Select
              label="Подрядчик"
              description="можно оставить пустым — подберут в Б24"
              placeholder="Ещё не выбран"
              data={(contractors ?? []).map((c) => ({
                value: c.id,
                label: c.binIin ? `${c.name} · ${c.binIin}` : c.name,
              }))}
              value={contractorId}
              onChange={setContractorId}
              searchable
              clearable
              nothingFoundMessage="Не найден — заведите нового"
              style={{ flex: 1 }}
            />
            <Button
              variant="default"
              leftSection={<IconUserPlus size={16} />}
              onClick={() => setContractorModal(true)}
            >
              Завести подрядчика
            </Button>
          </Group>

          <Switch
            label="Работали у нас в цеху"
            description="занимают наши посты — мощность участка это учтёт"
            checked={atOurShop}
            onChange={(e) => setAtOurShop(e.currentTarget.checked)}
          />

          {needsHours && (
            <NumberInput
              label="Оценка часов на всю партию"
              description="сдельная ставка часов не содержит, а цех ими занят — без оценки расчёт заказа не соберётся"
              value={hours}
              onChange={setHours}
              min={0}
              decimalScale={2}
              thousandSeparator=" "
              required
            />
          )}

          <Textarea
            label="Примечание"
            placeholder="необязательно"
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
            autosize
            minRows={1}
          />

          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>Отмена</Button>
            <Button loading={save.isPending} disabled={!canSave} onClick={() => save.mutate()}>
              {editing ? 'Сохранить' : 'Завести заявку'}
            </Button>
          </Group>
        </Stack>
      </Modal>

      {contractorModal && (
        <ContractorModal
          onClose={() => setContractorModal(false)}
          onCreated={(id) => { setContractorId(id); setContractorModal(false); }}
        />
      )}
    </>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Разнести на заказ                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

function AllocateModal({ request, onClose }: {
  request: AllocationSummary;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [orderId, setOrderId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [debounced] = useDebouncedValue(search, 300);
  const [qty, setQty] = useState<number | string>(request.unallocatedQty ?? request.plannedQty ?? '');
  const [sharePct, setSharePct] = useState<number | string>(100);
  const [note, setNote] = useState('');

  // Заказ ищется на бэкенде: их тысячи, и «первые 50» нужного могут не
  // содержать. Выбранный заказ держим отдельно — после выбора Mantine
  // кладёт в строку поиска его подпись, и следующий ответ сервера этот
  // заказ уже не вернёт: без подстраховки поле показало бы пустоту
  const [chosen, setChosen] = useState<{ value: string; label: string } | null>(null);

  const { data: orders, isFetching } = useQuery({
    queryKey: ['orders-for-allocation', debounced],
    queryFn: () => ordersApi
      .list({ pageSize: 50, ...(debounced ? { search: debounced } : {}) })
      .then((r) => r.data),
  });

  const orderOptions = useMemo(() => {
    const list = (orders?.data ?? []).map((o) => ({
      value: o.id,
      label: `${o.orderNumber}${o.customerName ? ` · ${o.customerName}` : ''}`,
    }));
    if (chosen && !list.some((o) => o.value === chosen.value)) list.unshift(chosen);
    return list;
  }, [orders, chosen]);

  const allocate = useMutation({
    mutationFn: () => contractorRequestsApi.allocate(request.id, {
      orderId: orderId!,
      qty: Number(qty),
      share: Number(sharePct) / 100,
      note: note.trim() || undefined,
    }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['contractor-requests'] });
      qc.invalidateQueries({ queryKey: ['contractor-request', request.id] });
      qc.invalidateQueries({ queryKey: ['contractor-work-all'] });
      notifications.show({
        title: `Заказ ${res.orderNumber}: ${formatNumber(res.qty, 3)} ${res.unit}`,
        message: [
          res.stageLabel,
          res.recalculatedRows > 0 ? `пересчитано строк: ${res.recalculatedRows}` : null,
          res.remainingQty != null
            ? `не разнесено ещё ${formatNumber(res.remainingQty, 3)} ${res.unit}`
            : null,
        ].filter(Boolean).join(' · '),
        color: 'success',
        icon: <IconCheck size={16} />,
      });
      onClose();
    },
    onError: (e) => notifications.show({
      title: 'Не разнесено',
      message: apiErrorMessage(e, 'Ошибка разнесения'),
      color: 'danger',
      icon: <IconAlertTriangle size={16} />,
    }),
  });

  return (
    <Modal
      opened
      onClose={onClose}
      title={<Text fw={700}>Разнести {request.number} на заказ</Text>}
      radius="md"
      size="lg"
      centered
    >
      <Stack gap="md">
        <Card withBorder radius="md" padding="sm" bg="var(--mantine-color-gray-0)">
          <Group justify="space-between" gap="xs" wrap="wrap">
            <Text size="sm">{request.stageLabel}</Text>
            <Text size="sm" c="dimmed">
              {request.contractor?.name ?? 'подрядчик не выбран'}
            </Text>
            <Text size="sm">
              не разнесено{' '}
              <Text span fw={700} ff="monospace">
                {request.unallocatedQty != null
                  ? `${formatNumber(request.unallocatedQty, 3)} ${request.unit}`
                  : '—'}
              </Text>
            </Text>
          </Group>
        </Card>

        <Select
          label="Заказ"
          description="куда ушла эта часть работы"
          placeholder="Номер заказа или клиент"
          data={orderOptions}
          value={orderId}
          onChange={(v) => {
            setOrderId(v);
            setChosen(orderOptions.find((o) => o.value === v) ?? null);
          }}
          searchable
          searchValue={search}
          onSearchChange={setSearch}
          nothingFoundMessage={isFetching ? 'Ищем…' : 'Заказ не найден'}
          limit={50}
          required
        />

        <NumberInput
          label={`Сколько ушло на этот заказ, ${request.unit}`}
          description="объём в единицах ставки — по нему делятся и деньги, и часы"
          value={qty}
          onChange={setQty}
          min={0}
          decimalScale={3}
          thousandSeparator=" "
          required
        />

        <NumberInput
          label="Доля вида работ, %"
          description="100 % — весь этот вид работ по заказу сделал подрядчик; меньше — часть делал наш цех"
          value={sharePct}
          onChange={setSharePct}
          min={1}
          max={100}
          suffix=" %"
        />

        <Textarea
          label="Примечание"
          placeholder="необязательно"
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
          autosize
          minRows={1}
        />

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Отмена</Button>
          <Button
            loading={allocate.isPending}
            disabled={!orderId || !(Number(qty) > 0)}
            onClick={() => allocate.mutate()}
          >
            Разнести
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Принять акт                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

function AcceptModal({ request, onClose }: {
  request: AllocationSummary;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: detail, isLoading } = useQuery({
    queryKey: ['contractor-request', request.id],
    queryFn: () => contractorRequestsApi.get(request.id),
  });

  const [qty, setQty] = useState<number | string>(
    request.actualQty ?? (request.allocatedQty > 0 ? request.allocatedQty : request.plannedQty) ?? '',
  );
  const [amount, setAmount] = useState<number | string>(
    request.actualAmount ?? request.totalAmount ?? '',
  );
  const [note, setNote] = useState('');
  // Основание приёмки — «Заказ поставщику» из 1С: Б24 оформил заявку, 1С
  // назвала сумму, и раскидывается по заказам именно она, а не число со
  // слов. Ручной ввод остаётся на случай, когда ДО ещё не пришёл
  const [docId, setDocId] = useState<string | null>(null);

  const candidates = (detail?.supplierActs ?? []).filter((a) => !a.linkedRequestNumber);
  const chosenDoc = candidates.find((a) => a.id === docId) ?? null;
  const pickDoc = (id: string | null) => {
    setDocId(id);
    const doc = candidates.find((a) => a.id === id);
    if (doc) setAmount(doc.totalAmount);
  };

  const works = detail?.works ?? [];
  const qtys = works.map((w) => w.qty ?? 0);
  const allocatedQty = qtys.reduce((s, q) => s + q, 0);
  const rest = Number(qty) - allocatedQty;
  const overflow = allocatedQty > Number(qty) + 1e-6;
  /**
   * Та же арифметика, что запишется на бэкенде: директор видит копейки ДО
   * нажатия. Знаменатель — ПРИНЯТЫЙ объём, а не разнесённый: неразнесённый
   * хвост участвует в делении виртуальной долей и остаётся деньгами вне
   * заказов, иначе разнесённые заказы оплатили бы всю партию.
   */
  const tail = Math.max(0, rest);
  const preview = splitAmount(
    Number(amount) || 0,
    tail > 1e-9 ? [...qtys, tail] : qtys,
  ).slice(0, qtys.length);
  const previewSum = preview.reduce((s, p) => s + p, 0);

  const accept = useMutation({
    mutationFn: () => contractorRequestsApi.accept(request.id, {
      actualQty: Number(qty),
      // С ДО сумма едет из 1С; руками поверх — только если человек её поправил
      ...(docId
        ? { paymentDocumentId: docId,
            ...(chosenDoc && Number(amount) !== chosenDoc.totalAmount
              ? { actualAmount: Number(amount) } : {}) }
        : { actualAmount: Number(amount) }),
      note: note.trim() || undefined,
    }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['contractor-requests'] });
      qc.invalidateQueries({ queryKey: ['contractor-request', request.id] });
      qc.invalidateQueries({ queryKey: ['contractor-work-all'] });
      notifications.show({
        title: 'Акт принят — сумма заморожена',
        message: [
          `${formatCurrency(res.actualAmount)} на ${res.allocatedRows} заказов`,
          res.unallocatedQty > 0
            ? `не разнесено ${formatNumber(res.unallocatedQty, 3)} ${request.unit}`
            : null,
        ].filter(Boolean).join(' · '),
        color: 'success',
        icon: <IconCheck size={16} />,
      });
      onClose();
    },
    onError: (e) => notifications.show({
      title: 'Не принято',
      message: apiErrorMessage(e, 'Ошибка приёмки'),
      color: 'danger',
      icon: <IconAlertTriangle size={16} />,
    }),
  });

  return (
    <Modal
      opened
      onClose={onClose}
      title={<Text fw={700}>Акт по заявке {request.number}</Text>}
      radius="md"
      size="lg"
      centered
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {request.stageLabel} · {request.contractor?.name ?? 'подрядчик не выбран'}
        </Text>

        <Select
          label="Заказ поставщику из 1С"
          description={candidates.length === 0
            ? 'от этого подрядчика непривязанных ДО пока нет — введите сумму руками, привязать можно позже'
            : 'сумма приёмки возьмётся из документа'}
          placeholder={candidates.length === 0 ? 'ДО ещё не пришёл' : 'выберите ДО'}
          data={candidates.map((a) => ({
            value: a.id,
            label: `${a.doNumber} · ${formatCurrency(a.totalAmount)}`
              + (a.doDate ? ` · ${formatDate(a.doDate)}` : ''),
          }))}
          value={docId}
          onChange={pickDoc}
          disabled={candidates.length === 0}
          clearable
          searchable
        />

        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
          <NumberInput
            label={`Принято по акту, ${request.unit}`}
            value={qty}
            onChange={setQty}
            min={0}
            decimalScale={3}
            thousandSeparator=" "
            autoFocus
            required
          />
          <NumberInput
            label="Сумма акта, ₸"
            description={chosenDoc
              ? `из ДО ${chosenDoc.doNumber} — правьте, только если акт разошёлся с заказом`
              : 'замораживается: пересчёт калькуляции её больше не двигает'}
            value={amount}
            onChange={setAmount}
            min={0}
            decimalScale={2}
            thousandSeparator=" "
            required
          />
        </SimpleGrid>

        {overflow && (
          <Alert color="danger" variant="light" icon={<IconAlertTriangle size={16} />}>
            <Text size="sm">
              По заказам разнесено {formatNumber(allocatedQty, 3)} {request.unit}, а принимается{' '}
              {formatNumber(Number(qty), 3)} — заказы поделили бы больше, чем подрядчик сдал.
              Поправьте разнесение.
            </Text>
          </Alert>
        )}

        <Stack gap={6}>
          <Text size="sm" fw={700}>Как сумма ляжет на заказы</Text>
          {isLoading ? (
            <Skeleton height={80} radius="sm" />
          ) : works.length === 0 ? (
            <Alert color="warning" variant="light" icon={<IconAlertTriangle size={16} />}>
              <Text size="sm">
                Заявка не разнесена ни на один заказ — вся сумма повиснет в воздухе,
                а штат на этом виде работ посчитается по норме целиком. Сначала «Разнести».
              </Text>
            </Alert>
          ) : (
            <Table withTableBorder withColumnBorders verticalSpacing={6}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Заказ</Table.Th>
                  <Table.Th ta="right">Объём</Table.Th>
                  <Table.Th ta="right">Доля</Table.Th>
                  <Table.Th ta="right">Сумма</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {works.map((w, i) => (
                  <Table.Tr key={w.id}>
                    <Table.Td>
                      <Text size="sm" ff="monospace">{w.order?.orderNumber ?? '—'}</Text>
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace">
                      {formatNumber(w.qty ?? 0, 3)} {request.unit}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace">
                      {/* Доля от ПРИНЯТОГО объёма, а не от разнесённого:
                          иначе половина партии выглядела бы как «100 %» */}
                      {Number(qty) > 0 ? `${Math.round(((w.qty ?? 0) / Number(qty)) * 100)} %` : '—'}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" fw={600}>
                      {formatCurrency(preview[i] ?? 0)}
                    </Table.Td>
                  </Table.Tr>
                ))}
                {rest > 1e-6 && (
                  <Table.Tr>
                    <Table.Td>
                      <Text size="sm" c="danger.7" fw={600}>не разнесено</Text>
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" c="danger.7">
                      {formatNumber(rest, 3)} {request.unit}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" c="danger.7">
                      {Number(qty) > 0 ? `${Math.round((rest / Number(qty)) * 100)} %` : '—'}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" fw={600} c="danger.7">
                      {formatCurrency(round2((Number(amount) || 0) - previewSum))}
                    </Table.Td>
                  </Table.Tr>
                )}
                <Table.Tr>
                  <Table.Td><Text size="sm" fw={700}>Итого по заказам</Text></Table.Td>
                  <Table.Td ta="right" ff="monospace" fw={700}>
                    {formatNumber(allocatedQty, 3)} {request.unit}
                  </Table.Td>
                  <Table.Td />
                  <Table.Td ta="right" ff="monospace" fw={700}>
                    {formatCurrency(previewSum)}
                  </Table.Td>
                </Table.Tr>
              </Table.Tbody>
            </Table>
          )}
          {works.length > 0 && rest > 1e-6 && (
            <Text size="xs" c="danger.7">
              {formatCurrency(round2((Number(amount) || 0) - previewSum))} останутся вне заказов:
              эти {formatNumber(rest, 3)} {request.unit} никому не разнесены. Себестоимость
              на них не считается, и в списке заявка останется красной, пока их не разнесут
            </Text>
          )}
        </Stack>

        <Textarea
          label="Примечание к акту"
          placeholder="необязательно"
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
          autosize
          minRows={1}
        />

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Отмена</Button>
          <Button
            loading={accept.isPending}
            disabled={!(Number(qty) > 0) || !(Number(amount) >= 0) || amount === '' || overflow}
            onClick={() => accept.mutate()}
          >
            Принять акт
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Раскрытая строка: куда заявка разнесена                                   */
/* ────────────────────────────────────────────────────────────────────────── */

function AllocationsPanel({ request, canAllocate }: {
  request: AllocationSummary;
  canAllocate: boolean;
}) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['contractor-request', request.id],
    queryFn: () => contractorRequestsApi.get(request.id),
  });

  const remove = useMutation({
    mutationFn: (workId: string) => contractorRequestsApi.removeAllocation(request.id, workId),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['contractor-requests'] });
      qc.invalidateQueries({ queryKey: ['contractor-request', request.id] });
      qc.invalidateQueries({ queryKey: ['contractor-work-all'] });
      notifications.show({
        title: 'Разнесение снято',
        message: res.recalculatedRows > 0
          ? `Пропорции пересчитаны, строк: ${res.recalculatedRows}`
          : 'Объём вернулся в нераспределённый остаток',
        color: 'success',
        icon: <IconCheck size={16} />,
      });
    },
    onError: (e) => notifications.show({
      title: 'Не снято',
      message: apiErrorMessage(e, 'Ошибка снятия разнесения'),
      color: 'danger',
      icon: <IconAlertTriangle size={16} />,
    }),
  });

  if (isLoading || !data) return <Skeleton height={70} radius="sm" />;

  return (
    <Stack gap="sm" py="xs">
      <Stack gap={2}>
        <Text size="sm">{data.description}</Text>
        {data.note && <Text size="xs" c="dimmed">Примечание: {data.note}</Text>}
      </Stack>

      {data.works.length === 0 ? (
        <Text size="sm" c="dimmed">
          Не разнесена ни на один заказ
          {canAllocate && data.status !== 'CANCELLED' ? ' — нажмите «Разнести»' : ''}
        </Text>
      ) : (
        <Table verticalSpacing={6} withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Заказ</Table.Th>
              <Table.Th ta="right">Объём</Table.Th>
              <Table.Th ta="right">Доля вида работ</Table.Th>
              <Table.Th ta="right">Сумма</Table.Th>
              <Table.Th ta="right">Часы</Table.Th>
              <Table.Th>Разнесено</Table.Th>
              <Table.Th w={44} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.works.map((w) => (
              <Table.Tr key={w.id}>
                <Table.Td>
                  {w.order
                    ? <OrderRef id={w.order.id} number={w.order.orderNumber} focus="cost" />
                    : <Text size="sm" c="dimmed">заказ удалён</Text>}
                </Table.Td>
                <Table.Td ta="right" ff="monospace">
                  {w.qty != null ? `${formatNumber(w.qty, 3)} ${data.unit}` : '—'}
                </Table.Td>
                <Table.Td ta="right" ff="monospace">{Math.round(w.share * 100)} %</Table.Td>
                <Table.Td ta="right" ff="monospace" fw={600}>
                  {w.amount != null ? formatCurrency(w.amount) : '—'}
                </Table.Td>
                <Table.Td ta="right" ff="monospace">
                  {w.plannedHours != null ? formatNumber(w.plannedHours, 2) : '—'}
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed">{formatDate(w.decidedAt)}</Text>
                  {w.acceptedAt && (
                    <Badge size="xs" color="success" variant="light">принято</Badge>
                  )}
                </Table.Td>
                <Table.Td>
                  {canAllocate && (
                    <Tooltip label="Снять разнесение — пропорции пересчитаются">
                      <ActionIcon
                        variant="subtle"
                        color="danger"
                        loading={remove.isPending && remove.variables === w.id}
                        onClick={() => remove.mutate(w.id)}
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      {data.supplierActs.length > 0 && (
        <Stack gap={2}>
          <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.08em' }}>
            Акты 1С по этому подрядчику
          </Text>
          {data.supplierActs.slice(0, 5).map((a) => (
            <Text key={a.id} size="xs" c="dimmed" ff="monospace">
              {a.doNumber} от {formatDate(a.doDate)} — {formatCurrency(a.totalAmount)}
            </Text>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Вкладка 1: заявки                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Описания список не отдаёт — они есть только в карточке заявки. Тянем их
 * одним фоновым проходом пачками по пять: 300 параллельных запросов упёрлись
 * бы в таймаут axios, а «ПОДР-014» без текста в списке не говорит ничего.
 */
function useDescriptions(ids: string[]) {
  const key = ids.join(',');
  return useQuery({
    queryKey: ['contractor-request-descriptions', key],
    enabled: ids.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const out: Record<string, string> = {};
      for (let i = 0; i < ids.length; i += 5) {
        const chunk = ids.slice(i, i + 5);
        // eslint-disable-next-line no-await-in-loop
        const details = await Promise.all(
          chunk.map((id) => contractorRequestsApi.get(id).catch(() => null)),
        );
        details.forEach((d) => { if (d) out[d.id] = d.description; });
      }
      return out;
    },
  });
}

function RequestsTab() {
  const qc = useQueryClient();
  const hasRole = useAuthStore((s) => s.hasRole);
  const canEdit = hasRole(['shop_foreman', 'planner', 'sales_manager', 'procurement', 'admin']);
  const canAllocate = hasRole(['shop_foreman', 'planner', 'admin']);
  const canAccept = hasRole(['procurement', 'accountant', 'planner', 'admin']);

  const [status, setStatus] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AllocationSummary | null>(null);
  const [allocating, setAllocating] = useState<AllocationSummary | null>(null);
  const [accepting, setAccepting] = useState<AllocationSummary | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['contractor-requests', status, stage],
    queryFn: () => contractorRequestsApi.list({
      ...(status ? { status } : {}),
      ...(stage ? { stage } : {}),
    }),
    refetchInterval: 60_000,
    retry: retryUnlessDenied,
  });

  const rows = data?.data ?? [];
  // Непринятые деньги наверх: строка, которую надо разнести, не должна
  // тонуть в хронологии — она и есть работа этого экрана
  const sorted = useMemo(
    () => [...rows].sort((a, b) => Number(b.needsAllocation) - Number(a.needsAllocation)),
    [rows],
  );
  const { data: descriptions } = useDescriptions(sorted.map((r) => r.id));

  const drafts = sorted.filter((r) => r.status === 'DRAFT');
  const selectedRows = drafts.filter((r) => selected.has(r.id));
  const selectedTotal = selectedRows.reduce((s, r) => s + (r.totalAmount ?? 0), 0);

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelected((prev) =>
    prev.size === drafts.length ? new Set() : new Set(drafts.map((r) => r.id)));

  const send = useMutation({
    mutationFn: (ids: string[]) => contractorRequestsApi.sendToBitrix(ids),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['contractor-requests'] });
      setSelected(new Set());
      notifications.show({
        title: 'Заявка ушла в Б24',
        message: `Сделка №${res.dealId}: ${res.sent} заявок на ${formatCurrency(res.totalEstimate)}`,
        color: 'success',
        icon: <IconCheck size={16} />,
      });
    },
    onError: (e) => notifications.show({
      title: 'Не отправлено',
      message: apiErrorMessage(e, 'Ошибка отправки в Б24'),
      color: 'danger',
      icon: <IconAlertTriangle size={16} />,
    }),
  });

  const cancel = useMutation({
    mutationFn: (id: string) => contractorRequestsApi.cancel(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contractor-requests'] });
      notifications.show({ title: 'Заявка отменена', message: '', color: 'gray' });
    },
    onError: (e) => notifications.show({
      title: 'Не отменена',
      message: apiErrorMessage(e, 'Ошибка отмены'),
      color: 'danger',
      icon: <IconAlertTriangle size={16} />,
    }),
  });

  if (error) {
    return (
      <Alert color="danger" variant="light" icon={<IconAlertTriangle size={16} />}>
        <Text size="sm">{apiErrorMessage(error, 'Не удалось загрузить заявки на подряд')}</Text>
      </Alert>
    );
  }

  return (
    <Stack gap="md">
      {/* Самая опасная точка потока: деньги приняты и не сидят ни в одном заказе */}
      {data && data.unallocated.requests > 0 && (
        <Alert color="danger" variant="light" icon={<IconAlertTriangle size={18} />}>
          <Text size="sm" fw={600}>
            Принято на {formatCurrency(data.unallocated.amount)} и не разнесено ни на один
            заказ — штат на этих работах считается по норме целиком
          </Text>
          <Text size="xs" c="dimmed">
            {data.unallocated.requests}{' '}
            {plural(data.unallocated.requests, 'заявка ждёт', 'заявки ждут', 'заявок ждут')}{' '}
            разнесения — они подняты наверх списка
          </Text>
        </Alert>
      )}

      <Group gap="sm" wrap="wrap">
        <Select
          size="sm"
          w={200}
          placeholder="Все статусы"
          clearable
          data={STATUS_FILTER_OPTIONS}
          value={status}
          onChange={setStatus}
        />
        <Select
          size="sm"
          w={230}
          placeholder="Все виды работ"
          clearable
          data={STAGE_OPTIONS}
          value={stage}
          onChange={setStage}
        />
        {canEdit && (
          <Button
            ml="auto"
            leftSection={<IconPlus size={16} />}
            onClick={() => setCreating(true)}
          >
            Новая заявка
          </Button>
        )}
      </Group>

      {/* Пачка черновиков → одна сделка в Б24, как в очереди на закуп */}
      {drafts.length > 0 && (
        <Card withBorder radius="md" padding="md">
          <Group justify="space-between" wrap="wrap" gap="sm">
            <Text size="sm">
              Выбрано <Text span fw={700} ff="monospace">{selected.size}</Text> из {drafts.length} черновиков
              {selected.size > 0 && (
                <> на <Text span fw={700} ff="monospace">{formatCurrency(selectedTotal)}</Text> (оценка)</>
              )}
            </Text>
            <Button
              leftSection={<IconSend size={16} />}
              disabled={selected.size === 0}
              loading={send.isPending}
              onClick={() => send.mutate([...selected])}
            >
              Отправить в Б24 одной заявкой
            </Button>
          </Group>
        </Card>
      )}

      <Card withBorder radius="md" padding={0}>
        {isLoading ? (
          <Stack gap={4} p="md">
            {[...Array(6)].map((_, i) => <Skeleton key={i} height={34} radius="sm" />)}
          </Stack>
        ) : sorted.length === 0 ? (
          <Stack align="center" gap="sm" py="xl">
            <ThemeIcon size={48} radius="xl" variant="light" color="gray">
              <IconClipboardList size={26} />
            </ThemeIcon>
            <Text fw={700}>Заявок на подряд нет</Text>
            <Text size="sm" c="dimmed" ta="center" maw={460}>
              Заявка заводится партией, когда заказы ещё не известны: «увезли красить
              балки». Потом пачка уходит одной сделкой в Б24, а цех разносит объём
              по заказам.
            </Text>
          </Stack>
        ) : (
          <Table.ScrollContainer minWidth={900}>
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={40}>
                    {drafts.length > 0 && (
                      <Checkbox
                        checked={selected.size === drafts.length && drafts.length > 0}
                        indeterminate={selected.size > 0 && selected.size < drafts.length}
                        onChange={toggleAll}
                      />
                    )}
                  </Table.Th>
                  <Table.Th>Заявка</Table.Th>
                  <Table.Th>Вид работ</Table.Th>
                  <Table.Th>Подрядчик</Table.Th>
                  <Table.Th ta="right">Объём и ставка</Table.Th>
                  <Table.Th ta="right">Сумма</Table.Th>
                  <Table.Th ta="right" w={150}>Разнесено · остаток</Table.Th>
                  <Table.Th style={stickyActions(false)} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {sorted.map((r) => {
                  const targetQty = r.actualQty ?? r.plannedQty;
                  const sentDays = daysSince(r.bitrixSentAt);
                  const opened = expandedId === r.id;
                  return (
                    <React.Fragment key={r.id}>
                      <Table.Tr
                        style={r.needsAllocation
                          ? { background: 'var(--mantine-color-danger-0)' }
                          : undefined}
                      >
                        <Table.Td>
                          {r.status === 'DRAFT' && (
                            <Checkbox checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                          )}
                        </Table.Td>

                        <Table.Td>
                          <Group gap={4} wrap="nowrap">
                            <ActionIcon
                              variant="subtle"
                              color="gray"
                              size="sm"
                              onClick={() => setExpandedId(opened ? null : r.id)}
                              aria-label="Показать разнесение"
                            >
                              {opened ? <IconChevronDown size={15} /> : <IconChevronRight size={15} />}
                            </ActionIcon>
                            <Text size="sm" fw={700} ff="monospace">{r.number}</Text>
                            <Badge
                              size="sm"
                              variant="light"
                              color={REQUEST_STATUS_COLORS[r.status] ?? 'gray'}
                            >
                              {REQUEST_STATUS_LABELS[r.status] ?? r.status}
                            </Badge>
                          </Group>
                          {/* Второй строкой, не в одну: три бейджа рядом с
                              номером сплющивались в нечитаемые точки */}
                          <Group gap={4} ml={28} mt={2} wrap="wrap" maw={200}>
                            {r.bitrixDealId && (
                              <Tooltip label={`Сделка в воронке «Заказ на Работы»`
                                + (sentDays != null ? `, в Б24 ${sentDays} ${daysWord(sentDays)}` : '')}>
                                <Badge size="sm" variant="light" color="blue">
                                  Б24 №{r.bitrixDealId}
                                </Badge>
                              </Tooltip>
                            )}
                            {r.supplierDoc && (
                              <Tooltip label={`Заказ поставщику из 1С на ${formatCurrency(r.supplierDoc.totalAmount)} — сумма приёмки из него`}>
                                <Badge size="sm" variant="light" color="teal">
                                  ДО {r.supplierDoc.doNumber}
                                </Badge>
                              </Tooltip>
                            )}
                            {/* 1С ответила: свежий непривязанный ДО подрядчика.
                                «Ждём ответа» должно кончаться сигналом, не тишиной */}
                            {!r.supplierDoc && r.candidateDoc && (
                              <Tooltip label={`Похоже, 1С оформила заказ поставщику: ${r.candidateDoc.doNumber}`
                                + ` на ${formatCurrency(r.candidateDoc.totalAmount)}. Принять — через акт`}>
                                <Badge size="sm" variant="filled" color="teal">
                                  пришёл ДО из 1С
                                </Badge>
                              </Tooltip>
                            )}
                          </Group>
                          <Text size="xs" c="dimmed" ml={28} lineClamp={2} maw={200}>
                            {/* пока описания не пришли — многоточие, а не пустота */}
                            {descriptions ? descriptions[r.id] ?? formatDate(r.createdAt) : '…'}
                          </Text>
                        </Table.Td>

                        <Table.Td maw={110}>
                          {/* Коротко: полная подпись вида работ — в раскрытой строке */}
                          <Text size="sm">{STAGE_SHORT[r.routingStage] ?? r.stageLabel}</Text>
                          {r.workLocation === 'OUR_SHOP' && (
                            <Text size="xs" c="dimmed">в нашем цеху</Text>
                          )}
                        </Table.Td>

                        <Table.Td maw={110}>
                          {r.contractor
                            ? <Text size="sm" lineClamp={2}>{r.contractor.name}</Text>
                            : <Text size="sm" c="dimmed">подберут в Б24</Text>}
                        </Table.Td>

                        <Table.Td ta="right" ff="monospace" style={{ whiteSpace: 'nowrap' }}>
                          {targetQty != null ? `${formatNumber(targetQty, 3)} ${r.unit}` : '—'}
                          {r.actualQty != null && <Text span size="xs" c="dimmed"> по акту</Text>}
                          <Text size="xs" c="dimmed">
                            {r.rate != null
                              ? `${formatCurrency(r.rate)} ${RATE_SUFFIXES[r.rateType] ?? ''}`
                              : 'ставки нет'}
                          </Text>
                        </Table.Td>

                        <Table.Td ta="right" ff="monospace" fw={600} style={{ whiteSpace: 'nowrap' }}>
                          {r.totalAmount != null ? formatCurrency(r.totalAmount) : '—'}
                        </Table.Td>

                        <Table.Td ta="right">
                          <Text
                            component="button"
                            type="button"
                            size="sm"
                            ff="monospace"
                            onClick={() => setExpandedId(opened ? null : r.id)}
                            style={{
                              background: 'none', border: 'none', padding: 0,
                              cursor: 'pointer', whiteSpace: 'nowrap',
                            }}
                          >
                            {formatNumber(r.allocatedQty, 3)}
                            {targetQty != null ? ` из ${formatNumber(targetQty, 3)}` : ''} {r.unit}
                          </Text>
                          <Text
                            size="xs"
                            ff="monospace"
                            fw={r.needsAllocation ? 700 : 400}
                            c={r.needsAllocation ? 'danger.7' : 'dimmed'}
                          >
                            {r.needsAllocation
                              ? `висит ${formatCurrency(r.unallocatedAmount)}`
                              : r.ordersCount > 0
                                ? `${r.ordersCount} ${plural(r.ordersCount, 'заказ', 'заказа', 'заказов')}`
                                : 'нет заказов'}
                          </Text>
                          {r.isStale && r.daysSinceAccepted != null && (
                            <Text size="xs" c="danger.7">
                              {r.daysSinceAccepted} {daysWord(r.daysSinceAccepted)} назад
                            </Text>
                          )}
                        </Table.Td>

                        <Table.Td style={stickyActions(r.needsAllocation)}>
                          <Group gap={4} wrap="nowrap" justify="flex-end">
                            {canAllocate && r.status !== 'CANCELLED' && (
                              <Button
                                size="compact-sm"
                                variant={r.needsAllocation ? 'filled' : 'light'}
                                onClick={() => setAllocating(r)}
                              >
                                Разнести
                              </Button>
                            )}
                            {canAccept && r.status !== 'CANCELLED' && (
                              <Tooltip label={r.acceptedAt
                                ? 'Правка акта: объём и сумма'
                                : 'Принять акт — сумма заморозится и разойдётся по заказам'}>
                                <ActionIcon
                                  variant={r.acceptedAt ? 'subtle' : 'light'}
                                  color={r.acceptedAt ? 'gray' : 'teal'}
                                  onClick={() => setAccepting(r)}
                                  aria-label={r.acceptedAt ? 'Правка акта' : 'Принять акт'}
                                >
                                  <IconFileInvoice size={16} />
                                </ActionIcon>
                              </Tooltip>
                            )}
                            {canEdit && r.status !== 'CANCELLED' && (
                              <Tooltip label="Подрядчик, ставка, объём — их называют в Б24">
                                <ActionIcon variant="subtle" color="gray" onClick={() => setEditing(r)}>
                                  <IconPencil size={16} />
                                </ActionIcon>
                              </Tooltip>
                            )}
                            {canEdit && r.ordersCount === 0 && r.acceptedAt == null
                              && r.status !== 'CANCELLED' && (
                              <Tooltip label="Отменить заявку">
                                <ActionIcon
                                  variant="subtle"
                                  color="danger"
                                  loading={cancel.isPending && cancel.variables === r.id}
                                  onClick={() => cancel.mutate(r.id)}
                                >
                                  <IconX size={16} />
                                </ActionIcon>
                              </Tooltip>
                            )}
                          </Group>
                        </Table.Td>
                      </Table.Tr>

                      {opened && (
                        <Table.Tr>
                          <Table.Td colSpan={8} style={{ background: 'var(--mantine-color-gray-0)' }}>
                            <AllocationsPanel request={r} canAllocate={canAllocate} />
                          </Table.Td>
                        </Table.Tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>

      {creating && <RequestFormModal editing={null} onClose={() => setCreating(false)} />}
      {editing && <RequestFormModal editing={editing} onClose={() => setEditing(null)} />}
      {allocating && <AllocateModal request={allocating} onClose={() => setAllocating(null)} />}
      {accepting && <AcceptModal request={accepting} onClose={() => setAccepting(null)} />}
    </Stack>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Вкладка 2: разнесено по заказам                                           */
/* ────────────────────────────────────────────────────────────────────────── */

interface WorkRow {
  id: string;
  order: { id: string; orderNumber: string; status: string; plannedShipmentDate: string | null };
  contractor: { id: string; name: string; binIin: string | null };
  /** Из какой заявки пришла строка; null — разовый подряд из отметки этапа */
  request: { id: string; number: string } | null;
  routingStage: string;
  share: number;
  rateType: string;
  rate: number;
  actualQty: number | null;
  amount: number | null;
  workLocation: 'OUR_SHOP' | 'CONTRACTOR_SITE';
  isAccepted: boolean;
  acceptedAt: string | null;
  decidedAt: string;
  reason: string | null;
}
interface WorkResponse {
  data: WorkRow[];
  byContractor: Array<{ id: string; name: string; open: number; accepted: number; amount: number }>;
  total: number;
}

const WORK_STAGE_LABELS: Record<string, string> = {
  ...ROUTING_STAGE_LABELS,
  'резка': 'Резка',
  'сборка/сварка/обшивка': 'Сборка / сварка / обшивка',
  'зачистка/покраска': 'Зачистка / покраска',
};

function AllocatedTab() {
  const qc = useQueryClient();
  const hasRole = useAuthStore((s) => s.hasRole);
  const canAccept = hasRole(['shop_foreman', 'planner', 'admin']);

  const [contractorId, setContractorId] = useState<string | null>(null);
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [accepting, setAccepting] = useState<WorkRow | null>(null);
  const [qty, setQty] = useState<number | string>('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['contractor-work-all', contractorId, onlyOpen],
    queryFn: () => api
      .get<WorkResponse>('/contractor-work', {
        params: {
          ...(contractorId ? { contractorId } : {}),
          ...(onlyOpen ? { onlyOpen: 'true' } : {}),
        },
      })
      .then((r) => r.data),
    refetchInterval: 60_000,
    retry: retryUnlessDenied,
  });

  const accept = useMutation({
    mutationFn: (input: { id: string; actualQty: number }) =>
      ordersApi.acceptContractorWork(input.id, { actualQty: input.actualQty }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contractor-work-all'] });
      qc.invalidateQueries({ queryKey: ['contractor-work'] });
      qc.invalidateQueries({ queryKey: ['contractor-requests'] });
      notifications.show({
        title: 'Работа принята',
        message: 'Сумма заморожена — пересчёт калькуляции её больше не двигает',
        color: 'success',
        icon: <IconCheck size={16} />,
      });
      setAccepting(null);
      setQty('');
    },
    onError: (e) => notifications.show({
      title: 'Не принято',
      message: apiErrorMessage(e, 'Ошибка приёмки'),
      color: 'danger',
      icon: <IconAlertTriangle size={16} />,
    }),
  });

  // Молчаливый вечный скелет — худший вид ошибки: человек ждёт данных,
  // которых ему не отдадут. Список работ открыт не всем ролям
  if (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    return (
      <Alert color="danger" variant="light" icon={<IconAlertTriangle size={16} />}>
        <Text size="sm">
          {status === 403
            ? 'Разнесённые работы видят плановик, менеджер, бухгалтер и директор — у вашей роли доступа нет. Заявки на вкладке рядом открыты.'
            : apiErrorMessage(error, 'Не удалось загрузить подряд по заказам')}
        </Text>
      </Alert>
    );
  }

  if (isLoading || !data) {
    return (
      <Stack gap="md">
        <Skeleton height={80} radius="md" />
        <Skeleton height={320} radius="md" />
      </Stack>
    );
  }

  const totalOwed = data.data.reduce((s, w) => s + (w.isAccepted ? w.amount ?? 0 : 0), 0);
  const openCount = data.data.filter((w) => !w.isAccepted).length;

  return (
    <Stack gap="md">
      {data.byContractor.length > 0 && (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
          {data.byContractor.map((c) => (
            <Card key={c.id} withBorder radius="md" padding="md">
              <Group gap="xs" mb={6} wrap="nowrap">
                <ThemeIcon variant="light" color="orange" radius="md" size="sm">
                  <IconBuildingFactory size={14} />
                </ThemeIcon>
                <Text fw={700} size="sm" truncate>{c.name}</Text>
              </Group>
              <Group justify="space-between">
                <Text size="xs" c="dimmed">В работе</Text>
                <Text size="sm" fw={600}>{c.open}</Text>
              </Group>
              <Group justify="space-between">
                <Text size="xs" c="dimmed">Принято</Text>
                <Text size="sm" fw={600}>{c.accepted}</Text>
              </Group>
              <Group justify="space-between" mt={4}>
                <Text size="xs" c="dimmed">Должны</Text>
                <Text size="sm" fw={700} ff="monospace">{formatCurrency(c.amount)}</Text>
              </Group>
            </Card>
          ))}
        </SimpleGrid>
      )}

      <Group gap="sm" wrap="wrap">
        <Select
          size="sm"
          w={240}
          placeholder="Все подрядчики"
          clearable
          data={data.byContractor.map((c) => ({ value: c.id, label: c.name }))}
          value={contractorId}
          onChange={setContractorId}
        />
        <Button
          size="sm"
          variant={onlyOpen ? 'filled' : 'default'}
          onClick={() => setOnlyOpen((v) => !v)}
        >
          Только не принятые {openCount > 0 ? `(${openCount})` : ''}
        </Button>
        <Text size="sm" c="dimmed" ml="auto">
          Принято на <Text span fw={700} ff="monospace">{formatCurrency(totalOwed)}</Text>
        </Text>
      </Group>

      <Card withBorder radius="md" padding={0}>
        {data.data.length === 0 ? (
          <Stack align="center" gap="sm" py="xl">
            <ThemeIcon size={48} radius="xl" variant="light" color="gray">
              <IconTruck size={26} />
            </ThemeIcon>
            <Text fw={700}>Подряда нет</Text>
            <Text size="sm" c="dimmed" ta="center" maw={440}>
              Строки появляются двумя путями: разнесением заявки на заказ (вкладка
              «Заявки») или отметкой этапа в цеху — переключателем «Делал не наш цех»
            </Text>
          </Stack>
        ) : (
          <Table.ScrollContainer minWidth={980}>
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Заказ</Table.Th>
                  <Table.Th>Заявка</Table.Th>
                  <Table.Th>Подрядчик</Table.Th>
                  <Table.Th>Вид работ</Table.Th>
                  <Table.Th ta="right">Доля</Table.Th>
                  <Table.Th ta="right">Ставка</Table.Th>
                  <Table.Th ta="right">Объём</Table.Th>
                  <Table.Th ta="right">Сумма</Table.Th>
                  <Table.Th>Состояние</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.data.map((w) => (
                  <Table.Tr key={w.id}>
                    <Table.Td>
                      <OrderRef id={w.order.id} number={w.order.orderNumber} focus="cost" />
                      {w.order.plannedShipmentDate && (
                        <Text size="xs" c="dimmed">{formatDate(w.order.plannedShipmentDate)}</Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {w.request
                        ? <Text size="sm" ff="monospace">{w.request.number}</Text>
                        : <Text size="sm" c="dimmed">разовый</Text>}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{w.contractor.name}</Text>
                      {w.workLocation === 'OUR_SHOP' && (
                        <Text size="xs" c="dimmed">в нашем цеху</Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{WORK_STAGE_LABELS[w.routingStage] ?? w.routingStage}</Text>
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace">{Math.round(w.share * 100)} %</Table.Td>
                    <Table.Td ta="right" ff="monospace">
                      {formatCurrency(w.rate)}
                      <Text size="xs" c="dimmed">
                        {RATE_SUFFIXES[w.rateType as RateTypeCode] ?? w.rateType}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace">
                      {w.actualQty != null
                        ? `${formatNumber(w.actualQty, 3)} ${RATE_UNITS[w.rateType as RateTypeCode] ?? ''}`
                        : '—'}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" fw={600}>
                      {w.amount != null ? formatCurrency(w.amount) : '—'}
                    </Table.Td>
                    <Table.Td>
                      {w.isAccepted ? (
                        <Tooltip label={`принято ${formatDate(w.acceptedAt)}`}>
                          <Badge color="success" variant="light" radius="xl">принято</Badge>
                        </Tooltip>
                      ) : canAccept ? (
                        <Button
                          size="compact-sm"
                          variant="light"
                          onClick={() => { setAccepting(w); setQty(''); }}
                        >
                          Принять
                        </Button>
                      ) : (
                        <Badge color="gray" variant="light" radius="xl">в работе</Badge>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>

      {/* Приёмка одной строки: объём в единицах ставки замораживает сумму */}
      <Modal
        opened={accepting !== null}
        onClose={() => setAccepting(null)}
        title={<Text fw={700}>Принять работу</Text>}
        radius="md"
        centered
      >
        {accepting && (
          <Stack gap="md">
            <Stack gap={2}>
              <Text size="sm">
                {accepting.contractor.name} ·{' '}
                {WORK_STAGE_LABELS[accepting.routingStage] ?? accepting.routingStage}
              </Text>
              <Text size="sm" c="dimmed">
                Заказ {accepting.order.orderNumber} · ставка {formatCurrency(accepting.rate)}{' '}
                {RATE_SUFFIXES[accepting.rateType as RateTypeCode] ?? accepting.rateType}
              </Text>
            </Stack>
            <NumberInput
              label={`Сколько сдал (${RATE_UNITS[accepting.rateType as RateTypeCode] ?? 'ед.'})`}
              description="сумма посчитается по ставке и заморозится — пересчёт её больше не двигает"
              value={qty}
              onChange={setQty}
              min={0}
              size="md"
              autoFocus
            />
            {Number(qty) > 0 && accepting.rateType !== 'FIXED' && (
              <Text size="sm">
                К оплате: <Text span fw={700} ff="monospace">
                  {formatCurrency(Number(qty) * accepting.rate)}
                </Text>
              </Text>
            )}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setAccepting(null)}>Отмена</Button>
              <Button
                loading={accept.isPending}
                disabled={!(Number(qty) >= 0) || qty === ''}
                onClick={() => accept.mutate({ id: accepting.id, actualQty: Number(qty) })}
              >
                Принять
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Подряд (26.08.2026): две вкладки одного потока.
 *
 * «Заявки» — партия, которую отдали на сторону, ещё не зная, по каким
 * заказам она разойдётся. «Разнесено по заказам» — строки, которые уже
 * сидят в себестоимости конкретных заказов. Разрыв между этими двумя
 * картинами и есть главная цифра экрана: принято, но не разнесено.
 */
export function ContractorWork() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'allocated' ? 'allocated' : 'requests';

  const setTab = (v: string) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    next.set('tab', v);
    return next;
  }, { replace: true });

  return (
    <Stack gap="md" style={{ minWidth: 0 }}>
      <Stack gap={4}>
        <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.08em' }}>
          Производство · Подряд
        </Text>
        <Text fw={700} size="xl">Кто делает наши работы на стороне</Text>
        <Text size="sm" c="dimmed">
          Штат считается по нормам спецификации и здесь не показывается — тут только то,
          что отдано подрядчикам
        </Text>
      </Stack>

      <Tabs value={tab} onChange={(v) => setTab(v ?? 'requests')} radius="md" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="requests" leftSection={<IconClipboardList size={15} />}>
            Заявки
          </Tabs.Tab>
          <Tabs.Tab value="allocated" leftSection={<IconListDetails size={15} />}>
            Разнесено по заказам
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="requests"><RequestsTab /></Tabs.Panel>
        <Tabs.Panel value="allocated"><AllocatedTab /></Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
