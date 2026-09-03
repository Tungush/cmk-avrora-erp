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

/**
 * Тихий текст на бежевой панели входа (03.09.2026).
 *
 * `--s-text-quiet` рассчитан на кремовый холст и на беже даёт всего
 * 3,55:1. Разбавленные чернила на 80 % дают 4,80:1 — то же ощущение
 * «тише основного», но читаемо. Белого здесь быть не может: панель
 * светлая, и белым текстом на ней было 1,43–1,71:1.
 */
const HERO_QUIET = 'color-mix(in srgb, var(--s-text-on-panel) 80%, transparent)';

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
        icon: <IconCheck aria-hidden size={20} />,
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
      {/* Слева — голубая панель с обещанием системы и мачтой, справа белая
          карточка входа на сером холсте. Так устроен и сам референс */}
      <div className="login-split">
        <div className="login-hero">
          {/* Мачта под базовую станцию: то, что завод и делает. Секции
              встают снизу вверх, как при монтаже, потом поднимаются
              антенны и загорается авиационный огонь */}
          <div className="login-mast" aria-hidden>
            <Mast height={520} sections={8} stroke={1.9} signal />
          </div>

          <div className="login-hero__text">
            <motion.div {...rise(0)}>
                <Group gap={14} wrap="nowrap" mb={40}>
                  {/* 03.09.2026: знак был кислотно-жёлтым #DDFD2C из старой
                      палитры — на беже это 1,48:1, пятно без формы. Белый
                      текст рядом давал 1,71:1. Панель бежевая, значит текст
                      на ней чернильный: 7,6:1 */}
                  <LogoMark size={44} color="var(--s-attention)" />
                  <Stack gap={2}>
                    <Text fw={700} size="lg" lh={1} style={{ letterSpacing: '0.02em', color: 'var(--s-text-on-panel)' }}>
                      АВРОРА
                    </Text>
                    <Text size="xs" fw={600} lh={1}
                      style={{ letterSpacing: '0.3em', color: HERO_QUIET }}>
                      ЦМК·ERP
                    </Text>
                  </Stack>
                </Group>
              </motion.div>

              <motion.div {...rise(0.04)}>
                <span className="mark" style={{ marginBottom: 14, display: 'inline-flex' }}>
                  Завод металлоконструкций
                </span>
              </motion.div>

              <motion.div {...rise(0.08)}>
                <Text
                  component="h1"
                  className="login-title"
                  fw={300}
                  style={{ fontSize: 'clamp(30px, 3.2vw, 44px)', lineHeight: 1.12, margin: '10px 0 0', color: 'var(--s-text-on-panel)' }}
                >
                  Заказ, цех и себестоимость —<br />в одном окне
                </Text>
              </motion.div>

              <motion.div {...rise(0.16)}>
                <Text mt={24} size="lg" lh={1.65} style={{ color: HERO_QUIET, maxWidth: 460 }}>
                  Заказы приходят из 1С, цех отмечает работы, цена считается
                  по партиям металла. Таблица на 44 листа больше не нужна.
                </Text>
              </motion.div>

              <motion.div {...rise(0.24)}>
                <Group gap={30} mt={44} wrap="nowrap">
                  {STATS.map((s) => (
                    <Stack gap={4} key={s.label}>
                      <Text fw={300} style={{ fontSize: 28, letterSpacing: '-0.03em', whiteSpace: 'nowrap', color: 'var(--s-text-on-panel)' }}>
                        {s.value}
                      </Text>
                      <Text size="xs" style={{ color: HERO_QUIET }}>{s.label}</Text>
                    </Stack>
                  ))}
                </Group>
              </motion.div>
          </div>
        </div>

        {/* Правая половина: белая карточка на сером холсте */}
        <div className="login-form-side">
          <div className="login-scene__glow login-scene__glow--a" />
          <div className="login-scene__glow login-scene__glow--b" />
          <div className="login-scene__grid" />
          <Box style={{ width: '100%', maxWidth: 420, position: 'relative', zIndex: 1 }}>
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
                        <LogoMark size={34} color="var(--s-text)" />
                        <Text fw={700} size="lg">АВРОРА</Text>
                      </Group>

                      <Stack gap={8}>
                        <Badge
                          variant="light"
                          radius="xl"
                          leftSection={<IconShieldLock aria-hidden size={16} />}
                          style={{
                            background: 'var(--c-yellow)',
                            color: 'var(--s-text)',
                            border: 'none',
                            width: 'fit-content',
                          }}
                        >
                          Личный доступ
                        </Badge>
                        <Text component="h2" fw={300}
                          style={{ fontSize: 30, letterSpacing: '-0.03em', margin: 0 }}>
                          Вход в систему
                        </Text>
                        <Text size="sm" c="dimmed">
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
                            rightSection={<IconArrowRight aria-hidden size={20} />}
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
        </div>
      </div>
    </div>
  );
}
