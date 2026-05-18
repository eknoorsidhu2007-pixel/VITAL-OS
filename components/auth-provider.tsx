"use client";

import * as React from "react";

import {
  buildDoctorUser,
  buildStaffUser,
  findDemoDoctor,
  findDemoStaff,
  getPermissions,
  isVitalUser,
  type VitalPermissions,
  type VitalRole,
  type VitalUser,
} from "@/lib/auth";

export type { VitalRole, VitalUser, VitalPermissions };
export {
  ACCESS_RESTRICTED_MESSAGE,
  AI_ASSISTANT_RESTRICTED_MESSAGE,
  INVALID_DOCTOR_LOGIN_MESSAGE,
  INVALID_STAFF_LOGIN_MESSAGE,
} from "@/lib/auth";

type AuthContextValue = {
  user: VitalUser | null;
  role: VitalRole | null;
  permissions: VitalPermissions;
  loginDoctor: (fullName: string, doctorId: string) => boolean;
  loginStaff: (fullName: string, staffId: string) => boolean;
  logout: () => void;
  hydrated: boolean;
};

const AuthContext = React.createContext<AuthContextValue | null>(null);

const STORAGE_KEY = "vital-os-user";
const LEGACY_ROLE_KEY = "vital-os-role";

function readStoredUser(): VitalUser | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isVitalUser(parsed)) {
        if (parsed.role === "doctor" && !parsed.doctorId) return null;
        if (parsed.role === "staff" && !parsed.staffId) return null;
        return parsed;
      }
    }

    const legacyRole = window.sessionStorage.getItem(LEGACY_ROLE_KEY);
    if (legacyRole === "staff" || legacyRole === "doctor") {
      window.sessionStorage.removeItem(LEGACY_ROLE_KEY);
    }
  } catch {
    /* ignore */
  }
  return null;
}

function persistUser(user: VitalUser | null) {
  try {
    if (user) {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(user));
    } else {
      window.sessionStorage.removeItem(STORAGE_KEY);
    }
    window.sessionStorage.removeItem(LEGACY_ROLE_KEY);
  } catch {
    /* ignore */
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<VitalUser | null>(null);
  const [hydrated, setHydrated] = React.useState(false);

  React.useEffect(() => {
    setUser(readStoredUser());
    setHydrated(true);
  }, []);

  const loginDoctor = React.useCallback((fullName: string, doctorId: string) => {
    const account = findDemoDoctor(fullName, doctorId);
    if (!account) return false;
    const next = buildDoctorUser(account);
    setUser(next);
    persistUser(next);
    return true;
  }, []);

  const loginStaff = React.useCallback((fullName: string, staffId: string) => {
    const account = findDemoStaff(fullName, staffId);
    if (!account) return false;
    const next = buildStaffUser(account);
    setUser(next);
    persistUser(next);
    return true;
  }, []);

  const logout = React.useCallback(() => {
    setUser(null);
    persistUser(null);
  }, []);

  const role = user?.role ?? null;
  const permissions = getPermissions(role);

  return (
    <AuthContext.Provider
      value={{
        user,
        role,
        permissions,
        loginDoctor,
        loginStaff,
        logout,
        hydrated,
      }}
    >
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
