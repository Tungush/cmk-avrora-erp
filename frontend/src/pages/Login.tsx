import React, { useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { TextInput, PasswordInput, Button, Text } from '@mantine/core';
import { IconArrowRight, IconCheck } from '@tabler/icons-react';
import { motion } from 'framer-motion';
import { useAuthStore } from '../store/auth';
import { LogoMark } from '../components/Brand';
import { authApi } from '../api/auth';
import { notifications } from '@mantine/notifications';
import { useMagnetic } from '../components/Aurora';
import { useMotionOff } from '../components/motion';

// Общий PIN на восемь операционных ролей убран (30.08.2026, решение
// пользователя): у каждого человека личный email+пароль, заводит и
// меняет роли Settings → Пользователи (users.controller.ts).

/** Настоящие числа завода, а не витринные «1200+» и «24/7» */
const STATS = [
  { value: '2 160', label: 'изделий в каталоге' },
  { value: '3 147', label: 'материалов с ценами партий' },
  { value: '3 866', label: 'норм труда' },
];

/**
 * Экран входа (переписан 05.09.2026: «продумать по-другому, красивее и
 * стильнее»).
 *
 * Было: тёмная панель с параграфом и жёлтый чип «Личный доступ». Стало:
 * один светлый холст с двумя мягкими свечениями акцентов — тем же, что
 * и внутри сервиса, — слева крупная типографика бренда (Manrope), справа
 * карточка формы с рамкой, без стекла, теней и света за курсором.
 * Ничего не движется в покое: подъём при появлении — единственная
 * анимация, и она выключается вместе с reduced-motion.
 */
export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const reduced = useMotionOff();
  useMagnetic(submitRef, 4);

  const setAuth = useAuthStore((state) => state.setAuth);
  const navigate = useNavigate();

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
      initial: { opacity: 0, y: 14 },
      animate: { opacity: 1, y: 0 },
      transition: { duration: 0.55, delay, ease: [0.25, 1, 0.5, 1] as const },
    });

  return (
    <div className="login-scene">
      <div className="login-scene__glow login-scene__glow--a" aria-hidden />
      <div className="login-scene__glow login-scene__glow--b" aria-hidden />
      <div className="login-scene__grid" aria-hidden />

      <div className="login-split">
        {/* Слева — бренд крупной типографикой, без параграфов */}
        <motion.section className="login-brand" aria-label="ЦМК АВРОРА" {...rise(0)}>
          <div className="login-brand__mark">
            <LogoMark size={44} color="var(--p-rose-ink)" />
            <div>
              <div className="login-brand__name">АВРОРА</div>
              <div className="login-brand__sub">ЦМК · ERP</div>
            </div>
          </div>
          <h1 className="login-brand__title">Заказ, цех и себестоимость — в&nbsp;одном окне.</h1>
          <dl className="login-brand__stats">
            {STATS.map((s) => (
              <div key={s.label}>
                <dt>{s.label}</dt>
                <dd>{s.value}</dd>
              </div>
            ))}
          </dl>
        </motion.section>

        {/* Справа — карточка формы */}
        <motion.div className="login-card" {...rise(0.08)}>
          <div className="login-card__eyebrow">Вход</div>
          <Text component="h2" className="login-card__title">Добро пожаловать</Text>
          <Text size="sm" c="dimmed" mb={22}>Личный email и пароль выдаёт администратор</Text>

          <form onSubmit={handleLogin} className="login-form">
            <TextInput
              label="Email"
              placeholder="name@avh.kz"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              size="md"
              radius="md"
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
              radius="md"
              required
              autoComplete="current-password"
            />
            <Button
              ref={submitRef}
              className="magnetic"
              type="submit"
              size="md"
              radius="xl"
              h={48}
              fullWidth
              loading={loading}
              rightSection={<IconArrowRight aria-hidden size={18} />}
              loaderProps={{ type: 'dots' }}
              mt={6}
            >
              Войти
            </Button>
          </form>
        </motion.div>
      </div>
    </div>
  );
}
