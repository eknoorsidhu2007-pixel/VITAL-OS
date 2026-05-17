"use client";

import * as React from "react";

import { useAuth } from "@/components/auth-provider";
import { LoginScreen } from "@/components/auth-context";

export function AppGate({ children }: { children: React.ReactNode }) {
  const { role } = useAuth();

  if (!role) {
    return <LoginScreen />;
  }

  return <>{children}</>;
}
