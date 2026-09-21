"use client";

import * as React from "react";
import { Eye, EyeOff, Shield, TestTube2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { VitalLogo } from "@/components/vital-logo";
import { useAuth } from "@/components/auth-provider";

const DEMO_EMAIL = "dr.sarah.wilson@test.com";
const DEMO_PASSWORD = "VitalOS2026!Doctor";

export function LoginScreen() {
  const { login } = useAuth();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const fillDemoCredentials = () => {
    setEmail(DEMO_EMAIL);
    setPassword(DEMO_PASSWORD);
    setError(null);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedEmail = email.trim();

    if (!trimmedEmail || !password) {
      setError("Enter your email and password.");
      return;
    }

    setSubmitting(true);
    const result = await login(trimmedEmail, password);
    setSubmitting(false);

    if (!result.ok) {
      setError(result.message);
      setPassword("");
    }
  };

  return (
    <main
      className="relative min-h-screen bg-background text-foreground"
      suppressHydrationWarning
    >
      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-[1480px] flex-col items-center justify-center gap-4 px-4 py-5 lg:px-8 lg:py-7">
        <div className="vital-card flex w-full max-w-lg flex-col items-center gap-6 px-8 py-10 text-center">
          <VitalLogo
            className="h-11 w-auto"
            textClassName="text-lg font-medium tracking-tight text-foreground"
          />

          <div className="w-full space-y-2 text-center">
            <p className="vital-footnote uppercase tracking-[0.16em]">
              Secure sign-in
            </p>

            <h1 className="vital-h1 text-xl">Sign in to VITAL OS</h1>

            <p className="vital-body">
              Use your clinical account or the demonstration account below.
            </p>
          </div>

          <div className="w-full rounded-xl border border-primary/20 bg-primary/5 p-4 text-left">
            <div className="flex items-center gap-2">
              <TestTube2
                className="h-4 w-4 text-primary"
                aria-hidden="true"
              />
              <p className="text-sm font-semibold">Recruiter Demo Account</p>
            </div>

            <p className="mt-1 text-xs text-muted-foreground">
              Explore VITAL OS using synthetic patient records.
            </p>

            <dl className="mt-3 space-y-2 rounded-lg border border-border/60 bg-background/60 p-3 text-xs">
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-muted-foreground">Email</dt>
                <dd className="font-mono">{DEMO_EMAIL}</dd>
              </div>

              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-muted-foreground">Password</dt>
                <dd className="font-mono">{DEMO_PASSWORD}</dd>
              </div>
            </dl>

            <Button
              type="button"
              variant="outline"
              className="mt-3 w-full"
              onClick={fillDemoCredentials}
            >
              Fill Demo Credentials
            </Button>
          </div>

          <form
            onSubmit={handleLogin}
            className="flex w-full flex-col gap-5 text-left"
          >
            <label className="space-y-1.5">
              <span className="vital-label">Email</span>

              <input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError(null);
                }}
                autoComplete="username"
                placeholder="you@hospital.org"
                className="vital-input"
              />
            </label>

            <label className="space-y-1.5">
              <span className="vital-label">Password</span>

              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError(null);
                  }}
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  className="vital-input pr-10"
                />

                <button
                  type="button"
                  onClick={() => setShowPassword((visible) => !visible)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              </div>
            </label>

            {error ? (
              <p
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {error}
              </p>
            ) : null}

            <Button type="submit" disabled={submitting} className="mt-1">
              {submitting ? "Signing in..." : "Sign in"}
            </Button>
          </form>

          <p className="vital-footnote flex items-center justify-center gap-2">
            <Shield
              className="h-3.5 w-3.5 text-muted-foreground"
              aria-hidden="true"
            />
            Your role and permissions come from your account.
          </p>
        </div>
      </div>
    </main>
  );
}