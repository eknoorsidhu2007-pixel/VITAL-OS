import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors mono",
  {
    variants: {
      variant: {
        default:
          "border-white/10 bg-white/[0.06] text-foreground/90 backdrop-blur-sm",
        clinical:
          "border-clinical-teal/45 bg-clinical-teal/15 text-clinical-teal shadow-[0_0_18px_-6px_hsl(var(--clinical-teal)/0.45)]",
        cyan:
          "border-clinical-cyan/45 bg-clinical-cyan/12 text-clinical-cyan shadow-[0_0_16px_-6px_hsl(var(--clinical-cyan)/0.4)]",
        warn:
          "border-clinical-warn/45 bg-clinical-warn/12 text-clinical-warn",
        danger:
          "border-clinical-danger/50 bg-clinical-danger/15 text-clinical-danger shadow-[0_0_20px_-6px_hsl(var(--clinical-danger)/0.45)]",
        outline: "border-white/12 bg-transparent text-foreground/85",
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
