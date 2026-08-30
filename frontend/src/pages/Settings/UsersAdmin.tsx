import React, { useState } from 'react';
import {
  Card, Stack, Text, Table, Skeleton, Box, Group, Button, Modal,
  TextInput, PasswordInput, Badge, MultiSelect, Switch, Tooltip,
} from '@mantine/core';
import { IconPlus, IconCheck, IconKey, IconPencil } from '@tabler/icons-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import api from '../../api/client';
import { formatDate } from '../../utils/formatters';

interface UserRow {
  id: string;
  email: string;
  isActive: boolean;
  createdAt: string;
  roles: Array<{ code: string; name: string }>;
  employee: { id: string; name: string } | null;
}

/**
 * Пользователи и роли (28.08.2026). Учётки жили только в сиде — завести
 * человека или отобрать доступ через интерфейс было нельзя, «кому мы дали
 * доступ» знал лишь Excel. Роли действуют со следующего входа: JWT несёт
 * роли, а вход читает их из базы, не с клиента.
 */
export function UsersAdmin() {
  const qc = useQueryClient();
  const [modal, setModal] = useState<'create' | 'edit' | 'password' | null>(null);
  const [target, setTarget] = useState<UserRow | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [roles, setRoles] = useState<string[]>([]);

  const { data: users, isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<UserRow[]>('/users').then((r) => r.data),
  });
  const { data: roleDict } = useQuery({
    queryKey: ['users-roles'],
    queryFn: () => api.get('/users/roles').then((r) => r.data),
  });

  const roleOptions = (roleDict ?? []).map((r: any) => ({
    value: r.code,
    label: `${r.name} (${r.code})`,
  }));

  const fail = (e: any) => notifications.show({
    title: 'Не сохранено',
    message: e?.response?.data?.error?.message ?? 'Ошибка',
    color: 'danger',
  });
  const done = (title: string) => {
    qc.invalidateQueries({ queryKey: ['users'] });
    notifications.show({ title, message: '', color: 'success', icon: <IconCheck size={16} /> });
    setModal(null); setTarget(null); setEmail(''); setPassword(''); setRoles([]);
  };

  const create = useMutation({
    mutationFn: () => api.post('/users', { email, password, roles }).then((r) => r.data),
    onSuccess: (u: any) => done(`Пользователь ${u.email} заведён`),
    onError: fail,
  });
  const update = useMutation({
    mutationFn: (input: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/users/${input.id}`, input.body).then((r) => r.data),
    onSuccess: () => done('Сохранено'),
    onError: fail,
  });
  const toggleActive = useMutation({
    mutationFn: (u: UserRow) => api.patch(`/users/${u.id}`, { isActive: !u.isActive }).then((r) => r.data),
    onSuccess: (u: any) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      notifications.show({
        title: u.isActive ? 'Доступ включён' : 'Доступ отключён',
        message: u.email, color: u.isActive ? 'success' : 'warning',
      });
    },
    onError: fail,
  });
  const resetPassword = useMutation({
    mutationFn: () => api.post(`/users/${target!.id}/reset-password`, { password }).then((r) => r.data),
    onSuccess: () => done('Пароль обновлён'),
    onError: fail,
  });

  const rows = users ?? [];

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          Учёток: <Text span fw={700} ff="monospace">{rows.length}</Text>
          {' '}· активных: <Text span fw={700} ff="monospace">{rows.filter((u) => u.isActive).length}</Text>
        </Text>
        <Button size="sm" leftSection={<IconPlus size={16} />} onClick={() => { setModal('create'); setRoles([]); }}>
          Завести пользователя
        </Button>
      </Group>

      <Card withBorder radius="md" padding={0}>
        {isLoading ? (
          <Stack gap={4} p="md">{[...Array(6)].map((_, i) => <Skeleton key={i} height={34} radius="sm" />)}</Stack>
        ) : (
          <Box style={{ overflowX: 'auto' }}>
            <Table highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Email</Table.Th>
                  <Table.Th>Роли</Table.Th>
                  <Table.Th>Сотрудник</Table.Th>
                  <Table.Th>Создан</Table.Th>
                  <Table.Th>Доступ</Table.Th>
                  <Table.Th w={110} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((u) => (
                  <Table.Tr key={u.id} style={{ opacity: u.isActive ? 1 : 0.55 }}>
                    <Table.Td>
                      <Text size="sm" fw={600} ff="monospace">{u.email}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        {u.roles.map((r) => (
                          <Badge key={r.code} size="xs" variant="light"
                            color={r.code === 'admin' ? 'red' : 'gray'}>
                            {r.name}
                          </Badge>
                        ))}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">{u.employee?.name ?? '—'}</Text>
                    </Table.Td>
                    <Table.Td ff="monospace" fz="xs">{formatDate(u.createdAt)}</Table.Td>
                    <Table.Td>
                      <Switch
                        size="sm"
                        checked={u.isActive}
                        onChange={() => toggleActive.mutate(u)}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        <Tooltip label="Роли">
                          <Button size="compact-xs" variant="subtle"
                            onClick={() => { setTarget(u); setRoles(u.roles.map((r) => r.code)); setModal('edit'); }}>
                            <IconPencil size={14} />
                          </Button>
                        </Tooltip>
                        <Tooltip label="Новый пароль">
                          <Button size="compact-xs" variant="subtle" color="gray"
                            onClick={() => { setTarget(u); setPassword(''); setModal('password'); }}>
                            <IconKey size={14} />
                          </Button>
                        </Tooltip>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Box>
        )}
      </Card>

      <Modal opened={modal === 'create'} onClose={() => setModal(null)}
        title={<Text fw={700}>Новый пользователь</Text>} radius="md" centered>
        <Stack gap="md">
          <TextInput label="Email" placeholder="name@avh.kz" value={email} onChange={(e) => setEmail(e.target.value)} />
          <PasswordInput label="Пароль" description="минимум 8 символов" value={password} onChange={(e) => setPassword(e.target.value)} />
          <MultiSelect label="Роли" data={roleOptions} value={roles} onChange={setRoles} searchable />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setModal(null)}>Отмена</Button>
            <Button loading={create.isPending}
              disabled={!email || password.length < 8 || roles.length === 0}
              onClick={() => create.mutate()}>
              Завести
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={modal === 'edit'} onClose={() => setModal(null)}
        title={<Text fw={700}>Роли: {target?.email}</Text>} radius="md" centered>
        <Stack gap="md">
          <MultiSelect label="Роли" data={roleOptions} value={roles} onChange={setRoles} searchable />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setModal(null)}>Отмена</Button>
            <Button loading={update.isPending} disabled={roles.length === 0}
              onClick={() => update.mutate({ id: target!.id, body: { roles } })}>
              Сохранить
            </Button>
          </Group>
          <Text size="xs" c="dimmed">Роли действуют со следующего входа пользователя.</Text>
        </Stack>
      </Modal>

      <Modal opened={modal === 'password'} onClose={() => setModal(null)}
        title={<Text fw={700}>Пароль: {target?.email}</Text>} radius="md" centered>
        <Stack gap="md">
          <PasswordInput label="Новый пароль" description="минимум 8 символов"
            value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setModal(null)}>Отмена</Button>
            <Button loading={resetPassword.isPending} disabled={password.length < 8}
              onClick={() => resetPassword.mutate()}>
              Обновить
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
