import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { server } from "@/test/setup";
import type { UpdateAutoView, UpdateInfo } from "@/lib/types";
import { AUTO_SETTLE_POLL_MS, useAutoUpdate } from "./use-auto-update";

afterEach(() => {
  vi.useRealTimers();
});

function view(over: Partial<UpdateAutoView> = {}): UpdateAutoView {
  return {
    mode: "off",
    at: "04:00",
    zone: "UTC",
    pinned: { mode: null, at: null },
    setting: { mode: "off", at: "04:00", changedAt: null },
    target: null,
    nextAt: null,
    windowEndsAt: null,
    paused: [],
    ...over,
  };
}

function info(over: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    current: "1.29.0",
    latest: "1.29.0",
    latestUrl: null,
    releaseAvailable: false,
    majorAvailable: null,
    majorUrl: null,
    bridgeStale: false,
    checkedAt: 1_000,
    ...over,
  };
}

interface Served {
  readonly reads: () => number;
}

function serve(answers: Array<() => Response>): Served {
  let count = 0;
  server.use(
    http.get("/api/update/auto", () => {
      const answer = answers[Math.min(count, answers.length - 1)];
      count += 1;
      if (answer === undefined) throw new Error("no answer to serve");
      return answer();
    }),
  );
  return { reads: () => count };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

describe("useAutoUpdate", () => {
  it("reads once on mount and hands the view over", async () => {
    const served = serve([() => HttpResponse.json(view({ mode: "daily" }))]);
    const { result } = renderHook(() => useAutoUpdate(info()));
    expect(result.current.load).toEqual({ kind: "reading" });
    await waitFor(() => expect(result.current.load.kind).toBe("ready"));
    await settle();
    expect(served.reads()).toBe(1);
    expect(result.current.load).toEqual({ kind: "ready", view: view({ mode: "daily" }) });
  });

  it("reads again on a run state, a newest release, a check or a dismissal, and not on anything else", async () => {
    const served = serve([() => HttpResponse.json(view())]);
    const run = { schema: 2, state: "staging", from: "1.29.0", to: "1.30.0", startedAt: 1, updatedAt: 2, pid: 3, attempt: 0, runId: "r-1" } satisfies UpdateInfo["run"];
    const { rerender } = renderHook((props: { update: UpdateInfo }) => useAutoUpdate(props.update), { initialProps: { update: info() } });
    await waitFor(() => expect(served.reads()).toBe(1));

    rerender({ update: info({ bridgeStale: true, newerVersions: ["1.29.0"] }) });
    await settle();
    expect(served.reads()).toBe(1);

    rerender({ update: info({ run }) });
    await waitFor(() => expect(served.reads()).toBe(2));
    rerender({ update: info({ run: { ...run, state: "restarting" } }) });
    await waitFor(() => expect(served.reads()).toBe(3));
    rerender({ update: info({ run: { ...run, state: "restarting" }, latest: "1.30.0" }) });
    await waitFor(() => expect(served.reads()).toBe(4));
    rerender({ update: info({ run: { ...run, state: "restarting" }, latest: "1.30.0", checkedAt: 2_000 }) });
    await waitFor(() => expect(served.reads()).toBe(5));
    rerender({ update: info({ run: { ...run, state: "restarting" }, latest: "1.30.0", checkedAt: 2_000, dismissedVersion: "1.30.0" }) });
    await waitFor(() => expect(served.reads()).toBe(6));
    rerender({ update: info({ run: { ...run, state: "restarting", updatedAt: 9 }, latest: "1.30.0", checkedAt: 2_000, dismissedVersion: "1.30.0" }) });
    await settle();
    expect(served.reads()).toBe(6);
  });

  it("reads a 404 as a bridge from before the route", async () => {
    serve([() => HttpResponse.text("not found", { status: 404 })]);
    const { result } = renderHook(() => useAutoUpdate(info()));
    await waitFor(() => expect(result.current.load).toEqual({ kind: "old" }));
  });

  it("reads any other failure as failed while it holds no view", async () => {
    serve([() => HttpResponse.json({ error: "boom" }, { status: 500 })]);
    const { result } = renderHook(() => useAutoUpdate(info()));
    await waitFor(() => expect(result.current.load).toEqual({ kind: "failed" }));
  });

  it("keeps the view it holds when a read again fails", async () => {
    const served = serve([() => HttpResponse.json(view({ mode: "available" })), () => HttpResponse.json({ error: "boom" }, { status: 503 })]);
    const { result, rerender } = renderHook((props: { update: UpdateInfo }) => useAutoUpdate(props.update), { initialProps: { update: info() } });
    await waitFor(() => expect(result.current.load.kind).toBe("ready"));
    rerender({ update: info({ latest: "1.30.0" }) });
    await waitFor(() => expect(served.reads()).toBe(2));
    await settle();
    expect(result.current.load).toEqual({ kind: "ready", view: view({ mode: "available" }) });
  });

  it("replaces the view with a saved one", async () => {
    serve([() => HttpResponse.json(view())]);
    const { result } = renderHook(() => useAutoUpdate(info()));
    await waitFor(() => expect(result.current.load.kind).toBe("ready"));
    act(() => result.current.saved(view({ mode: "daily", setting: { mode: "daily", at: "04:00", changedAt: 5 } })));
    expect(result.current.load).toEqual({ kind: "ready", view: view({ mode: "daily", setting: { mode: "daily", at: "04:00", changedAt: 5 } }) });
  });

  it("reads with no snapshot at all", async () => {
    const served = serve([() => HttpResponse.json(view())]);
    const { result } = renderHook(() => useAutoUpdate(undefined));
    await waitFor(() => expect(result.current.load.kind).toBe("ready"));
    expect(served.reads()).toBe(1);
  });

  it("reads again on a beat while the machine has not settled its automatic update, and stops once it has", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const last = { runId: "auto-1", version: "1.30.0", from: "1.29.0", to: "1.30.0", mode: "available", outcome: null, startedAt: 1, settledAt: null } satisfies UpdateAutoView["last"];
    const setting = { mode: "available", at: "04:00", changedAt: 1 } satisfies UpdateAutoView["setting"];
    const pending = view({ mode: "available", setting, last });
    const settled = view({ mode: "available", setting, last: { ...last, outcome: "aborted", settledAt: 2, reason: "staging stopped" } });
    const served = serve([() => HttpResponse.json(pending), () => HttpResponse.json(pending), () => HttpResponse.json(settled)]);
    const { result } = renderHook(() => useAutoUpdate(info()));
    await waitFor(() => expect(served.reads()).toBe(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_SETTLE_POLL_MS - 500);
    });
    expect(served.reads()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await waitFor(() => expect(served.reads()).toBe(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_SETTLE_POLL_MS);
    });
    await waitFor(() => expect(result.current.load).toEqual({ kind: "ready", view: settled }));
    expect(served.reads()).toBe(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_SETTLE_POLL_MS * 3);
    });
    expect(served.reads()).toBe(3);
  });

  it("reads again a beat after the daily window it names opens, and after it closes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const opensAt = Date.now() + 10_000;
    const daily = view({ mode: "daily", setting: { mode: "daily", at: "04:00", changedAt: 1 }, nextAt: opensAt, windowEndsAt: opensAt + 20_000 });
    const served = serve([() => HttpResponse.json(daily)]);
    renderHook(() => useAutoUpdate(info()));
    await waitFor(() => expect(served.reads()).toBe(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000 + AUTO_SETTLE_POLL_MS - 500);
    });
    expect(served.reads()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await waitFor(() => expect(served.reads()).toBe(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    await waitFor(() => expect(served.reads()).toBe(3));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(served.reads()).toBe(3);
  });
});
