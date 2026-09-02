import React, { useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  TextInput, PasswordInput, Button, Text, Stack, Group, Box, Badge,
} from '@mantine/core';
import { IconArrowRight, IconCheck, IconShieldLock } from '@tabler/icons-react';
import { motion } from 'framer-motion';
import { useAuthStore } from '../store/auth';
import { LogoMark } from '../components/Brand';
import { authApi } from '../api/auth';
import { notifications } from '@mantine/notifications';
import { useCursorLight, useMagnetic } from '../components/Aurora';
import { useMotionOff } from '../components/motion';
import { Mast } from '../components/Mast';

// Общий PIN на восемь операционных ролей убран (30.08.2026, решение
// пользователя): у каждого человека личный email+пароль, заводит и
// меняет роли Settings → Пользователи (users.controller.ts).

/** Настоящие числа завода, а не витринные «1200+» и «24/7» */
const STATS = [
  { value: '2 160', label: 'изделий в каталоге' },
  { value: '3 147', label: 'материалов с ценами партий' },
  { value: '3 866', label: 'норм труда' },
];

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const reduced = useMotionOff();

  useCursorLight();
  useMagnetic(submitRef, 4);

  const setAuth = useAuthStore((state) => state.setAuth);
  const navigate = useNavigate();

  /** Слои сцены сдвигаются за курсором на разную глубину — параллакс */
  const onSceneMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (reduced) return;
    const el = sceneRef.current;
    if (!el) return;
    const dx = e.clientX / window.innerWidth - 0.5;
    const dy = e.clientY / window.innerHeight - 0.5;
    el.style.setProperty('--par-x', `${dx * 26}px`);
    el.style.setProperty('--par-y', `${dy * 26}px`);
  }, [reduced]);

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
      navigate('/'); // Моя работа — единственный экран, с которого начинается день
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

  const rise = (delay: number) => (reduced
    ? {}
    : {
      initial: { opacity: 0, y: 18 },
      animate: { opacity: 1, y: 0 },
      transition: { duration: 0.6, delay, ease: [0.25, 1, 0.5, 1] as const },
    });

  return (
    <div className="login-scene" ref={sceneRef} onPointerMove={onSceneMove}>
      {/* Сияние раскалённого металла: три пятна на разной глубине */}
      <div className="login-scene__glow login-scene__glow--a" style={{ transform: 'translate3d(calc(var(--par-x, 0px) * -1), calc(var(--par-y, 0px) * -1), 0)' }} />
      <div className="login-scene__glow login-scene__glow--b" style={{ transform: 'translate3d(var(--par-x, 0px), var(--par-y, 0px), 0)' }} />
      <div className="login-scene__glow login-scene__glow--c" />
      <div className="login-scene__grid" />

      <Box
        mih="100vh"
        px={{ base: 20, md: 40 }}
        py={{ base: 40, md: 56 }}
        style={{ position: 'relative', zIndex: 1, display: 'grid', placeItems: 'center' }}
      >
        <div style={{ width: '100%', maxWidth: 1340 }}>
          <Group justify="space-between" align="center" wrap="wrap" gap={48}>

            {/* Мачта под базовую станцию: то, что завод и делает. Секции
                встают снизу вверх, как при монтаже, потом поднимаются
                антенны и загорается авиационный огонь */}
            <Box className="login-mast" visibleFrom="lg">
              <Mast height={560} sections={8} stroke={1.9} />
            </Box>

            {/* Средняя колонна: обещание системы */}
            <Box style={{ flex: '1 1 380px', minWidth: 0, maxWidth: 520 }} visibleFrom="md">
              <motion.div {...rise(0)}>
                <Group gap={14} wrap="nowrap" mb={48}>
                  <LogoMark size={44} color="#F5A623" />
                  <Stack gap={2}>
                    <Text fw={800} c="white" size="lg" lh={1} style={{ letterSpacing: '0.02em' }}>
                      АВРОРА
                    </Text>
                    <Text size="xs" fw={600} lh={1}
                      style={{ letterSpacing: '0.3em', color: 'rgba(255,255,255,0.5)' }}>
                      ЦМК·ERP
                    </Text>
                  </Stack>
                </Group>
              </motion.div>

              <motion.div {...rise(0.08)}>
                <Text
                  component="h1"
                  className="login-title"
                  fw={900}
                  style={{ fontSize: 'clamp(34px, 4.2vw, 54px)', lineHeight: 1.06, margin: 0 }}
                >
                  Заказ, цех и себестоимость —<br />в одном окне
                </Text>
              </motion.div>

              <motion.div {...rise(0.16)}>
                <Text mt={24} size="lg" lh={1.65} style={{ color: 'rgba(255,255,255,0.62)', maxWidth: 460 }}>
                  Заказы приходят из 1С, цех отмечает работы, цена считается
                  по партиям металла. Таблица на 44 листа больше не нужна.
                </Text>
              </motion.div>

              <motion.div {...rise(0.24)}>
                <Group gap={40} mt={56} wrap="wrap">
                  {STATS.map((s) => (
                    <Stack gap={4} key={s.label}>
                      <Text fw={800} c="white" style={{ fontSize: 30, letterSpacing: '-0.02em' }}>
                        {s.value}
                      </Text>
                      <Text size="sm" style={{ color: 'rgba(255,255,255,0.45)' }}>{s.label}</Text>
                    </Stack>
                  ))}
                </Group>
              </motion.div>
            </Box>

            {/* Правая колонна: стеклянная панель входа */}
            <Box style={{ flex: '0 1 420px', width: '100%', maxWidth: 440 }}>
              <motion.div
                {...(reduced ? {} : {
                  initial: { opacity: 0, y: 26, scale: 0.98 },
                  animate: { opacity: 1, y: 0, scale: 1 },
                  transition: { duration: 0.7, delay: 0.1, ease: [0.25, 1, 0.5, 1] as const },
                })}
              >
                <div className="login-card">
                  <Box p={{ base: 24, sm: 36 }}>
                    <Stack gap="xl">
                      <Group gap={12} hiddenFrom="md">
                        <LogoMark size={34} color="#F5A623" />
                        <Text fw={800} c="white" size="lg">АВРОРА</Text>
                      </Group>

                      <Stack gap={8}>
                        <Badge
                          variant="light"
                          radius="xl"
                          leftSection={<IconShieldLock size={13} />}
                          style={{
                            background: 'rgba(245, 166, 35, 0.14)',
                            color: '#F5C542',
                            border: '1px solid rgba(245, 166, 35, 0.25)',
                            width: 'fit-content',
                          }}
                        >
                          Личный доступ
                        </Badge>
                        <Text component="h2" fw={800} c="white"
                          style={{ fontSize: 30, letterSpacing: '-0.02em', margin: 0 }}>
                          Вход в систему
                        </Text>
                        <Text size="sm" style={{ color: 'rgba(255,255,255,0.5)' }}>
                          Личный email и пароль — их выдаёт администратор
                        </Text>
                      </Stack>

                      <form onSubmit={handleLogin}>
                        <Stack gap="md">
                          <TextInput
                            label="Email"
                            placeholder="name@avh.kz"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            size="md"
                            required
                            autoComplete="username"
                            autoFocus
                          />
                          <PasswordInput
                            label="Пароль"
                            placeholder="Пароль вашего логина"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            size="md"
                            required
                            autoComplete="current-password"
                          />
                          <Button
                            ref={submitRef}
                            className="magnetic"
                            type="submit"
                            size="md"
                            h={52}
                            fullWidth
                            loading={loading}
                            rightSection={<IconArrowRight size={18} />}
                            loaderProps={{ type: 'dots' }}
                            mt="sm"
                          >
                            Войти
                          </Button>
                        </Stack>
                      </form>
                    </Stack>
                  </Box>
                </div>
              </motion.div>
            </Box>
          </Group>
        </div>
      </Box>
    </div>
  );
}
