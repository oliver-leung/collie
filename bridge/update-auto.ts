import { readFileSync } from "node:fs";
import { join } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString, parseJson, type JsonValue } from "../web/src/lib/json.ts";
import type { AuditEntry } from "./audit.ts";
import { settingByEnv } from "./config-schema.ts";
import { sourceOf, type ConfigFileLayer, type Environment } from "./config-source.ts";
import { apiError, ERROR_CODE_LIST, type ApiErrorBody, type ApiErrorDetail, type ErrorCode } from "./error-codes.ts";
import type { PushMessage } from "./push.ts";
import { pushTitle } from "./push-titles.ts";
import type { AutoHold, AutoMode, AutoOutcome, AutoUnavailable, CrewMode, UpdateAutoView, UpdateStatus } from "./types.ts";
import {
  compareSemver,
  DIGEST_EARLIEST_HOUR,
  mirrorValue,
  parsePrereleaseTag,
  UPDATE_MIRROR_ENV,
  type UpdateOffer,
} from "./update.ts";
import {
  updateStartStateOf,
  updateStartVerdict,
  type PreflightReport,
  type UpdateStartCrew,
  type UpdateStartResult,
} from "./update-action.ts";
import { isEdgeBuild, isStrictRelease, type UpdateLineWriter } from "./update-line.ts";
import { inFlight, type RunTrigger, type UpdateRun, type UpdateRunState } from "./update-run.ts";
import { developmentBase } from "./version.ts";
import { isRequestId } from "./worktree-receipts.ts";

export type { AutoHold, AutoMode, AutoOutcome, AutoUnavailable, UpdateAutoView };

export const UPDATE_AUTO_FILE = "update-auto.json";
export const UPDATE_AUTO_SCHEMA = 1;
export const AUTO_MODE_ENV = "COLLIE_AUTO_UPDATE";
export const AUTO_AT_ENV = "COLLIE_AUTO_UPDATE_AT";
export const DEFAULT_AUTO_AT = "04:00";
export const AUTO_DAILY_WINDOW_MS = 3 * 60 * 60 * 1000;
export const AUTO_QUIET_MS = 15 * 60 * 1000;
export const AUTO_RETRY_MS = 60 * 60 * 1000;
export const AUTO_RETRY_MAX_MS = 6 * 60 * 60 * 1000;
export const AUTO_RECORD_WAIT_MS = 15 * 60 * 1000;
export const AUTO_NO_RECORD_MAX = 3;
export const AUTO_FAILED_MAX = 20;
export const AUTO_FRESH_CHECK_MS = 30 * 60 * 1000;
export const AUTO_RECHECK_MS = 60 * 1000;
export const AUTO_RECONCILE_MS = 5 * 1000;
export const AUTO_REASON_MAX = 240;
export const AUTO_LABEL_MAX = 120;

export type AutoBusy = "busy_reading" | "busy_sending";
export type AutoWaitCode = AutoBusy | "service" | ErrorCode;
export type AutoPinOrigin = "env" | "config";
export interface AutoPin {
  readonly raw: string;
  readonly origin: AutoPinOrigin;
}
export interface AutoPins {
  readonly mode: AutoPin | null;
  readonly at: AutoPin | null;
}
export interface AutoSetting {
  readonly mode: AutoMode;
  readonly at: string;
  readonly pinned: { readonly mode: AutoPinOrigin | null; readonly at: AutoPinOrigin | null };
  readonly invalid: "invalid_mode" | "invalid_time" | null;
}
export interface AutoAttempt {
  readonly runId: string;
  readonly version: string;
  readonly from: string;
  readonly mode: "daily" | "available";
  readonly startedAt: number;
  readonly outcome: AutoOutcome | null;
  readonly to?: string;
  readonly reason?: string;
  readonly settledAt: number | null;
  readonly toldAt: number | null;
}
export type AutoFailureOutcome = "rolled-back" | "stuck" | "interrupted" | "aborted" | "no-record" | "reverted";
export interface AutoFailure {
  readonly version: string;
  readonly outcome: AutoFailureOutcome;
  readonly at: number;
}
export interface AutoSkip {
  readonly code: AutoWaitCode;
  readonly at: number;
  readonly version: string | null;
  readonly count: number;
  readonly error?: string;
  readonly detail?: ApiErrorDetail;
}
export interface AutoUpdateRecord {
  readonly schema: number;
  readonly mode: AutoMode;
  readonly at: string;
  readonly changedAt: number | null;
  readonly requestId?: string;
  readonly setBy?: string;
  readonly attempt: AutoAttempt | null;
  readonly failed: readonly AutoFailure[];
  readonly strikes: { readonly version: string; readonly count: number } | null;
  readonly lastTryAt: number | null;
  readonly slotDay: string | null;
  readonly skip: AutoSkip | null;
}
export const DEFAULT_AUTO_RECORD: AutoUpdateRecord = {
  schema: UPDATE_AUTO_SCHEMA,
  mode: "off",
  at: DEFAULT_AUTO_AT,
  changedAt: null,
  attempt: null,
  failed: [],
  strikes: null,
  lastTryAt: null,
  slotDay: null,
  skip: null,
};
export interface AutoRequest {
  readonly mode: AutoMode | null;
  readonly at: string | null;
  readonly atInvalid: boolean;
  readonly requestId: string | null;
}
export interface AutoWindow {
  readonly day: string;
  readonly start: number;
  readonly end: number;
}
export interface AutoSettlement {
  readonly outcome: AutoOutcome;
  readonly to: string;
  readonly reason?: string;
}
export interface AutoFacts {
  readonly crewMode: CrewMode;
  readonly canRun: boolean;
  readonly installKind: UpdateStatus["installKind"];
  readonly underVersions: boolean;
  readonly platform: string;
  readonly build: string;
  readonly env: Environment;
  readonly supervised: boolean | null;
}
export interface AutoAction {
  preflight(force?: boolean): Promise<PreflightReport | null>;
  lockHeld(): boolean;
  starting?(): boolean;
  newRunId(): string;
  start(a: { major: boolean; runId: string; toTag: string; trigger: RunTrigger }): UpdateStartResult | Promise<UpdateStartResult>;
}
export interface AutoUpdaterDeps {
  readonly now: () => number;
  readonly bootAt: number;
  readonly store: { read(): AutoUpdateRecord; write(record: AutoUpdateRecord): void };
  readonly pins: AutoPins;
  readonly unavailable: AutoUnavailable | null;
  readonly deposed: () => boolean;
  readonly crewMode: CrewMode;
  readonly zone: string;
  readonly offer: () => UpdateOffer;
  readonly status: () => UpdateStatus;
  readonly checkRelease: () => Promise<void>;
  readonly run: () => UpdateRun | null;
  readonly action: AutoAction | undefined;
  readonly build: string;
  readonly crew: UpdateStartCrew | null;
  readonly lastPollAt: () => number | null;
  readonly sends: () => readonly { readonly phase: string }[];
  readonly labels: () => readonly string[] | null;
  readonly updatesEnabled: () => boolean;
  readonly notify: (message: PushMessage) => void;
  readonly announced: (version: string) => void;
  readonly audit: (entry: AuditEntry) => void;
  readonly log: (line: string) => void;
  readonly warn: (line: string) => void;
}
export type AutoChoice =
  | { readonly kind: "saved"; readonly replay: boolean; readonly before: AutoMode; readonly view: UpdateAutoView }
  | { readonly kind: "refused"; readonly status: 409; readonly body: ApiErrorBody };

export const AUTO_UNAVAILABLE_SENTENCE = {
  peer: "this machine is a crew member, and it follows its lead",
  no_runner: "this bridge runs from source with no compiled collie to start",
  packaged: "a package manager owns this install",
  unknown_install: "Collie cannot tell how this machine was installed",
  windows_checkout: "a source checkout on Windows never updates itself",
  in_place: "this checkout updates in place, with no health check and no way back",
  first_stage: "this checkout has not staged an update yet, and its first staged update has no way back",
  dev_build: "this is a development build",
  ci: "CI is set on this machine",
  mirror: `${UPDATE_MIRROR_ENV} is set on this machine`,
  unsupervised: "no service manager restarts this bridge",
  deposed: "this machine handed the crew to another lead",
  invalid_mode: "COLLIE_AUTO_UPDATE is not off, daily or available",
  invalid_time: "COLLIE_AUTO_UPDATE_AT is not a time like 04:00",
} satisfies Readonly<Record<AutoUnavailable, string>>;

type AutoRunMode = AutoAttempt["mode"];
type AutoWaiting = NonNullable<UpdateAutoView["waiting"]>;
type AutoLast = NonNullable<UpdateAutoView["last"]>;

interface PinnedMode {
  readonly mode: AutoMode;
  readonly invalid: boolean;
}

interface NotStarted {
  readonly code: AutoWaitCode;
  readonly error: string;
  readonly detail?: ApiErrorDetail;
}

interface DraftAttempt {
  runId: string;
  version: string;
  from: string;
  mode: AutoRunMode;
  startedAt: number;
  outcome: AutoOutcome | null;
  to?: string;
  reason?: string;
  settledAt: number | null;
  toldAt: number | null;
}

interface DraftSkip {
  code: AutoWaitCode;
  at: number;
  version: string | null;
  count: number;
  error?: string;
  detail?: ApiErrorDetail;
}

interface DraftRecord {
  schema: number;
  mode: AutoMode;
  at: string;
  changedAt: number | null;
  requestId?: string;
  setBy?: string;
  attempt: AutoAttempt | null;
  failed: readonly AutoFailure[];
  strikes: { readonly version: string; readonly count: number } | null;
  lastTryAt: number | null;
  slotDay: string | null;
  skip: AutoSkip | null;
}

const AUTO_MODES: readonly AutoMode[] = ["off", "daily", "available"];
const RUN_MODES: readonly AutoRunMode[] = ["daily", "available"];
const OUTCOMES: readonly AutoOutcome[] = ["done", "rolled-back", "stuck", "interrupted", "aborted", "no-record"];
const FAILURE_OUTCOMES: readonly AutoFailureOutcome[] = ["rolled-back", "stuck", "interrupted", "aborted", "no-record", "reverted"];
const LOCAL_WAIT_CODES: readonly (AutoBusy | "service")[] = ["busy_reading", "busy_sending", "service"];
const OFF_WORDS: ReadonlySet<string> = new Set(["0", "false", "no"]);
const AUTO_TIME = /^(\d{1,2}):(\d{2})$/;
const LOCAL_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const CONFIG_SOURCE = "config.toml";
const NO_SERVICE_ROW = "the preflight did not check the service";

/**
 * @param raw The `mode` field of a request body.
 * @returns The mode when `raw` is exactly `off`, `daily` or `available`, else null.
 */
export function parseAutoMode(raw: JsonValue | undefined): AutoMode | null {
  return AUTO_MODES.find((mode) => mode === raw) ?? null;
}

/**
 * @param raw A time as `H:MM` or `HH:MM`, 24 hours.
 * @returns The time as `HH:MM`, or null when `raw` is not a string in that form within 00:00 to 23:59.
 */
export function parseAutoTime(raw: JsonValue | undefined): string | null {
  const text = asJsonString(raw);
  const parts = text === undefined ? null : AUTO_TIME.exec(text);
  if (parts === null) return null;
  const hour = Number(parts[1]);
  const minute = Number(parts[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null;
  return `${pad2(hour)}:${pad2(minute)}`;
}

/**
 * @param env The effective environment, the config file layer already applied.
 * @param layer The config file layer under it.
 * @returns The two pins, each null when its variable is unset or empty.
 */
export function autoPinsOf(env: Environment, layer: ConfigFileLayer): AutoPins {
  return { mode: pinOf(AUTO_MODE_ENV, env, layer), at: pinOf(AUTO_AT_ENV, env, layer) };
}

/**
 * @param pins The pins read at boot.
 * @param record The record's own mode and time.
 * @returns The effective setting, which pin decided each half, and the invalid pin, if any.
 */
export function autoSetting(pins: AutoPins, record: Pick<AutoUpdateRecord, "mode" | "at">): AutoSetting {
  const recordAt = parseAutoTime(record.at) ?? DEFAULT_AUTO_AT;
  const pinnedMode = pins.mode === null ? null : modeOfPin(pins.mode.raw);
  const pinnedAt = pins.at === null ? null : parseAutoTime(pins.at.raw.trim());
  const timeInvalid = pins.at !== null && pinnedAt === null;
  return {
    mode: pinnedMode === null ? record.mode : pinnedMode.mode,
    at: pinnedAt ?? recordAt,
    pinned: { mode: pins.mode?.origin ?? null, at: pins.at?.origin ?? null },
    invalid: pinnedMode?.invalid === true ? "invalid_mode" : timeInvalid ? "invalid_time" : null,
  };
}

/**
 * @param pins The pins read at boot.
 * @returns One sentence per pin that does not read as written.
 */
export function autoPinWarnings(pins: AutoPins): string[] {
  const out: string[] = [];
  if (pins.mode !== null && modeOfPin(pins.mode.raw).invalid) {
    out.push(
      pins.mode.origin === "env"
        ? `${AUTO_MODE_ENV}=${pins.mode.raw} is not off, daily or available, read as off`
        : `auto_update = "${pins.mode.raw}" in config.toml is not off, daily or available, read as off`,
    );
  }
  if (pins.at !== null && parseAutoTime(pins.at.raw.trim()) === null) {
    out.push(
      pins.at.origin === "env"
        ? `${AUTO_AT_ENV}=${pins.at.raw} is not a time like 04:00, so automatic updates are off`
        : `auto_update_at = "${pins.at.raw}" in config.toml is not a time like 04:00, so automatic updates are off`,
    );
  }
  return out;
}

/**
 * @param facts What this machine is.
 * @returns The first reason this machine never updates itself, or null when it may.
 */
export function autoEligibility(facts: AutoFacts): AutoUnavailable | null {
  const kind = facts.installKind;
  const checkout = kind === "linked-clone" || kind === "detached-checkout";
  if (facts.crewMode === "peer") return "peer";
  if (!facts.canRun) return "no_runner";
  if (kind === "packaged") return "packaged";
  if (kind === "unknown") return "unknown_install";
  if (checkout && facts.platform === "win32") return "windows_checkout";
  if (kind === "detached-checkout" && !facts.underVersions) return "in_place";
  if (kind === "linked-clone" && !facts.underVersions) return "first_stage";
  if (developmentBase(facts.build) !== null) return "dev_build";
  if (isSet(facts.env.CI)) return "ci";
  if (mirrorValue(facts.env) !== null) return "mirror";
  if (facts.supervised === false) return "unsupervised";
  return null;
}

/**
 * @param version A dotted version.
 * @returns Whether `collie update --to-tag` can take it: a strict release or an Edge build.
 */
export function pinnable(version: string): boolean {
  return isStrictRelease(version) || isEdgeBuild(version);
}

/**
 * @param target The release the scheduler would take.
 * @param record The record's failure memory.
 * @param offer What the last release check offered.
 * @returns The first hold on `target`, or null when nothing holds it.
 */
export function holdOf(
  target: string,
  record: Pick<AutoUpdateRecord, "failed">,
  offer: Pick<UpdateOffer, "dismissed" | "linkChange" | "linkKnown">,
): AutoHold | null {
  if (record.failed.some((failure) => failure.version === target)) return "paused";
  if (offer.dismissed === target) return "dismissed";
  if (!pinnable(target)) return "prerelease";
  if (offer.linkChange !== null) return "link_change";
  if (!offer.linkKnown) return "link_unknown";
  return null;
}

/**
 * @param a The clock, the newest paired poll, the bridge's start and the Send Protocol requests.
 * @returns Why Collie is in use now, or null when it is quiet.
 */
export function quietGuard(a: {
  readonly now: number;
  readonly lastPollAt: number | null;
  readonly bootAt: number;
  readonly sends: readonly { readonly phase: string }[];
}): AutoBusy | null {
  if (a.now - (a.lastPollAt ?? a.bootAt) < AUTO_QUIET_MS) return "busy_reading";
  if (a.sends.some((request) => request.phase === "accepted" || request.phase === "submit-sent")) return "busy_sending";
  return null;
}

/**
 * @param view The setting half of the view.
 * @returns The boot line, or null when automatic updates are off by default and nothing is pinned.
 */
export function autoUpdateLine(
  view: Pick<UpdateAutoView, "mode" | "at" | "zone" | "pinned" | "setting" | "unavailable" | "nextAt">,
): string | null {
  const invalid = view.unavailable === "invalid_mode" || view.unavailable === "invalid_time";
  if (view.mode === "off" && view.pinned.mode === null && view.pinned.at === null && !invalid) return null;
  const parts = [modeWords(view.mode, view.at, view.zone), deciderOf(view)];
  if (view.unavailable !== undefined) parts.push(`not available here: ${unavailableSentenceOf(view.unavailable, view.pinned)}`);
  if (view.nextAt !== null) parts.push(`next look ${localMinute(view.nextAt)}`);
  return parts.join(", ");
}

/**
 * @param attempt A settled automatic attempt.
 * @param a The version running now and how many crew members are below the attempt's version.
 * @returns The push that tells the attempt's outcome, or null for `no-record` and a pending attempt.
 */
export function autoPushOf(
  attempt: AutoAttempt,
  a: { readonly current: string; readonly membersBehind: number },
): PushMessage | null {
  const outcome = attempt.outcome;
  if (outcome === null || outcome === "no-record") return null;
  const to = attempt.to ?? attempt.version;
  const message: PushMessage = {
    type: "update",
    tag: "collie:update",
    ...pushTitle(outcome === "done" ? "update.auto_done" : "update.auto_failed", { version: to }),
    body: pushBody(outcome, attempt, to, a),
    target: "settings",
  };
  if (outcome !== "done") message.renotify = true;
  return message;
}

/**
 * @param to A run record's `to` or `from`, a version or a version directory.
 * @returns The dotted version with one leading `v` dropped, or null when there is none.
 */
export function bareRunVersion(to: string | null): string | null {
  if (to === null) return null;
  const bare = to.startsWith("v") ? to.slice(1) : to;
  return isDottedVersion(bare) ? bare : null;
}

/**
 * @param attempt The pending automatic attempt.
 * @param run The run record on disk, resolved.
 * @param now The clock.
 * @returns How the attempt ended, or null while it is still running or its record may still come.
 */
export function autoOutcomeOf(attempt: AutoAttempt, run: UpdateRun | null, now: number): AutoSettlement | null {
  if (run !== null && run.runId === attempt.runId) {
    const outcome = terminalOutcome(run.state);
    if (outcome === null) return null;
    const to = bareRunVersion(run.to) ?? attempt.version;
    const reason = run.reason?.trim() ?? "";
    return reason === "" ? { outcome, to } : { outcome, to, reason: reason.slice(0, AUTO_REASON_MAX) };
  }
  if (now - attempt.startedAt >= AUTO_RECORD_WAIT_MS) return { outcome: "no-record", to: attempt.version };
  return null;
}

/**
 * @param run The run record on disk, resolved.
 * @returns The version a person rolled back from on the phone, or null.
 */
export function revertedVersion(run: UpdateRun | null): string | null {
  if (run === null || run.state !== "done" || run.action !== "rollback" || run.from === null) return null;
  return bareRunVersion(run.from);
}

/**
 * @param attempt The last automatic attempt.
 * @param current The version running now.
 * @returns The version a done automatic attempt installed when it is above `current`, else null.
 */
export function driftedVersion(attempt: AutoAttempt | null, current: string): string | null {
  if (attempt === null || attempt.outcome !== "done") return null;
  const version = bareRunVersion(attempt.to ?? null) ?? attempt.version;
  return compareSemver(version, current) > 0 ? version : null;
}

/**
 * @param count How many tries in a row were refused for one version.
 * @returns The wait before the next try: 1 h for 0 and 1, then 2 h, 4 h, and 6 h from there.
 */
export function retryDelayMs(count: number): number {
  return Math.min(AUTO_RETRY_MS * 2 ** Math.max(0, count - 1), AUTO_RETRY_MAX_MS);
}

/**
 * @param at An instant.
 * @returns Its host-local day as `YYYY-MM-DD`.
 */
export function localDay(at: number): string {
  const date = new Date(at);
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * @param day A host-local day as `YYYY-MM-DD`.
 * @param at A time as `HH:MM`.
 * @returns The instant that day's slot opens, or NaN when either does not parse.
 */
export function slotStart(day: string, at: string): number {
  const date = LOCAL_DAY.exec(day);
  const time = AUTO_TIME.exec(parseAutoTime(at) ?? "");
  if (date === null || time === null) return Number.NaN;
  return new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]), Number(time[1]), Number(time[2]), 0, 0).getTime();
}

/**
 * @param now The clock.
 * @param at The daily time as `HH:MM`.
 * @returns The slot that opened last: today's once its start has passed, else yesterday's.
 */
export function currentSlot(now: number, at: string): AutoWindow {
  const today = localDay(now);
  const start = slotStart(today, at);
  if (now >= start) return windowOf(today, start);
  const yesterday = dayAfter(today, -1);
  return windowOf(yesterday, slotStart(yesterday, at));
}

/**
 * @param now The clock.
 * @param at The daily time as `HH:MM`.
 * @param slotDay The day whose slot a start already spent, or null.
 * @returns The open window not yet spent, else the next one to open.
 */
export function nextWindow(now: number, at: string, slotDay: string | null): AutoWindow {
  const current = currentSlot(now, at);
  if (now < current.end && slotDay !== current.day) return current;
  const today = localDay(now);
  const todayStart = slotStart(today, at);
  if (now < todayStart && slotDay !== today) return windowOf(today, todayStart);
  const tomorrow = dayAfter(today, 1);
  return windowOf(tomorrow, slotStart(tomorrow, at));
}

/**
 * @param now The clock.
 * @param hour A host-local hour, 0 to 23.
 * @returns Today at `hour:00` when that is still ahead, else tomorrow's.
 */
export function nextLocalHour(now: number, hour: number): number {
  const today = localDay(now);
  const at = `${pad2(hour)}:00`;
  const todayAt = slotStart(today, at);
  return todayAt > now ? todayAt : slotStart(dayAfter(today, 1), at);
}

/**
 * @param text The file's contents, or null when there is no file.
 * @returns The record, read field by field; anything unreadable reads as the default.
 */
export function parseAutoRecord(text: string | null): AutoUpdateRecord {
  const doc = text === null ? undefined : asJsonObject(parseJson(text));
  if (doc === undefined || asJsonNumber(doc.schema) !== UPDATE_AUTO_SCHEMA) return DEFAULT_AUTO_RECORD;
  const record: DraftRecord = {
    schema: UPDATE_AUTO_SCHEMA,
    mode: parseAutoMode(doc.mode) ?? "off",
    at: parseAutoTime(doc.at) ?? DEFAULT_AUTO_AT,
    changedAt: epochOf(doc.changedAt),
    attempt: attemptOf(doc.attempt),
    failed: failuresOf(doc.failed),
    strikes: strikesOf(doc.strikes),
    lastTryAt: epochOf(doc.lastTryAt),
    slotDay: dayOf(doc.slotDay),
    skip: skipOf(doc.skip),
  };
  const requestId = asJsonString(doc.requestId);
  if (requestId !== undefined && requestId !== "") record.requestId = requestId;
  const setBy = labelOf(asJsonString(doc.setBy) ?? null);
  if (setBy !== null) record.setBy = setBy;
  return record;
}

/**
 * @param stateDir The bridge's state folder.
 * @returns The record's path inside it.
 */
export function updateAutoPath(stateDir: string): string {
  return join(stateDir, UPDATE_AUTO_FILE);
}

/**
 * @param stateDir The bridge's state folder.
 * @returns The record on disk, or the default when there is none or it cannot be read.
 */
export function readAutoRecordSync(stateDir: string): AutoUpdateRecord {
  try {
    return parseAutoRecord(readFileSync(updateAutoPath(stateDir), "utf8"));
  } catch {
    return DEFAULT_AUTO_RECORD;
  }
}

/**
 * Writes the record through a temporary sibling and a rename, owner-only.
 *
 * @param files The writer.
 * @param stateDir The bridge's state folder.
 * @param record The record to write.
 * @throws When the writer fails.
 */
export function writeAutoRecord(files: UpdateLineWriter, stateDir: string, record: AutoUpdateRecord): void {
  const at = updateAutoPath(stateDir);
  const scratch = `${at}.tmp`;
  files.mkdirp(stateDir, 0o700);
  files.write(scratch, `${JSON.stringify(record, null, 2)}\n`, 0o600);
  files.rename(scratch, at);
}

/**
 * @param text The body of `POST /api/update/auto`.
 * @returns The request, or null when the body is not a JSON object.
 */
export function parseAutoRequestText(text: string): AutoRequest | null {
  const doc = asJsonObject(parseJson(text));
  if (doc === undefined) return null;
  const at = doc.at === undefined ? null : parseAutoTime(doc.at);
  return {
    mode: parseAutoMode(doc.mode),
    at,
    atInvalid: doc.at !== undefined && at === null,
    requestId: isRequestId(doc.requestId) ? doc.requestId : null,
  };
}

export class AutoUpdater {
  private record: AutoUpdateRecord;
  private wakeAt = 0;
  private running: Promise<void> | null = null;
  private freshDay: string | null = null;
  private readonly logged = new Map<string, string>();

  /**
   * @param deps Every effect the scheduler has: the clock, the record's store and the bridge's seams.
   * @throws When the store's first read throws.
   */
  constructor(private readonly deps: AutoUpdaterDeps) {
    this.record = deps.store.read();
  }

  /** Logs the boot line when there is one, then a warning for each pin that does not read as written. */
  observe(): void {
    const line = autoUpdateLine(this.view());
    if (line !== null) this.deps.log(`automatic updates: ${line}`);
    for (const warning of autoPinWarnings(this.deps.pins)) this.deps.warn(warning);
  }

  /** Starts one evaluation when none runs and its wake has come. */
  tick(): void {
    if (this.running !== null || this.deps.now() < this.wakeAt) return;
    this.begin();
  }

  /** Wakes the scheduler after a successful release check, and starts an evaluation when none runs. */
  afterCheck(): void {
    this.wakeAt = 0;
    if (this.running === null) this.begin();
  }

  /** @returns What `GET /api/update/auto` answers. Reads only. */
  view(): UpdateAutoView {
    const record = this.record;
    const s = autoSetting(this.deps.pins, record);
    const unavailable = this.unavailableOf(s);
    const offer = this.deps.offer();
    const target = targetOf(offer);
    const now = this.deps.now();
    const due = s.mode === "daily" && unavailable === null && !this.pending() ? nextWindow(now, s.at, record.slotDay) : null;
    const window = due !== null && target === null && due.start <= now ? nextWindow(now, s.at, due.day) : due;
    const view: UpdateAutoView = {
      mode: s.mode,
      at: s.at,
      zone: this.deps.zone,
      pinned: { mode: s.pinned.mode, at: s.pinned.at },
      setting: { mode: record.mode, at: record.at, changedAt: record.changedAt },
      target,
      nextAt: window === null ? null : window.start,
      windowEndsAt: window === null ? null : window.end,
      paused: pausedOf(record.failed, offer.current),
    };
    if (unavailable !== null) view.unavailable = unavailable;
    const hold = target === null ? null : holdOf(target, record, offer);
    if (hold !== null) view.hold = hold;
    const waiting = waitingOf(record.skip, target);
    if (waiting !== null) view.waiting = waiting;
    if (record.attempt !== null) view.last = lastOf(record.attempt);
    return view;
  }

  /**
   * @param a The mode and time the phone asked for, its request id, and the pairing label that asked.
   * @returns The saved view, a replay of the same request, or a 409 refusal.
   * @throws When the record cannot be written.
   */
  choose(a: { readonly mode: AutoMode; readonly at: string | null; readonly requestId: string; readonly by: string | null }): AutoChoice {
    const record = this.record;
    const s = autoSetting(this.deps.pins, record);
    if (s.pinned.mode !== null) return pinnedRefusal(s.pinned.mode === "env" ? AUTO_MODE_ENV : CONFIG_SOURCE);
    const at = a.at === null ? null : parseAutoTime(a.at);
    if (s.pinned.at !== null && at !== null && at !== s.at) {
      return pinnedRefusal(s.pinned.at === "env" ? AUTO_AT_ENV : CONFIG_SOURCE);
    }
    const unavailable = this.unavailableOf(s);
    if (a.mode !== "off" && unavailable !== null) {
      return {
        kind: "refused",
        status: 409,
        body: apiError("update.auto_unavailable", { reason: unavailableSentenceOf(unavailable, s.pinned) }),
      };
    }
    if (record.requestId === a.requestId && record.mode === a.mode && (at === null || s.pinned.at !== null || record.at === at)) {
      return { kind: "saved", replay: true, before: record.mode, view: this.view() };
    }
    const saved: AutoUpdateRecord = {
      ...withoutSetBy(record),
      mode: a.mode,
      at: s.pinned.at !== null ? record.at : (at ?? record.at),
      changedAt: this.deps.now(),
      requestId: a.requestId,
    };
    const setBy = a.mode === "off" ? null : labelOf(a.by);
    this.save(setBy === null ? saved : { ...saved, setBy });
    this.wakeAt = 0;
    return { kind: "saved", replay: false, before: record.mode, view: this.view() };
  }

  /**
   * Turns automatic updates off when the device that last turned them on is revoked. Never throws.
   *
   * @param label The pairing label of the revoked device.
   * @param reason Why the device is gone, as its `device.revoke` audit line names it.
   */
  forget(label: string, reason: string): void {
    const record = this.record;
    if (record.mode === "off" || record.setBy !== label) return;
    this.wakeAt = 0;
    try {
      this.save(withoutSetBy({ ...record, mode: "off", changedAt: this.deps.now() }));
    } catch (cause) {
      this.logOnce("forget", `automatic updates could not be turned off for ${label}: ${errorText(cause)}`, "warn");
      return;
    }
    this.deps.audit({ action: "update.auto", device: null, detail: { from: record.mode, to: "off", reason, label } });
    this.deps.log(`automatic updates off: ${label} was revoked`);
  }

  /** @returns A promise that settles when the evaluation in flight, if any, has finished. */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private begin(): void {
    this.running = this.evaluate()
      .catch((cause) => {
        this.wakeAt = this.deps.now() + AUTO_RECHECK_MS;
        this.logOnce("evaluate", `automatic updates: the evaluation failed: ${errorText(cause)}`, "warn");
      })
      .finally(() => {
        this.running = null;
      });
  }

  private async evaluate(): Promise<void> {
    this.wakeAt = await this.decide();
  }

  private async decide(): Promise<number> {
    let now = this.deps.now();
    const s = autoSetting(this.deps.pins, this.record);
    if (!this.pending() && !this.untold() && (s.mode === "off" || this.unavailableOf(s) !== null)) {
      return Number.POSITIVE_INFINITY;
    }
    const run = this.deps.run();
    let offer = this.deps.offer();
    this.reconcile(run, now);
    const tellAt = this.tell(offer, now);
    const restWake = this.pending() ? now + AUTO_RECONCILE_MS : (tellAt ?? Number.POSITIVE_INFINITY);
    if (s.mode === "off" || this.unavailableOf(s) !== null) return restWake;
    if (this.revoked(s)) return restWake;
    this.noteReverts(run, offer, now);
    if (this.pending()) return now + AUTO_RECONCILE_MS;
    if (this.untold()) return tellAt ?? now + AUTO_RECHECK_MS;
    const mode = s.mode === "daily" ? "daily" : "available";
    const window = mode === "daily" ? nextWindow(now, s.at, this.record.slotDay) : null;
    if (window !== null && now < window.start) return window.start;
    const action = this.deps.action;
    if (action === undefined) return restWake;
    if (this.inProgress(run, action)) return now + AUTO_RECHECK_MS;
    if (window !== null && this.freshDay !== window.day && offer.checkedAt !== null && now - offer.checkedAt > AUTO_FRESH_CHECK_MS) {
      this.freshDay = window.day;
      await this.deps.checkRelease();
      offer = this.deps.offer();
      now = this.deps.now();
    }
    const heldWake = window === null ? Number.POSITIVE_INFINITY : window.end;
    const target = targetOf(offer);
    if (target === null || holdOf(target, this.record, offer) !== null) return heldWake;
    const retryAt = this.retryAt(target);
    if (retryAt !== null && now < retryAt) return retryAt;
    if (this.deferred(target, now)) return now + AUTO_RECHECK_MS;
    const report = await this.preflight(action);
    now = this.deps.now();
    const recheck = this.recheck(s, target, action, now, heldWake);
    if (recheck !== null) return recheck;
    const status = this.deps.status();
    if (status.latest !== target) return 0;
    const verdict = updateStartVerdict(
      { confirm: true, target, major: false, peersOnly: false },
      updateStartStateOf({
        status,
        lockHeld: action.lockHeld(),
        starting: action.starting?.() ?? false,
        preflight: report,
        build: this.deps.build,
        crew: this.deps.crew,
      }),
    );
    if (verdict.kind === "refuse") {
      if (verdict.body.code === "update.none_available") return heldWake;
      return this.refused({ target, code: verdict.body.code, error: verdict.body.error, detail: verdict.body.detail, at: now });
    }
    if (verdict.kind !== "start") return heldWake;
    const service = report?.checks.find((check) => check.id === "service");
    if (service === undefined || service.verdict !== "green") {
      return this.refused({ target, code: "service", error: service?.reason ?? NO_SERVICE_ROW, at: now });
    }
    return await this.launch({ target, from: status.current, mode, at: s.at, window, action, now });
  }

  private reconcile(run: UpdateRun | null, now: number): void {
    const attempt = this.record.attempt;
    if (attempt === null || attempt.outcome !== null) return;
    const settled = autoOutcomeOf(attempt, run, now);
    if (settled === null) return;
    const outcome = settled.outcome;
    const record = this.record;
    let failed = record.failed;
    let strikes = record.strikes;
    if (outcome === "no-record") {
      const count = strikes !== null && strikes.version === attempt.version ? strikes.count + 1 : 1;
      strikes = count >= AUTO_NO_RECORD_MAX ? null : { version: attempt.version, count };
      if (count >= AUTO_NO_RECORD_MAX) failed = withFailure(failed, { version: attempt.version, outcome, at: now });
    } else if (outcome === "done") {
      strikes = null;
    } else {
      failed = withFailure(failed, { version: settled.to, outcome, at: now });
    }
    this.save({ ...record, attempt: settledAttempt(attempt, settled, now), failed, strikes });
    this.logOnce(`outcome:${attempt.runId}`, `automatic update to ${settled.to}: ${outcome}`);
  }

  private tell(offer: UpdateOffer, now: number): number | null {
    const attempt = this.record.attempt;
    if (attempt === null || attempt.outcome === null || attempt.toldAt !== null) return null;
    const told: AutoUpdateRecord = { ...this.record, attempt: { ...attempt, toldAt: now } };
    if (attempt.outcome === "no-record" || !this.deps.updatesEnabled()) {
      this.save(told);
      return null;
    }
    if (new Date(now).getHours() < DIGEST_EARLIEST_HOUR) return nextLocalHour(now, DIGEST_EARLIEST_HOUR);
    this.save(told);
    const message = autoPushOf(attempt, { current: offer.current, membersBehind: this.membersBehind(attempt) });
    if (message !== null) this.deps.notify(message);
    if (attempt.outcome !== "done") this.deps.announced(attempt.to ?? attempt.version);
    return null;
  }

  private revoked(s: AutoSetting): boolean {
    const setBy = this.record.setBy;
    if (s.pinned.mode !== null || setBy === undefined) return false;
    const labels = this.deps.labels();
    if (labels === null || labels.includes(setBy)) return false;
    this.forget(setBy, "device-revoked");
    return true;
  }

  private noteReverts(run: UpdateRun | null, offer: UpdateOffer, now: number): void {
    const left = revertedVersion(run);
    if (run !== null && left !== null && compareSemver(left, offer.current) > 0 && !this.holds(left)) {
      this.save({ ...this.record, failed: withFailure(this.record.failed, { version: left, outcome: "reverted", at: run.updatedAt }) });
    }
    const drifted = driftedVersion(this.record.attempt, offer.current);
    if (drifted !== null && !this.holds(drifted)) {
      this.save({ ...this.record, failed: withFailure(this.record.failed, { version: drifted, outcome: "reverted", at: now }) });
    }
  }

  private recheck(s: AutoSetting, target: string, action: AutoAction, now: number, heldWake: number): number | null {
    const current = autoSetting(this.deps.pins, this.record);
    const restWake = this.pending() ? now + AUTO_RECONCILE_MS : Number.POSITIVE_INFINITY;
    if (current.mode === "off" || this.unavailableOf(current) !== null) return restWake;
    if (current.mode !== s.mode || current.at !== s.at) return 0;
    if (this.revoked(current)) return restWake;
    if (this.inProgress(this.deps.run(), action)) return now + AUTO_RECHECK_MS;
    const offer = this.deps.offer();
    if (targetOf(offer) !== target) return 0;
    if (holdOf(target, this.record, offer) !== null) return heldWake;
    if (this.deferred(target, now)) return now + AUTO_RECHECK_MS;
    return null;
  }

  private async launch(a: {
    readonly target: string;
    readonly from: string;
    readonly mode: AutoRunMode;
    readonly at: string;
    readonly window: AutoWindow | null;
    readonly action: AutoAction;
    readonly now: number;
  }): Promise<number> {
    const runId = a.action.newRunId();
    const previous = this.record.attempt;
    this.save({
      ...this.record,
      attempt: { runId, version: a.target, from: a.from, mode: a.mode, startedAt: a.now, outcome: null, settledAt: null, toldAt: null },
    });
    const started = await a.action.start({ major: false, runId, toTag: `v${a.target}`, trigger: "auto" });
    const now = this.deps.now();
    if (!started.ok) {
      this.save({ ...this.record, attempt: previous });
      return this.refused({ target: a.target, ...notStartedOf(started), at: now });
    }
    this.note({ ...this.record, skip: null });
    this.deps.audit({ action: "update", device: null, detail: { to: a.target, major: false, trigger: "auto", mode: a.mode } });
    this.logged.delete("skip");
    this.logOnce("start", `automatic update to ${a.target} started (run ${runId}, ${a.mode === "daily" ? `daily from ${a.at}` : "when available"})`);
    if (a.window !== null) this.save({ ...this.record, slotDay: a.window.day });
    return now + AUTO_RECONCILE_MS;
  }

  private refused(a: {
    readonly target: string;
    readonly code: AutoWaitCode;
    readonly error: string;
    readonly detail?: ApiErrorDetail;
    readonly at: number;
  }): number {
    const prior = this.record.skip;
    const count = prior !== null && prior.version === a.target ? prior.count + 1 : 1;
    const skip: DraftSkip = { code: a.code, at: a.at, version: a.target, count, error: a.error };
    if (a.detail !== undefined) skip.detail = a.detail;
    this.note({ ...this.record, skip });
    this.logOnce("skip", `automatic update to ${a.target} not started: ${a.code}`);
    return a.at + retryDelayMs(count);
  }

  private deferred(target: string, now: number): boolean {
    const busy = quietGuard({ now, lastPollAt: this.deps.lastPollAt(), bootAt: this.deps.bootAt, sends: this.deps.sends() });
    if (busy === null) return false;
    const prior = this.record.skip;
    if (prior === null || prior.code !== busy || prior.version !== target) {
      const count = prior !== null && prior.version === target ? prior.count : 0;
      this.note({ ...this.record, skip: { code: busy, at: now, version: target, count } });
      this.logOnce("skip", `automatic update to ${target} not started: ${busy}`);
    }
    return true;
  }

  private async preflight(action: AutoAction): Promise<PreflightReport | null> {
    try {
      return await action.preflight(true);
    } finally {
      this.note({ ...this.record, lastTryAt: this.deps.now() });
    }
  }

  private retryAt(target: string): number | null {
    const last = this.record.lastTryAt;
    if (last === null) return null;
    const skip = this.record.skip;
    return last + retryDelayMs(skip !== null && skip.version === target ? skip.count : 0);
  }

  private inProgress(run: UpdateRun | null, action: AutoAction): boolean {
    if (run !== null && inFlight(run.state)) return true;
    return action.lockHeld() || action.starting?.() === true || this.deps.crew?.updateRunOpen() === true;
  }

  private membersBehind(attempt: AutoAttempt): number {
    const to = attempt.to ?? attempt.version;
    const rows = this.deps.crew?.updateRows() ?? [];
    return rows.filter((row) => row.version !== null && row.installKind !== "packaged" && compareSemver(row.version, to) < 0).length;
  }

  private holds(version: string): boolean {
    return this.record.failed.some((failure) => failure.version === version);
  }

  private pending(): boolean {
    const attempt = this.record.attempt;
    return attempt !== null && attempt.outcome === null;
  }

  private untold(): boolean {
    const attempt = this.record.attempt;
    return attempt !== null && attempt.outcome !== null && attempt.toldAt === null;
  }

  private unavailableOf(s: AutoSetting): AutoUnavailable | null {
    if (s.invalid !== null) return s.invalid;
    if (this.deps.unavailable !== null) return this.deps.unavailable;
    if (this.deps.action === undefined) return "no_runner";
    return this.deps.deposed() ? "deposed" : null;
  }

  private save(next: AutoUpdateRecord): void {
    const pruned = this.pruned(next);
    this.deps.store.write(pruned);
    this.record = pruned;
  }

  private note(next: AutoUpdateRecord): void {
    const pruned = this.pruned(next);
    this.record = pruned;
    try {
      this.deps.store.write(pruned);
    } catch (cause) {
      this.logOnce("write", `automatic updates: ${UPDATE_AUTO_FILE} could not be written: ${errorText(cause)}`, "warn");
    }
  }

  private pruned(record: AutoUpdateRecord): AutoUpdateRecord {
    const current = this.deps.offer().current;
    const failed = record.failed.filter((failure) => compareSemver(failure.version, current) > 0).slice(-AUTO_FAILED_MAX);
    return failed.length === record.failed.length ? record : { ...record, failed };
  }

  private logOnce(key: string, line: string, channel: "log" | "warn" = "log"): void {
    if (this.logged.get(key) === line) return;
    this.logged.set(key, line);
    if (channel === "warn") this.deps.warn(line);
    else this.deps.log(line);
  }
}

function pinOf(name: string, env: Environment, layer: ConfigFileLayer): AutoPin | null {
  const raw = env[name]?.trim() ?? "";
  if (raw === "") return null;
  const row = settingByEnv(name);
  const origin: AutoPinOrigin = row === undefined || sourceOf(row, env, layer) === "env" ? "env" : "config";
  return { raw, origin };
}

function modeOfPin(raw: string): PinnedMode {
  const word = raw.trim().toLowerCase();
  const known = AUTO_MODES.find((mode) => mode === word);
  if (known !== undefined) return { mode: known, invalid: false };
  return { mode: "off", invalid: !OFF_WORDS.has(word) };
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isDottedVersion(version: string): boolean {
  return version !== "" && version === version.trim() && parsePrereleaseTag(`v${version}`) !== null;
}

function dayAfter(day: string, offset: number): string {
  const date = LOCAL_DAY.exec(day);
  if (date === null) return day;
  return localDay(new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]) + offset, 12).getTime());
}

function windowOf(day: string, start: number): AutoWindow {
  return { day, start, end: start + AUTO_DAILY_WINDOW_MS };
}

function localMinute(at: number): string {
  const date = new Date(at);
  return `${localDay(at)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function modeWords(mode: AutoMode, at: string, zone: string): string {
  if (mode === "off") return "off";
  if (mode === "available") return "when available";
  return zone === "" ? `daily at ${at}` : `daily at ${at} ${zone}`;
}

function unavailableSentenceOf(
  code: AutoUnavailable,
  pinned: { readonly mode: AutoPinOrigin | null; readonly at: AutoPinOrigin | null },
): string {
  if (code === "invalid_mode" && pinned.mode === "config") return `auto_update in ${CONFIG_SOURCE} is not off, daily or available`;
  if (code === "invalid_time" && pinned.at === "config") return `auto_update_at in ${CONFIG_SOURCE} is not a time like 04:00`;
  return AUTO_UNAVAILABLE_SENTENCE[code];
}

function deciderOf(view: Pick<UpdateAutoView, "pinned" | "setting">): string {
  if (view.pinned.mode === "env") return `set by ${AUTO_MODE_ENV}`;
  if (view.pinned.mode === "config") return `set by ${CONFIG_SOURCE}`;
  return view.setting.changedAt === null ? "the default" : "set on the phone";
}

function pushBody(
  outcome: Exclude<AutoOutcome, "no-record">,
  attempt: AutoAttempt,
  to: string,
  a: { readonly current: string; readonly membersBehind: number },
): string {
  const skipped = `Automatic updates skip ${to} until a newer release.`;
  const reason = attempt.reason?.trim() ?? "";
  const because = reason === "" ? "" : `: ${reason}`;
  switch (outcome) {
    case "done":
      return a.membersBehind > 0
        ? `Collie ${to} is running. It replaced ${attempt.from} on its own. The members wait for Retry crew update.`
        : `Collie ${to} is running. It replaced ${attempt.from} on its own.`;
    case "rolled-back":
      return `${to} did not come up, so this machine went back to ${attempt.from}. ${skipped}`;
    case "stuck":
      return `The update to ${to} could not finish${because}. Collie ${a.current} is running. ${skipped}`;
    case "interrupted":
      return `The update to ${to} stopped before it finished. Nothing is half installed. ${skipped}`;
    case "aborted":
      return `The update to ${to} stopped before anything moved${because}. ${skipped}`;
  }
}

function terminalOutcome(state: UpdateRunState): AutoOutcome | null {
  switch (state) {
    case "done":
      return "done";
    case "rolled-back":
      return "rolled-back";
    case "stuck":
      return "stuck";
    case "interrupted":
      return "interrupted";
    case "idle":
      return "aborted";
    default:
      return null;
  }
}

function targetOf(offer: Pick<UpdateOffer, "releaseAvailable" | "latest">): string | null {
  return offer.releaseAvailable ? offer.latest : null;
}

function pinnedRefusal(source: string): AutoChoice {
  return { kind: "refused", status: 409, body: apiError("update.auto_pinned", { source }) };
}

function notStartedOf(started: Extract<UpdateStartResult, { readonly ok: false }>): NotStarted {
  if (started.refusal === "update.in_progress") return { code: started.refusal, error: started.reason, detail: { state: "starting" } };
  if (started.refusal !== undefined) return { code: started.refusal, error: started.reason };
  return { code: "update.start_failed", error: started.reason, detail: { reason: started.reason } };
}

function withoutSetBy(record: AutoUpdateRecord): AutoUpdateRecord {
  const { setBy, ...rest } = record;
  return setBy === undefined ? record : rest;
}

function labelOf(label: string | null): string | null {
  return label === null || label === "" || label.length > AUTO_LABEL_MAX ? null : label;
}

function withFailure(failed: readonly AutoFailure[], failure: AutoFailure): AutoFailure[] {
  return [...failed.filter((known) => known.version !== failure.version), failure];
}

function settledAttempt(attempt: AutoAttempt, settled: AutoSettlement, at: number): AutoAttempt {
  const next: DraftAttempt = {
    runId: attempt.runId,
    version: attempt.version,
    from: attempt.from,
    mode: attempt.mode,
    startedAt: attempt.startedAt,
    outcome: settled.outcome,
    to: settled.to,
    settledAt: at,
    toldAt: attempt.toldAt,
  };
  if (settled.reason !== undefined) next.reason = settled.reason;
  return next;
}

function pausedOf(failed: readonly AutoFailure[], current: string): string[] {
  return [...new Set(failed.map((failure) => failure.version))].filter((version) => compareSemver(version, current) > 0);
}

function waitingOf(skip: AutoSkip | null, target: string | null): AutoWaiting | null {
  if (skip === null || target === null || (skip.version !== null && skip.version !== target)) return null;
  const waiting: AutoWaiting = { code: skip.code, at: skip.at, version: skip.version };
  if (skip.error !== undefined) waiting.error = skip.error;
  if (skip.detail !== undefined) waiting.detail = { ...skip.detail };
  return waiting;
}

function lastOf(attempt: AutoAttempt): AutoLast {
  const last: AutoLast = {
    runId: attempt.runId,
    version: attempt.version,
    from: attempt.from,
    to: attempt.to ?? attempt.version,
    mode: attempt.mode,
    outcome: attempt.outcome,
    startedAt: attempt.startedAt,
    settledAt: attempt.settledAt,
  };
  if (attempt.reason !== undefined) last.reason = attempt.reason;
  return last;
}

function epochOf(value: JsonValue | undefined): number | null {
  const at = asJsonNumber(value);
  return at !== undefined && Number.isFinite(at) ? at : null;
}

function dayOf(value: JsonValue | undefined): string | null {
  const day = asJsonString(value);
  return day !== undefined && LOCAL_DAY.test(day) ? day : null;
}

function versionOf(value: JsonValue | undefined): string | null {
  const version = asJsonString(value);
  return version !== undefined && isDottedVersion(version) ? version : null;
}

function attemptOf(value: JsonValue | undefined): AutoAttempt | null {
  const doc = asJsonObject(value);
  if (doc === undefined) return null;
  const runId = asJsonString(doc.runId);
  const version = versionOf(doc.version);
  const from = versionOf(doc.from);
  const mode = RUN_MODES.find((known) => known === doc.mode);
  const startedAt = epochOf(doc.startedAt);
  if (runId === undefined || runId === "" || version === null || from === null || mode === undefined || startedAt === null) {
    return null;
  }
  const attempt: DraftAttempt = {
    runId,
    version,
    from,
    mode,
    startedAt,
    outcome: OUTCOMES.find((known) => known === doc.outcome) ?? null,
    settledAt: epochOf(doc.settledAt),
    toldAt: epochOf(doc.toldAt),
  };
  const to = versionOf(doc.to);
  if (to !== null) attempt.to = to;
  const reason = asJsonString(doc.reason);
  if (reason !== undefined) attempt.reason = reason.slice(0, AUTO_REASON_MAX);
  return attempt;
}

function failuresOf(value: JsonValue | undefined): AutoFailure[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((raw): AutoFailure[] => {
      const doc = asJsonObject(raw);
      if (doc === undefined) return [];
      const version = versionOf(doc.version);
      const outcome = FAILURE_OUTCOMES.find((known) => known === doc.outcome);
      const at = epochOf(doc.at);
      return version === null || outcome === undefined || at === null ? [] : [{ version, outcome, at }];
    })
    .slice(-AUTO_FAILED_MAX);
}

function strikesOf(value: JsonValue | undefined): AutoUpdateRecord["strikes"] {
  const doc = asJsonObject(value);
  if (doc === undefined) return null;
  const version = versionOf(doc.version);
  const count = asJsonNumber(doc.count);
  if (version === null || count === undefined || !Number.isInteger(count) || count < 1) return null;
  return { version, count };
}

function skipOf(value: JsonValue | undefined): AutoSkip | null {
  const doc = asJsonObject(value);
  if (doc === undefined) return null;
  const code = LOCAL_WAIT_CODES.find((known) => known === doc.code) ?? ERROR_CODE_LIST.find((known) => known === doc.code);
  const at = epochOf(doc.at);
  const version = doc.version === undefined || doc.version === null ? null : versionOf(doc.version);
  if (code === undefined || at === null || (version === null && doc.version !== undefined && doc.version !== null)) return null;
  const count = asJsonNumber(doc.count);
  const skip: DraftSkip = { code, at, version, count: count !== undefined && Number.isInteger(count) && count >= 0 ? count : 0 };
  const error = asJsonString(doc.error);
  if (error !== undefined) skip.error = error;
  const detail = detailOf(doc.detail);
  if (detail !== null) skip.detail = detail;
  return skip;
}

function detailOf(value: JsonValue | undefined): ApiErrorDetail | null {
  const doc = asJsonObject(value);
  if (doc === undefined) return null;
  const entries: [string, string | number][] = [];
  for (const [key, raw] of Object.entries(doc)) {
    const text = asJsonString(raw);
    const number = asJsonNumber(raw);
    if (text !== undefined) entries.push([key, text]);
    else if (number !== undefined) entries.push([key, number]);
    else return null;
  }
  return Object.fromEntries(entries);
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
