# 0141: An automatic update is the operator's standing consent for one machine

- **Status:** Proposed (2026-11-14), for the maintainer to accept
- **Date:** 2026-11-14
- **Shipped in:** pending
- **Amends in scope:** [ADR 0064](./0064-an-update-puts-the-phone-in-update-mode.md), point 7. A
  device that did not start a run keeps its app and gets one line in the band. For a run the bridge
  started for itself, that line reads `Automatic update running. <step>.` in place of
  `Update running, started on another device. <step>.` Everything else in 0064 stands.
- **Relates to:** [ADR 0006](./0006-update-advances-the-checkout-herdr-installed.md) (a
  Herdr-managed checkout updates in place, with no way back) ·
  [ADR 0016](./0016-updates-ride-the-operators-ssh.md) (no automatic rollout to the crew; unchanged)
  · [ADR 0020](./0020-a-major-upgrade-is-consented-by-flag.md) (a major is consented by flag) ·
  [ADR 0024](./0024-a-beacon-is-a-hint-never-a-control-channel.md) (an action is armed by a named
  choice) · [ADR 0026](./0026-the-operator-is-the-quorum.md) (silence may arm, never authorize) ·
  [ADR 0035](./0035-a-packaged-install-is-not-ours-to-update.md) (a packaged install is not ours to
  update) · [ADR 0037](./0037-a-staged-update-confirms-its-runner-before-it-exits.md) (the runner a
  start launches) · [ADR 0040](./0040-configuration-precedence-and-the-config-file.md) (the
  environment and the file win over the phone) ·
  [ADR 0044](./0044-the-update-screen-is-one-reducer-and-one-shared-poll.md) (one reducer draws the
  strip) · [ADR 0046](./0046-an-urgent-patch-keeps-the-daily-cadence.md) (urgency changes the
  delivery, never the act) ·
  [ADR 0050](./0050-a-crew-fault-blocks-an-update-only-when-the-update-makes-it-worse.md) (the crew
  rows the verdict reads) ·
  [ADR 0062](./0062-a-crew-run-levels-to-its-target-and-its-second-step-is-not-a-new-attempt.md)
  (the follower's hourly limit) · [ADR 0074](./0074-a-push-title-is-a-code-the-phone-translates.md)
  (two push codes) · [ADR 0094](./0094-launchers-added-from-a-phone.md) (a revoke takes back what
  the device set) · [ADR 0110](./0110-two-release-lines.md) (one resolver for the offer; new files
  only) · [ADR 0111](./0111-the-skill-follows-the-update.md) and
  [ADR 0132](./0132-the-math-engines-are-a-pack-the-host-downloads.md) (what a restart costs) ·
  [ADR 0129](./0129-an-anonymous-install-count-on-by-default.md) (the one narrow thing that is on by
  default)
- **Trail:** the pull request that carries this record, and the lines it argues with:
  `updateStartVerdict` in `bridge/update-action.ts` ("No confirm, no update", and "One tap plus one
  confirm is the whole contract", which this change removes from its doc), the `POST /api/update`
  handler in `bridge/server.ts` ("an action is armed by a named choice of the operator's and by
  nothing else"), and ADR 0016, whose
  alternatives reject "an automatic, unsupervised rollout" and whose 2026-09-04 addendum (§5) holds
  that a crew rollout "cannot begin without an operator confirm on the lead". That last line still
  holds, because the scheduler mints no crew turn. · `bridge/update-auto.ts` · `bridge/update.ts`
  (`offer`, `onChecked`, `noteAnnounced`) · `bridge/update-action.ts` (`updateStartStateOf`,
  `UpdateStartLatch`) · `bridge/update-run.ts` (`trigger`, `crewTurnStart`) · `bridge/server.ts`
  (`GET` and `POST /api/update/auto`, `forgetDevice`) · `bridge/index.ts` · `cli/update.ts`
  (`--trigger auto`) · `web/src/components/auto-update-card.tsx` ·
  `web/src/components/ui/setting-card.tsx` · `web/src/lib/update-screen.ts` · `docs/upgrading.md`
  → *Automatic updates*

## Context

Every update starts from a person. The bridge checks for a release every six hours and the digest
tells the operator about it, and neither installs anything. The one update a bridge starts without
a tap of its own is a crew member's follow, and it rides the confirm a person gave on the lead.
Releases come often: 40 strict releases were tagged in the 31 days to 2026-11-13, about 1.3 a day,
and each one waits for a tap on every machine.

An update already carries its own checks, and none of them needs a person in front of it: the
verdict, the forced preflight, the health gate and its one rollback. Four facts bound what a machine
may do with them alone.

1. **The health gate's promise is bounded.** It proves that the service came back and answered
   `/api/health` with the version that was installed, not that the build works
   (`docs/upgrading.md` → *What the health gate does not catch*).
2. **A failed Stable release is offered again.** `afterFailedBuild` in `bridge/update-line.ts`
   rejects only an Edge build, because the next Stable is the fix. A schedule with no memory of its
   own would install a broken release, roll back, and install it again at every slot.
3. **The CLI plans from the remote's own tags.** `collie update` with no pin can name a tag whose
   release is not published yet (#503), or one whose crew-link note the bridge never read.
4. **Two starts a few seconds apart can both pass.** The verdict's in-flight checks read
   `update.json` and the update lock, and the spawned updater writes both only once it runs,
   seconds after the spawn.

## Decision

**A Collie starts its own update only when its operator switched automatic updates on for that
machine, and then it starts exactly the routine update a tap would start, pinned to the release the
bridge vetted, through the same verdict, the same forced preflight and the one spawner, only on an
install that stages beside the live build and rolls back under a supervisor, for this machine
alone, never again for a release that did not finish, and never for one the operator declined.**

The setting is the operator's standing consent: the named choice ADR 0024 asks for, made once, ahead
of time, for one machine. The scheduler passes `confirm: true` on its strength and on nothing else.
Every check below can only defer a start, never authorize one, which is the line ADR 0026 draws
between arming and authorizing.

1. **Off by default, per machine.** A write device sets it under Settings → Updates → Automatic
   updates (`POST /api/update/auto`, with a request id, a receipt and an audit line), and the bridge
   stores it in `<stateDir>/update-auto.json`. `[update] auto_update` and `auto_update_at` in
   `config.toml`, or `COLLIE_AUTO_UPDATE` and `COLLIE_AUTO_UPDATE_AT`, pin it, and a pin wins
   (ADR 0040). A pinned mode refuses every phone write, the same word included: a write under a pin
   would only pretend, and it would become the setting the day the pin is removed. A pinned time
   locks the time and is never copied into the record. An unknown mode word reads as `off`, and a
   pinned time that does not parse turns automatic updates off in every mode. Revoking the paired
   device that last set a mode other than `off` turns it off, as a revoke takes back the launchers a
   device added (ADR 0094).
2. **Two schedules.** `daily` starts at most once per host-local day, inside the three hours from
   `HH:MM` (default `04:00`). There is no catch-up: a window the machine slept through, or spent in
   use, waits for the next day's, because the operator picked the hour for when the machine is
   idle. When the window is open and the last release check is over 30 minutes old, the bridge
   checks once first, so a release published since the six-hourly check is taken in this window.
   `available` starts after the check that offers a newer build, at most once an hour.
3. **The start a tap makes, pinned.** The request is `{ confirm: true, target, major: false,
   peersOnly: false }`, judged by `updateStartVerdict` over `updateStartStateOf(...)` after a forced
   `preflight(true)`, then started by `startDetachedUpdate`, the one spawner, as
   `collie update --to-tag v<target> --run-id <id> --trigger auto`, and nothing else: never
   `--major`, `--downgrade`, `--rollback` or `--line`. The pin is the version every check vetted.
4. **A routine target only.** The target is `lineOffer`'s answer inside the installed major on this
   machine's line (ADR 0110), and only a strict release or an Edge build, which is what `--to-tag`
   takes. A prerelease outside the Edge line waits for a tap, a major always does (ADR 0020), and
   urgency changes no schedule (ADR 0046).
5. **Only an install that can come back.** A binary install, or a checkout whose root sits under
   `versions/`; on Linux only when the bridge is its own systemd unit; everywhere only when the
   forced preflight's `service` row is green. Anything else is unavailable, for one of a closed set
   of reasons: `peer`, `no_runner`, `packaged`, `unknown_install`, `windows_checkout`, `in_place`,
   `first_stage`, `dev_build`, `ci`, `mirror`, `unsupervised`, `deposed`, `invalid_mode`,
   `invalid_time`. A linked clone before its first stage is `first_stage`: that first staged update
   has no rollback target, so a failed health check ends `stuck`.
6. **No new timer.** The engine's tick, the clock the crew sweep already rides, and the monitor's
   `onChecked`, after every successful release check. `updateCadenceTick` and its two timers stay
   as they are.
7. **Not while Collie is in use.** No start while a paired device's page polled this bridge in the
   last 15 minutes, or while a Send Protocol request is being typed. The bridge's own boot counts as
   a poll, because the poll map lives in memory and is empty after every restart. Both signals are
   read before the preflight and again after it.
8. **One start at a time.** A latch, claimed as the first statement of `startDetachedUpdate` and
   held until `update.json` names that run or 120 seconds pass, refuses a second start from a tap
   and from the scheduler alike (`409 update.in_progress`, `{ state: "starting" }`).
9. **Memory, and the operator's no.** Never taken automatically again: a release whose automatic
   run ended `rolled-back`, `stuck`, `interrupted` or `aborted`; one a person rolled back from on
   the phone; one an automatic run installed that no longer runs; one whose automatic run wrote no
   record three times. A newer release is not affected, and a person's tap still works. Also held,
   for as long as the reason stands: the release the band was dismissed for, a prerelease outside
   the Edge line, a release whose sidecar changes the crew link, and, on a lead, one whose sidecar
   could not be read yet.
10. **Backoff.** A refusal by the verdict, the `service` row or the launcher is tried again after 1,
    2 and 4 hours, then every 6, for the same release. A deferral while Collie is in use is looked
    at again every minute and runs no preflight. An evaluation that throws waits a minute.
11. **This machine only.** `crewTurnStart` returns null for a run with `trigger: "auto"`, so a lead
    updates itself and levels nobody, and its members wait for Retry crew update. A member or the
    deputy never updates itself this way (`peer`). Nothing new crosses the crew link.
12. **Reporting.** `update.json` carries `trigger: "auto"`. The strip reads
    `Automatic update running. <step>.` on every device, and the Updates page gains an Automatic
    updates card. One push per settled run, `update.auto_done` or `update.auto_failed` (ADR 0074),
    under the `updates` alert and never before 09:00 host-local. A failure push alerts again
    (`renotify`) and marks its version announced, so the digest does not offer that version over
    the result. The digest itself is unchanged. A run that leaves the bridge down is told when the
    bridge next starts, and the runner never sends a push.
13. **One new file, and restart recognition.** `update-auto.json` holds the setting and the
    scheduler's memory, schema 1, written by the bridge alone and absent until the feature is turned
    on. New fields and new files only (ADR 0110). The attempt, its run id and version, is written
    before the spawn, and every evaluation reconciles it with `update.json` by run id, after the
    bridge's own restart too, so a success is never retried. A run that no record names within 15
    minutes counts as `no-record`.
14. **The outbound text.** `CLAUDE.md` and `docs/security.md` say that, with the feature on, the
    bridge makes an update's calls without a tap.

## Alternatives rejected

- **On by default.** ADR 0129 opened one narrow count, not a road. An update is an action, and an
  action is armed by a named choice.
- **An OS timer** (cron, a systemd timer, a launchd calendar, Task Scheduler). Four schedulers
  outside the verdict, invisible to the phone.
- **A third bridge timer.** `updateCadenceTick` rides the two timers the bridge already arms, on
  purpose, and the engine's tick is already the frequent clock.
- **The lead's run leveling the crew.** ADR 0016's addendum lets a crew rollout begin only on a
  confirm on the lead, and a lead's automatic update mints no crew turn.
- **Members on their own schedule.** The crew would drift into version skew, and the crew rows that
  bound a release across machines (ADR 0050) are read only in the lead's run.
- **A start with no pin.** The CLI then plans from its own tags: it can take a tag whose release is
  not published yet, or one whose crew-link note the bridge never read.
- **A run with no run id.** The bridge could not recognize its own run after a restart.
- **Catch-up later the same day.** It restarts Collie in the working day, which is what the chosen
  hour avoids.
- **Holding the availability digest while an automatic update will take the release.** It breaks
  ADR 0046's guarantee: the operator is told at the release, or at the next 09:00 after it.
- **The runner pushing a stuck result itself.** A second sender, and the runner exits long before
  09:00.
- **A pairing request as a sign of use.** An unpaired browser can keep one open, and the approver's
  own page already polls.
- **An install-root lock for two instances on one install.** A change to the tap's own locking. The
  docs say to turn automatic updates on in one instance only.
- **Herdr-managed in place, packaged, Windows source checkouts, and a linked clone's first stage.**
  Each has no way back, or the install is not Collie's to update.
- **Urgent meaning "install now".** Urgency changes the delivery, never the act (ADR 0046).

## Consequences

- **At most one restart a day, or one an hour.** `daily` restarts Collie once in its window, and
  `available` can restart it once an hour while releases come.
- **Release notes are read after the install, not before.**
- **The unattended install rests on TLS and a hash.** A binary install checks the archive against
  the release manifest's sha256, and a checkout fetches the tag. Nothing is signed by a key the
  operator holds. A bad release reaches every `available` machine within one six-hour check, and
  every `daily` machine at its next window.
- **A stuck run leaves the machine dark until someone looks.** It is told only when the bridge runs
  again, and the docs say so in a Caution.
- **A transient abort pauses a release.** A network failure while staging ends `aborted`, and that
  release then waits for a newer one or a tap. The card and the push say so.
- **A minor that needs an operator act is applied unattended.** A release shaped like 1.18.0, which
  made reads need the pairing token (ADR 0086), would land with nobody there to read its notes.
  Only a sidecar marker could hold such a release, and none exists.
- **The band's dismiss now also holds an automatic update.**
- **A restart costs what a restart always costs.** WalkyTalky items end "bridge restarted", the
  math pack waits for a tap (ADR 0132), and the skill sync rewrites harness files (ADR 0111).
- **The quiet guard sees the phone, not the terminal.** A person who works only in a terminal, with
  no paired page open, is not a reason to wait.
- **No rehearsal drives it end to end.** CI and the update mirror are excluded on purpose, so
  `make win-rehearse` and the browser leg cannot start an automatic run. The run is the tap's run
  plus two flags, and Windows and macOS rely on that sharing.
- **A terminal rollback of a release a tap installed is not remembered.** `collie update --rollback`
  writes no record, and a rollback off a Stable build leaves `update-line.json` as it was, so after
  one only a release an automatic run installed is held. The docs tell the operator to dismiss the
  other from the band.
- **Majors, crews, packaged, Herdr-managed and Windows source installs stay a tap.**

## Left open for the maintainer

**A minimum release age, a soak, for `daily`.** The daily window does not delay a release
published just before it opens: one published minutes before the window can be installed in it.
That is the same exposure `available` has by decision. A soak of a day would let a regression
surface on Edge machines and on taps first, at the cost of a day's delay for every fix, an urgent
one included. This record does not decide it.

## What would justify revisiting

- Release artifacts signed with a key the operator holds, so an unattended install can check more
  than TLS and the manifest's hash.
- A Windows rehearsal that can drive an automatic run.
- A Herdr refresh verb with a rollback, which would let a Herdr-managed checkout take part.
- Operators asking for crew-wide automatic leveling, which reopens ADR 0016.
