import dynamic from "next/dynamic";

function VitalOsBootShell() {
  return (
    <main className="relative min-h-screen overflow-hidden" suppressHydrationWarning>
      <div className="grid-bg pointer-events-none absolute inset-0 opacity-40" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-clinical-teal/50 via-clinical-mint/40 to-transparent" />

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-[1480px] flex-col items-center justify-center gap-4 px-4 py-5 lg:px-8 lg:py-7">
        <div className="panel flex max-w-md flex-col items-center gap-4 px-10 py-12 text-center">
          <div
            className="h-10 w-10 animate-spin rounded-full border-2 border-clinical-teal/50 border-t-clinical-mint"
            aria-hidden
          />
          <p className="mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Initializing VITAL OS
          </p>
          <p className="text-sm text-muted-foreground">
            Loading speech interfaces…
          </p>
        </div>
      </div>
    </main>
  );
}

const VitalOsClient = dynamic(
  () => import("@/components/vital-os-client"),
  { ssr: false, loading: VitalOsBootShell }
);

export default function Page() {
  return <VitalOsClient />;
}
