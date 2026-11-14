import { act, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { COLLAPSE_MS } from "./collapse";
import { SettingCard, SettingStatus } from "./setting-card";

afterEach(() => {
  vi.useRealTimers();
});

function slotted(container: HTMLElement, slot: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
  if (found === null) throw new Error(`no [data-slot="${slot}"]`);
  return found;
}

function headerOf(card: HTMLElement): Element {
  const header = card.firstElementChild;
  if (header === null) throw new Error("the card has no header");
  return header;
}

describe("SettingCard", () => {
  it("draws the icon, the title and the description, then the aside at the header's end", () => {
    const { container } = render(
      <SettingCard
        icon="time"
        title="Automatic updates"
        description="When this machine updates."
        slot="auto-update"
        aside={<button type="button">Toggle</button>}
      />,
    );
    const card = slotted(container, "auto-update");
    const view = within(card);
    expect(view.getByText("Automatic updates")).toBeInTheDocument();
    expect(view.getByText("When this machine updates.")).toBeInTheDocument();
    expect(card.querySelector('[data-icon="time"]')).not.toBeNull();
    const aside = view.getByRole("button", { name: "Toggle" });
    expect(aside.parentElement).toHaveClass("shrink-0");
    expect(aside.parentElement?.previousElementSibling).toHaveClass("min-w-0", "flex-1");
    expect(headerOf(card).lastElementChild).toBe(aside.parentElement);
  });

  it("puts the caller's sections after the header, in order", () => {
    const { container } = render(
      <SettingCard icon="time" title="Title" description="Description" slot="card-under-test">
        <div data-slot="first">One</div>
        <div data-slot="second">Two</div>
      </SettingCard>,
    );
    const parts = Array.from(slotted(container, "card-under-test").children, (child) => child.getAttribute("data-slot"));
    expect(parts).toEqual([null, "first", "second"]);
  });

  it("draws no aside slot when none is handed in", () => {
    const { container } = render(<SettingCard icon="time" title="Title" description="Description" slot="plain" />);
    expect(headerOf(slotted(container, "plain")).children).toHaveLength(2);
  });
});

describe("SettingStatus", () => {
  it("says the text in one role=status line under a rule, reserving one line by default", () => {
    const { container } = render(<SettingStatus text="Off." busy={false} error={null} />);
    const block = slotted(container, "setting-status");
    expect(block).toHaveClass("border-t", "border-border");
    const line = within(block).getByRole("status");
    expect(line).toHaveTextContent("Off.");
    expect(line).toHaveClass("min-h-5");
    expect(line).not.toHaveClass("min-h-10");
  });

  it("reserves two lines when asked to, and takes the caller's id", () => {
    const { container } = render(<SettingStatus text="Off." busy={false} error={null} lines={2} id="status-id" />);
    const line = within(slotted(container, "setting-status")).getByRole("status");
    expect(line).toHaveClass("min-h-10");
    expect(line).not.toHaveClass("min-h-5");
    expect(line).toHaveAttribute("id", "status-id");
  });

  it("draws the spinner only while busy, hidden from the screen reader", () => {
    const { container, rerender } = render(<SettingStatus text="Saving…" busy error={null} />);
    const spinner = within(slotted(container, "setting-status")).getByRole("status").querySelector('[data-icon="busy"]');
    expect(spinner).not.toBeNull();
    expect(spinner).toHaveAttribute("aria-hidden", "true");
    expect(spinner).toHaveClass("animate-spin");
    rerender(<SettingStatus text="Saved." busy={false} error={null} />);
    expect(within(slotted(container, "setting-status")).getByRole("status").querySelector('[data-icon="busy"]')).toBeNull();
  });

  it("brings the failure line in through Collapse and holds it through the exit", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<SettingStatus text="" busy={false} error={null} />);
    expect(slotted(container, "setting-status").querySelector('[data-slot="collapse"]')).toBeNull();
    rerender(<SettingStatus text="" busy={false} error="The setting was not changed." />);
    const collapse = slotted(slotted(container, "setting-status"), "collapse");
    const failure = within(collapse).getByText("The setting was not changed.");
    expect(failure).toHaveClass("text-status-blocked");
    rerender(<SettingStatus text="Saved." busy={false} error={null} />);
    expect(within(slotted(container, "setting-status")).getByText("The setting was not changed.")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(COLLAPSE_MS + 1);
    });
    expect(within(slotted(container, "setting-status")).queryByText("The setting was not changed.")).toBeNull();
  });

  it("puts the caller's lines after the status and the failure line", () => {
    const { container } = render(
      <SettingStatus text="Off." busy={false} error={null}>
        <p>This setting changes this machine only.</p>
      </SettingStatus>,
    );
    const block = slotted(container, "setting-status");
    expect(block.lastElementChild).toHaveTextContent("This setting changes this machine only.");
    expect(block.firstElementChild).toHaveAttribute("role", "status");
  });
});
