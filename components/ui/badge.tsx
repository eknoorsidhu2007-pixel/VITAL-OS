import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold tracking-[0.01em] transition-all duration-200 mono",
  {
    variants: {
      variant: {
        default:
          "border-slate-300/80 bg-slate-100 text-slate-800 hover:bg-slate-200/90",
        clinical:
          "border-clinical-teal/55 bg-clinical-teal/20 text-slate-900 shadow-[0_0_18px_-6px_hsl(var(--clinical-teal)/0.45)] hover:bg-clinical-teal/28",
        cyan:
          "border-clinical-cyan/55 bg-clinical-cyan/18 text-slate-900 shadow-[0_0_16px_-6px_hsl(var(--clinical-cyan)/0.4)] hover:bg-clinical-cyan/24",
        warn:
          "border-clinical-warn/65 bg-clinical-warn/24 text-amber-950 hover:bg-clinical-warn/34",
        danger:
          "border-clinical-danger/60 bg-clinical-danger/22 text-rose-950 shadow-[0_0_20px_-6px_hsl(var(--clinical-danger)/0.45)] hover:bg-clinical-danger/30",
        outline: "border-slate-300/85 bg-slate-100/95 text-slate-800 hover:bg-slate-200/90 focus-visible:ring-2 focus-visible:ring-slate-400/60",
        allergies:
          "border-rose-300/95 bg-rose-100/95 text-rose-900 hover:bg-rose-200/90 focus-visible:ring-2 focus-visible:ring-rose-300/75",
        medications:
          "border-blue-300/95 bg-blue-100/95 text-blue-900 hover:bg-blue-200/90 focus-visible:ring-2 focus-visible:ring-blue-300/75",
        problems:
          "border-amber-300/95 bg-amber-100/95 text-amber-950 hover:bg-amber-200/90 focus-visible:ring-2 focus-visible:ring-amber-300/75",
        notes:
          "border-teal-300/95 bg-teal-100/95 text-teal-900 hover:bg-teal-200/90 focus-visible:ring-2 focus-visible:ring-teal-300/75",
        risk:
          "border-amber-400/95 bg-gradient-to-r from-amber-100 to-rose-100 text-rose-900 hover:from-amber-200 hover:to-rose-200 focus-visible:ring-2 focus-visible:ring-amber-400/75",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
