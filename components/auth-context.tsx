"use client";

import * as React from "react";
import { Shield, Stethoscope, UserRound } from "lucide-react";

import { VitalLogo } from "@/components/vital-logo";
import { useAuth } from "@/components/auth-provider";
import type { VitalRole } from "@/lib/auth";

const VITAL_BACKGROUND_STYLE: React.CSSProperties = {
  backgroundColor: "hsl(260 42% 4%)",
  backgroundImage:
    "radial-gradient(1100px 720px at 12% -15%, hsl(270 85% 26% / 0.5), transparent 58%), radial-gradient(880px 640px at 102% 8%, hsl(312 75% 22% / 0.38), transparent 52%), radial-gradient(900px 520px at 48% 108%, hsl(217 90% 24% / 0.28), transparent 55%), linear-gradient(165deg, hsl(260 44% 5%) 0%, hsl(265 42% 3%) 45%, hsl(260 48% 4%) 100%)",
  backgroundAttachment: "fixed",
};

const ROLE_OPTIONS: Array<{
  role: VitalRole;
  title: string;
  description: string;
  icon: React.ReactNode;
}> = [
  {
    role: "doctor",
    title: "Doctor",
    description: "Full chart access, roster tools, and clinical AI.",
    icon: <Stethoscope className="h-5 w-5 text-clinical-teal" aria-hidden />,
  },
  {
    role: "staff",
    title: "Staff",
    description: "Workspace access with supervised patient-data restrictions.",
    icon: <UserRound className="h-5 w-5 text-clinical-cyan" aria-hidden />,
  },
];

export function LoginScreen() {
  const { login } = useAuth();

  return (
    <main
      className="relative min-h-screen overflow-hidden text-foreground"
      style={VITAL_BACKGROUND_STYLE}
      suppressHydrationWarning
    >
      <div className="grid-bg pointer-events-none absolute inset-0 opacity-40" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-clinical-teal/50 via-clinical-mint/40 to-transparent" />

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-[1480px] flex-col items-center justify-center gap-4 px-4 py-5 lg:px-8 lg:py-7">
        <div className="panel flex w-full max-w-lg flex-col items-center gap-6 px-8 py-10 text-center">
          <VitalLogo className="h-10 w-auto" />
          <div className="space-y-2">
            <p className="mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
              Secure sign-in
            </p>
            <h1 className="text-xl font-semibold tracking-tight text-gradient-clinical">
              Choose your role
            </h1>
            <p className="text-sm text-muted-foreground">
              Select how you are using VITAL OS on this device.
            </p>
          </div>
          <div className="grid w-full gap-3 sm:grid-cols-2">
            {ROLE_OPTIONS.map((option) => (
              <button
                key={option.role}
                type="button"
                onClick={() => login(option.role)}
                className="group flex h-auto min-h-[9.5rem] flex-col items-start gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-4 text-left transition duration-200 hover:border-clinical-teal/40 hover:clinical-glow focus-visible:outline-none focus-visible:ring-clinical"
              >
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  {option.icon}
                  {option.title}
                </span>
                <span className="text-xs leading-relaxed text-muted-foreground">
                  {option.description}
                </span>
              </button>
            ))}
          </div>
          <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <Shield className="h-3.5 w-3.5 text-clinical-mint" aria-hidden />
            Demo role selection for this workstation session.
          </p>
        </div>
      </div>
    </main>
  );
}
