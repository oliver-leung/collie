import { render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { server } from "@/test/setup";
import { useAutoUpdate } from "@/hooks/use-auto-update";
import { useUpdateScreen } from "@/hooks/use-update-screen";
import { asJsonString, parseJsonObject, type JsonObject } from "@/lib/json";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { __resetReloadGuard } from "@/lib/reload-guard";
import { useOptionalRootData } from "@/lib/route-data";
import type { DeviceAuth, ServerSummary, UpdateAutoView, UpdateInfo, UpdateRun } from "@/lib/types";
import { __resetUpdateAsk } from "@/lib/update-ask";
import { clearUpdateStarted } from "@/lib/update-ribbon";
import { __resetUpdateRunStore } from "@/lib/update-run-store";
import { AutoUpdateControl } from "./auto-update-card";
import { CrewProvider } from "./crew-provider";
import { UpdateScreen } from "./update-screen";

function info(over: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    current: "1.29.0",
    latest: "1.29.0",
    latestUrl: null,
    releaseAvailable: false,
    majorAvailable: null,
    majorUrl: null,
    bridgeStale: false,
    checkedAt: 1_700_000_000_000,
    ...over,
  };
}

function view(over: Partial<UpdateAutoView> = {}): UpdateAutoView {
  return {
    mode: "off",
    at: "04:00",
    zone: "",
    pinned: { mode: null, at: null },
    setting: { mode: "off", at: "04:00", changedAt: null },
    target: null,
    nextAt: null,
    windowEndsAt: null,
    paused: [],
    ...over,
  };
}

function homeData(update: UpdateInfo, device: DeviceAuth | undefined): HomeData {
  return {
    bridge: "connected",
    device,
    agents: [],
    shellPanes: [],
    workspaces: [],
    tabs: [],
    sessions: [],
    servers: [],
    ts: 0,
    scope: {},
    viewAll: false,
    snoozedUntil: null,
    update,
    error: false,
    authError: false,
  };
}

function Harness() {
  const auto = useAutoUpdate(useOptionalRootData()?.update);
  return <AutoUpdateControl load={auto.load} onSaved={auto.saved} />;
}

function ModeHost() {
  const mode = useUpdateScreen();
  return <UpdateScreen screen={mode} onOpenUpdates={() => {}} onStarted={() => {}} />;
}

interface Mount {
  readonly read: UpdateAutoView | "missing";
  readonly update?: UpdateInfo;
  readonly run?: UpdateRun;
  readonly device?: DeviceAuth;
  readonly servers?: ServerSummary[];
}

function mount({ read, update = info(), run, device, servers }: Mount) {
  server.use(
    http.get("/api/update/check", () => HttpResponse.json({ ...update, run, preflight: null })),
    http.get("/api/update/auto", () => (read === "missing" ? HttpResponse.text("not found", { status: 404 }) : HttpResponse.json(read))),
  );
  const element =
    servers === undefined ? (
      <Harness />
    ) : (
      <CrewProvider servers={servers}>
        <Harness />
      </CrewProvider>
    );
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", loader: () => homeData(update, device), element }], {
    initialEntries: ["/"],
  });
  const rendered = render(
    <>
      <RouterProvider router={router} />
      <ModeHost />
    </>,
  );
  return { ...rendered, card: () => findCard(rendered.container) };
}

function findCard(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const card = container.querySelector<HTMLElement>('[data-slot="auto-update"]');
    if (card === null) throw new Error("no Automatic updates card");
    return card;
  });
}

function statusLine(card: HTMLElement): HTMLElement {
  return within(card).getByRole("status");
}

function servePost(answer: (body: JsonObject) => Response): JsonObject[] {
  const bodies: JsonObject[] = [];
  server.use(
    http.post("/api/update/auto", async ({ request }) => {
      const body = parseJsonObject(await request.text()) ?? {};
      bodies.push(body);
      return answer(body);
    }),
  );
  return bodies;
}

beforeEach(() => {
  __resetReloadGuard();
  __resetUpdateAsk();
  clearUpdateStarted();
  __resetUpdateRunStore();
});

afterEach(() => {
  __resetUpdateRunStore();
});

describe("Automatic updates card", () => {
  it("reads the setting and says it", async () => {
    const { card } = mount({ read: view() });
    const found = await card();
    await waitFor(() => expect(statusLine(found)).toHaveTextContent("Off. Updates wait for you to start them."));
    expect(within(found).getByRole("radio", { name: "Off" })).toBeChecked();
    expect(within(found).getByText("No automatic update has run on this machine yet.")).toBeInTheDocument();
    expect(within(found).getByText("This setting changes this machine only.")).toBeInTheDocument();
  });

  it("a tap on Daily posts the mode, the shown time and a request id, and shows the receipt", async () => {
    const user = userEvent.setup();
    const bodies = servePost((body) =>
      HttpResponse.json({
        ok: true,
        ...view({ mode: "daily", setting: { mode: "daily", at: "04:00", changedAt: 1 }, nextAt: 2, windowEndsAt: 3 }),
        requestId: asJsonString(body.requestId) ?? "",
      }),
    );
    const { card } = mount({ read: view() });
    const found = await card();
    await waitFor(() => expect(within(found).getByRole("radio", { name: "Daily" })).toBeEnabled());
    await user.click(within(found).getByRole("radio", { name: "Daily" }));
    await waitFor(() => expect(statusLine(found)).toHaveTextContent("Saved. This machine updates itself once a day, from 04:00 on its own clock."));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ mode: "daily", at: "04:00" });
    expect(asJsonString(bodies[0]?.requestId)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(within(found).getByRole("radio", { name: "Daily" })).toBeChecked();
    expect(within(found).getByRole("combobox", { name: "Time on this machine's clock" })).toBeEnabled();
  });

  it("a refusal keeps the old segment, says why, and a retry of the same tap reuses the request id", async () => {
    const user = userEvent.setup();
    const bodies = servePost(() =>
      HttpResponse.json(
        {
          error: "COLLIE_AUTO_UPDATE on this machine sets automatic updates; nothing was changed",
          code: "update.auto_pinned",
          detail: { source: "COLLIE_AUTO_UPDATE" },
        },
        { status: 409 },
      ),
    );
    const { card } = mount({ read: view() });
    const found = await card();
    await waitFor(() => expect(within(found).getByRole("radio", { name: "Daily" })).toBeEnabled());
    await user.click(within(found).getByRole("radio", { name: "Daily" }));
    expect(
      await within(found).findByText(
        "The setting was not changed. COLLIE_AUTO_UPDATE on this machine sets automatic updates. Nothing was changed.",
      ),
    ).toBeInTheDocument();
    expect(within(found).getByRole("radio", { name: "Off" })).toBeChecked();
    expect(statusLine(found).textContent).toBe("");
    await user.click(within(found).getByRole("radio", { name: "Daily" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(asJsonString(bodies[1]?.requestId)).toBe(asJsonString(bodies[0]?.requestId));
  });

  it("a new time is a new request: it posts daily with the picked time", async () => {
    const user = userEvent.setup();
    const bodies = servePost((body) =>
      HttpResponse.json({ ok: true, ...view({ mode: "daily", at: "06:00", setting: { mode: "daily", at: "06:00", changedAt: 2 } }), requestId: asJsonString(body.requestId) ?? "" }),
    );
    const { card } = mount({ read: view({ mode: "daily", setting: { mode: "daily", at: "04:00", changedAt: 1 } }) });
    const found = await card();
    const select = within(found).getByRole("combobox", { name: "Time on this machine's clock" });
    await waitFor(() => expect(select).toBeEnabled());
    await user.selectOptions(select, "06:00");
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ mode: "daily", at: "06:00" });
    await waitFor(() => expect(select).toHaveValue("06:00"));
  });

  it("a mode set on the machine disables every segment and names the switch", async () => {
    const { card } = mount({ read: view({ mode: "daily", pinned: { mode: "env", at: null } }) });
    const found = await card();
    await waitFor(() => expect(statusLine(found)).toHaveTextContent("COLLIE_AUTO_UPDATE on this machine sets this. Change it there and restart Collie."));
    for (const name of ["Off", "Daily", "On release"]) expect(within(found).getByRole("radio", { name })).toBeDisabled();
    expect(within(found).getByRole("combobox")).toBeDisabled();
  });

  it("where automatic updates are not available, Off stays and the other two do not", async () => {
    const { card } = mount({ read: view({ mode: "daily", unavailable: "first_stage" }) });
    const found = await card();
    await waitFor(() =>
      expect(statusLine(found)).toHaveTextContent("This checkout's first staged update has no way back. Take it with the card above."),
    );
    expect(within(found).getByRole("radio", { name: "Off" })).toBeEnabled();
    expect(within(found).getByRole("radio", { name: "Daily" })).toBeDisabled();
    expect(within(found).getByRole("radio", { name: "On release" })).toBeDisabled();
  });

  it("a device that may only read can look and not change", async () => {
    const { card } = mount({ read: view(), device: { enforced: true, device: "tablet", authorized: false } });
    const found = await card();
    await waitFor(() => expect(statusLine(found)).toHaveTextContent("This device can look but not change host settings."));
    for (const name of ["Off", "Daily", "On release"]) expect(within(found).getByRole("radio", { name })).toBeDisabled();
  });

  it("an update in flight disables the choice", async () => {
    const run: UpdateRun = { schema: 2, state: "staging", from: "1.29.0", to: "1.30.0", startedAt: 1, updatedAt: Date.now(), pid: 4, attempt: 0, runId: "r-1" };
    const { card } = mount({ read: view(), run });
    const found = await card();
    await waitFor(() => expect(statusLine(found)).toHaveTextContent("Off. Updates wait for you to start them."));
    await waitFor(() => expect(within(found).getByRole("radio", { name: "Daily" })).toBeDisabled());
    expect(within(found).getByRole("radio", { name: "Off" })).toBeDisabled();
    expect(within(found).getByRole("radio", { name: "On release" })).toBeDisabled();
  });

  it("a bridge from before the route says to update it once", async () => {
    const { card } = mount({ read: "missing" });
    const found = await card();
    await waitFor(() =>
      expect(statusLine(found)).toHaveTextContent("This machine runs a Collie from before automatic updates. Update it once above."),
    );
    expect(within(found).getByRole("radio", { name: "Off" })).toBeChecked();
    expect(within(found).getByRole("radio", { name: "Off" })).toBeDisabled();
  });

  it("a lead with members says it never updates them, by name", async () => {
    const servers: ServerSummary[] = [
      { id: "desk", name: "desk", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 1 },
      { id: "minibuch", name: "minibuch", isLead: false, reachable: true, protocol: "ok", lastSeenAt: 1 },
      { id: "cellar", name: "cellar", isLead: false, reachable: true, protocol: "ok", lastSeenAt: 1 },
    ];
    const { card } = mount({ read: view(), servers });
    const found = await card();
    expect(
      await within(found).findByText(
        "It never updates the members. After an automatic update, Retry crew update above levels them: minibuch, cellar.",
      ),
    ).toBeInTheDocument();
  });

  it("a solo machine draws no members line", async () => {
    const { card } = mount({ read: view() });
    const found = await card();
    await waitFor(() => expect(statusLine(found)).toHaveTextContent("Off. Updates wait for you to start them."));
    expect(found.querySelector('[data-slot="auto-update-members"]')).toBeNull();
  });
});
