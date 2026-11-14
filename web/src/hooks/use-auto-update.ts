import { useCallback, useEffect, useState } from "react";

import { useVisibleInterval } from "@/hooks/use-visible-interval";
import { fetchAutoUpdate, isApiErrorStatus } from "@/lib/api";
import { autoBoundaryAt, autoSettling, type AutoLoad } from "@/lib/auto-update";
import type { UpdateAutoView, UpdateInfo } from "@/lib/types";

export const AUTO_SETTLE_POLL_MS = 5_000;

export interface AutoUpdateReading {
  readonly load: AutoLoad;
  readonly saved: (view: UpdateAutoView) => void;
}

/**
 * This machine's automatic update setting, read on mount, again on every update transition, every
 * {@link AUTO_SETTLE_POLL_MS} while the page is visible and the reading names an automatic update
 * with no outcome yet, and {@link AUTO_SETTLE_POLL_MS} after the daily window it names opens or
 * closes.
 *
 * @param update - the snapshot's update status; a change of its run, its newest release, its last
 *   check or its dismissed release reads the setting again.
 * @returns the reading (`old` for a bridge with no route, `failed` only while no view is held),
 *   and `saved`, which replaces the view with a receipt.
 */
export function useAutoUpdate(update: UpdateInfo | undefined): AutoUpdateReading {
  const [load, setLoad] = useState<AutoLoad>({ kind: "reading" });
  const [beat, setBeat] = useState(0);
  const runId = update?.run?.runId;
  const runState = update?.run?.state;
  const latest = update?.latest;
  const checkedAt = update?.checkedAt;
  const dismissed = update?.dismissedVersion;

  useVisibleInterval(() => setBeat((n) => n + 1), AUTO_SETTLE_POLL_MS, autoSettling(load));

  useEffect(() => {
    const at = autoBoundaryAt(load, Date.now());
    if (at === null) return;
    const timer = setTimeout(() => setBeat((n) => n + 1), at - Date.now() + AUTO_SETTLE_POLL_MS);
    return () => clearTimeout(timer);
  }, [load, beat]);

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const view = await fetchAutoUpdate(ac.signal);
        if (ac.signal.aborted) return;
        setLoad({ kind: "ready", view });
      } catch (thrown) {
        if (ac.signal.aborted) return;
        if (isApiErrorStatus(thrown, 404)) {
          setLoad({ kind: "old" });
          return;
        }
        setLoad((held) => (held.kind === "ready" ? held : { kind: "failed" }));
      }
    })();
    return () => ac.abort();
  }, [runId, runState, latest, checkedAt, dismissed, beat]);

  const saved = useCallback((view: UpdateAutoView) => setLoad({ kind: "ready", view }), []);
  return { load, saved };
}
