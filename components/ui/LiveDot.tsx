import type { CSSProperties } from "react";

/** 6px pulsating dot indicator for active streaming. While `prefers-reduced-motion`
 *  is set, renders as a static dot. */
export function LiveDot() {
  return (
    <span
      className="live-dot"
      aria-label="streaming"
      style={{ "--live-dot-alpha": 1 } as CSSProperties}
    />
  );
}

/** 14px ring spinner using border + rotate. Respects `prefers-reduced-motion`. */
export function Spinner() {
  return <span className="live-spinner" aria-label="loading" />;
}
