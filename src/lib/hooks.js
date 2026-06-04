import { useState, useEffect } from "react";
import { clamp } from "./util";

// Measure a wrapping element's width (ResizeObserver), clamped to [min,max].
function useContainerWidth(ref, min = 320, max = 900) {
  const [w, setW] = useState(min);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(entries => {
      const cw = entries[0].contentRect.width;
      if (cw) setW(clamp(Math.round(cw), min, max));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, min, max]);
  return w;
}

export { useContainerWidth };
