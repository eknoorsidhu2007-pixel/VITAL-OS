"use client";

import * as React from "react";
import { ArrowLeft, Eye, EyeOff, Shield, Stethoscope, UserRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { VitalLogo } from "@/components/vital-logo";
import {
  INVALID_DOCTOR_LOGIN_MESSAGE,
  INVALID_STAFF_LOGIN_MESSAGE,
  useAuth,
} from "@/components/auth-provider";
import type { VitalRole } from "@/lib/auth";

const VITAL_BACKGROUND_STYLE: React.CSSProperties = {
  backgroundColor: "hsl(260 42% 4%)",
  backgroundImage:
    "radial-gradient(1100px 720px at 12% -15%, hsl(270 85% 26% / 0.5), transparent 58%), radial-gradient(880px 640px at 102% 8%, hsl(312 75% 22% / 0.38), transparent 52%), radial-gradient(900px 520px at 48% 108%, hsl(217 90% 24% / 0.28), transparent 55%), linear-gradient(165deg, hsl(260 44% 5%) 0%, hsl(265 42% 3%) 45%, hsl(260 48% 4%) 100%)",
  backgroundAttachment: "fixed",
};

const LOGIN_INPUT_CLASS =
  "w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-left text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-clinical-teal/40 focus:ring-1 focus:ring-clinical-teal/30";

const ROLE_OPTIONS: Array<{
  role: VitalRole;
  title: string;
  description: string;
  icon: React.ReactNode;
}> = [
  {
    role: "doctor",
    title: "Doctor",
    description: "Sign in with your Doctor ID and username.",
    icon: <Stethoscope className="h-5 w-5 text-clinical-teal" aria-hidden />,
  },
  {
    role: "staff",
    title: "Staff",
    description: "Sign in with your Staff ID and username.",
    icon: <UserRound className="h-5 w-5 text-clinical-cyan" aria-hidden />,
  },
];

type LoginStep = "role" | "doctor" | "staff";

const CREDENTIAL_FORMS: Record<
  Exclude<LoginStep, "role">,
  {
    signInLabel: string;
    heading: string;
    idLabel: string;
    idPlaceholder: string;
    submitAccent: string;
    invalidMessage: string;
  }
> = {
  doctor: {
    signInLabel: "Doctor sign-in",
    heading: "Enter your Doctor ID",
    idLabel: "Doctor ID",
    idPlaceholder: "Enter your Doctor ID",
    submitAccent: "bg-clinical-teal/90 text-primary-foreground hover:bg-clinical-teal",
    invalidMessage: INVALID_DOCTOR_LOGIN_MESSAGE,
  },
  staff: {
    signInLabel: "Staff sign-in",
    heading: "Enter your Staff ID",
    idLabel: "Staff ID",
    idPlaceholder: "Enter your Staff ID",
    submitAccent: "bg-clinical-cyan/90 text-primary-foreground hover:bg-clinical-cyan",
    invalidMessage: INVALID_STAFF_LOGIN_MESSAGE,
  },
};

export function LoginScreen() {
  const { loginDoctor, loginStaff } = useAuth();
  const [step, setStep] = React.useState<LoginStep>("role");
  const [fullName, setFullName] = React.useState("");
  const [credentialId, setCredentialId] = React.useState("");
  const [showCredentialId, setShowCredentialId] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const handleRoleSelect = (role: VitalRole) => {
    setError(null);
    setFullName("");
    setCredentialId("");
    setShowCredentialId(false);
    if (role === "doctor") {
      setStep("doctor");
      return;
    }
    setStep("staff");
  };

  const handleCredentialLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (step === "role") return;

    const form = CREDENTIAL_FORMS[step];
    setError(null);
    const name = fullName.trim();
    const id = credentialId.trim();
    if (!name || !id) {
      setError(form.invalidMessage);
      return;
    }
    setSubmitting(true);
    const ok =
      step === "doctor" ? loginDoctor(name, id) : loginStaff(name, id);
    setSubmitting(false);
    if (!ok) {
      setError(form.invalidMessage);
    }
  };

  const handleBack = () => {
    setStep("role");
    setError(null);
    setFullName("");
    setCredentialId("");
    setShowCredentialId(false);
  };

  const credentialForm = step !== "role" ? CREDENTIAL_FORMS[step] : null;

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
          {step === "role" ? (
            <>
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
                    onClick={() => handleRoleSelect(option.role)}
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
            </>
          ) : credentialForm ? (
            <>
              <div className="w-full space-y-2 text-center">
                <p className="mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
                  {credentialForm.signInLabel}
                </p>
                <h1 className="text-xl font-semibold tracking-tight text-gradient-clinical">
                  {credentialForm.heading}
                </h1>
                <p className="text-sm text-muted-foreground">
                  Demo credentials only — use your assigned username and ID.
                </p>
              </div>
              <form
                onSubmit={handleCredentialLogin}
                className="flex w-full flex-col gap-4 text-left"
              >
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    Username
                  </span>
                  <input
                    type="text"
                    value={fullName}
                    onChange={(e) => {
                      setFullName(e.target.value);
                      setError(null);
                    }}
                    autoComplete="username"
                    placeholder="Enter your username"
                    className={LOGIN_INPUT_CLASS}
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    {credentialForm.idLabel}
                  </span>
                  <div className="relative">
                    <input
                      type={showCredentialId ? "text" : "password"}
                      inputMode="numeric"
                      value={credentialId}
                      onChange={(e) => {
                        setCredentialId(e.target.value);
                        setError(null);
                      }}
                      autoComplete="off"
                      placeholder={credentialForm.idPlaceholder}
                      className={`${LOGIN_INPUT_CLASS} pr-10`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowCredentialId((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground transition hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-clinical-teal/40"
                      aria-label={showCredentialId ? "Hide ID" : "Show ID"}
                    >
                      {showCredentialId ? (
                        <EyeOff className="h-4 w-4" aria-hidden />
                      ) : (
                        <Eye className="h-4 w-4" aria-hidden />
                      )}
                    </button>
                  </div>
                </label>
                {error ? (
                  <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {error}
                  </p>
                ) : null}
                <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleBack}
                    className="inline-flex items-center gap-2 border-white/10 bg-white/[0.03] text-foreground hover:bg-white/[0.06]"
                  >
                    <ArrowLeft className="h-4 w-4" aria-hidden />
                    Back
                  </Button>
                  <Button
                    type="submit"
                    disabled={submitting}
                    className={credentialForm.submitAccent}
                  >
                    {submitting ? "Signing in…" : "Login"}
                  </Button>
                </div>
              </form>
            </>
          ) : null}
          <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <Shield className="h-3.5 w-3.5 text-clinical-mint" aria-hidden />
            Demo workstation sign-in — not for production use.
          </p>
        </div>
      </div>
    </main>
  );
}
