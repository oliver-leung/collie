import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuditEntry } from "./audit.ts";
import { buildConfigLayer, overlayConfig, type ConfigFileLayer, type ConfigSource, type Environment } from "./config-source.ts";
import { apiError, type ErrorCode } from "./error-codes.ts";
import type { JsonObject } from "./json.ts";
import type { PushMessage } from "./push.ts";
import type { UpdateStatus } from "./types.ts";
import { compareSemver, type UpdateOffer } from "./update.ts";
import { worstVerdict, type CrewUpdateRow, type PreflightCheck, type PreflightReport, type UpdateStartResult } from "./update-action.ts";
import { diskWriter, type UpdateLineWriter } from "./update-line.ts";
import type { RunTrigger, UpdateRun, UpdateRunState } from "./update-run.ts";
import {
  AUTO_DAILY_WINDOW_MS,
  AUTO_FAILED_MAX,
  AUTO_FRESH_CHECK_MS,
  AUTO_QUIET_MS,
  AUTO_RECHECK_MS,
  AUTO_RECONCILE_MS,
  AUTO_RECORD_WAIT_MS,
  AUTO_RETRY_MS,
  AUTO_UNAVAILABLE_SENTENCE,
  AutoUpdater,
  autoEligibility,
  autoOutcomeOf,
  autoPinWarnings,
  autoPinsOf,
  autoPushOf,
  autoSetting,
  autoUpdateLine,
  bareRunVersion,
  currentSlot,
  DEFAULT_AUTO_RECORD,
  driftedVersion,
  holdOf,
  localDay,
  nextLocalHour,
  nextWindow,
  parseAutoMode,
  parseAutoRecord,
  parseAutoRequestText,
  parseAutoTime,
  pinnable,
  quietGuard,
  readAutoRecordSync,
  retryDelayMs,
  revertedVersion,
  slotStart,
  UPDATE_AUTO_FILE,
  updateAutoPath,
  writeAutoRecord,
  type AutoAttempt,
  type AutoFacts,
  type AutoFailure,
  type AutoMode,
  type AutoPins,
  type AutoSkip,
  type AutoUnavailable,
  type AutoUpdateRecord,
  type AutoUpdaterDeps,
  type AutoWaitCode,
  type UpdateAutoView,
} from "./update-auto.ts";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const REQUEST_ID = "0b7f0c9e-0f37-4d65-9a2c-8b0f5f4c2b11";
const OTHER_ID = "9a8b7c6d-1e2f-4a3b-8c9d-0e1f2a3b4c5d";
const NO_PINS: AutoPins = { mode: null, at: null };
const MODES: readonly AutoMode[] = ["off", "daily", "available"];
const ON_MODES: readonly AutoMode[] = ["daily", "available"];
const IN_FLIGHT_STATES: readonly UpdateRunState[] = ["preflight", "staging", "restarting", "verifying"];
const ZONE_BEFORE = process.env.TZ;

beforeEach(() => {
  process.env.TZ = "UTC";
});

afterEach(() => {
  if (ZONE_BEFORE === undefined) delete process.env.TZ;
  else process.env.TZ = ZONE_BEFORE;
});

function local(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  return new Date(year, month - 1, day, hour, minute, second, 0).getTime();
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

function record(extra: Partial<AutoUpdateRecord> = {}): AutoUpdateRecord {
  return { ...DEFAULT_AUTO_RECORD, ...extra };
}

function attempt(extra: Partial<AutoAttempt> = {}): AutoAttempt {
  return {
    runId: "run-a",
    version: "1.30.0",
    from: "1.29.0",
    mode: "available",
    startedAt: 0,
    outcome: null,
    settledAt: null,
    toldAt: null,
    ...extra,
  };
}

function runRecord(state: UpdateRunState, extra: Partial<UpdateRun> = {}): UpdateRun {
  return { schema: 2, state, from: "1.29.0", to: "1.30.0", startedAt: 0, updatedAt: 0, pid: 4242, attempt: 0, ...extra };
}

function check(id: string, verdict: PreflightCheck["verdict"], reason = `${id} is ${verdict}`): PreflightCheck {
  return { id, verdict, reason };
}

function report(...checks: PreflightCheck[]): PreflightReport {
  return { schema: 1, verdict: worstVerdict(checks.map((c) => c.verdict)), checks };
}

function greenReport(): PreflightReport {
  return report(check("tree", "green"), check("service", "green", "collie.service is active — the update can restart it"));
}

function offerOf(current: string, latest: string | null, checkedAt: number | null, extra: Partial<UpdateOffer> = {}): UpdateOffer {
  return {
    current,
    latest,
    releaseAvailable: latest !== null && compareSemver(latest, current) > 0,
    linkChange: null,
    linkKnown: true,
    dismissed: null,
    checkedAt,
    ...extra,
  };
}

function statusOf(offer: UpdateOffer, run: UpdateRun | null): UpdateStatus {
  const status: UpdateStatus = {
    current: offer.current,
    latest: offer.latest,
    latestUrl: null,
    releaseAvailable: offer.releaseAvailable,
    majorAvailable: null,
    majorUrl: null,
    installKind: "binary",
    dismissedVersion: offer.dismissed,
    dismissedCrewVersion: null,
    bridgeStale: false,
    restartNeeded: false,
    checkedAt: offer.checkedAt,
  };
  if (run !== null) status.run = run;
  return status;
}

function row(name: string, version: string | null, extra: Partial<CrewUpdateRow> = {}): CrewUpdateRow {
  return { name, version, verdict: "green", reasons: [], asOf: 1, ...extra };
}

interface StartCall {
  readonly major: boolean;
  readonly runId: string;
  readonly toTag: string;
  readonly trigger: RunTrigger;
}

interface World {
  now: number;
  offer: UpdateOffer;
  status: UpdateStatus | null;
  run: UpdateRun | null;
  report: PreflightReport | null;
  lockHeld: boolean;
  starting: boolean;
  startResult: UpdateStartResult;
  rows: CrewUpdateRow[];
  crewRunOpen: boolean;
  lastPollAt: number | null;
  sends: { readonly phase: string }[];
  labels: string[] | null;
  updatesEnabled: boolean;
  deposed: boolean;
  writeFails: boolean;
  runFails: boolean;
  runIds: number;
  gate: Promise<void> | null;
  onPreflight: (() => void) | null;
  onCheck: (() => void) | null;
  onStatus: (() => void) | null;
}

interface Harness {
  readonly updater: AutoUpdater;
  readonly world: World;
  readonly writes: AutoUpdateRecord[];
  readonly starts: StartCall[];
  readonly savedAtStart: (AutoUpdateRecord | undefined)[];
  readonly preflights: (boolean | undefined)[];
  readonly checks: number[];
  readonly pushes: PushMessage[];
  readonly toldAtPush: (number | null | undefined)[];
  readonly announced: string[];
  readonly audits: AuditEntry[];
  readonly logs: string[];
  readonly warns: string[];
  readonly order: string[];
  readonly reads: { run: number; offer: number };
}

interface RigOptions {
  readonly record?: AutoUpdateRecord;
  readonly pins?: AutoPins;
  readonly unavailable?: AutoUnavailable | null;
  readonly crew?: boolean;
  readonly action?: boolean;
  readonly now?: number;
  readonly bootAt?: number;
  readonly zone?: string;
  readonly build?: string;
}

function rig(o: RigOptions = {}): Harness {
  const now = o.now ?? local(2026, 11, 14, 10);
  const world: World = {
    now,
    offer: offerOf("1.29.0", "1.30.0", now - 5 * MINUTE),
    status: null,
    run: null,
    report: greenReport(),
    lockHeld: false,
    starting: false,
    startResult: { ok: true },
    rows: [],
    crewRunOpen: false,
    lastPollAt: null,
    sends: [],
    labels: ["pixel-7"],
    updatesEnabled: true,
    deposed: false,
    writeFails: false,
    runFails: false,
    runIds: 0,
    gate: null,
    onPreflight: null,
    onCheck: null,
    onStatus: null,
  };
  const writes: AutoUpdateRecord[] = [];
  const starts: StartCall[] = [];
  const savedAtStart: (AutoUpdateRecord | undefined)[] = [];
  const preflights: (boolean | undefined)[] = [];
  const checks: number[] = [];
  const pushes: PushMessage[] = [];
  const toldAtPush: (number | null | undefined)[] = [];
  const announced: string[] = [];
  const audits: AuditEntry[] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  const order: string[] = [];
  const reads = { run: 0, offer: 0 };
  const deps: AutoUpdaterDeps = {
    now: () => world.now,
    bootAt: o.bootAt ?? now - DAY,
    store: {
      read: () => o.record ?? DEFAULT_AUTO_RECORD,
      write: (next) => {
        if (world.writeFails) throw new Error("disk full");
        writes.push(next);
        order.push("write");
      },
    },
    pins: o.pins ?? NO_PINS,
    unavailable: o.unavailable ?? null,
    deposed: () => world.deposed,
    crewMode: o.crew === true ? "lead" : "solo",
    zone: o.zone ?? "Europe/Berlin",
    offer: () => {
      reads.offer += 1;
      return world.offer;
    },
    status: () => {
      const hook = world.onStatus;
      world.onStatus = null;
      hook?.();
      return world.status ?? statusOf(world.offer, world.run);
    },
    checkRelease: async () => {
      checks.push(world.now);
      const hook = world.onCheck;
      world.onCheck = null;
      hook?.();
    },
    run: () => {
      reads.run += 1;
      if (world.runFails) throw new Error("unreadable");
      return world.run;
    },
    action:
      o.action === false
        ? undefined
        : {
            preflight: async (force) => {
              preflights.push(force);
              order.push("preflight");
              if (world.gate !== null) await world.gate;
              const hook = world.onPreflight;
              world.onPreflight = null;
              hook?.();
              return world.report;
            },
            lockHeld: () => world.lockHeld,
            starting: () => world.starting,
            newRunId: () => {
              world.runIds += 1;
              return `run-${world.runIds}`;
            },
            start: (a) => {
              starts.push(a);
              savedAtStart.push(writes.at(-1));
              order.push("start");
              return world.startResult;
            },
          },
    build: o.build ?? "1.29.0",
    crew:
      o.crew === true
        ? { updateRows: () => world.rows, updatePeers: () => [], updateRunOpen: () => world.crewRunOpen }
        : null,
    lastPollAt: () => world.lastPollAt,
    sends: () => world.sends,
    labels: () => world.labels,
    updatesEnabled: () => world.updatesEnabled,
    notify: (message) => {
      pushes.push(message);
      toldAtPush.push(writes.at(-1)?.attempt?.toldAt);
      order.push("notify");
    },
    announced: (version) => {
      announced.push(version);
    },
    audit: (entry) => {
      audits.push(entry);
    },
    log: (line) => {
      logs.push(line);
    },
    warn: (line) => {
      warns.push(line);
    },
  };
  return {
    updater: new AutoUpdater(deps),
    world,
    writes,
    starts,
    savedAtStart,
    preflights,
    checks,
    pushes,
    toldAtPush,
    announced,
    audits,
    logs,
    warns,
    order,
    reads,
  };
}

async function step(h: Harness, at?: number): Promise<void> {
  if (at !== undefined) h.world.now = at;
  h.updater.tick();
  await h.updater.settled();
}

function lastWrite(h: Harness): AutoUpdateRecord | undefined {
  return h.writes.at(-1);
}

function layerOf(env: Environment, source: ConfigSource): ConfigFileLayer {
  return {
    env,
    sources: new Map(Object.keys(env).map((name): [string, ConfigSource] => [name, source])),
    problems: [],
    files: [],
    blocked: [],
  };
}

const EMPTY_LAYER: ConfigFileLayer = layerOf({}, "file:instance");

describe("the setting and its pins", () => {
  test("no file and no pin reads off at 04:00, decided by nothing", () => {
    expect(autoSetting(NO_PINS, DEFAULT_AUTO_RECORD)).toEqual({
      mode: "off",
      at: "04:00",
      pinned: { mode: null, at: null },
      invalid: null,
    });
  });

  test("with no pin the record's own mode and time decide", () => {
    expect(autoSetting(NO_PINS, record({ mode: "daily", at: "05:30" }))).toEqual({
      mode: "daily",
      at: "05:30",
      pinned: { mode: null, at: null },
      invalid: null,
    });
  });

  test("a pin in the environment decides the mode and names env", () => {
    const pins = autoPinsOf({ COLLIE_AUTO_UPDATE: "daily" }, EMPTY_LAYER);
    expect(pins).toEqual({ mode: { raw: "daily", origin: "env" }, at: null });
    expect(autoSetting(pins, record({ mode: "available" }))).toMatchObject({ mode: "daily", pinned: { mode: "env", at: null } });
  });

  test("a pin that came from config.toml names config, through sourceOf", () => {
    const fileEnv = { COLLIE_AUTO_UPDATE: "available", COLLIE_AUTO_UPDATE_AT: "05:00" };
    const pins = autoPinsOf({ ...fileEnv }, layerOf(fileEnv, "file:instance"));
    expect(pins).toEqual({ mode: { raw: "available", origin: "config" }, at: { raw: "05:00", origin: "config" } });
    expect(autoSetting(pins, DEFAULT_AUTO_RECORD)).toEqual({
      mode: "available",
      at: "05:00",
      pinned: { mode: "config", at: "config" },
      invalid: null,
    });
  });

  test("a process value over the file's value names env", () => {
    const pins = autoPinsOf({ COLLIE_AUTO_UPDATE: "off" }, layerOf({ COLLIE_AUTO_UPDATE: "daily" }, "file:home"));
    expect(pins.mode).toEqual({ raw: "off", origin: "env" });
  });

  test("an unset or empty variable is no pin", () => {
    expect(autoPinsOf({ COLLIE_AUTO_UPDATE: "  ", COLLIE_AUTO_UPDATE_AT: "" }, EMPTY_LAYER)).toEqual(NO_PINS);
  });

  test("an unknown word reads as off and marks the mode invalid", () => {
    const pins: AutoPins = { mode: { raw: "weekly", origin: "env" }, at: null };
    expect(autoSetting(pins, record({ mode: "daily" }))).toEqual({
      mode: "off",
      at: "04:00",
      pinned: { mode: "env", at: null },
      invalid: "invalid_mode",
    });
    expect(autoPinWarnings(pins)).toEqual(["COLLIE_AUTO_UPDATE=weekly is not off, daily or available, read as off"]);
  });

  test("0, false and no read as off without a warning", () => {
    for (const word of ["0", "false", "no", "NO"]) {
      const pins: AutoPins = { mode: { raw: word, origin: "env" }, at: null };
      expect(autoSetting(pins, record({ mode: "daily" }))).toMatchObject({ mode: "off", invalid: null });
      expect(autoPinWarnings(pins)).toEqual([]);
    }
  });

  test("a pin word is read in any case and with spaces around it", () => {
    const pins = autoPinsOf({ COLLIE_AUTO_UPDATE: "  Daily " }, EMPTY_LAYER);
    expect(autoSetting(pins, DEFAULT_AUTO_RECORD)).toMatchObject({ mode: "daily", invalid: null });
    expect(autoSetting({ mode: { raw: " AVAILABLE ", origin: "config" }, at: null }, DEFAULT_AUTO_RECORD).mode).toBe("available");
    expect(autoPinWarnings(pins)).toEqual([]);
  });

  test("a time pin is normalized and locks the time", () => {
    const pins: AutoPins = { mode: null, at: { raw: "4:05", origin: "env" } };
    expect(autoSetting(pins, record({ mode: "daily", at: "06:00" }))).toEqual({
      mode: "daily",
      at: "04:05",
      pinned: { mode: null, at: "env" },
      invalid: null,
    });
  });

  test("a time pin that does not parse turns automatic updates off in every mode", () => {
    const pins: AutoPins = { mode: null, at: { raw: "25:00", origin: "env" } };
    for (const mode of MODES) {
      expect(autoSetting(pins, record({ mode, at: "06:00" }))).toEqual({
        mode,
        at: "06:00",
        pinned: { mode: null, at: "env" },
        invalid: "invalid_time",
      });
    }
    const pinnedMode: AutoPins = { mode: { raw: "available", origin: "env" }, at: { raw: "noon", origin: "config" } };
    expect(autoSetting(pinnedMode, DEFAULT_AUTO_RECORD).invalid).toBe("invalid_time");
    expect(autoPinWarnings(pinnedMode)).toEqual([
      'auto_update_at = "noon" in config.toml is not a time like 04:00, so automatic updates are off',
    ]);
  });

  test("a bad mode pin outranks a bad time pin, and both are warned about", () => {
    const pins: AutoPins = { mode: { raw: "sometimes", origin: "config" }, at: { raw: "4pm", origin: "env" } };
    expect(autoSetting(pins, DEFAULT_AUTO_RECORD).invalid).toBe("invalid_mode");
    expect(autoPinWarnings(pins)).toEqual([
      'auto_update = "sometimes" in config.toml is not off, daily or available, read as off',
      "COLLIE_AUTO_UPDATE_AT=4pm is not a time like 04:00, so automatic updates are off",
    ]);
  });

  test("a record time that does not parse reads as 04:00", () => {
    expect(autoSetting(NO_PINS, record({ mode: "daily", at: "late" })).at).toBe("04:00");
    expect(parseAutoRecord(JSON.stringify({ schema: 1, mode: "daily", at: "24:00" })).at).toBe("04:00");
  });

  test("a config.toml value that is not a string still pins the setting, and fails closed", () => {
    function pinsOf(toml: string): AutoPins {
      const layer = buildConfigLayer([{ path: "/srv/collie/config.toml", layer: "instance", text: `[update]\n${toml}\n`, error: null }], () => {}, {
        home: "/home/pat",
      });
      return autoPinsOf(overlayConfig({}, layer), layer);
    }
    const phone = record({ mode: "daily", at: "05:00" });
    expect(autoSetting(pinsOf("auto_update = false"), phone)).toEqual({ mode: "off", at: "05:00", pinned: { mode: "config", at: null }, invalid: null });
    expect(autoSetting(pinsOf("auto_update = 0"), phone)).toMatchObject({ mode: "off", pinned: { mode: "config" }, invalid: null });
    expect(autoSetting(pinsOf("auto_update = true"), phone)).toMatchObject({ mode: "off", pinned: { mode: "config" }, invalid: "invalid_mode" });
    expect(autoSetting(pinsOf('auto_update = ["daily"]'), phone)).toMatchObject({ mode: "off", invalid: "invalid_mode" });
    expect(autoSetting(pinsOf("auto_update_at = 04:00:00"), phone)).toMatchObject({
      mode: "daily",
      pinned: { mode: null, at: "config" },
      invalid: "invalid_time",
    });
    expect(autoSetting(pinsOf("auto_update_at = 4"), phone)).toMatchObject({ pinned: { at: "config" }, invalid: "invalid_time" });
    expect(autoPinWarnings(pinsOf("auto_update = true"))).toEqual([
      'auto_update = "true" in config.toml is not off, daily or available, read as off',
    ]);
    expect(autoPinWarnings(pinsOf("auto_update_at = 04:00:00"))).toEqual([
      'auto_update_at = "04:00:00" in config.toml is not a time like 04:00, so automatic updates are off',
    ]);
  });
});

describe("parsing a mode, a time and a request", () => {
  test("parseAutoMode takes the three lowercase words only", () => {
    expect(parseAutoMode("off")).toBe("off");
    expect(parseAutoMode("daily")).toBe("daily");
    expect(parseAutoMode("available")).toBe("available");
    expect(parseAutoMode("Daily")).toBeNull();
    expect(parseAutoMode(" daily")).toBeNull();
    expect(parseAutoMode(1)).toBeNull();
    expect(parseAutoMode(undefined)).toBeNull();
  });

  test("parseAutoTime takes 00:00 to 23:59 and pads the hour", () => {
    expect(parseAutoTime("04:00")).toBe("04:00");
    expect(parseAutoTime("4:00")).toBe("04:00");
    expect(parseAutoTime("23:59")).toBe("23:59");
    expect(parseAutoTime("00:00")).toBe("00:00");
    for (const bad of ["24:00", "12:60", "4", "04:0", "04:00:00", " 04:00", "", "noon"]) expect(parseAutoTime(bad)).toBeNull();
    expect(parseAutoTime(400)).toBeNull();
    expect(parseAutoTime(null)).toBeNull();
  });

  test("a valid body", () => {
    expect(parseAutoRequestText(JSON.stringify({ mode: "daily", at: "5:30", requestId: REQUEST_ID }))).toEqual({
      mode: "daily",
      at: "05:30",
      atInvalid: false,
      requestId: REQUEST_ID,
    });
  });

  test("no time is no time, and no mode is a null mode", () => {
    expect(parseAutoRequestText(JSON.stringify({ mode: "off", requestId: REQUEST_ID }))).toEqual({
      mode: "off",
      at: null,
      atInvalid: false,
      requestId: REQUEST_ID,
    });
    expect(parseAutoRequestText(JSON.stringify({ requestId: REQUEST_ID }))?.mode).toBeNull();
    expect(parseAutoRequestText(JSON.stringify({ mode: "weekly", requestId: REQUEST_ID }))?.mode).toBeNull();
  });

  test("a time that does not parse is marked invalid", () => {
    expect(parseAutoRequestText(JSON.stringify({ mode: "daily", at: "25:00", requestId: REQUEST_ID }))).toMatchObject({
      at: null,
      atInvalid: true,
    });
    expect(parseAutoRequestText(JSON.stringify({ mode: "daily", at: null, requestId: REQUEST_ID }))?.atInvalid).toBe(true);
  });

  test("a request id that is not a UUID is null", () => {
    expect(parseAutoRequestText(JSON.stringify({ mode: "daily", requestId: "abc" }))?.requestId).toBeNull();
    expect(parseAutoRequestText(JSON.stringify({ mode: "daily" }))?.requestId).toBeNull();
  });

  test("a body that is not a JSON object is null", () => {
    expect(parseAutoRequestText("{")).toBeNull();
    expect(parseAutoRequestText("[]")).toBeNull();
    expect(parseAutoRequestText('"daily"')).toBeNull();
  });
});

describe("who may update itself", () => {
  const ELIGIBLE: AutoFacts = {
    crewMode: "solo",
    canRun: true,
    installKind: "binary",
    underVersions: false,
    platform: "linux",
    build: "1.29.0",
    env: {},
    supervised: true,
  };
  const DEV = "1.29.0-dev+c7ac1e91";
  const MIRROR = { COLLIE_UPDATE_MIRROR: "http://127.0.0.1:9" };
  const rows: [AutoUnavailable, Partial<AutoFacts>][] = [
    ["peer", { crewMode: "peer", canRun: false, installKind: "packaged" }],
    ["no_runner", { canRun: false, installKind: "packaged" }],
    ["packaged", { installKind: "packaged", platform: "win32", build: DEV }],
    ["unknown_install", { installKind: "unknown", build: DEV }],
    ["windows_checkout", { installKind: "detached-checkout", platform: "win32", underVersions: true }],
    ["in_place", { installKind: "detached-checkout", underVersions: false, build: DEV }],
    ["first_stage", { installKind: "linked-clone", underVersions: false, build: DEV }],
    ["dev_build", { build: DEV, env: { CI: "1", ...MIRROR } }],
    ["ci", { env: { CI: "true", ...MIRROR }, supervised: false }],
    ["mirror", { env: MIRROR, supervised: false }],
    ["unsupervised", { supervised: false }],
  ];
  for (const [code, facts] of rows) {
    test(`${code} is the first reason that holds`, () => {
      expect(autoEligibility({ ...ELIGIBLE, ...facts })).toBe(code);
    });
  }

  test("each reason has its English sentence", () => {
    expect(AUTO_UNAVAILABLE_SENTENCE).toEqual({
      peer: "this machine is a crew member, and it follows its lead",
      no_runner: "this bridge runs from source with no compiled collie to start",
      packaged: "a package manager owns this install",
      unknown_install: "Collie cannot tell how this machine was installed",
      windows_checkout: "a source checkout on Windows never updates itself",
      in_place: "this checkout updates in place, with no health check and no way back",
      first_stage: "this checkout has not staged an update yet, and its first staged update has no way back",
      dev_build: "this is a development build",
      ci: "CI is set on this machine",
      mirror: "COLLIE_UPDATE_MIRROR is set on this machine",
      unsupervised: "no service manager restarts this bridge",
      deposed: "this machine handed the crew to another lead",
      invalid_mode: "COLLIE_AUTO_UPDATE is not off, daily or available",
      invalid_time: "COLLIE_AUTO_UPDATE_AT is not a time like 04:00",
    });
  });

  test("a linked clone outside versions/ is first_stage, inside it is eligible", () => {
    expect(autoEligibility({ ...ELIGIBLE, installKind: "linked-clone", underVersions: false })).toBe("first_stage");
    expect(autoEligibility({ ...ELIGIBLE, installKind: "linked-clone", underVersions: true })).toBeNull();
  });

  test("the eligible installs", () => {
    expect(autoEligibility(ELIGIBLE)).toBeNull();
    expect(autoEligibility({ ...ELIGIBLE, installKind: "detached-checkout", underVersions: true })).toBeNull();
    expect(autoEligibility({ ...ELIGIBLE, crewMode: "lead", installKind: "linked-clone", underVersions: true })).toBeNull();
    expect(autoEligibility({ ...ELIGIBLE, platform: "darwin", supervised: null })).toBeNull();
    expect(autoEligibility({ ...ELIGIBLE, platform: "win32", supervised: null })).toBeNull();
    expect(autoEligibility({ ...ELIGIBLE, env: { CI: " ", COLLIE_UPDATE_MIRROR: "" } })).toBeNull();
  });
});

describe("slot math on the host's clock", () => {
  function due(now: number, at: string, slotDay: string | null): boolean {
    const window = nextWindow(now, at, slotDay);
    return window.start <= now && now < window.end;
  }

  test("an ordinary New York day is due from 04:00 to 06:59:59 and at no other time", () => {
    process.env.TZ = "America/New_York";
    expect(due(local(2026, 11, 16, 3, 59, 59), "04:00", null)).toBe(false);
    expect(due(local(2026, 11, 16, 4, 0), "04:00", null)).toBe(true);
    expect(due(local(2026, 11, 16, 6, 59, 59), "04:00", null)).toBe(true);
    expect(due(local(2026, 11, 16, 7, 0), "04:00", null)).toBe(false);
    expect(nextWindow(local(2026, 11, 16, 7, 0), "04:00", null)).toEqual({
      day: "2026-11-17",
      start: local(2026, 11, 17, 4),
      end: local(2026, 11, 17, 7),
    });
    expect(nextWindow(local(2026, 11, 16, 3, 0), "04:00", null).start).toBe(local(2026, 11, 16, 4));
  });

  test("a time in the spring-forward gap opens at 03:30 EDT, once", () => {
    process.env.TZ = "America/New_York";
    const start = slotStart("2027-03-14", "02:30");
    expect(iso(start)).toBe("2027-03-14T07:30:00.000Z");
    expect(nextWindow(local(2027, 3, 14, 3, 0), "02:30", null).start).toBe(start);
    expect(due(start, "02:30", null)).toBe(true);
    expect(due(start + 10 * MINUTE, "02:30", "2027-03-14")).toBe(false);
    expect(iso(nextWindow(start + 10 * MINUTE, "02:30", "2027-03-14").start)).toBe("2027-03-15T06:30:00.000Z");
  });

  test("a time in the fall-back repeat opens at its first occurrence only", () => {
    process.env.TZ = "America/New_York";
    const first = slotStart("2027-11-07", "01:30");
    expect(iso(first)).toBe("2027-11-07T05:30:00.000Z");
    const window = nextWindow(first, "01:30", null);
    expect(window.end - window.start).toBe(AUTO_DAILY_WINDOW_MS);
    const second = first + HOUR;
    expect(due(second, "01:30", null)).toBe(true);
    expect(due(second, "01:30", "2027-11-07")).toBe(false);
    expect(iso(nextWindow(second, "01:30", "2027-11-07").start)).toBe("2027-11-08T06:30:00.000Z");
  });

  test("a spent slot waits for tomorrow", () => {
    process.env.TZ = "America/New_York";
    expect(due(local(2026, 11, 16, 4, 30), "04:00", "2026-11-16")).toBe(false);
    expect(nextWindow(local(2026, 11, 16, 4, 30), "04:00", "2026-11-16").start).toBe(local(2026, 11, 17, 4));
  });

  test("a time changed after the slot was spent waits for tomorrow", () => {
    process.env.TZ = "America/New_York";
    const now = local(2026, 11, 16, 5, 0);
    expect(nextWindow(now, "10:00", "2026-11-16").start).toBe(local(2026, 11, 17, 10));
    expect(nextWindow(now, "03:00", "2026-11-16").start).toBe(local(2026, 11, 17, 3));
    expect(nextWindow(now, "10:00", "2026-11-15").start).toBe(local(2026, 11, 16, 10));
  });

  test("a 23:00 window that runs past midnight belongs to the day it opened", () => {
    process.env.TZ = "America/New_York";
    const now = local(2026, 11, 17, 0, 30);
    expect(currentSlot(now, "23:00")).toEqual({ day: "2026-11-16", start: local(2026, 11, 16, 23), end: local(2026, 11, 17, 2) });
    expect(nextWindow(now, "23:00", null).day).toBe("2026-11-16");
    expect(due(now, "23:00", null)).toBe(true);
    expect(nextWindow(now, "23:00", "2026-11-16")).toEqual({
      day: "2026-11-17",
      start: local(2026, 11, 17, 23),
      end: local(2026, 11, 18, 2),
    });
  });

  test("Auckland's 12:30 comes once per local day, not per UTC day", () => {
    process.env.TZ = "Pacific/Auckland";
    const now = local(2026, 11, 14, 12, 45);
    expect(iso(now).slice(0, 10)).toBe("2026-11-13");
    expect(localDay(now)).toBe("2026-11-14");
    expect(nextWindow(now, "12:30", null)).toEqual({
      day: "2026-11-14",
      start: local(2026, 11, 14, 12, 30),
      end: local(2026, 11, 14, 15, 30),
    });
    expect(due(local(2026, 11, 14, 23, 0), "12:30", "2026-11-14")).toBe(false);
    expect(nextWindow(local(2026, 11, 14, 23, 0), "12:30", "2026-11-14").start).toBe(local(2026, 11, 15, 12, 30));
  });

  test("nextLocalHour at 08:59 is today's 09:00 and at 09:01 tomorrow's", () => {
    process.env.TZ = "America/New_York";
    expect(nextLocalHour(local(2026, 11, 16, 8, 59), 9)).toBe(local(2026, 11, 16, 9));
    expect(nextLocalHour(local(2026, 11, 16, 9, 1), 9)).toBe(local(2026, 11, 17, 9));
  });

  test("a day or a time that does not parse has no slot", () => {
    expect(slotStart("tomorrow", "04:00")).toBeNaN();
    expect(slotStart("2026-11-16", "4 am")).toBeNaN();
  });
});

describe("what a run record says about an attempt", () => {
  const pending = attempt({ startedAt: 1000 });

  test("each terminal state of the attempt's own run", () => {
    expect(autoOutcomeOf(pending, runRecord("done", { runId: "run-a" }), 2000)).toEqual({ outcome: "done", to: "1.30.0" });
    expect(autoOutcomeOf(pending, runRecord("rolled-back", { runId: "run-a", reason: "no answer" }), 2000)).toEqual({
      outcome: "rolled-back",
      to: "1.30.0",
      reason: "no answer",
    });
    expect(autoOutcomeOf(pending, runRecord("stuck", { runId: "run-a", reason: "the rollback failed too" }), 2000)).toEqual({
      outcome: "stuck",
      to: "1.30.0",
      reason: "the rollback failed too",
    });
    expect(autoOutcomeOf(pending, runRecord("interrupted", { runId: "run-a" }), 2000)).toEqual({ outcome: "interrupted", to: "1.30.0" });
    expect(autoOutcomeOf(pending, runRecord("idle", { runId: "run-a", reason: "v1.30.0 is not published yet" }), 2000)).toEqual({
      outcome: "aborted",
      to: "1.30.0",
      reason: "v1.30.0 is not published yet",
    });
  });

  test("a version directory reads as its version", () => {
    expect(autoOutcomeOf(pending, runRecord("done", { runId: "run-a", to: "v1.30.0" }), 2000)?.to).toBe("1.30.0");
    expect(autoOutcomeOf(pending, runRecord("done", { runId: "run-a", to: null }), 2000)?.to).toBe("1.30.0");
  });

  test("a long reason is cut to 240 characters", () => {
    expect(autoOutcomeOf(pending, runRecord("stuck", { runId: "run-a", reason: "x".repeat(500) }), 2000)?.reason).toHaveLength(240);
  });

  test("a run still in flight has no outcome yet", () => {
    for (const state of IN_FLIGHT_STATES) {
      expect(autoOutcomeOf(pending, runRecord(state, { runId: "run-a" }), 1000 + DAY)).toBeNull();
    }
  });

  test("another run's record is never the attempt's, even on the attempt's version", () => {
    const other = runRecord("done", { runId: "a-tap", to: "1.30.0" });
    expect(autoOutcomeOf(pending, other, 1000 + AUTO_RECORD_WAIT_MS - 1)).toBeNull();
    expect(autoOutcomeOf(pending, other, 1000 + AUTO_RECORD_WAIT_MS)).toEqual({ outcome: "no-record", to: "1.30.0" });
    expect(autoOutcomeOf(pending, runRecord("done"), 1000 + AUTO_RECORD_WAIT_MS)?.outcome).toBe("no-record");
    expect(autoOutcomeOf(pending, null, 1000 + AUTO_RECORD_WAIT_MS - 1)).toBeNull();
    expect(autoOutcomeOf(pending, null, 1000 + AUTO_RECORD_WAIT_MS)?.outcome).toBe("no-record");
  });

  test("revertedVersion names the build a done phone rollback left, and nothing else", () => {
    expect(revertedVersion(runRecord("done", { action: "rollback", from: "v1.30.0", to: "v1.29.0" }))).toBe("1.30.0");
    expect(revertedVersion(runRecord("done", { action: "rollback", from: "1.30.0", to: "1.29.0" }))).toBe("1.30.0");
    expect(revertedVersion(runRecord("verifying", { action: "rollback", from: "1.30.0" }))).toBeNull();
    expect(revertedVersion(runRecord("done", { action: "switch", from: "1.30.0-edge.2" }))).toBeNull();
    expect(revertedVersion(runRecord("done"))).toBeNull();
    expect(revertedVersion(runRecord("done", { action: "rollback", from: null }))).toBeNull();
    expect(revertedVersion(null)).toBeNull();
  });

  test("driftedVersion names a done automatic version above the running one", () => {
    const done = attempt({ outcome: "done", to: "1.30.0" });
    expect(driftedVersion(done, "1.29.0")).toBe("1.30.0");
    expect(driftedVersion(done, "1.30.0")).toBeNull();
    expect(driftedVersion(done, "1.31.0")).toBeNull();
    expect(driftedVersion(attempt({ outcome: "rolled-back" }), "1.29.0")).toBeNull();
    expect(driftedVersion(attempt(), "1.29.0")).toBeNull();
    expect(driftedVersion(null, "1.29.0")).toBeNull();
  });

  test("bareRunVersion drops one v and keeps only a version", () => {
    expect(bareRunVersion("v1.30.0")).toBe("1.30.0");
    expect(bareRunVersion("1.30.0")).toBe("1.30.0");
    expect(bareRunVersion("v1.30.0-edge.2")).toBe("1.30.0-edge.2");
    expect(bareRunVersion("vv1.30.0")).toBeNull();
    expect(bareRunVersion("unknown")).toBeNull();
    expect(bareRunVersion(null)).toBeNull();
  });

  test("retryDelayMs waits 1, 1, 2, 4, then 6 hours", () => {
    expect([0, 1, 2, 3, 4, 5, 12].map(retryDelayMs)).toEqual([HOUR, HOUR, 2 * HOUR, 4 * HOUR, 6 * HOUR, 6 * HOUR, 6 * HOUR]);
  });
});

describe("holds and the quiet guard", () => {
  const clear = offerOf("1.29.0", "1.30.0", 0);

  test("holdOf answers in order: paused, dismissed, prerelease, link change, link unknown", () => {
    const everything = { ...clear, dismissed: "2.0.0-beta.4", linkChange: { from: 7, to: 8 }, linkKnown: false };
    const failed = record({ failed: [{ version: "2.0.0-beta.4", outcome: "rolled-back", at: 1 }] });
    expect(holdOf("2.0.0-beta.4", failed, everything)).toBe("paused");
    expect(holdOf("2.0.0-beta.4", DEFAULT_AUTO_RECORD, everything)).toBe("dismissed");
    expect(holdOf("2.0.0-beta.4", DEFAULT_AUTO_RECORD, { ...everything, dismissed: null })).toBe("prerelease");
    expect(holdOf("1.30.0", DEFAULT_AUTO_RECORD, { ...everything, dismissed: null })).toBe("link_change");
    expect(holdOf("1.30.0", DEFAULT_AUTO_RECORD, { ...everything, dismissed: null, linkChange: null })).toBe("link_unknown");
    expect(holdOf("1.30.0", DEFAULT_AUTO_RECORD, clear)).toBeNull();
    expect(holdOf("1.30.0-edge.3", DEFAULT_AUTO_RECORD, clear)).toBeNull();
  });

  test("pinnable takes a strict release and an Edge build, never another prerelease", () => {
    expect(pinnable("1.30.0")).toBe(true);
    expect(pinnable("1.30.0-edge.3")).toBe(true);
    expect(pinnable("2.0.0-beta.4")).toBe(false);
  });

  test("quietGuard: a poll inside 15 minutes, the boot, then a send being typed", () => {
    const now = 100 * HOUR;
    const quiet = { now, lastPollAt: now - AUTO_QUIET_MS, bootAt: 0, sends: [] };
    expect(quietGuard(quiet)).toBeNull();
    expect(quietGuard({ ...quiet, lastPollAt: now - AUTO_QUIET_MS + 1 })).toBe("busy_reading");
    expect(quietGuard({ ...quiet, lastPollAt: null, bootAt: now - 14 * MINUTE })).toBe("busy_reading");
    expect(quietGuard({ ...quiet, lastPollAt: null, bootAt: now - 16 * MINUTE })).toBeNull();
    expect(quietGuard({ ...quiet, sends: [{ phase: "accepted" }] })).toBe("busy_sending");
    expect(quietGuard({ ...quiet, sends: [{ phase: "submit-sent" }] })).toBe("busy_sending");
    expect(quietGuard({ ...quiet, sends: [{ phase: "settled" }, { phase: "held" }] })).toBeNull();
    expect(quietGuard({ ...quiet, lastPollAt: now, sends: [{ phase: "accepted" }] })).toBe("busy_reading");
  });
});

describe("the scheduler: zero tax when off", () => {
  test("off with nothing pending reads no run, no offer, and writes nothing", async () => {
    const h = rig();
    h.world.run = runRecord("done", { action: "rollback", from: "1.30.0", to: "1.29.0", runId: "phone" });
    await step(h);
    h.updater.afterCheck();
    await h.updater.settled();
    await step(h, h.world.now + DAY);
    expect(h.reads).toEqual({ run: 0, offer: 0 });
    expect(h.writes).toEqual([]);
    expect(h.preflights).toEqual([]);
    h.updater.observe();
    expect(h.logs).toEqual([]);
    expect(h.warns).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  test("an install that cannot update itself never runs the preflight", async () => {
    const h = rig({ record: record({ mode: "available", changedAt: 1 }), unavailable: "packaged" });
    await step(h);
    h.updater.afterCheck();
    await h.updater.settled();
    expect(h.preflights).toEqual([]);
    expect(h.writes).toEqual([]);
    expect(h.reads.run).toBe(0);
  });

  test("a deposed lead and a missing runner are unavailable too", async () => {
    const deposed = rig({ record: record({ mode: "available" }) });
    deposed.world.deposed = true;
    await step(deposed);
    expect(deposed.preflights).toEqual([]);
    expect(deposed.updater.view().unavailable).toBe("deposed");
    const runnerless = rig({ record: record({ mode: "available" }), action: false });
    await step(runnerless);
    expect(runnerless.updater.view().unavailable).toBe("no_runner");
  });
});

describe("the scheduler: a start", () => {
  test("available with a release forces the preflight, saves the attempt, then starts once", async () => {
    const h = rig({ record: record({ mode: "available" }) });
    const t0 = h.world.now;
    await step(h);
    expect(h.preflights).toEqual([true]);
    expect(h.starts).toEqual([{ major: false, runId: "run-1", toTag: "v1.30.0", trigger: "auto" }]);
    expect(h.savedAtStart[0]?.attempt).toEqual({
      runId: "run-1",
      version: "1.30.0",
      from: "1.29.0",
      mode: "available",
      startedAt: t0,
      outcome: null,
      settledAt: null,
      toldAt: null,
    });
    expect(h.order.indexOf("preflight")).toBeLessThan(h.order.indexOf("start"));
    expect(h.audits).toEqual([{ action: "update", device: null, detail: { to: "1.30.0", major: false, trigger: "auto", mode: "available" } }]);
    expect(h.logs).toContain("automatic update to 1.30.0 started (run run-1, when available)");
    expect(lastWrite(h)?.lastTryAt).toBe(t0);
    expect(lastWrite(h)?.skip).toBeNull();
    for (let i = 1; i <= 10; i++) await step(h, t0 + i * AUTO_RECONCILE_MS);
    expect(h.starts).toHaveLength(1);
    expect(h.preflights).toHaveLength(1);
  });

  test("a daily start spends the day's slot and names the time in the log", async () => {
    const now = local(2026, 11, 14, 4, 10);
    const h = rig({ record: record({ mode: "daily", at: "04:00" }), now });
    await step(h);
    expect(h.starts).toHaveLength(1);
    expect(lastWrite(h)?.slotDay).toBe("2026-11-14");
    expect(h.logs).toContain("automatic update to 1.30.0 started (run run-1, daily from 04:00)");
    expect(h.audits[0]?.detail).toEqual({ to: "1.30.0", major: false, trigger: "auto", mode: "daily" });
  });

  test("a lock, a start in flight, an open crew run or a run in flight waits a minute without a preflight", async () => {
    const blockers: ((world: World, busy: boolean) => void)[] = [
      (world, busy) => {
        world.lockHeld = busy;
      },
      (world, busy) => {
        world.starting = busy;
      },
      (world, busy) => {
        world.crewRunOpen = busy;
      },
      (world, busy) => {
        world.run = busy ? runRecord("staging", { runId: "a-tap" }) : null;
      },
    ];
    for (const block of blockers) {
      const h = rig({ record: record({ mode: "available" }), crew: true });
      const t0 = h.world.now;
      block(h.world, true);
      await step(h);
      expect(h.preflights).toEqual([]);
      await step(h, t0 + AUTO_RECHECK_MS - 1);
      expect(h.preflights).toEqual([]);
      block(h.world, false);
      await step(h, t0 + AUTO_RECHECK_MS);
      expect(h.starts).toHaveLength(1);
    }
  });

  test("the verdict reads the lock, the latch, the crew run and the crew rows as they are at the verdict", async () => {
    const cases: [(world: World) => void, ErrorCode, Record<string, string>][] = [
      [
        (world) => {
          world.lockHeld = true;
        },
        "update.in_progress",
        { state: "staging" },
      ],
      [
        (world) => {
          world.starting = true;
        },
        "update.in_progress",
        { state: "starting" },
      ],
      [
        (world) => {
          world.crewRunOpen = true;
        },
        "update.in_progress",
        { state: "levelling the crew" },
      ],
      [
        (world) => {
          world.rows = [row("attic", "1.29.0", { verdict: "red", reasons: ["the disk is full"] })];
        },
        "update.preflight_red",
        { check: "attic", reason: "the disk is full" },
      ],
    ];
    for (const [flip, code, detail] of cases) {
      const h = rig({ record: record({ mode: "available" }), crew: true });
      h.world.onStatus = () => {
        flip(h.world);
      };
      await step(h);
      expect(h.starts).toEqual([]);
      expect(lastWrite(h)?.skip).toEqual({
        code,
        at: h.world.now,
        version: "1.30.0",
        count: 1,
        error: apiError(code, detail).error,
        detail,
      });
    }
  });

  test("the verdict refuses a packaged status and a development lead of a crew", async () => {
    const packaged = rig({ record: record({ mode: "available" }) });
    packaged.world.status = { ...statusOf(packaged.world.offer, null), installKind: "packaged" };
    await step(packaged);
    expect(packaged.starts).toEqual([]);
    expect(lastWrite(packaged)?.skip?.code).toBe("update.packaged");
    const dev = rig({ record: record({ mode: "available" }), crew: true, build: "1.29.0-dev+c7ac1e91" });
    dev.world.rows = [row("attic", "1.29.0")];
    await step(dev);
    expect(dev.starts).toEqual([]);
    expect(lastWrite(dev)?.skip?.code).toBe("update.dev_lead");
  });

  test("a red preflight saves its code, English and detail, and is retried after 1, 2, 4, then 6 hours", async () => {
    const h = rig({ record: record({ mode: "available" }) });
    h.world.report = report(check("tree", "red", "working tree has tracked changes"), check("service", "green"));
    let last = h.world.now;
    await step(h);
    expect(h.preflights).toHaveLength(1);
    const detail = { check: "tree", reason: "working tree has tracked changes" };
    expect(lastWrite(h)?.skip).toEqual({
      code: "update.preflight_red",
      at: last,
      version: "1.30.0",
      count: 1,
      error: apiError("update.preflight_red", detail).error,
      detail,
    });
    expect(h.logs).toContain("automatic update to 1.30.0 not started: update.preflight_red");
    for (const [index, delay] of [HOUR, 2 * HOUR, 4 * HOUR, 6 * HOUR, 6 * HOUR].entries()) {
      await step(h, last + delay - 1);
      expect(h.preflights).toHaveLength(index + 1);
      await step(h, last + delay);
      expect(h.preflights).toHaveLength(index + 2);
      last += delay;
    }
    expect(lastWrite(h)?.skip?.count).toBe(6);
    expect(h.logs.filter((line) => line.includes("not started"))).toHaveLength(1);
    expect(h.starts).toEqual([]);
  });

  test("a new version restarts the backoff count, and still waits an hour after the last try", async () => {
    const h = rig({ record: record({ mode: "available" }) });
    const t0 = h.world.now;
    h.world.report = report(check("tree", "red"), check("service", "green"));
    await step(h);
    await step(h, t0 + HOUR);
    expect(lastWrite(h)?.skip?.count).toBe(2);
    h.world.offer = offerOf("1.29.0", "1.30.1", t0 + HOUR);
    h.updater.afterCheck();
    await h.updater.settled();
    expect(h.preflights).toHaveLength(2);
    await step(h, t0 + 2 * HOUR);
    expect(h.preflights).toHaveLength(3);
    expect(lastWrite(h)?.skip).toMatchObject({ version: "1.30.1", count: 1 });
  });

  test("none available at the verdict saves no skip", async () => {
    const h = rig({ record: record({ mode: "available" }) });
    h.world.status = { ...statusOf(h.world.offer, null), current: "1.30.0" };
    await step(h);
    expect(h.preflights).toHaveLength(1);
    expect(h.starts).toEqual([]);
    expect(lastWrite(h)?.skip).toBeNull();
    expect(h.updater.view().waiting).toBeUndefined();
  });

  test("a service row that is not green stops the start with the code service", async () => {
    const h = rig({ record: record({ mode: "available" }) });
    const reason = "no service manager on this host — the bridge is unsupervised, so restart it by hand after the update";
    h.world.report = report(check("tree", "green"), check("service", "amber", reason));
    await step(h);
    expect(h.starts).toEqual([]);
    expect(lastWrite(h)?.skip).toEqual({ code: "service", at: h.world.now, version: "1.30.0", count: 1, error: reason });
    expect(h.updater.view().waiting).toEqual({ code: "service", at: h.world.now, version: "1.30.0", error: reason });
  });

  test("a failed start puts the previous attempt back and saves the refusal", async () => {
    const before = attempt({ runId: "old", version: "1.29.0", from: "1.28.0", outcome: "done", settledAt: 5, toldAt: 6 });
    const h = rig({ record: record({ mode: "available", attempt: before }) });
    h.world.startResult = { ok: false, reason: "the update could not be started: spawn ENOENT" };
    await step(h);
    expect(h.starts).toHaveLength(1);
    expect(lastWrite(h)?.attempt).toEqual(before);
    expect(lastWrite(h)?.skip).toMatchObject({ code: "update.start_failed", count: 1, error: "the update could not be started: spawn ENOENT" });
    const refused = rig({ record: record({ mode: "available" }) });
    refused.world.startResult = { ok: false, reason: "the manager did not answer", refusal: "update.manager_unreachable" };
    await step(refused);
    expect(lastWrite(refused)?.attempt).toBeNull();
    expect(lastWrite(refused)?.skip?.code).toBe("update.manager_unreachable");
    expect(refused.audits).toEqual([]);
  });

  test("a launcher refusal is saved with the detail its code's sentence names", async () => {
    const failed = rig({ record: record({ mode: "available" }) });
    failed.world.startResult = { ok: false, reason: "spawn ENOENT" };
    await step(failed);
    expect(lastWrite(failed)?.skip).toEqual({
      code: "update.start_failed",
      at: failed.world.now,
      version: "1.30.0",
      count: 1,
      error: "spawn ENOENT",
      detail: { reason: "spawn ENOENT" },
    });
    expect(failed.updater.view().waiting?.detail).toEqual({ reason: "spawn ENOENT" });
    const latched = rig({ record: record({ mode: "available" }) });
    latched.world.startResult = { ok: false, reason: "an update is already running (starting); nothing was started", refusal: "update.in_progress" };
    await step(latched);
    expect(lastWrite(latched)?.skip).toMatchObject({ code: "update.in_progress", detail: { state: "starting" } });
    const unreachable = rig({ record: record({ mode: "available" }) });
    unreachable.world.startResult = { ok: false, reason: "the manager did not answer", refusal: "update.manager_unreachable" };
    await step(unreachable);
    expect(lastWrite(unreachable)?.skip?.detail).toBeUndefined();
  });

  test("a store that throws before the start spawns nothing", async () => {
    const h = rig({ record: record({ mode: "available" }) });
    h.world.writeFails = true;
    await step(h);
    expect(h.preflights).toHaveLength(1);
    expect(h.starts).toEqual([]);
    expect(h.warns).toContain("automatic updates: the evaluation failed: disk full");
  });

  test("an evaluation that throws wakes a minute later and logs once", async () => {
    const h = rig({ record: record({ mode: "available" }) });
    h.world.runFails = true;
    const t0 = h.world.now;
    await step(h);
    expect(h.warns).toEqual(["automatic updates: the evaluation failed: unreadable"]);
    await step(h, t0 + AUTO_RECHECK_MS - 1);
    expect(h.reads.run).toBe(1);
    await step(h, t0 + AUTO_RECHECK_MS);
    expect(h.reads.run).toBe(2);
    expect(h.warns).toHaveLength(1);
  });

  test("a try whose disk write failed still holds the rate limit", async () => {
    const h = rig({ record: record({ mode: "available" }) });
    h.world.report = report(check("tree", "red"), check("service", "green"));
    h.world.writeFails = true;
    await step(h);
    expect(h.preflights).toHaveLength(1);
    expect(h.warns.filter((line) => line.includes("could not be written"))).toHaveLength(1);
    h.updater.afterCheck();
    await h.updater.settled();
    await step(h, h.world.now + 30 * MINUTE);
    expect(h.preflights).toHaveLength(1);
    expect(h.updater.view().waiting?.code).toBe("update.preflight_red");
  });

  test("a second tick while one evaluation awaits does nothing", async () => {
    const h = rig({ record: record({ mode: "available" }) });
    const gate = Promise.withResolvers<void>();
    h.world.gate = gate.promise;
    h.updater.tick();
    await Promise.resolve();
    h.updater.tick();
    h.updater.afterCheck();
    h.updater.tick();
    expect(h.preflights).toHaveLength(1);
    gate.resolve();
    await h.updater.settled();
    expect(h.starts).toHaveLength(1);
    expect(h.preflights).toHaveLength(1);
  });
});

describe("the scheduler: the quiet guard", () => {
  test("a poll 14 minutes ago defers without a preflight, 16 minutes ago does not", async () => {
    const h = rig({ record: record({ mode: "available" }) });
    const t0 = h.world.now;
    h.world.lastPollAt = t0 - 14 * MINUTE;
    await step(h);
    expect(h.preflights).toEqual([]);
    expect(h.updater.view().waiting).toEqual({ code: "busy_reading", at: t0, version: "1.30.0" });
    await step(h, t0 + AUTO_RECHECK_MS - 1);
    expect(h.preflights).toEqual([]);
    await step(h, t0 + AUTO_RECHECK_MS);
    expect(h.starts).toHaveLength(1);
    const later = rig({ record: record({ mode: "available" }) });
    later.world.lastPollAt = later.world.now - 16 * MINUTE;
    await step(later);
    expect(later.starts).toHaveLength(1);
  });

  test("the bridge's own start counts as a poll for 15 minutes", async () => {
    const boot = local(2026, 11, 14, 10);
    const h = rig({ record: record({ mode: "available" }), now: boot + MINUTE, bootAt: boot });
    await step(h);
    expect(h.preflights).toEqual([]);
    expect(h.updater.view().waiting?.code).toBe("busy_reading");
    await step(h, boot + AUTO_QUIET_MS - AUTO_RECHECK_MS);
    expect(h.preflights).toEqual([]);
    await step(h, boot + AUTO_QUIET_MS);
    expect(h.starts).toHaveLength(1);
  });

  test("a message being typed into a pane defers", async () => {
    const h = rig({ record: record({ mode: "available" }) });
    h.world.sends = [{ phase: "settled" }, { phase: "submit-sent" }];
    await step(h);
    expect(h.preflights).toEqual([]);
    expect(h.updater.view().waiting?.code).toBe("busy_sending");
    h.world.sends = [{ phase: "settled" }];
    await step(h, h.world.now + AUTO_RECHECK_MS);
    expect(h.starts).toHaveLength(1);
  });

  test("a deferral is written once while it stays the same", async () => {
    const h = rig({ record: record({ mode: "available" }) });
    h.world.lastPollAt = h.world.now;
    const t0 = h.world.now;
    for (let i = 0; i < 5; i++) {
      h.world.lastPollAt = t0 + i * AUTO_RECHECK_MS;
      await step(h, t0 + i * AUTO_RECHECK_MS);
    }
    expect(h.writes.filter((written) => written.skip?.code === "busy_reading")).toHaveLength(1);
    expect(h.logs.filter((line) => line.endsWith("busy_reading"))).toHaveLength(1);
  });

  test("a deferral for a new version starts its backoff count again", async () => {
    const h = rig({ record: record({ mode: "available" }) });
    const t0 = h.world.now;
    h.world.report = report(check("tree", "red"), check("service", "green"));
    await step(h);
    expect(lastWrite(h)?.skip).toMatchObject({ version: "1.30.0", count: 1 });
    h.world.offer = offerOf("1.29.0", "1.30.1", t0);
    h.world.lastPollAt = t0 + HOUR;
    await step(h, t0 + HOUR);
    expect(lastWrite(h)?.skip).toEqual({ code: "busy_reading", at: t0 + HOUR, version: "1.30.1", count: 0 });
    h.world.lastPollAt = t0;
    await step(h, t0 + HOUR + AUTO_RECHECK_MS);
    expect(lastWrite(h)?.skip).toMatchObject({ code: "update.preflight_red", version: "1.30.1", count: 1 });
  });

  test("a poll that lands during the preflight stops before the verdict", async () => {
    const h = rig({ record: record({ mode: "available" }) });
    h.world.onPreflight = () => {
      h.world.lastPollAt = h.world.now;
    };
    await step(h);
    expect(h.preflights).toHaveLength(1);
    expect(h.starts).toEqual([]);
    expect(h.updater.view().waiting?.code).toBe("busy_reading");
  });
});

describe("the scheduler: holds", () => {
  const cases: [string, (offer: UpdateOffer) => UpdateOffer, UpdateAutoView["hold"]][] = [
    ["a link change", (offer) => ({ ...offer, linkChange: { from: 7, to: 8 } }), "link_change"],
    ["a link note not read yet on a lead", (offer) => ({ ...offer, linkKnown: false }), "link_unknown"],
    ["a dismissed release", (offer) => ({ ...offer, dismissed: "1.30.0" }), "dismissed"],
    ["a beta", (offer) => offerOf("2.0.0-beta.3", "2.0.0-beta.4", offer.checkedAt), "prerelease"],
  ];
  for (const [name, set, hold] of cases) {
    test(`${name} never starts`, async () => {
      const h = rig({ record: record({ mode: "available" }), crew: true });
      h.world.offer = set(h.world.offer);
      await step(h);
      h.updater.afterCheck();
      await h.updater.settled();
      expect(h.preflights).toEqual([]);
      expect(h.updater.view().hold).toBe(hold);
    });
  }

  test("a paused version never starts", async () => {
    const h = rig({ record: record({ mode: "available", failed: [{ version: "1.30.0", outcome: "aborted", at: 1 }] }) });
    await step(h);
    expect(h.preflights).toEqual([]);
    expect(h.updater.view()).toMatchObject({ hold: "paused", paused: ["1.30.0"] });
  });

  test("a solo machine's link reading is known, so it starts", async () => {
    const h = rig({ record: record({ mode: "available" }) });
    await step(h);
    expect(h.starts).toHaveLength(1);
  });

  test("the offer moving to a newer release during the preflight returns, and the next try takes the new one", async () => {
    const h = rig({ record: record({ mode: "available" }) });
    const t0 = h.world.now;
    h.world.onPreflight = () => {
      h.world.offer = offerOf("1.29.0", "1.30.1", h.world.now);
    };
    await step(h);
    expect(h.starts).toEqual([]);
    await step(h);
    expect(h.preflights).toHaveLength(1);
    await step(h, t0 + AUTO_RETRY_MS);
    expect(h.starts).toEqual([{ major: false, runId: "run-1", toTag: "v1.30.1", trigger: "auto" }]);
  });
});

describe("the scheduler: daily", () => {
  test("outside the window nothing runs, and the wake is the next window", async () => {
    const h = rig({ record: record({ mode: "daily", at: "04:00" }), now: local(2026, 11, 14, 10) });
    await step(h);
    expect(h.preflights).toEqual([]);
    await step(h, local(2026, 11, 15, 3, 59));
    expect(h.preflights).toEqual([]);
    expect(h.reads.run).toBe(1);
    await step(h, local(2026, 11, 15, 4));
    expect(h.starts).toHaveLength(1);
  });

  test("a check older than 30 minutes is refreshed once per window, before the target", async () => {
    const now = local(2026, 11, 14, 4, 10);
    const h = rig({ record: record({ mode: "daily", at: "04:00" }), now });
    h.world.offer = offerOf("1.29.0", null, now - 2 * HOUR);
    h.world.onCheck = () => {
      h.world.offer = offerOf("1.29.0", "1.30.0", h.world.now);
    };
    await step(h);
    expect(h.checks).toEqual([now]);
    expect(h.starts).toEqual([{ major: false, runId: "run-1", toTag: "v1.30.0", trigger: "auto" }]);
  });

  test("the refresh runs once per window even when it finds nothing", async () => {
    const now = local(2026, 11, 14, 4, 10);
    const h = rig({ record: record({ mode: "daily", at: "04:00" }), now });
    h.world.offer = offerOf("1.29.0", null, now - 2 * HOUR);
    await step(h);
    h.updater.afterCheck();
    await h.updater.settled();
    expect(h.checks).toEqual([now]);
    await step(h, local(2026, 11, 15, 4, 10));
    expect(h.checks).toEqual([now, local(2026, 11, 15, 4, 10)]);
  });

  test("no refresh while the boot check has not run", async () => {
    const now = local(2026, 11, 14, 4, 10);
    const h = rig({ record: record({ mode: "daily", at: "04:00" }), now });
    h.world.offer = offerOf("1.29.0", null, null);
    await step(h);
    expect(h.checks).toEqual([]);
  });

  test("a recent check is not refreshed", async () => {
    const now = local(2026, 11, 14, 4, 10);
    const h = rig({ record: record({ mode: "daily", at: "04:00" }), now });
    h.world.offer = offerOf("1.29.0", "1.30.0", now - AUTO_FRESH_CHECK_MS);
    await step(h);
    expect(h.checks).toEqual([]);
    expect(h.starts).toHaveLength(1);
  });

  test("a no-target evaluation inside the window sleeps until the window's end", async () => {
    const now = local(2026, 11, 14, 4, 10);
    const h = rig({ record: record({ mode: "daily", at: "04:00" }), now });
    h.world.offer = offerOf("1.29.0", null, now - MINUTE);
    await step(h);
    expect(h.reads.run).toBe(1);
    await step(h, now + MINUTE);
    expect(h.reads.run).toBe(1);
    await step(h, local(2026, 11, 14, 7));
    expect(h.reads.run).toBe(2);
  });

  test("the slot is spent only by a start, so a refused try may come again in the window", async () => {
    const now = local(2026, 11, 14, 4, 10);
    const h = rig({ record: record({ mode: "daily", at: "04:00" }), now });
    h.world.report = report(check("tree", "red"), check("service", "green"));
    await step(h);
    expect(lastWrite(h)?.slotDay).toBeNull();
    h.world.report = greenReport();
    await step(h, now + HOUR);
    expect(h.starts).toHaveLength(1);
    expect(lastWrite(h)?.slotDay).toBe("2026-11-14");
  });
});

describe("the scheduler: changes during the preflight", () => {
  test("switching off during the preflight stops before the verdict", async () => {
    const h = rig({ record: record({ mode: "available" }) });
    h.world.onPreflight = () => {
      h.updater.choose({ mode: "off", at: null, requestId: OTHER_ID, by: null });
    };
    await step(h);
    expect(h.starts).toEqual([]);
    expect(lastWrite(h)?.mode).toBe("off");
  });

  test("switching from available to daily during the preflight starts nothing outside the window", async () => {
    const h = rig({ record: record({ mode: "available" }), now: local(2026, 11, 14, 10) });
    h.world.onPreflight = () => {
      h.updater.choose({ mode: "daily", at: "04:00", requestId: OTHER_ID, by: null });
    };
    await step(h);
    expect(h.starts).toEqual([]);
    await step(h);
    expect(h.starts).toEqual([]);
  });

  test("revoking the device that set it during the preflight turns it off before the verdict", async () => {
    const h = rig({ record: record({ mode: "available", setBy: "pixel-7", changedAt: 1 }) });
    h.world.onPreflight = () => {
      h.world.labels = ["tablet"];
    };
    await step(h);
    expect(h.starts).toEqual([]);
    expect(lastWrite(h)?.mode).toBe("off");
    expect(h.audits).toEqual([
      { action: "update.auto", device: null, detail: { from: "available", to: "off", reason: "device-revoked", label: "pixel-7" } },
    ]);
  });
});

describe("the scheduler: failure memory", () => {
  test("three runs that never wrote a record pause the version", async () => {
    const h = rig({ record: record({ mode: "available" }) });
    const t0 = h.world.now;
    for (let strike = 1; strike <= 3; strike++) {
      const startedAt = t0 + (strike - 1) * AUTO_RETRY_MS;
      await step(h, startedAt);
      expect(h.starts).toHaveLength(strike);
      await step(h, startedAt + AUTO_RECORD_WAIT_MS);
      expect(lastWrite(h)?.attempt?.outcome).toBe("no-record");
    }
    expect(lastWrite(h)?.failed).toEqual([{ version: "1.30.0", outcome: "no-record", at: t0 + 2 * AUTO_RETRY_MS + AUTO_RECORD_WAIT_MS }]);
    expect(lastWrite(h)?.strikes).toBeNull();
    expect(h.logs.filter((line) => line === "automatic update to 1.30.0: no-record")).toHaveLength(3);
    await step(h, t0 + 10 * AUTO_RETRY_MS);
    expect(h.starts).toHaveLength(3);
    expect(h.updater.view().hold).toBe("paused");
    expect(h.pushes).toEqual([]);
  });

  test("a done run clears the strikes", async () => {
    const h = rig({
      record: record({ mode: "available", attempt: attempt({ startedAt: 1 }), strikes: { version: "1.30.0", count: 2 } }),
    });
    h.world.run = runRecord("done", { runId: "run-a" });
    h.world.offer = offerOf("1.30.0", "1.30.0", h.world.now);
    await step(h);
    expect(lastWrite(h)?.strikes).toBeNull();
    expect(lastWrite(h)?.attempt?.outcome).toBe("done");
  });

  test("a rolled-back run pauses its version, and a newer version still starts", async () => {
    const h = rig({ record: record({ mode: "available", attempt: attempt({ startedAt: 1 }) }) });
    h.world.run = runRecord("rolled-back", { runId: "run-a", reason: "no answer from the new build" });
    await step(h);
    expect(lastWrite(h)?.failed).toEqual([{ version: "1.30.0", outcome: "rolled-back", at: h.world.now }]);
    expect(h.starts).toEqual([]);
    expect(h.updater.view().hold).toBe("paused");
    h.world.offer = offerOf("1.29.0", "1.30.1", h.world.now);
    h.updater.afterCheck();
    await h.updater.settled();
    expect(h.starts).toEqual([{ major: false, runId: "run-1", toTag: "v1.30.1", trigger: "auto" }]);
  });

  test("an untold outcome blocks a new start until it is told", async () => {
    const now = local(2026, 11, 14, 7);
    const h = rig({ record: record({ mode: "available", attempt: attempt({ startedAt: now - HOUR }) }), now });
    h.world.run = runRecord("rolled-back", { runId: "run-a" });
    h.world.offer = offerOf("1.29.0", "1.30.1", now);
    await step(h);
    expect(h.pushes).toEqual([]);
    expect(h.preflights).toEqual([]);
    await step(h, local(2026, 11, 14, 8, 59));
    expect(h.preflights).toEqual([]);
    await step(h, local(2026, 11, 14, 9));
    expect(h.pushes).toHaveLength(1);
    expect(h.starts).toEqual([{ major: false, runId: "run-1", toTag: "v1.30.1", trigger: "auto" }]);
  });

  test("a done automatic version that is no longer running pauses it", async () => {
    const done = attempt({ outcome: "done", to: "1.30.0", settledAt: 2, toldAt: 3 });
    const h = rig({ record: record({ mode: "available", attempt: done }) });
    await step(h);
    expect(lastWrite(h)?.failed).toEqual([{ version: "1.30.0", outcome: "reverted", at: h.world.now }]);
    expect(h.preflights).toEqual([]);
    expect(h.updater.view()).toMatchObject({ hold: "paused", paused: ["1.30.0"] });
  });

  test("a done phone rollback pauses the version it left, once the mode is on", async () => {
    const h = rig();
    h.world.run = runRecord("done", { action: "rollback", from: "1.30.0", to: "1.29.0", runId: "phone", updatedAt: 77 });
    await step(h);
    expect(h.writes).toEqual([]);
    h.updater.choose({ mode: "available", at: null, requestId: REQUEST_ID, by: "pixel-7" });
    await step(h);
    expect(lastWrite(h)?.failed).toEqual([{ version: "1.30.0", outcome: "reverted", at: 77 }]);
    expect(h.preflights).toEqual([]);
    h.updater.afterCheck();
    await h.updater.settled();
    expect(h.writes.filter((written) => written.failed.length > 0)).toHaveLength(1);
    expect(h.preflights).toEqual([]);
  });

  test("a failure at or below the running version is pruned on the next write", async () => {
    const h = rig({
      record: record({
        mode: "available",
        failed: [
          { version: "1.28.0", outcome: "stuck", at: 1 },
          { version: "1.29.0", outcome: "aborted", at: 2 },
        ],
      }),
    });
    expect(h.updater.view().paused).toEqual([]);
    await step(h);
    expect(lastWrite(h)?.failed).toEqual([]);
  });

  test("the failure memory keeps the newest twenty", async () => {
    const failed = Array.from({ length: 25 }, (_, i): AutoFailure => ({ version: `1.29.${i + 1}`, outcome: "aborted", at: i }));
    expect(parseAutoRecord(JSON.stringify({ schema: 1, failed })).failed).toHaveLength(AUTO_FAILED_MAX);
    const h = rig({ record: record({ mode: "available", failed }) });
    h.world.offer = offerOf("1.29.0", "1.31.0", h.world.now);
    await step(h);
    const kept = lastWrite(h)?.failed ?? [];
    expect(kept).toHaveLength(AUTO_FAILED_MAX);
    expect(kept[0]?.version).toBe("1.29.6");
  });
});

describe("the scheduler: revoking the device that set it", () => {
  test("forget turns a record that label set off, audits it and wakes the scheduler", async () => {
    const now = local(2026, 11, 14, 7);
    const told = attempt({ startedAt: 1, outcome: "done", settledAt: 2, toldAt: null });
    const h = rig({ record: record({ mode: "daily", setBy: "pixel-7", changedAt: 1, attempt: told }), now });
    h.world.offer = offerOf("1.30.0", null, now);
    await step(h);
    expect(h.reads.run).toBe(1);
    h.updater.forget("pixel-7", "device-revoked");
    const saved = lastWrite(h);
    expect(saved?.mode).toBe("off");
    expect(saved?.changedAt).toBe(now);
    expect(Object.keys(saved ?? {})).not.toContain("setBy");
    expect(h.audits).toEqual([
      { action: "update.auto", device: null, detail: { from: "daily", to: "off", reason: "device-revoked", label: "pixel-7" } },
    ]);
    expect(h.logs).toContain("automatic updates off: pixel-7 was revoked");
    await step(h);
    expect(h.reads.run).toBe(2);
  });

  test("another label changes nothing", () => {
    const h = rig({ record: record({ mode: "daily", setBy: "pixel-7", changedAt: 1 }) });
    h.updater.forget("tablet", "device-revoked");
    expect(h.writes).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  test("the audit line names the reason the device went, as its device.revoke line does", () => {
    const h = rig({ record: record({ mode: "available", setBy: "pixel-7", changedAt: 1 }) });
    h.updater.forget("pixel-7", "expired-replaced");
    expect(lastWrite(h)?.mode).toBe("off");
    expect(h.audits).toEqual([
      { action: "update.auto", device: null, detail: { from: "available", to: "off", reason: "expired-replaced", label: "pixel-7" } },
    ]);
  });

  test("under a mode pin the record turns off and the pin keeps deciding", () => {
    const pins: AutoPins = { mode: { raw: "daily", origin: "env" }, at: null };
    const h = rig({ record: record({ mode: "available", setBy: "pixel-7", changedAt: 1 }), pins });
    h.updater.forget("pixel-7", "device-revoked");
    expect(lastWrite(h)?.mode).toBe("off");
    expect(h.updater.view()).toMatchObject({ mode: "daily", setting: { mode: "off" } });
  });

  test("a device missing from the registry turns it off before the next start", async () => {
    const h = rig({ record: record({ mode: "available", setBy: "pixel-7", changedAt: 1 }) });
    h.world.labels = ["tablet"];
    await step(h);
    expect(h.preflights).toEqual([]);
    expect(lastWrite(h)?.mode).toBe("off");
    expect(h.audits[0]?.action).toBe("update.auto");
  });

  test("a registry that cannot be read changes nothing", async () => {
    const h = rig({ record: record({ mode: "available", setBy: "pixel-7", changedAt: 1 }) });
    h.world.labels = null;
    await step(h);
    expect(h.starts).toHaveLength(1);
  });

  test("a failed write never throws out of forget", () => {
    const h = rig({ record: record({ mode: "daily", setBy: "pixel-7", changedAt: 1 }) });
    h.world.writeFails = true;
    expect(() => h.updater.forget("pixel-7", "device-revoked")).not.toThrow();
    expect(h.audits).toEqual([]);
    expect(h.warns).toHaveLength(1);
    expect(h.updater.view().setting.mode).toBe("daily");
  });
});

describe("telling the outcome", () => {
  function settledRig(state: UpdateRunState, extra: Partial<UpdateRun> = {}, o: RigOptions = {}): Harness {
    const h = rig({ record: record({ mode: "available", attempt: attempt({ startedAt: 1 }) }), ...o });
    h.world.run = runRecord(state, { runId: "run-a", ...extra });
    if (state === "done") h.world.offer = offerOf("1.30.0", "1.30.0", h.world.now);
    return h;
  }

  test("a done run is told once at or after 09:00", async () => {
    const h = settledRig("done");
    await step(h);
    expect(h.pushes).toEqual([
      {
        type: "update",
        tag: "collie:update",
        title: "Collie updated itself to 1.30.0",
        titleCode: "update.auto_done",
        titleDetail: { version: "1.30.0" },
        body: "Collie 1.30.0 is running. It replaced 1.29.0 on its own.",
        target: "settings",
      },
    ]);
    expect(h.announced).toEqual([]);
    expect(h.logs).toContain("automatic update to 1.30.0: done");
    await step(h, h.world.now + DAY);
    expect(h.pushes).toHaveLength(1);
  });

  test("before 09:00 the outcome waits for 09:00", async () => {
    const h = settledRig("done", {}, { now: local(2026, 11, 14, 8, 30) });
    await step(h);
    expect(h.pushes).toEqual([]);
    expect(lastWrite(h)?.attempt).toMatchObject({ outcome: "done", toldAt: null });
    await step(h, local(2026, 11, 14, 8, 59));
    expect(h.pushes).toEqual([]);
    await step(h, local(2026, 11, 14, 9));
    expect(h.pushes).toHaveLength(1);
  });

  test("toldAt is saved before the push, and a store that cannot save it sends nothing", async () => {
    const h = settledRig("done");
    await step(h);
    expect(h.toldAtPush).toEqual([h.world.now]);
    const settled = attempt({ startedAt: 1, outcome: "done", to: "1.30.0", settledAt: 2 });
    const blocked = rig({ record: record({ mode: "available", attempt: settled }) });
    blocked.world.offer = offerOf("1.30.0", "1.30.0", blocked.world.now);
    blocked.world.writeFails = true;
    await step(blocked);
    expect(blocked.pushes).toEqual([]);
    expect(blocked.warns).toContain("automatic updates: the evaluation failed: disk full");
  });

  const failures: [UpdateRunState, string, Partial<UpdateRun>][] = [
    [
      "rolled-back",
      "1.30.0 did not come up, so this machine went back to 1.29.0. Automatic updates skip 1.30.0 until a newer release.",
      { reason: "no answer" },
    ],
    [
      "stuck",
      "The update to 1.30.0 could not finish: the health check timed out. Collie 1.29.0 is running. Automatic updates skip 1.30.0 until a newer release.",
      { reason: "the health check timed out", recovery: "collie update --rollback" },
    ],
    [
      "interrupted",
      "The update to 1.30.0 stopped before it finished. Nothing is half installed. Automatic updates skip 1.30.0 until a newer release.",
      {},
    ],
    [
      "idle",
      "The update to 1.30.0 stopped before anything moved: v1.30.0 is not published yet. Automatic updates skip 1.30.0 until a newer release.",
      { reason: "v1.30.0 is not published yet" },
    ],
  ];
  for (const [state, body, extra] of failures) {
    test(`a ${state} run re-alerts with its body and marks the version announced`, async () => {
      const h = settledRig(state, extra);
      await step(h);
      expect(h.pushes).toEqual([
        {
          type: "update",
          tag: "collie:update",
          title: "Automatic update to 1.30.0 did not finish",
          titleCode: "update.auto_failed",
          titleDetail: { version: "1.30.0" },
          body,
          target: "settings",
          renotify: true,
        },
      ]);
      expect(h.announced).toEqual(["1.30.0"]);
    });
  }

  test("the stuck body names the running version and carries no command", async () => {
    const h = settledRig("stuck", { reason: "the rollback did not come up either", recovery: "collie update --rollback" });
    h.world.offer = offerOf("1.30.0", null, h.world.now);
    await step(h);
    const body = h.pushes[0]?.body ?? "";
    expect(body).toContain("Collie 1.30.0 is running.");
    expect(body).toContain("the rollback did not come up either");
    expect(body).not.toContain("collie update");
    expect(body).not.toContain("herdr");
    expect(body).not.toContain("`");
  });

  test("done on a lead names the members still behind, and a packaged member does not count", async () => {
    const h = settledRig("done", {}, { crew: true });
    h.world.rows = [row("attic", "1.29.0"), row("nas", "1.30.0")];
    await step(h);
    expect(h.pushes[0]?.body).toBe("Collie 1.30.0 is running. It replaced 1.29.0 on its own. The members wait for Retry crew update.");
    const packaged = settledRig("done", {}, { crew: true });
    packaged.world.rows = [row("arch", "1.29.0", { installKind: "packaged" }), row("new", null)];
    await step(packaged);
    expect(packaged.pushes[0]?.body).toBe("Collie 1.30.0 is running. It replaced 1.29.0 on its own.");
  });

  test("a run that wrote no record is told silently, and its version is tried again", async () => {
    const h = rig({ record: record({ mode: "available", attempt: attempt({ startedAt: 1 }) }) });
    await step(h);
    const told = h.writes.find((written) => written.attempt?.outcome === "no-record" && written.attempt.toldAt !== null);
    expect(told?.attempt).toMatchObject({ runId: "run-a", outcome: "no-record", toldAt: h.world.now });
    expect(told?.strikes).toEqual({ version: "1.30.0", count: 1 });
    expect(h.pushes).toEqual([]);
    expect(h.announced).toEqual([]);
    expect(h.starts).toEqual([{ major: false, runId: "run-1", toTag: "v1.30.0", trigger: "auto" }]);
  });

  test("with the updates switch off the outcome is marked told without a push", async () => {
    const h = settledRig("rolled-back");
    h.world.updatesEnabled = false;
    await step(h);
    expect(lastWrite(h)?.attempt?.toldAt).toBe(h.world.now);
    expect(h.pushes).toEqual([]);
    expect(h.announced).toEqual([]);
  });

  test("an outcome is reconciled and told after the mode was turned off", async () => {
    const h = rig({ record: record({ mode: "off", attempt: attempt({ startedAt: 1 }) }) });
    h.world.run = runRecord("done", { runId: "run-a" });
    await step(h);
    expect(h.pushes).toHaveLength(1);
    expect(h.preflights).toEqual([]);
  });

  test("a pending attempt is reconciled across a restart by its run id", async () => {
    const pending = record({ mode: "daily", attempt: attempt({ startedAt: local(2026, 11, 14, 4), mode: "daily" }), slotDay: "2026-11-14" });
    const h = rig({ record: pending, now: local(2026, 11, 14, 4, 5) });
    h.world.offer = offerOf("1.30.0", "1.30.0", h.world.now);
    h.world.run = runRecord("verifying", { runId: "run-a" });
    await step(h);
    expect(h.writes).toEqual([]);
    h.world.run = runRecord("done", { runId: "run-a", to: "v1.30.0" });
    await step(h, h.world.now + AUTO_RECONCILE_MS);
    expect(lastWrite(h)?.attempt).toMatchObject({ outcome: "done", to: "1.30.0", settledAt: h.world.now });
    expect(h.starts).toEqual([]);
  });
});

describe("the view", () => {
  test("daily answers the next window, available and off answer none", () => {
    const now = local(2026, 11, 14, 10);
    const daily = rig({ record: record({ mode: "daily", at: "04:00", changedAt: 5 }), now });
    expect(daily.updater.view()).toEqual({
      mode: "daily",
      at: "04:00",
      zone: "Europe/Berlin",
      pinned: { mode: null, at: null },
      setting: { mode: "daily", at: "04:00", changedAt: 5 },
      target: "1.30.0",
      nextAt: local(2026, 11, 15, 4),
      windowEndsAt: local(2026, 11, 15, 7),
      paused: [],
    });
    const open = rig({ record: record({ mode: "daily", at: "09:30" }), now });
    expect(open.updater.view()).toMatchObject({ nextAt: local(2026, 11, 14, 9, 30), windowEndsAt: local(2026, 11, 14, 12, 30) });
    open.world.offer = offerOf("1.30.0", "1.30.0", now - 5 * MINUTE);
    expect(open.updater.view()).toMatchObject({ target: null, nextAt: local(2026, 11, 15, 9, 30), windowEndsAt: local(2026, 11, 15, 12, 30) });
    const late = rig({ record: record({ mode: "daily", at: "23:00" }), now: local(2026, 11, 15, 0, 30) });
    late.world.offer = offerOf("1.30.0", null, late.world.now);
    expect(late.updater.view()).toMatchObject({ nextAt: local(2026, 11, 15, 23), windowEndsAt: local(2026, 11, 16, 2) });
    const ahead = rig({ record: record({ mode: "daily", at: "11:00" }), now });
    ahead.world.offer = offerOf("1.30.0", null, now);
    expect(ahead.updater.view()).toMatchObject({ nextAt: local(2026, 11, 14, 11), windowEndsAt: local(2026, 11, 14, 14) });
    expect(rig({ record: record({ mode: "available" }), now }).updater.view()).toMatchObject({ nextAt: null, windowEndsAt: null });
    expect(rig({ now }).updater.view()).toMatchObject({ mode: "off", nextAt: null, windowEndsAt: null });
    expect(rig({ record: record({ mode: "daily" }), unavailable: "ci", now }).updater.view()).toMatchObject({
      unavailable: "ci",
      nextAt: null,
    });
  });

  test("a pending attempt answers no next time and the attempt as the last one", () => {
    const h = rig({ record: record({ mode: "daily", attempt: attempt({ startedAt: 9, mode: "daily" }) }) });
    expect(h.updater.view()).toMatchObject({
      nextAt: null,
      windowEndsAt: null,
      last: {
        runId: "run-a",
        version: "1.30.0",
        from: "1.29.0",
        to: "1.30.0",
        mode: "daily",
        outcome: null,
        startedAt: 9,
        settledAt: null,
      },
    });
  });

  test("the last outcome carries its reason and its own to", () => {
    const settled = attempt({ outcome: "aborted", to: "1.30.0-edge.1", reason: "the build failed", settledAt: 12, toldAt: 13 });
    expect(rig({ record: record({ attempt: settled }) }).updater.view().last).toEqual({
      runId: "run-a",
      version: "1.30.0",
      from: "1.29.0",
      to: "1.30.0-edge.1",
      mode: "available",
      outcome: "aborted",
      startedAt: 0,
      settledAt: 12,
      reason: "the build failed",
    });
  });

  test("no release means no target and no hold", () => {
    const h = rig({ record: record({ mode: "available" }) });
    h.world.offer = offerOf("1.30.0", "1.30.0", 1);
    const view = h.updater.view();
    expect(view.target).toBeNull();
    expect(view.hold).toBeUndefined();
  });

  test("waiting shows only for the current target", () => {
    const skip: AutoSkip = { code: "update.preflight_red", at: 4, version: "1.29.5", count: 2, error: "preflight is red on tree: dirty" };
    expect(rig({ record: record({ mode: "available", skip }) }).updater.view().waiting).toBeUndefined();
    expect(rig({ record: record({ mode: "available", skip: { ...skip, version: null } }) }).updater.view().waiting).toEqual({
      code: "update.preflight_red",
      at: 4,
      version: null,
      error: "preflight is red on tree: dirty",
    });
    const current = { ...skip, version: "1.30.0", detail: { check: "tree", reason: "dirty" } };
    expect(rig({ record: record({ mode: "available", skip: current }) }).updater.view().waiting).toEqual({
      code: "update.preflight_red",
      at: 4,
      version: "1.30.0",
      error: "preflight is red on tree: dirty",
      detail: { check: "tree", reason: "dirty" },
    });
    const none = rig({ record: record({ mode: "available", skip: current }) });
    none.world.offer = offerOf("1.30.0", "1.30.0", 1);
    expect(none.updater.view().waiting).toBeUndefined();
  });

  test("paused lists the failed versions above the running one", () => {
    const failed: AutoFailure[] = [
      { version: "1.28.0", outcome: "stuck", at: 1 },
      { version: "1.30.0", outcome: "rolled-back", at: 2 },
      { version: "1.30.1", outcome: "reverted", at: 3 },
    ];
    expect(rig({ record: record({ failed }) }).updater.view().paused).toEqual(["1.30.0", "1.30.1"]);
  });

  test("a read writes nothing", () => {
    const h = rig({ record: record({ mode: "daily", attempt: attempt({ outcome: "done", settledAt: 1 }) }) });
    h.updater.view();
    h.updater.view();
    expect(h.writes).toEqual([]);
  });
});

describe("choosing the setting", () => {
  test("a save keeps the request id and the device that set it", () => {
    const h = rig();
    const now = h.world.now;
    const result = h.updater.choose({ mode: "daily", at: "05:30", requestId: REQUEST_ID, by: "pixel-7" });
    expect(result).toMatchObject({ kind: "saved", replay: false, before: "off" });
    if (result.kind !== "saved") throw new Error("refused");
    expect(result.view).toMatchObject({ mode: "daily", at: "05:30", setting: { mode: "daily", at: "05:30", changedAt: now } });
    expect(lastWrite(h)).toEqual({ ...DEFAULT_AUTO_RECORD, mode: "daily", at: "05:30", changedAt: now, requestId: REQUEST_ID, setBy: "pixel-7" });
  });

  test("a save with no time keeps the record's time", () => {
    const h = rig({ record: record({ at: "06:15" }) });
    h.updater.choose({ mode: "available", at: null, requestId: REQUEST_ID, by: null });
    expect(lastWrite(h)).toMatchObject({ mode: "available", at: "06:15" });
    expect(lastWrite(h)?.setBy).toBeUndefined();
  });

  test("off drops the device that set it", () => {
    const h = rig({ record: record({ mode: "daily", setBy: "pixel-7", changedAt: 1 }) });
    const result = h.updater.choose({ mode: "off", at: null, requestId: REQUEST_ID, by: "pixel-7" });
    expect(result).toMatchObject({ kind: "saved", before: "daily" });
    const saved = lastWrite(h);
    expect(saved?.mode).toBe("off");
    expect(Object.keys(saved ?? {})).not.toContain("setBy");
  });

  test("the same request again is a replay and writes nothing", () => {
    const h = rig();
    h.updater.choose({ mode: "daily", at: "05:30", requestId: REQUEST_ID, by: "pixel-7" });
    const replay = h.updater.choose({ mode: "daily", at: "05:30", requestId: REQUEST_ID, by: "pixel-7" });
    expect(replay).toMatchObject({ kind: "saved", replay: true, before: "daily" });
    expect(h.updater.choose({ mode: "daily", at: null, requestId: REQUEST_ID, by: null })).toMatchObject({ replay: true });
    expect(h.writes).toHaveLength(1);
    expect(h.updater.choose({ mode: "daily", at: "06:00", requestId: REQUEST_ID, by: null })).toMatchObject({ replay: false });
    expect(h.writes).toHaveLength(2);
  });

  test("a pinned mode refuses every write, the same word included, and writes nothing", () => {
    const env = rig({ pins: { mode: { raw: "daily", origin: "env" }, at: null } });
    for (const mode of MODES) {
      expect(env.updater.choose({ mode, at: null, requestId: REQUEST_ID, by: "pixel-7" })).toEqual({
        kind: "refused",
        status: 409,
        body: apiError("update.auto_pinned", { source: "COLLIE_AUTO_UPDATE" }),
      });
    }
    const config = rig({ pins: { mode: { raw: "weekly", origin: "config" }, at: null } });
    expect(config.updater.choose({ mode: "off", at: null, requestId: REQUEST_ID, by: null })).toEqual({
      kind: "refused",
      status: 409,
      body: apiError("update.auto_pinned", { source: "config.toml" }),
    });
    expect(env.writes).toEqual([]);
    expect(config.writes).toEqual([]);
  });

  test("a pinned time refuses another time and is never copied into the record", () => {
    const h = rig({ pins: { mode: null, at: { raw: "06:00", origin: "env" } } });
    expect(h.updater.choose({ mode: "daily", at: "05:00", requestId: REQUEST_ID, by: null })).toEqual({
      kind: "refused",
      status: 409,
      body: apiError("update.auto_pinned", { source: "COLLIE_AUTO_UPDATE_AT" }),
    });
    const saved = h.updater.choose({ mode: "daily", at: "06:00", requestId: REQUEST_ID, by: null });
    expect(saved).toMatchObject({ kind: "saved", view: { mode: "daily", at: "06:00", setting: { at: "04:00" } } });
    expect(lastWrite(h)?.at).toBe("04:00");
    h.updater.choose({ mode: "available", at: null, requestId: OTHER_ID, by: null });
    expect(lastWrite(h)?.at).toBe("04:00");
    const config = rig({ pins: { mode: null, at: { raw: "06:00", origin: "config" } } });
    expect(config.updater.choose({ mode: "daily", at: "07:00", requestId: REQUEST_ID, by: null })).toMatchObject({
      body: { code: "update.auto_pinned", detail: { source: "config.toml" } },
    });
  });

  test("an install that cannot update itself refuses on and accepts off", () => {
    const h = rig({ record: record({ mode: "daily", setBy: "pixel-7", changedAt: 1 }), unavailable: "packaged" });
    for (const mode of ON_MODES) {
      expect(h.updater.choose({ mode, at: null, requestId: REQUEST_ID, by: null })).toEqual({
        kind: "refused",
        status: 409,
        body: apiError("update.auto_unavailable", { reason: AUTO_UNAVAILABLE_SENTENCE.packaged }),
      });
    }
    expect(h.writes).toEqual([]);
    expect(h.updater.choose({ mode: "off", at: null, requestId: REQUEST_ID, by: null })).toMatchObject({ kind: "saved" });
    expect(lastWrite(h)?.mode).toBe("off");
  });

  test("a time pin that does not parse refuses daily and available", () => {
    const h = rig({ pins: { mode: null, at: { raw: "25:00", origin: "env" } } });
    for (const mode of ON_MODES) {
      expect(h.updater.choose({ mode, at: null, requestId: REQUEST_ID, by: null })).toEqual({
        kind: "refused",
        status: 409,
        body: apiError("update.auto_unavailable", { reason: "COLLIE_AUTO_UPDATE_AT is not a time like 04:00" }),
      });
    }
    expect(h.updater.choose({ mode: "off", at: null, requestId: REQUEST_ID, by: null })).toMatchObject({ kind: "saved" });
    const config = rig({ pins: { mode: null, at: { raw: "25:00", origin: "config" } } });
    expect(config.updater.choose({ mode: "daily", at: null, requestId: REQUEST_ID, by: null })).toEqual({
      kind: "refused",
      status: 409,
      body: apiError("update.auto_unavailable", { reason: "auto_update_at in config.toml is not a time like 04:00" }),
    });
  });

  test("a config.toml mode that is not a string refuses the phone as a pin does", () => {
    const layer = buildConfigLayer(
      [{ path: "/srv/collie/config.toml", layer: "instance", text: "[update]\nauto_update = false\n", error: null }],
      () => {},
      { home: "/home/pat" },
    );
    const h = rig({ record: record({ mode: "daily", setBy: "pixel-7", changedAt: 1 }), pins: autoPinsOf(overlayConfig({}, layer), layer) });
    expect(h.updater.choose({ mode: "daily", at: null, requestId: REQUEST_ID, by: "pixel-7" })).toEqual({
      kind: "refused",
      status: 409,
      body: apiError("update.auto_pinned", { source: "config.toml" }),
    });
    expect(h.updater.view()).toMatchObject({ mode: "off", pinned: { mode: "config", at: null } });
    expect(h.writes).toEqual([]);
  });

  test("a save wakes the scheduler at the next tick", async () => {
    const h = rig();
    await step(h);
    expect(h.preflights).toEqual([]);
    h.updater.choose({ mode: "available", at: null, requestId: REQUEST_ID, by: "pixel-7" });
    await step(h);
    expect(h.starts).toHaveLength(1);
  });
});

describe("the record on disk", () => {
  const FULL = {
    schema: 1,
    mode: "daily",
    at: "04:00",
    changedAt: 1763092800000,
    requestId: REQUEST_ID,
    setBy: "pixel-7",
    attempt: {
      runId: "2b0d6c1e-7c4b-4bd8-9a5e-1f0f2b8f7a10",
      version: "1.30.0",
      from: "1.29.0",
      mode: "daily",
      startedAt: 1763100000000,
      outcome: "done",
      to: "1.30.0",
      reason: "the service came back as 1.29.0 after the health check",
      settledAt: 1763100090000,
      toldAt: 1763118000000,
    },
    failed: [{ version: "1.29.1", outcome: "rolled-back", at: 1763000000000 }],
    strikes: { version: "1.30.1", count: 1 },
    lastTryAt: 1763100000000,
    slotDay: "2026-11-14",
    skip: {
      code: "update.preflight_red",
      at: 1763100000000,
      version: "1.30.0",
      count: 1,
      error: "preflight is red on tree: working tree has tracked changes",
      detail: { check: "tree", reason: "working tree has tracked changes" },
    },
  };

  function parsed(patch: JsonObject): AutoUpdateRecord {
    return parseAutoRecord(JSON.stringify({ ...FULL, ...patch }));
  }

  test("the spec's example reads whole", () => {
    expect(parseAutoRecord(JSON.stringify(FULL))).toEqual({
      schema: 1,
      mode: "daily",
      at: "04:00",
      changedAt: 1763092800000,
      requestId: REQUEST_ID,
      setBy: "pixel-7",
      attempt: {
        runId: "2b0d6c1e-7c4b-4bd8-9a5e-1f0f2b8f7a10",
        version: "1.30.0",
        from: "1.29.0",
        mode: "daily",
        startedAt: 1763100000000,
        outcome: "done",
        to: "1.30.0",
        reason: "the service came back as 1.29.0 after the health check",
        settledAt: 1763100090000,
        toldAt: 1763118000000,
      },
      failed: [{ version: "1.29.1", outcome: "rolled-back", at: 1763000000000 }],
      strikes: { version: "1.30.1", count: 1 },
      lastTryAt: 1763100000000,
      slotDay: "2026-11-14",
      skip: {
        code: "update.preflight_red",
        at: 1763100000000,
        version: "1.30.0",
        count: 1,
        error: "preflight is red on tree: working tree has tracked changes",
        detail: { check: "tree", reason: "working tree has tracked changes" },
      },
    });
  });

  test("no file, junk and another schema read as the default", () => {
    expect(parseAutoRecord(null)).toEqual(DEFAULT_AUTO_RECORD);
    expect(parseAutoRecord("not json")).toEqual(DEFAULT_AUTO_RECORD);
    expect(parseAutoRecord("[]")).toEqual(DEFAULT_AUTO_RECORD);
    expect(parsed({ schema: 2 })).toEqual(DEFAULT_AUTO_RECORD);
    expect(parsed({ schema: "1" })).toEqual(DEFAULT_AUTO_RECORD);
  });

  test("the top-level fields, each read on its own", () => {
    expect(parsed({ mode: "weekly" }).mode).toBe("off");
    expect(parsed({ mode: "Daily" }).mode).toBe("off");
    expect(parsed({ at: "7:15" }).at).toBe("07:15");
    expect(parsed({ at: 415 }).at).toBe("04:00");
    expect(parsed({ changedAt: "yesterday" }).changedAt).toBeNull();
    expect(parsed({ requestId: "" }).requestId).toBeUndefined();
    expect(parsed({ requestId: 5 }).requestId).toBeUndefined();
    expect(parsed({ setBy: "" }).setBy).toBeUndefined();
    expect(parsed({ setBy: "x".repeat(121) }).setBy).toBeUndefined();
    expect(parsed({ setBy: "x".repeat(120) }).setBy).toHaveLength(120);
    expect(parsed({ lastTryAt: null }).lastTryAt).toBeNull();
    expect(parsed({ lastTryAt: "now" }).lastTryAt).toBeNull();
    expect(parsed({ slotDay: "14.11.2026" }).slotDay).toBeNull();
    expect(parsed({ strikes: { version: "1.30.1", count: 0 } }).strikes).toBeNull();
    expect(parsed({ strikes: { version: "v1.30.1", count: 1 } }).strikes).toBeNull();
    expect(parsed({ strikes: null }).strikes).toBeNull();
  });

  test("the attempt: a missing required field drops it, an optional one is dropped alone", () => {
    for (const field of ["runId", "version", "from", "mode", "startedAt"]) {
      const broken = Object.fromEntries(Object.entries(FULL.attempt).filter(([key]) => key !== field));
      expect(parsed({ attempt: broken }).attempt).toBeNull();
    }
    expect(parsed({ attempt: { ...FULL.attempt, version: "v1.30.0" } }).attempt).toBeNull();
    expect(parsed({ attempt: { ...FULL.attempt, mode: "off" } }).attempt).toBeNull();
    expect(parsed({ attempt: { ...FULL.attempt, runId: "" } }).attempt).toBeNull();
    expect(parsed({ attempt: { ...FULL.attempt, outcome: "canceled" } }).attempt?.outcome).toBeNull();
    expect(parsed({ attempt: { ...FULL.attempt, to: "latest" } }).attempt?.to).toBeUndefined();
    expect(parsed({ attempt: { ...FULL.attempt, reason: "y".repeat(300) } }).attempt?.reason).toHaveLength(240);
    expect(parsed({ attempt: { ...FULL.attempt, settledAt: "soon", toldAt: false } }).attempt).toMatchObject({
      settledAt: null,
      toldAt: null,
    });
    expect(parsed({ attempt: null }).attempt).toBeNull();
  });

  test("failed: a bad entry or outcome is dropped, the rest kept", () => {
    const failed = [
      { version: "1.29.1", outcome: "rolled-back", at: 1 },
      { version: "1.29.2", outcome: "canceled", at: 2 },
      { version: "latest", outcome: "stuck", at: 3 },
      { version: "1.29.4", outcome: "stuck" },
      "1.29.5",
      { version: "1.29.6", outcome: "reverted", at: 6 },
    ];
    expect(parsed({ failed }).failed).toEqual([
      { version: "1.29.1", outcome: "rolled-back", at: 1 },
      { version: "1.29.6", outcome: "reverted", at: 6 },
    ]);
    expect(parsed({ failed: "1.29.1" }).failed).toEqual([]);
  });

  test("skip: an unknown code drops it, a bad count reads 0, error and detail are optional", () => {
    const codes: readonly AutoWaitCode[] = ["busy_reading", "busy_sending", "service", "update.start_failed"];
    for (const code of codes) {
      expect(parsed({ skip: { ...FULL.skip, code } }).skip?.code).toBe(code);
    }
    expect(parsed({ skip: { ...FULL.skip, code: "busy_pairing" } }).skip).toBeNull();
    expect(parsed({ skip: { ...FULL.skip, at: "noon" } }).skip).toBeNull();
    expect(parsed({ skip: { ...FULL.skip, version: "next" } }).skip).toBeNull();
    expect(parsed({ skip: { ...FULL.skip, version: null } }).skip?.version).toBeNull();
    expect(parsed({ skip: { ...FULL.skip, count: -1 } }).skip?.count).toBe(0);
    expect(parsed({ skip: { ...FULL.skip, count: 1.5 } }).skip?.count).toBe(0);
    expect(parsed({ skip: { code: "service", at: 5 } }).skip).toEqual({ code: "service", at: 5, version: null, count: 0 });
    expect(parsed({ skip: { ...FULL.skip, detail: { check: "tree", nested: { a: 1 } } } }).skip?.detail).toBeUndefined();
    expect(parsed({ skip: { ...FULL.skip, detail: { count: 3 } } }).skip?.detail).toEqual({ count: 3 });
  });

  test("a written record reads back the same, through a temporary file and a rename at 0600 and 0700", () => {
    const calls: string[] = [];
    const writer: UpdateLineWriter = {
      mkdirp: (dir, mode) => {
        calls.push(`mkdirp ${dir} ${String(mode)}`);
      },
      write: (path, _text, mode) => {
        calls.push(`write ${path} ${String(mode)}`);
      },
      rename: (from, to) => {
        calls.push(`rename ${from} ${to}`);
      },
    };
    const written = parseAutoRecord(JSON.stringify(FULL));
    writeAutoRecord(writer, "/state", written);
    const path = updateAutoPath("/state");
    expect(path).toBe(join("/state", UPDATE_AUTO_FILE));
    expect(calls).toEqual([`mkdirp /state ${String(0o700)}`, `write ${path}.tmp ${String(0o600)}`, `rename ${path}.tmp ${path}`]);
    const dir = mkdtempSync(join(tmpdir(), "collie-update-auto-"));
    try {
      expect(readAutoRecordSync(dir)).toEqual(DEFAULT_AUTO_RECORD);
      writeAutoRecord(diskWriter, dir, written);
      expect(readAutoRecordSync(dir)).toEqual(written);
      expect(statSync(updateAutoPath(dir)).mode & 0o777).toBe(0o600);
      expect(readFileSync(updateAutoPath(dir), "utf8").endsWith("}\n")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the lines and the pushes", () => {
  function lineOf(view: Partial<UpdateAutoView>): string | null {
    return autoUpdateLine({
      mode: "off",
      at: "04:00",
      zone: "Europe/Berlin",
      pinned: { mode: null, at: null },
      setting: { mode: "off", at: "04:00", changedAt: null },
      nextAt: null,
      ...view,
    });
  }

  test("autoUpdateLine for each shape", () => {
    expect(lineOf({})).toBeNull();
    expect(lineOf({ setting: { mode: "off", at: "04:00", changedAt: 5 } })).toBeNull();
    expect(lineOf({ mode: "daily", setting: { mode: "daily", at: "04:00", changedAt: 5 }, nextAt: local(2026, 11, 15, 4) })).toBe(
      "daily at 04:00 Europe/Berlin, set on the phone, next look 2026-11-15 04:00",
    );
    expect(lineOf({ mode: "daily", zone: "", nextAt: local(2026, 11, 15, 4, 30) })).toBe(
      "daily at 04:00, the default, next look 2026-11-15 04:30",
    );
    expect(lineOf({ mode: "available", pinned: { mode: "env", at: null } })).toBe("when available, set by COLLIE_AUTO_UPDATE");
    expect(lineOf({ mode: "available", pinned: { mode: "config", at: null } })).toBe("when available, set by config.toml");
    expect(lineOf({ pinned: { mode: null, at: "env" } })).toBe("off, the default");
    expect(lineOf({ pinned: { mode: "env", at: null }, unavailable: "invalid_mode" })).toBe(
      "off, set by COLLIE_AUTO_UPDATE, not available here: COLLIE_AUTO_UPDATE is not off, daily or available",
    );
    expect(lineOf({ unavailable: "invalid_time" })).toBe(
      "off, the default, not available here: COLLIE_AUTO_UPDATE_AT is not a time like 04:00",
    );
    expect(lineOf({ pinned: { mode: "config", at: null }, unavailable: "invalid_mode" })).toBe(
      "off, set by config.toml, not available here: auto_update in config.toml is not off, daily or available",
    );
    expect(lineOf({ pinned: { mode: null, at: "config" }, unavailable: "invalid_time" })).toBe(
      "off, the default, not available here: auto_update_at in config.toml is not a time like 04:00",
    );
    expect(lineOf({ mode: "daily", setting: { mode: "daily", at: "04:00", changedAt: 5 }, unavailable: "packaged" })).toBe(
      "daily at 04:00 Europe/Berlin, set on the phone, not available here: a package manager owns this install",
    );
  });

  test("observe logs the line and then each pin warning", () => {
    const pins: AutoPins = { mode: { raw: "nightly", origin: "env" }, at: { raw: "4pm", origin: "config" } };
    const h = rig({ pins });
    h.updater.observe();
    expect(h.logs).toEqual([
      "automatic updates: off, set by COLLIE_AUTO_UPDATE, not available here: COLLIE_AUTO_UPDATE is not off, daily or available",
    ]);
    expect(h.warns).toEqual([
      "COLLIE_AUTO_UPDATE=nightly is not off, daily or available, read as off",
      'auto_update_at = "4pm" in config.toml is not a time like 04:00, so automatic updates are off',
    ]);
    const daily = rig({ record: record({ mode: "daily", changedAt: 1 }), now: local(2026, 11, 14, 10) });
    daily.updater.observe();
    expect(daily.logs).toEqual(["automatic updates: daily at 04:00 Europe/Berlin, set on the phone, next look 2026-11-15 04:00"]);
  });

  test("autoPinWarnings for good pins is empty", () => {
    expect(autoPinWarnings(NO_PINS)).toEqual([]);
    expect(autoPinWarnings({ mode: { raw: "available", origin: "config" }, at: { raw: "23:30", origin: "env" } })).toEqual([]);
  });

  test("autoPushOf for each outcome", () => {
    const base = attempt({ settledAt: 1 });
    const a = { current: "1.29.0", membersBehind: 0 };
    expect(autoPushOf({ ...base, outcome: "done" }, { ...a, current: "1.30.0" })?.body).toBe(
      "Collie 1.30.0 is running. It replaced 1.29.0 on its own.",
    );
    expect(autoPushOf({ ...base, outcome: "done" }, { current: "1.30.0", membersBehind: 2 })?.body).toBe(
      "Collie 1.30.0 is running. It replaced 1.29.0 on its own. The members wait for Retry crew update.",
    );
    expect(autoPushOf({ ...base, outcome: "done" }, a)?.renotify).toBeUndefined();
    expect(autoPushOf({ ...base, outcome: "stuck" }, a)?.body).toBe(
      "The update to 1.30.0 could not finish. Collie 1.29.0 is running. Automatic updates skip 1.30.0 until a newer release.",
    );
    expect(autoPushOf({ ...base, outcome: "aborted", reason: "  " }, a)?.body).toBe(
      "The update to 1.30.0 stopped before anything moved. Automatic updates skip 1.30.0 until a newer release.",
    );
    expect(autoPushOf({ ...base, outcome: "rolled-back", to: "1.30.0-edge.2" }, a)).toMatchObject({
      title: "Automatic update to 1.30.0-edge.2 did not finish",
      titleDetail: { version: "1.30.0-edge.2" },
      renotify: true,
    });
    expect(autoPushOf({ ...base, outcome: "interrupted" }, a)?.titleCode).toBe("update.auto_failed");
    expect(autoPushOf({ ...base, outcome: "no-record" }, a)).toBeNull();
    expect(autoPushOf(base, a)).toBeNull();
  });
});
