import { useId, useRef, useState, useSyncExternalStore } from "react";

import { useCrew } from "@/components/crew-provider";
import { Collapse } from "@/components/ui/collapse";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { SettingCard, SettingStatus } from "@/components/ui/setting-card";
import { useLocale } from "@/hooks/use-locale";
import { setAutoUpdate } from "@/lib/api";
import { describeThrownError } from "@/lib/api-error-message";
import { autoCardView, type AutoCardView, type AutoLoad } from "@/lib/auto-update";
import { t } from "@/lib/i18n";
import { usePairing } from "@/lib/pairing";
import { useOptionalRootData } from "@/lib/route-data";
import { isReadOnly, type AutoMode, type UpdateAutoView } from "@/lib/types";
import { getUpdateClaim, runInFlight, subscribeUpdateStarted } from "@/lib/update-ribbon";
import { useUpdateRun } from "@/lib/update-run-store";
import { mintRequestId } from "@/lib/worktree-name";

export interface AutoUpdateControlProps {
  readonly load: AutoLoad;
  readonly onSaved: (view: UpdateAutoView) => void;
}

/**
 * The Automatic updates card, wired: the device's write right, the update in flight, the crew's
 * members, and the write with a request id.
 *
 * @param props - `load`, the machine's reading, and `onSaved`, which takes the receipt of a write.
 * @returns the card.
 */
export function AutoUpdateControl({ load, onSaved }: AutoUpdateControlProps) {
  useLocale();
  const root = useOptionalRootData();
  const { refused } = usePairing();
  const { check, run } = useUpdateRun();
  const claim = useSyncExternalStore(subscribeUpdateStarted, getUpdateClaim, getUpdateClaim);
  const { servers } = useCrew();
  const members = servers.filter((server) => !server.isLead).map((server) => server.name);
  const [receipt, setReceipt] = useState<AutoMode | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ mode: AutoMode; at: string; requestId: string } | null>(null);

  const card = autoCardView({
    load,
    receipt,
    update: root?.update ?? check,
    saving,
    error,
    canWrite: !isReadOnly(root?.device) && !refused,
    moving: claim !== null || runInFlight(run),
    now: Date.now(),
  });

  async function save(mode: AutoMode, at: string): Promise<void> {
    const held = pending.current;
    const requestId = held !== null && held.mode === mode && held.at === at ? held.requestId : mintRequestId();
    pending.current = { mode, at, requestId };
    setSaving(true);
    setError(null);
    try {
      const answer = await setAutoUpdate({ mode, at, requestId });
      pending.current = null;
      setReceipt(mode);
      onSaved(answer);
    } catch (thrown) {
      setError(t("updates.auto.failed", { reason: describeThrownError(thrown) }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <AutoUpdateCardView
      card={card}
      saving={saving}
      members={members}
      onMode={(mode) => void save(mode, card.at)}
      onTime={(at) => void save(card.mode, at)}
    />
  );
}

export interface AutoUpdateCardViewProps {
  readonly card: AutoCardView;
  readonly saving: boolean;
  readonly members: readonly string[];
  readonly onMode: (mode: AutoMode) => void;
  readonly onTime: (at: string) => void;
}

/**
 * The Automatic updates card, every value handed in.
 *
 * @param props - `card`, from `autoCardView`; `saving` for the spinner; `members`, the crew's
 *   members by name; `onMode` and `onTime`, called with the mode or the time a tap picked.
 * @returns the card: the mode, the daily time, then the status block.
 */
export function AutoUpdateCardView({ card, saving, members, onMode, onTime }: AutoUpdateCardViewProps) {
  useLocale();
  const timeId = useId();
  const options: readonly SegmentedOption<AutoMode>[] = [
    { value: "off", label: t("updates.auto.mode.off") },
    { value: "daily", label: t("updates.auto.mode.daily"), disabled: card.onlyOff },
    { value: "available", label: t("updates.auto.mode.available"), disabled: card.onlyOff },
  ];
  return (
    <SettingCard icon="time" title={t("updates.auto.title")} description={t("updates.auto.description")} slot="auto-update">
      <div className="border-t border-border p-2">
        <Segmented
          options={options}
          value={card.mode}
          onChange={onMode}
          label={t("updates.auto.title")}
          semantics="choice"
          tight
          disabled={card.modeDisabled}
        />
      </div>

      <div className="flex items-center gap-3 border-t border-border px-4 py-2">
        <label htmlFor={timeId} className="min-w-0 flex-1 text-sm">
          {t("updates.auto.time.label")}
        </label>
        <Select
          id={timeId}
          className="shrink-0"
          aria-label={t("updates.auto.time.label")}
          value={card.at}
          disabled={card.timeDisabled}
          onChange={(event) => onTime(event.target.value)}
        >
          {card.timeOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </div>

      <SettingStatus lines={2} text={card.status} busy={saving} error={card.error}>
        <p data-slot="auto-update-next" className="min-h-10 text-sm text-muted-foreground">
          {card.next}
        </p>
        <Collapse open={card.why !== ""} className="-mt-2">
          {card.why !== "" ? (
            <p data-slot="auto-update-why" className="pt-2 text-sm text-muted-foreground">
              {card.why}
            </p>
          ) : null}
        </Collapse>
        <p data-slot="auto-update-last" className="min-h-10 text-sm text-muted-foreground">
          {card.last}
        </p>
        <p className="text-sm text-muted-foreground">{t("updates.auto.thisMachine")}</p>
        <Collapse open={members.length > 0} className="-mt-2">
          {members.length > 0 ? (
            <p data-slot="auto-update-members" className="pt-2 text-sm text-muted-foreground">
              {t("updates.auto.members", { names: members.join(", ") })}
            </p>
          ) : null}
        </Collapse>
      </SettingStatus>
    </SettingCard>
  );
}
