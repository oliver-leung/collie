import { describeApiError } from "./api-error-message";
import { getLocaleSnapshot, t, type MessageKey } from "./i18n";
import type { AutoHold, AutoMode, AutoOutcome, UpdateAutoView, UpdateInfo } from "./types";

export type AutoLoad = { kind: "reading" } | { kind: "failed" } | { kind: "old" } | { kind: "ready"; view: UpdateAutoView };

export interface AutoCardInput {
  readonly load: AutoLoad;
  readonly receipt: AutoMode | null;
  readonly update: UpdateInfo | undefined;
  readonly saving: boolean;
  readonly error: string | null;
  readonly canWrite: boolean;
  readonly moving: boolean;
  readonly now: number;
}

export interface AutoCardView {
  readonly view: UpdateAutoView | null;
  readonly mode: AutoMode;
  readonly at: string;
  readonly modeDisabled: boolean;
  readonly onlyOff: boolean;
  readonly timeDisabled: boolean;
  readonly status: string;
  readonly error: string | null;
  readonly next: string;
  readonly why: string;
  readonly last: string;
  readonly timeOptions: readonly string[];
}

const DEFAULT_AT = "04:00";

const RECEIPT_KEY = {
  off: "updates.auto.receipt.off",
  daily: "updates.auto.receipt.daily",
  available: "updates.auto.receipt.available",
} satisfies Record<AutoMode, MessageKey>;

const HOLD_KEY = {
  paused: "updates.auto.offer.paused",
  dismissed: "updates.auto.offer.dismissed",
  prerelease: "updates.auto.offer.prerelease",
  link_change: "updates.auto.offer.linkChange",
  link_unknown: "updates.auto.offer.linkUnknown",
} satisfies Record<AutoHold, MessageKey>;

const OUTCOME_KEY = {
  done: "updates.auto.last.done",
  "rolled-back": "updates.auto.last.rolledBack",
  stuck: "updates.auto.last.stuck",
  interrupted: "updates.auto.last.interrupted",
  aborted: "updates.auto.last.aborted",
  "no-record": "updates.auto.last.noRecord",
} satisfies Record<AutoOutcome, MessageKey>;

/**
 * Everything the Automatic updates card draws, in the active language.
 *
 * @param input - the reading, this session's receipt, the snapshot's update status, the write in
 *   flight and its failure, whether this device may write, whether an update is moving, and now.
 * @returns the shown mode and time, which controls are disabled, and the status, next, why and
 *   last lines.
 */
export function autoCardView(input: AutoCardInput): AutoCardView {
  const view = input.load.kind === "ready" ? input.load.view : null;
  const mode: AutoMode = view?.mode ?? "off";
  const at = view?.at ?? DEFAULT_AT;
  const modeDisabled = view === null || input.saving || input.moving || !input.canWrite || view.pinned.mode !== null;
  const onlyOff = view !== null && view.unavailable !== undefined;
  const timeDisabled = view === null || modeDisabled || view.pinned.at !== null || mode !== "daily" || onlyOff;
  return {
    view,
    mode,
    at,
    modeDisabled,
    onlyOff,
    timeDisabled,
    status: statusLine(input),
    error: input.error,
    next: view === null ? "" : nextLine(view, input.update, input.now),
    why: view === null ? "" : whyLine(view, input.now),
    last: view === null ? "" : lastLine(view, input.now),
    timeOptions: autoTimeOptions(at),
  };
}

/**
 * Whether automatic updates are on for this machine.
 *
 * @param load - the card's reading.
 * @returns true for a reading whose mode is not off on a machine where they are available.
 */
export function autoIsOn(load: AutoLoad): boolean {
  return load.kind === "ready" && load.view.mode !== "off" && load.view.unavailable === undefined;
}

/**
 * Whether the reading names an automatic update the machine has not given an outcome yet.
 *
 * @param load - the card's reading.
 * @returns true while the last automatic update in the reading has no outcome.
 */
export function autoSettling(load: AutoLoad): boolean {
  return load.kind === "ready" && running(load.view);
}

/**
 * The next opening or close of the daily window the reading names.
 *
 * @param load - the card's reading.
 * @param now - now, epoch ms.
 * @returns the earliest of `nextAt` and `windowEndsAt` that is after `now`, epoch ms, or null when
 *   neither is.
 */
export function autoBoundaryAt(load: AutoLoad, now: number): number | null {
  if (load.kind !== "ready") return null;
  const ahead = [load.view.nextAt, load.view.windowEndsAt].filter((at): at is number => at !== null && at > now);
  return ahead.length === 0 ? null : Math.min(...ahead);
}

/**
 * The times the daily select offers.
 *
 * @param at - the time the machine holds, `HH:MM`.
 * @returns `00:00` to `23:00` on the hour, with `at` among them in order when it is not on the hour.
 */
export function autoTimeOptions(at: string): string[] {
  const hours = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`);
  if (!/^\d{2}:\d{2}$/.test(at) || hours.includes(at)) return hours;
  return [...hours, at].toSorted();
}

/**
 * A moment on the host's own clock, in the active language.
 *
 * @param at - the moment, epoch ms.
 * @param now - now, epoch ms.
 * @param zone - the host's IANA zone; empty or unknown reads as this phone's zone.
 * @returns the time alone when `at` falls on the same host-local day as `now`, else a date and a
 *   time.
 */
export function whenOf(at: number, now: number, zone: string): string {
  const timeZone = knownZone(zone);
  const sameDay = dayIn(at, timeZone) === dayIn(now, timeZone);
  const options: Intl.DateTimeFormatOptions = sameDay
    ? { hour: "2-digit", minute: "2-digit", timeZone }
    : { dateStyle: "medium", timeStyle: "short", timeZone };
  return new Intl.DateTimeFormat(getLocaleSnapshot().locale, options).format(new Date(at));
}

function knownZone(zone: string): string | undefined {
  if (zone === "") return undefined;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function dayIn(at: number, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(new Date(at));
}

function statusLine(input: AutoCardInput): string {
  const load = input.load;
  if (load.kind === "reading") return t("updates.auto.reading");
  if (load.kind === "failed") return t("updates.auto.readFailed");
  if (load.kind === "old") return t("updates.auto.oldBridge");
  const view = load.view;
  if (input.saving) return t("updates.auto.saving");
  if (input.error !== null) return "";
  if (input.receipt !== null && input.receipt === view.setting.mode) return t(RECEIPT_KEY[input.receipt], { at: view.at });
  if (view.unavailable === "invalid_mode") {
    return t("updates.auto.unavailable.invalid_mode", {
      source: view.pinned.mode === "env" ? "COLLIE_AUTO_UPDATE" : "auto_update in config.toml",
    });
  }
  if (view.unavailable === "invalid_time") {
    return t("updates.auto.unavailable.invalid_time", {
      source: view.pinned.at === "env" ? "COLLIE_AUTO_UPDATE_AT" : "auto_update_at in config.toml",
    });
  }
  if (view.unavailable !== undefined) return t(`updates.auto.unavailable.${view.unavailable}`);
  if (!input.canWrite) return t("updates.auto.readOnly");
  if (view.pinned.mode !== null) {
    return t("updates.auto.pinned.mode", { source: view.pinned.mode === "env" ? "COLLIE_AUTO_UPDATE" : "config.toml" });
  }
  if (view.pinned.at !== null && view.mode === "daily") {
    return t("updates.auto.pinned.at", { source: view.pinned.at === "env" ? "COLLIE_AUTO_UPDATE_AT" : "config.toml" });
  }
  if (view.mode === "daily") {
    return view.zone === "" ? t("updates.auto.on.daily", { at: view.at }) : t("updates.auto.on.dailyZone", { at: view.at, zone: view.zone });
  }
  if (view.mode === "available") return t("updates.auto.on.available");
  return t("updates.auto.on.off");
}

function running(view: UpdateAutoView): boolean {
  return view.last !== undefined && view.last.outcome === null;
}

function nextLine(view: UpdateAutoView, update: UpdateInfo | undefined, now: number): string {
  if (view.mode === "off" || view.unavailable !== undefined) return "";
  if (view.last !== undefined && view.last.outcome === null) return t("updates.auto.next.running", { version: view.last.version });
  if (view.target !== null) {
    const version = view.target;
    if (view.hold !== undefined) return t(HOLD_KEY[view.hold], { version });
    if (view.mode === "available") return t("updates.auto.offer.available", { version });
    if (view.nextAt === null) return "";
    if (view.nextAt > now) return t("updates.auto.offer.daily", { version, when: whenOf(view.nextAt, now, view.zone) });
    if (view.windowEndsAt === null || view.windowEndsAt <= now) return "";
    return t("updates.auto.offer.dailyNow", { version, end: whenOf(view.windowEndsAt, now, view.zone) });
  }
  const major = update?.majorAvailable ?? null;
  if (major !== null) return t("updates.auto.offer.major", { version: major });
  if (view.mode === "available") return t("updates.auto.next.available");
  return view.nextAt === null || view.nextAt <= now ? "" : t("updates.auto.next.daily", { when: whenOf(view.nextAt, now, view.zone) });
}

function whyLine(view: UpdateAutoView, now: number): string {
  const waiting = view.waiting;
  if (waiting === undefined || view.target === null || running(view)) return "";
  if (view.mode === "off" || view.unavailable !== undefined || view.hold !== undefined) return "";
  const when = whenOf(waiting.at, now, view.zone);
  if (waiting.code === "busy_reading" || waiting.code === "busy_sending") return t(`updates.auto.wait.${waiting.code}`, { when });
  const reason = describeApiError({ code: waiting.code, error: waiting.error, detail: waiting.detail });
  return t("updates.auto.wait.refused", { when, reason });
}

function lastLine(view: UpdateAutoView, now: number): string {
  const last = view.last;
  if (last === undefined) return t("updates.auto.last.none");
  if (last.outcome === null) return t("updates.auto.last.running", { version: last.version });
  const when = whenOf(last.settledAt ?? last.startedAt, now, view.zone);
  const reason = last.reason ?? "";
  const key = last.outcome === "aborted" && reason !== "" ? "updates.auto.last.abortedReason" : OUTCOME_KEY[last.outcome];
  return t(key, { from: last.from, to: last.to, when, reason });
}
