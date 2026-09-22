/**
 * Autoscroll for the message list: follow new content while the reader is at
 * the bottom (within 80 px), otherwise leave the position alone and raise a
 * "new messages" flag. `scrollToBottom()` jumps down (own sends, the pill).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DependencyList } from "react";

export const STICK_THRESHOLD_PX = 80;

export function isNearBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number }, threshold = STICK_THRESHOLD_PX): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

export function useStickToBottom(contentDeps: DependencyList) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Position as of the last scroll event, i.e. before the update being laid out.
  const atBottom = useRef(true);
  const force = useRef(false);
  const [hasNew, setHasNew] = useState(false);

  const jump = useCallback(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setHasNew(false);
  }, []);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    atBottom.current = isNearBottom(el);
    if (atBottom.current) setHasNew(false);
  }, []);

  useLayoutEffect(() => {
    if (force.current || atBottom.current) {
      force.current = false;
      jump();
    } else {
      setHasNew(true);
    }
  }, contentDeps);

  // Streaming text grows after the list re-rendered (animation-frame throttled); keep following it.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) jump();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [jump]);

  /** Scroll down after the next render (call before dispatching an own send). */
  const scrollToBottomNext = useCallback(() => {
    force.current = true;
  }, []);

  return { containerRef, contentRef, onScroll, hasNew, scrollToBottom: jump, scrollToBottomNext };
}
