/**
 * Detects the user's prefers-reduced-motion media query preference.
 * Returns true when the user has requested reduced motion.
 */
import { useState, useEffect } from "react";

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    return Boolean(mq?.matches);
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!mq || typeof mq.addEventListener !== "function") {
      return;
    }
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return reduced;
}
