import { useEffect, useRef } from "react";
import type { MtView } from "../../lib/mytickets-view";

// ============================================================================
// Direction-aware feed scroll restoration for MyTickets.
//
// The first cut (d73d8c1) scrolled to top on EVERY view change, so returning
// to the feed from a sub-view threw the user to the top of the list — losing
// their place. Landing mid-card on open is a cosmetic wrong-start; losing a
// position in a list you were working through is lost work. This restores the
// offset the user left from.
//
//   feed      → sub-view (detail / profile / manual / new): jump to top.
//   sub-view  → feed: restore the offset captured when the feed was left.
//   sub-view  → sub-view (detail → profile): forward, top, and do NOT clobber
//               the saved feed offset (it's still needed when the user finally
//               returns to the feed).
//
// CAPTURE. The feed offset has to be read BEFORE the view swap — by the time a
// transition effect runs, the feed DOM is gone and the browser may have
// clamped scrollY against the new (shorter) page. So a scroll listener records
// the live feed offset into `liveRef` while the feed is the active view, and
// the leave transition snapshots `liveRef` into `savedRef`. The split matters:
// the live listener keeps writing during the restore scroll, but the restore
// reads the snapshot, so it can't clobber itself.
//
// RESTORE TIMING. requestAnimationFrame, one frame after the feed re-mounts,
// so the list is laid out before the offset is clamped/applied. Restoring in
// the same tick (useLayoutEffect) can land short against a half-built document
// if a card height settles after first paint; the one-frame delay is
// imperceptible and not worth the synchronous-reflow cost or the land-short
// risk. `scroll-behavior: smooth` on <html> would animate the restore (and let
// an in-flight smooth scroll resume past it), so the jump temporarily defeats
// smooth-behavior and restores the stylesheet value after.
//
// CLAMP. If the feed changed while away (a ticket settled, one was deleted, the
// list re-sorted) the saved offset may now point past the end. Clamp to the
// current document height and move on — this is not a scroll-anchoring system.
//
// FIRST MOUNT (view === "feed", nothing saved) is a no-op so it doesn't fight
// the browser's own scroll restoration.
// ============================================================================

/** Instant `scrollTo` that defeats `scroll-behavior: smooth` for one call. */
function jumpTo(y: number): void {
  const el = document.documentElement;
  const prev = el.style.scrollBehavior;
  el.style.scrollBehavior = "auto";
  window.scrollTo(0, y);
  el.style.scrollBehavior = prev;
}

export function useFeedScrollRestore(view: MtView): void {
  // Live feed offset, kept current by a scroll listener while the feed mounts.
  const liveRef = useRef(0);
  // The offset to restore: snapshotted from liveRef when the feed is left.
  const savedRef = useRef<number | null>(null);
  // The view before the current one, to detect direction.
  const prevViewRef = useRef<MtView>("feed");

  // Capture the feed scroll offset while the feed is the active view.
  useEffect(() => {
    if (view !== "feed") return;
    liveRef.current = window.scrollY;
    const onScroll = () => {
      liveRef.current = window.scrollY;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [view]);

  // Direction-aware top / restore on every view change.
  useEffect(() => {
    const from = prevViewRef.current;
    const to = view;
    prevViewRef.current = to;
    if (from === to) return; // first mount / no transition → no-op

    const wasFeed = from === "feed";
    const nowFeed = to === "feed";

    if (wasFeed && !nowFeed) {
      // Leaving the feed into a sub-view: snapshot the live offset, then top.
      savedRef.current = liveRef.current;
      jumpTo(0);
    } else if (!wasFeed && nowFeed) {
      // Returning to the feed: restore the snapshot after paint, clamped.
      const target = savedRef.current;
      savedRef.current = null;
      if (target == null) return; // nothing saved (e.g. deep-linked in) → leave it
      const raf = requestAnimationFrame(() => {
        const max = Math.max(
          0,
          document.documentElement.scrollHeight - window.innerHeight,
        );
        jumpTo(Math.max(0, Math.min(target, max)));
      });
      return () => cancelAnimationFrame(raf);
    } else if (!wasFeed && !nowFeed) {
      // Sub-view → sub-view forward move: top. The saved feed offset is
      // intentionally left untouched for the eventual return to the feed.
      jumpTo(0);
    }
  }, [view]);
}
