import React, { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Container,
  Paper,
  TextInput,
  PasswordInput,
  PinInput,
  Button,
  Title,
  Text,
  Stack,
  Group,
  Box,
  Flex,
  SimpleGrid,
  SegmentedControl,
} from '@mantine/core';
import { IconArrowRight, IconCheck } from '@tabler/icons-react';
import { useAuthStore } from '../store/auth';
import { LogoLockup } from '../components/Brand';
import { authApi } from '../api/auth';
import { notifications } from '@mantine/notifications';

// Общий вход «для остальных» (24.08.2026, решение пользователя): один PIN
// на восемь операционных ролей вместо личных паролей — люди меняются,
// поимённый учёт не нужен. Личный email+пароль остаётся только у
// директора и администратора (setup-shared-login.ts / rotate-passwords.ts).
const SHARED_LOGIN_EMAIL = 'smena@avh.kz';

export function Login() {
  const [mode, setMode] = useState<'shared' | 'personal'>('shared');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(false);

  const setAuth = useAuthStore((state) => state.setAuth);
  const navigate = useNavigate();

  // Роль больше не выбирают на глаз — её решает то, каким входом вошли.
  // Ошибка входа — это ошибка, а не повод пускать под тестовыми данными:
  // тот же принцип честности, что и в runWithFallback (fallback.ts).
  const doLogin = useCallback(async (loginEmail: string, loginPassword: string) => {
    setLoading(true);
    try {
      const { data } = await authApi.login(loginEmail, loginPassword);
      setAuth(data.accessToken, data.user, data.permissions);
      notifications.show({
        title: 'Добро пожаловать',
        message: `Вход выполнен: ${loginEmail}`,
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
  }, [setAuth, navigate]);

  const handlePersonalLogin = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    doLogin(email, password);
  }, [email, password, doLogin]);

  const handlePinComplete = useCallback((value: string) => {
    doLogin(SHARED_LOGIN_EMAIL, value);
  }, [doLogin]);

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
                    {mode === 'shared' ? 'Общий PIN цеха, склада и офиса' : 'Личный вход директора и администратора'}
                  </Text>
                </Stack>

                <SegmentedControl
                  fullWidth
                  size="md"
                  value={mode}
                  onChange={(v) => setMode(v as 'shared' | 'personal')}
                  data={[
                    { value: 'shared', label: 'Цех и офис' },
                    { value: 'personal', label: 'Личный вход' },
                  ]}
                />

                {mode === 'shared' ? (
                  <Stack gap="md" align="center">
                    <PinInput
                      length={6}
                      type="number"
                      size="xl"
                      value={pin}
                      onChange={setPin}
                      onComplete={handlePinComplete}
                      disabled={loading}
                      autoFocus
                    />
                    <Button
                      size="md"
                      h={48}
                      w="100%"
                      loading={loading}
                      disabled={pin.length !== 6}
                      onClick={() => handlePinComplete(pin)}
                      rightSection={<IconArrowRight size={18} />}
                      loaderProps={{ type: 'dots' }}
                    >
                      Войти
                    </Button>
                  </Stack>
                ) : (
                  <form onSubmit={handlePersonalLogin}>
                    <Stack gap="md">
                      <TextInput
                        label="Email"
                        placeholder="director@avh.kz"
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
                )}

                <Text ta="center" c="dimmed" size="xs" mt="md">
                  {mode === 'shared' ? 'PIN один на всех, кроме директора и администратора' : 'Логин и пароль выдаёт администратор'}
                </Text>
              </Stack>
            </Paper>
          </Container>
        </Box>
      </Flex>
    </Box>
  );
}
