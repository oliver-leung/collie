import type { ReactElement, ReactNode } from "react";

import { Icon } from "@/components/icons/icon";
import type { IconKey } from "@/components/icons/keys";
import { Card } from "@/components/ui/card";
import { Collapse } from "@/components/ui/collapse";
import { cn } from "@/lib/utils";

export interface SettingCardProps {
  readonly icon: IconKey;
  readonly title: string;
  readonly description: string;
  readonly slot: string;
  readonly aside?: ReactNode;
  readonly children?: ReactNode;
}

/**
 * A host setting's card.
 *
 * @param props - `icon`, `title` and `description` for the header, `slot` for the card's
 *   `data-slot`, `aside` for an optional control at the header's end, and `children` for the
 *   sections under the header, each drawing its own top rule.
 * @returns the card: the header, then the sections.
 */
export function SettingCard({ icon, title, description, slot, aside, children }: SettingCardProps): ReactElement {
  return (
    <Card className="gap-0 py-0" data-slot={slot}>
      <div className="flex items-start gap-3 p-4">
        <Icon name={icon} className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{title}</div>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {aside !== undefined && <div className="shrink-0">{aside}</div>}
      </div>
      {children}
    </Card>
  );
}

export interface SettingStatusProps {
  readonly text: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly lines?: 1 | 2;
  readonly id?: string;
  readonly children?: ReactNode;
}

/**
 * A host setting's status block, under a rule.
 *
 * @param props - `text` for the `role="status"` line, `busy` for its spinner, `error` for the
 *   failure line (null for none), `lines` for the height the status line reserves (1 by default),
 *   `id` for the status line's id, and `children` for the lines after it.
 * @returns the block: the status line, the failure line through `Collapse`, then the children.
 */
export function SettingStatus({ text, busy, error, lines = 1, id, children }: SettingStatusProps): ReactElement {
  return (
    <div data-slot="setting-status" className="flex flex-col gap-2 border-t border-border px-4 py-3">
      <p id={id} role="status" className={cn("flex items-start gap-2 text-sm text-muted-foreground", lines === 2 ? "min-h-10" : "min-h-5")}>
        {busy && <Icon name="busy" className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden="true" />}
        {text}
      </p>
      <Collapse open={error !== null} className="-mt-2">
        {error !== null ? (
          <p data-slot="setting-error" className="pt-2 text-sm text-status-blocked">
            {error}
          </p>
        ) : null}
      </Collapse>
      {children}
    </div>
  );
}
