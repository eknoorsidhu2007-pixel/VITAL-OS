"use client";

import * as React from "react";

import type { VitalRole } from "@/lib/auth";
import { ACCESS_RESTRICTED_MESSAGE } from "@/lib/auth";

export type { VitalRole };
export { ACCESS_RESTRICTED_MESSAGE };

type AuthContextValue = {
  role: VitalRole | null;
  login: (role: VitalRole) => void;
  logout: () => void;
};

const AuthContext = React.createContext<AuthContextValue | null>(null);

const STORAGE_KEY = "vital-os-role";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [role, setRole] = React.useState<VitalRole | null>(null);

  React.useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem(STORAGE_KEY);
      if (stored === "doctor" || stored === "staff") {
        setRole(stored);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const login = React.useCallback((next: VitalRole) => {
    setRole(next);
    try {
      window.sessionStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const logout = React.useCallback(() => {
    setRole(null);
    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <AuthContext.Provider value={{ role, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
