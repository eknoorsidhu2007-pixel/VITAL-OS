import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:scale-[0.98]",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-[0_0_0_1px_hsl(var(--primary)/0.45),0_10px_32px_-10px_hsl(var(--primary)/0.65),0_0_40px_-12px_hsl(var(--primary)/0.35)] hover:brightness-110",
        destructive:
          "bg-destructive text-destructive-foreground shadow-[0_0_0_1px_hsl(var(--destructive)/0.4),0_8px_24px_-12px_hsl(var(--destructive)/0.7)] hover:brightness-110",
        outline:
          "border border-white/15 bg-white/[0.04] text-foreground backdrop-blur-sm hover:bg-white/[0.08] hover:border-white/20",
        secondary:
          "border border-white/10 bg-white/[0.06] text-secondary-foreground backdrop-blur-sm hover:bg-white/[0.1]",
        ghost: "text-foreground/80 hover:bg-accent/40 hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-12 rounded-xl px-6 text-base",
        xl: "h-14 rounded-2xl px-8 text-base",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
