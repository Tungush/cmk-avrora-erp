import React from 'react';
import { useAuthStore } from '../store/auth';

interface RoleGateProps {
  roles: string[];
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

/**
 * Conditionally renders children if the current user has any of the required roles.
 * 'admin' role always bypasses.
 */
export function RoleGate({ roles, children, fallback = null }: RoleGateProps) {
  const hasRole = useAuthStore((state) => state.hasRole(roles));

  if (!hasRole) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}
