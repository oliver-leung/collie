import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { autoBoundaryAt, autoCardView, autoIsOn, autoSettling, autoTimeOptions, whenOf, type AutoCardInput, type AutoLoad } from "./auto-update";
import type { AutoHold, AutoUnavailable, UpdateAutoView, UpdateInfo } from "./types";

const ZONE_BEFORE = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Asia/Tokyo";
});
afterAll(() => {
  if (ZONE_BEFORE === undefined) delete process.env.TZ;
  else process.env.TZ = ZONE_BEFORE;
});

const HOUR = 60 * 60 * 1000;
const ZONE = "America/New_York";
const NOW = Date.UTC(2026, 10, 14, 13, 0);
const NEXT_AT = Date.UTC(2026, 10, 15, 9, 0);
const ENDS_AT = NEXT_AT + 3 * HOUR;

function view(over: Partial<UpdateAutoView> = {}): UpdateAutoView {
  return {
    mode: "daily",
    at: "04:00",
    zone: ZONE,
    pinned: { mode: null, at: null },
    setting: { mode: "daily", at: "04:00", changedAt: 1 },
    target: null,
    nextAt: NEXT_AT,
    windowEndsAt: ENDS_AT,
    paused: [],
    ...over,
  };
}

function ready(over: Partial<UpdateAutoView> = {}): AutoLoad {
  return { kind: "ready", view: view(over) };
}

function input(over: Partial<AutoCardInput> = {}): AutoCardInput {
  return { load: ready(), receipt: null, update: undefined, saving: false, error: null, canWrite: true, moving: false, now: NOW, ...over };
}

function update(over: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    current: "1.29.0",
    latest: "1.29.0",
    latestUrl: null,
    releaseAvailable: false,
    majorAvailable: null,
    majorUrl: null,
    bridgeStale: false,
    checkedAt: NOW - HOUR,
    ...over,
  };
}

function hostTime(at: number): string {
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", timeZone: ZONE }).format(new Date(at));
}

function hostDateTime(at: number): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: ZONE }).format(new Date(at));
}

describe("the status line, first match wins", () => {
  const cases: ReadonlyArray<readonly [string, AutoCardInput, string]> = [
    ["reading", input({ load: { kind: "reading" } }), "Reading the setting from this machine…"],
    ["failed", input({ load: { kind: "failed" } }), "The setting could not be read from this machine."],
    ["old", input({ load: { kind: "old" } }), "This machine runs a Collie from before automatic updates. Update it once above."],
    ["saving", input({ saving: true, error: "x", receipt: "daily" }), "Saving…"],
    ["error", input({ error: "The setting was not changed. x", receipt: "daily" }), ""],
    ["receipt off", input({ receipt: "off", load: ready({ mode: "off", setting: { mode: "off", at: "04:00", changedAt: 2 } }) }), "Saved. Updates wait for you to start them."],
    ["receipt daily", input({ receipt: "daily", load: ready({ at: "05:00" }) }), "Saved. This machine updates itself once a day, from 05:00 on its own clock."],
    [
      "receipt available",
      input({ receipt: "available", load: ready({ mode: "available", setting: { mode: "available", at: "04:00", changedAt: 2 } }) }),
      "Saved. This machine updates itself soon after each release.",
    ],
    [
      "receipt before unavailable",
      input({ receipt: "off", load: ready({ mode: "off", setting: { mode: "off", at: "04:00", changedAt: 2 }, unavailable: "peer" }) }),
      "Saved. Updates wait for you to start them.",
    ],
    [
      "a receipt the machine's setting no longer holds",
      input({ receipt: "daily", load: ready({ mode: "off", setting: { mode: "off", at: "04:00", changedAt: 3 } }) }),
      "Off. Updates wait for you to start them.",
    ],
    ["unavailable before read-only", input({ canWrite: false, load: ready({ unavailable: "packaged" }) }), "Your package manager updates this machine. Collie never updates it by itself."],
    ["read-only", input({ canWrite: false, load: ready({ pinned: { mode: "env", at: null } }) }), "This device can look but not change host settings."],
    ["mode pinned by env", input({ load: ready({ pinned: { mode: "env", at: null } }) }), "COLLIE_AUTO_UPDATE on this machine sets this. Change it there and restart Collie."],
    ["mode pinned by config", input({ load: ready({ pinned: { mode: "config", at: "env" } }) }), "config.toml on this machine sets this. Change it there and restart Collie."],
    ["time pinned by env, daily", input({ load: ready({ pinned: { mode: null, at: "env" } }) }), "COLLIE_AUTO_UPDATE_AT on this machine sets the time."],
    ["time pinned by config, daily", input({ load: ready({ pinned: { mode: null, at: "config" } }) }), "config.toml on this machine sets the time."],
    ["time pinned, not daily", input({ load: ready({ mode: "available", pinned: { mode: null, at: "env" } }) }), "Soon after each release, once nobody is using Collie."],
    ["off", input({ load: ready({ mode: "off" }) }), "Off. Updates wait for you to start them."],
    ["daily with a zone", input(), "Once a day, from 04:00 on this machine's clock (America/New_York)."],
    ["daily with no zone", input({ load: ready({ zone: "" }) }), "Once a day, from 04:00 on this machine's clock."],
    ["available", input({ load: ready({ mode: "available" }) }), "Soon after each release, once nobody is using Collie."],
  ];
  it.each(cases)("%s", (_label, given, status) => {
    expect(autoCardView(given).status).toBe(status);
  });

  const unavailable: ReadonlyArray<readonly [AutoUnavailable, string]> = [
    ["peer", "This machine follows its lead. Retry crew update on the lead updates it."],
    ["no_runner", "This Collie runs from source with no compiled collie, so it cannot update itself."],
    ["packaged", "Your package manager updates this machine. Collie never updates it by itself."],
    ["unknown_install", "Collie cannot tell how this machine was installed, so it never updates itself."],
    ["windows_checkout", "A source checkout on Windows never updates itself. Install the release zip to use this."],
    ["in_place", "This checkout updates in place, with no way back, so it never updates by itself."],
    ["first_stage", "This checkout's first staged update has no way back. Take it with the card above."],
    ["dev_build", "This is a development build. It updates from its checkout, never by itself."],
    ["ci", "CI is set on this machine, so it never updates by itself."],
    ["mirror", "A rehearsal mirror is set on this machine, so it never updates by itself."],
    ["unsupervised", "No service manager restarts Collie on this machine, so it never updates by itself."],
    ["deposed", "This machine handed the crew to another lead, so it does not update itself."],
  ];
  it.each(unavailable)("unavailable: %s", (code, status) => {
    expect(autoCardView(input({ load: ready({ unavailable: code }) })).status).toBe(status);
  });

  it("names the switch that set a word Collie does not know, from the environment or the file", () => {
    const fromEnv = ready({ mode: "off", unavailable: "invalid_mode", pinned: { mode: "env", at: null } });
    const fromFile = ready({ mode: "off", unavailable: "invalid_mode", pinned: { mode: "config", at: null } });
    expect(autoCardView(input({ load: fromEnv })).status).toBe("COLLIE_AUTO_UPDATE is not off, daily or available here, so automatic updates are off.");
    expect(autoCardView(input({ load: fromFile })).status).toBe(
      "auto_update in config.toml is not off, daily or available here, so automatic updates are off.",
    );
  });

  it("names the switch that set a time that does not parse, from the environment or the file", () => {
    const fromEnv = ready({ unavailable: "invalid_time", pinned: { mode: null, at: "env" } });
    const fromFile = ready({ unavailable: "invalid_time", pinned: { mode: null, at: "config" } });
    expect(autoCardView(input({ load: fromEnv })).status).toBe("COLLIE_AUTO_UPDATE_AT is not a time like 04:00 here, so automatic updates are off.");
    expect(autoCardView(input({ load: fromFile })).status).toBe(
      "auto_update_at in config.toml is not a time like 04:00 here, so automatic updates are off.",
    );
  });
});

describe("the controls", () => {
  it("shows Off at 04:00, every control disabled, before a reading", () => {
    for (const load of [{ kind: "reading" }, { kind: "failed" }, { kind: "old" }] satisfies AutoLoad[]) {
      const card = autoCardView(input({ load }));
      expect(card.view).toBeNull();
      expect(card).toMatchObject({ mode: "off", at: "04:00", modeDisabled: true, timeDisabled: true, onlyOff: false });
      expect(card.next).toBe("");
      expect(card.why).toBe("");
      expect(card.last).toBe("");
    }
  });

  it("leaves the mode and the time free on a daily machine that may write", () => {
    expect(autoCardView(input())).toMatchObject({ mode: "daily", at: "04:00", modeDisabled: false, timeDisabled: false, onlyOff: false });
  });

  it("disables the whole row while saving, while an update moves, on a read-only device and under a mode pin", () => {
    for (const over of [{ saving: true }, { moving: true }, { canWrite: false }, { load: ready({ pinned: { mode: "config", at: null } }) }] satisfies Partial<AutoCardInput>[]) {
      expect(autoCardView(input(over))).toMatchObject({ modeDisabled: true, timeDisabled: true });
    }
  });

  it("leaves Off alone on a machine where automatic updates are not available", () => {
    expect(autoCardView(input({ load: ready({ unavailable: "first_stage" }) }))).toMatchObject({ modeDisabled: false, onlyOff: true, timeDisabled: true });
  });

  it("disables the time alone under a time pin, and whenever the mode is not daily", () => {
    expect(autoCardView(input({ load: ready({ pinned: { mode: null, at: "env" } }) }))).toMatchObject({ modeDisabled: false, timeDisabled: true });
    expect(autoCardView(input({ load: ready({ mode: "available" }) }))).toMatchObject({ modeDisabled: false, timeDisabled: true });
    expect(autoCardView(input({ load: ready({ mode: "off" }) }))).toMatchObject({ modeDisabled: false, timeDisabled: true });
  });

  it("offers the saved time among the hours, and hands the failure through", () => {
    const card = autoCardView(input({ load: ready({ at: "04:30" }), error: "The setting was not changed. x" }));
    expect(card.at).toBe("04:30");
    expect(card.timeOptions).toContain("04:30");
    expect(card.error).toBe("The setting was not changed. x");
  });
});

describe("the next line", () => {
  it("is empty while off and where automatic updates are not available", () => {
    expect(autoCardView(input({ load: ready({ mode: "off", target: "1.30.0" }) })).next).toBe("");
    expect(autoCardView(input({ load: ready({ unavailable: "ci", target: "1.30.0" }) })).next).toBe("");
  });

  it("(a) names the automatic update that is running", () => {
    const last = { runId: "r", version: "1.30.0", from: "1.29.0", to: "1.30.0", mode: "daily", outcome: null, startedAt: NOW, settledAt: null } satisfies UpdateAutoView["last"];
    expect(autoCardView(input({ load: ready({ target: "1.30.0", nextAt: null, windowEndsAt: null, last }) })).next).toBe(
      "An automatic update to 1.30.0 is running.",
    );
  });

  const holds: ReadonlyArray<readonly [AutoHold, string]> = [
    ["paused", "Automatic updates skip 1.30.0 after a failed or reversed update. The card above takes it."],
    ["dismissed", "You dismissed 1.30.0, so automatic updates skip it. The card above still takes it."],
    ["prerelease", "1.30.0 is a prerelease, so it waits for you. Take it with the card above."],
    ["link_change", "1.30.0 changes the crew link, so it waits for you. Take it with the card above."],
    ["link_unknown", "1.30.0 is out. Its crew link note is not read yet, so it waits for the next check."],
  ];
  it.each(holds)("(b) a held release: %s", (hold, next) => {
    expect(autoCardView(input({ load: ready({ target: "1.30.0", hold }) })).next).toBe(next);
  });

  it("(b) a release that waits for the next daily window, on the host's clock", () => {
    expect(autoCardView(input({ load: ready({ target: "1.30.0" }) })).next).toBe(
      `1.30.0 is out. It installs from ${hostDateTime(NEXT_AT)}, once nobody is using Collie.`,
    );
  });

  it("(b) a release inside an open daily window says when the window closes", () => {
    const open = ready({ target: "1.30.0", nextAt: NOW - HOUR, windowEndsAt: NOW + 2 * HOUR });
    expect(autoCardView(input({ load: open })).next).toBe(`1.30.0 is out. It installs before ${hostTime(NOW + 2 * HOUR)}, once nobody is using Collie.`);
  });

  it("(b) a reading that outlived its daily window names no time already past", () => {
    const closed = ready({ target: "1.30.0", nextAt: NOW - 4 * HOUR, windowEndsAt: NOW - HOUR });
    expect(autoCardView(input({ load: closed })).next).toBe("");
    expect(autoCardView(input({ load: ready({ target: "1.30.0", nextAt: NOW - HOUR, windowEndsAt: NOW }) })).next).toBe("");
  });

  it("(b) a release on a machine that takes one when available", () => {
    expect(autoCardView(input({ load: ready({ mode: "available", target: "1.30.0", nextAt: null, windowEndsAt: null }) })).next).toBe(
      "1.30.0 is out. It installs once nobody has used Collie for 15 minutes.",
    );
  });

  it("(c) a new major alone is never taken", () => {
    expect(autoCardView(input({ update: update({ majorAvailable: "2.0.0" }) })).next).toBe(
      "2.0.0 is a new major. Automatic updates never cross one: use Cross to 2.0.0 above.",
    );
  });

  it("(d) up to date says when it looks next, or that the release check looks", () => {
    expect(autoCardView(input({ update: update() })).next).toBe(`Up to date. Next look ${hostDateTime(NEXT_AT)}.`);
    expect(autoCardView(input({ load: ready({ mode: "available", nextAt: null, windowEndsAt: null }) })).next).toBe(
      "Up to date. The next release check looks again.",
    );
  });

  it("(d) never names a time already past as the next look", () => {
    expect(autoCardView(input({ update: update(), load: ready({ nextAt: NOW - HOUR, windowEndsAt: NOW + 2 * HOUR }) })).next).toBe("");
    expect(autoCardView(input({ update: update(), load: ready({ nextAt: NOW, windowEndsAt: NOW + 3 * HOUR }) })).next).toBe("");
  });
});

describe("the why line", () => {
  const at = NOW - HOUR;

  it("says the person was reading or typing, at the host's time", () => {
    const reading = ready({ target: "1.30.0", waiting: { code: "busy_reading", at, version: "1.30.0" } });
    const sending = ready({ target: "1.30.0", waiting: { code: "busy_sending", at, version: "1.30.0" } });
    expect(autoCardView(input({ load: reading })).why).toBe(`Not started at ${hostTime(at)}: Collie was in use.`);
    expect(autoCardView(input({ load: sending })).why).toBe(`Not started at ${hostTime(at)}: a message was being typed into a pane.`);
  });

  it("translates a refusal whose code this build knows, with its detail", () => {
    const waiting = {
      code: "update.preflight_red",
      at,
      version: "1.30.0",
      error: "preflight is red on tree: working tree has tracked changes",
      detail: { check: "tree", reason: "working tree has tracked changes" },
    };
    expect(autoCardView(input({ load: ready({ target: "1.30.0", waiting }) })).why).toBe(
      `Not started at ${hostTime(at)}: Preflight is red on tree: working tree has tracked changes`,
    );
  });

  it("gives the service row's own sentence for the service check", () => {
    const waiting = { code: "service", at, version: "1.30.0", error: "the collie unit is not active" };
    expect(autoCardView(input({ load: ready({ target: "1.30.0", waiting }) })).why).toBe(`Not started at ${hostTime(at)}: the collie unit is not active`);
  });

  it("is empty with no target, while a run is pending, while off, held or unavailable", () => {
    const waiting = { code: "busy_reading", at, version: "1.30.0" };
    const last = { runId: "r", version: "1.30.0", from: "1.29.0", to: "1.30.0", mode: "daily", outcome: null, startedAt: NOW, settledAt: null } satisfies UpdateAutoView["last"];
    for (const over of [
      { waiting },
      { waiting, target: "1.30.0", last },
      { waiting, target: "1.30.0", mode: "off" },
      { waiting, target: "1.30.0", hold: "dismissed" },
      { waiting, target: "1.30.0", unavailable: "deposed" },
      { target: "1.30.0" },
    ] satisfies Partial<UpdateAutoView>[]) {
      expect(autoCardView(input({ load: ready(over) })).why).toBe("");
    }
  });
});

describe("the last line", () => {
  const settledAt = NOW - 2 * HOUR;
  function settled(outcome: "done" | "rolled-back" | "stuck" | "interrupted" | "aborted" | "no-record", reason?: string): AutoLoad {
    const last = { runId: "r", version: "1.30.0", from: "1.29.0", to: "1.30.0", mode: "daily", outcome, startedAt: settledAt - HOUR, settledAt } satisfies UpdateAutoView["last"];
    return ready({ last: reason === undefined ? last : { ...last, reason } });
  }
  const when = hostTime(settledAt);

  it("says none has run, or the one running now", () => {
    expect(autoCardView(input()).last).toBe("No automatic update has run on this machine yet.");
    const last = { runId: "r", version: "1.30.0", from: "1.29.0", to: "1.30.0", mode: "available", outcome: null, startedAt: NOW, settledAt: null } satisfies UpdateAutoView["last"];
    expect(autoCardView(input({ load: ready({ last }) })).last).toBe("Last automatic update: 1.30.0, running now.");
  });

  const outcomes: ReadonlyArray<readonly [AutoLoad, string]> = [
    [settled("done"), `Last automatic update: 1.29.0 to 1.30.0, ${when}.`],
    [settled("rolled-back"), `Last automatic update: 1.30.0 did not come up, ${when}. Back on 1.29.0.`],
    [settled("stuck"), `Last automatic update: 1.30.0 could not finish, ${when}. See the card above.`],
    [settled("interrupted"), `Last automatic update: the run to 1.30.0 stopped, ${when}. Nothing is half installed.`],
    [
      settled("aborted", "the release is not published yet"),
      `Last automatic update: the run to 1.30.0 stopped before anything moved, ${when}: the release is not published yet.`,
    ],
    [settled("aborted"), `Last automatic update: the run to 1.30.0 stopped before anything moved, ${when}.`],
    [settled("no-record"), `Last automatic update: the run to 1.30.0 never started, ${when}.`],
  ];
  it.each(outcomes)("%#: one line per outcome", (load, last) => {
    expect(autoCardView(input({ load })).last).toBe(last);
  });

  it("dates a run with no settle time by its start", () => {
    const last = { runId: "r", version: "1.30.0", from: "1.29.0", to: "1.30.0", mode: "daily", outcome: "done", startedAt: NOW - 3 * HOUR, settledAt: null } satisfies UpdateAutoView["last"];
    expect(autoCardView(input({ load: ready({ last }) })).last).toBe(`Last automatic update: 1.29.0 to 1.30.0, ${hostTime(NOW - 3 * HOUR)}.`);
  });
});

describe("autoTimeOptions", () => {
  it("offers the 24 hours", () => {
    const hours = autoTimeOptions("04:00");
    expect(hours).toHaveLength(24);
    expect(hours[0]).toBe("00:00");
    expect(hours.at(-1)).toBe("23:00");
  });

  it("adds a saved time off the hour, in order", () => {
    const options = autoTimeOptions("04:30");
    expect(options).toHaveLength(25);
    expect(options.slice(3, 7)).toEqual(["03:00", "04:00", "04:30", "05:00"]);
    expect(options).toEqual(options.toSorted());
  });

  it("adds nothing that is not a time", () => {
    expect(autoTimeOptions("4:30")).toHaveLength(24);
  });
});

describe("whenOf, on the host's clock", () => {
  it("prints the host's time of day, not this phone's, on the host's same day", () => {
    const at = Date.UTC(2026, 10, 14, 9, 0);
    expect(whenOf(at, NOW, ZONE)).toBe(hostTime(at));
    expect(whenOf(at, NOW, ZONE)).not.toBe(new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(new Date(at)));
  });

  it("prints a date and a time on another host day", () => {
    const at = Date.UTC(2026, 10, 15, 6, 0);
    expect(whenOf(at, NOW, ZONE)).toBe(hostDateTime(at));
  });

  it("falls back to this phone's zone for an empty or unknown zone", () => {
    const at = Date.UTC(2026, 10, 14, 9, 0);
    const phone = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(new Date(at));
    expect(whenOf(at, NOW, "")).toBe(phone);
    expect(whenOf(at, NOW, "Mars/Olympus_Mons")).toBe(phone);
  });
});

describe("autoIsOn", () => {
  it("is on for a mode that is not off on a machine where it is available", () => {
    expect(autoIsOn(ready())).toBe(true);
    expect(autoIsOn(ready({ mode: "available" }))).toBe(true);
  });

  it("is off for off, unavailable, and any load that is not ready", () => {
    expect(autoIsOn(ready({ mode: "off" }))).toBe(false);
    expect(autoIsOn(ready({ unavailable: "peer" }))).toBe(false);
    expect(autoIsOn({ kind: "reading" })).toBe(false);
    expect(autoIsOn({ kind: "failed" })).toBe(false);
    expect(autoIsOn({ kind: "old" })).toBe(false);
  });
});

describe("autoSettling", () => {
  it("is true only while the reading names an automatic update with no outcome", () => {
    const last = { runId: "r", version: "1.30.0", from: "1.29.0", to: "1.30.0", mode: "daily", outcome: null, startedAt: NOW, settledAt: null } satisfies UpdateAutoView["last"];
    expect(autoSettling(ready({ last }))).toBe(true);
    expect(autoSettling(ready({ last: { ...last, outcome: "aborted", settledAt: NOW } }))).toBe(false);
    expect(autoSettling(ready())).toBe(false);
    expect(autoSettling({ kind: "reading" })).toBe(false);
    expect(autoSettling({ kind: "old" })).toBe(false);
  });
});

describe("autoBoundaryAt", () => {
  it("is the window's start while it is ahead, then its end, then nothing", () => {
    expect(autoBoundaryAt(ready(), NOW)).toBe(NEXT_AT);
    expect(autoBoundaryAt(ready(), NEXT_AT)).toBe(ENDS_AT);
    expect(autoBoundaryAt(ready(), ENDS_AT)).toBeNull();
  });

  it("is nothing without a window or a reading", () => {
    expect(autoBoundaryAt(ready({ mode: "available", nextAt: null, windowEndsAt: null }), NOW)).toBeNull();
    expect(autoBoundaryAt({ kind: "reading" }, NOW)).toBeNull();
    expect(autoBoundaryAt({ kind: "failed" }, NOW)).toBeNull();
  });
});
