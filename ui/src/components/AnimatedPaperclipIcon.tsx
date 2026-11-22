import type { SVGProps } from "react";
import { cn } from "../lib/utils";
import bionicLogo from "../assets/bionic-logo.png";

export function AnimatedPaperclipIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 256 256"
      className={cn("paperclip-thinking-icon bionic-logo-pulse", className)}
      aria-hidden="true"
      {...props}
    >
      <image
        className="bionic-logo-pulse-img"
        href={bionicLogo}
        width="256"
        height="256"
      />
    </svg>
  );
}

/** Full-page loading state: a large, centered, gray animated logo. */
export function PaperclipLoading({ className }: { className?: string }) {
  return (
    <div
      role="status"
      className={cn("flex min-h-dvh w-full items-center justify-center", className)}
    >
      <AnimatedPaperclipIcon className="h-24 w-24" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
