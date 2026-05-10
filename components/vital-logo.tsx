"use client";

import Image from "next/image";
import { cn } from "@/lib/utils";

type VitalLogoProps = {
  size?: number;
  variant?: "icon" | "full" | "stacked";
  className?: string;
  textClassName?: string;
};

export function VitalLogo({
  size = 26,
  variant = "full",
  className,
  textClassName,
}: VitalLogoProps) {
  const icon = (
    <Image
      src="/vital-logo.png"
      alt="VITAL OS logo"
      width={size}
      height={size}
      priority
      className="h-auto w-auto object-contain"
    />
  );

  if (variant === "icon") {
    return <span className={cn("inline-flex items-center", className)}>{icon}</span>;
  }

  if (variant === "stacked") {
    return (
      <span className={cn("inline-flex flex-col items-center gap-1", className)}>
        {icon}
        <span
          className={cn(
            "text-[11px] font-semibold leading-none tracking-[0.14em]",
            textClassName
          )}
        >
          VITAL
        </span>
        <span
          className={cn(
            "-mt-0.5 text-[10px] font-medium leading-none tracking-[0.2em]",
            textClassName
          )}
        >
          OS
        </span>
      </span>
    );
  }

  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      {icon}
      <span className={cn("text-sm font-semibold tracking-wide", textClassName)}>
        VITAL OS
      </span>
    </span>
  );
}
