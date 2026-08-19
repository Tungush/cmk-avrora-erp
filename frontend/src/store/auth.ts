import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { UserPayload } from '../types';
import { permissionsForRoles } from '../utils/fieldAccess';

interface AuthState {
  token: string | null;
  user: UserPayload | null;
  /** Права на группы полей: "order.commercial:write" и т.п. (§1 07_ARCHITECTURE_AND_UX.md) */
  permissions: string[];
  setAuth: (token: string, user: UserPayload, permissions?: string[]) => void;
  logout: () => void;
  hasRole: (roles: string[]) => boolean;
  /** Проверка права: can('write', 'order.commercial') */
  can: (action: 'read' | 'write' | 'approve', target: string) => boolean;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,
      permissions: [],
      setAuth: (token: string, user: UserPayload, permissions?: string[]) =>
        set({
          token,
          user,
          // permissions приходят с бэкенда; в демо-режиме вычисляются из ролей локально
          permissions: permissions ?? permissionsForRoles(user.roles),
        }),
      logout: () => set({ token: null, user: null, permissions: [] }),
      hasRole: (roles: string[]) => {
        const user = get().user;
        if (!user) return false;
        if (user.roles.includes('admin')) return true;
        return roles.some((r) => user.roles.includes(r));
      },
      can: (action, target) => get().permissions.includes(`${target}:${action}`),
    }),
    {
      name: 'auth-storage',
      // у старых сессий permissions в сторадже нет — восстанавливаем из ролей
      merge: (persisted, current) => {
        const state = { ...current, ...(persisted as Partial<AuthState>) };
        if (state.user && (!state.permissions || state.permissions.length === 0)) {
          state.permissions = permissionsForRoles(state.user.roles);
        }
        return state as AuthState;
      },
    }
  )
);
