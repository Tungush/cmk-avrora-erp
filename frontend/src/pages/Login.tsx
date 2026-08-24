import React, { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Container,
  Paper,
  TextInput,
  PasswordInput,
  Button,
  Title,
  Text,
  Stack,
  Group,
  Box,
  Flex,
  SimpleGrid,
} from '@mantine/core';
import { IconArrowRight, IconCheck } from '@tabler/icons-react';
import { useAuthStore } from '../store/auth';
import { LogoLockup } from '../components/Brand';
import { authApi } from '../api/auth';
import { notifications } from '@mantine/notifications';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const setAuth = useAuthStore((state) => state.setAuth);
  const navigate = useNavigate();

  // Роль больше не выбирают на глаз — её решает пароль конкретного логина.
  // Ошибка входа — это ошибка, а не повод пускать под тестовыми данными:
  // тот же принцип честности, что и в runWithFallback (fallback.ts).
  const handleLogin = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const { data } = await authApi.login(email, password);
      setAuth(data.accessToken, data.user, data.permissions);
      notifications.show({
        title: 'Добро пожаловать',
        message: `Вход выполнен: ${email}`,
        color: 'success',
        icon: <IconCheck size={18} />,
      });
      navigate('/dashboard');
    } catch (err: any) {
      notifications.show({
        title: 'Не удалось войти',
        message: err?.response?.data?.error?.message ?? 'Неверный email или пароль',
        color: 'danger',
      });
    } finally {
      setLoading(false);
    }
  }, [email, password, setAuth, navigate]);

  // Настоящие числа завода, а не витринные «1200+» и «24/7»:
  // конкретика — единственная статистика, которой верят
  const stats = [
    { value: '2 160', label: 'изделий в каталоге' },
    { value: '3 147', label: 'материалов с ценами партий' },
    { value: '3 866', label: 'норм труда по переделам' },
  ];

  return (
    <Box mih="100vh" bg="gray.0" style={{ overflowX: 'hidden' }}>
      <Flex mih="100vh" align="stretch" wrap="nowrap">
        <Box w="50%" display={{ base: 'none', lg: 'block' }} style={{ flex: '0 0 50%' }}>
          <Box
            mih="100vh"
            h="100%"
            bg="dark.9"
            pos="relative"
            p={{ base: 32, lg: 48, xl: 80 }}
            style={{ overflow: 'hidden' }}
          >
            {/* Медленное сияние раскалённого металла — живой фон, не отвлекает */}
            <div className="aurora" />

            <Stack justify="space-between" h="100%" pos="relative" style={{ zIndex: 1 }}>
              <Stack gap="xl">
                <LogoLockup onDark markSize={44} />

                <Stack gap="lg" mt={64}>
                  <Title order={1} c="white" fw={900} lh={1.04} style={{ fontSize: 38, letterSpacing: '-0.03em', maxWidth: 560 }}>
                    Заказ, цех и себестоимость — в одном окне
                  </Title>
                  <Text c="dark.3" size="lg" maw={480} lh={1.6}>
                    Заказы приходят из 1С, цех отмечает переделы, цена считается
                    по партиям металла. Таблица на 44 листа больше не нужна.
                  </Text>
                </Stack>
              </Stack>

              <SimpleGrid cols={{ base: 1, md: 3 }} spacing={40} mt={80}>
                {stats.map((stat) => (
                  <Stack gap={4} key={stat.label}>
                    <Text c="white" fz={28} fw={800}>{stat.value}</Text>
                    <Text c="dark.4" size="xs" fw={500} style={{ letterSpacing: '0.02em' }}>{stat.label}</Text>
                  </Stack>
                ))}
              </SimpleGrid>
            </Stack>
          </Box>
        </Box>

        <Box style={{ flex: 1, minWidth: 0 }}>
          <Container size={460} py={60} px="md" mih="100vh" display="flex" style={{ alignItems: 'center' }}>
            <Paper withBorder shadow="sm" p="xl" radius="lg" w="100%">
              <Stack gap="lg">
                <Group display={{ base: 'flex', lg: 'none' }} mb="xs">
                  <LogoLockup markSize={34} />
                </Group>

                <Stack gap={6}>
                  <Title order={2} fw={900} style={{ fontSize: 32, letterSpacing: '-0.02em' }}>
                    Вход в систему
                  </Title>
                  <Text c="dimmed" size="sm">
                    Введите данные для доступа к панели управления
                  </Text>
                </Stack>

                <form onSubmit={handleLogin}>
                  <Stack gap="md">
                    <TextInput
                      label="Email"
                      placeholder="master@avh.kz"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      size="md"
                      required
                      withAsterisk
                      autoComplete="username"
                    />
                    <PasswordInput
                      label="Пароль"
                      placeholder="Пароль вашего логина"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      size="md"
                      required
                      withAsterisk
                      autoComplete="current-password"
                    />
                    <Button
                      type="submit"
                      size="md"
                      h={48}
                      loading={loading}
                      rightSection={<IconArrowRight size={18} />}
                      loaderProps={{ type: 'dots' }}
                      mt="md"
                    >
                      Войти
                    </Button>
                  </Stack>
                </form>

                <Text ta="center" c="dimmed" size="xs" mt="md">
                  Логин и пароль выдаёт администратор
                </Text>
              </Stack>
            </Paper>
          </Container>
        </Box>
      </Flex>
    </Box>
  );
}
