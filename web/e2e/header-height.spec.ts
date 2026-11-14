import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import type { UpdateInfo } from "@/lib/types";
import { fixtureSnapshot } from "@/test/handlers";

import { fill, installApiStub, pinLocale } from "./fixtures/api";
import { keepPhoneLayout } from "./fixtures/layout";

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }) => {
  await pinLocale(page, "en");
  await installApiStub(page);
  await keepPhoneLayout(page);
});

const PANE = `/pane/${encodeURIComponent("w1:p1")}`;

interface HeaderRoute {
  readonly path: string;
  readonly controls: readonly string[];
}

const ROUTES: readonly HeaderRoute[] = [
  { path: "/", controls: [en["nav.home.aria.default"], en["nav.settings.aria"]] },
  { path: "/space/w2", controls: [en["nav.home.aria.default"], en["nav.settings.aria"]] },
  { path: PANE, controls: [en["nav.home.aria.default"], en["chat.paneMenu.aria"]] },
  { path: "/settings", controls: [en["settings.nav.back"]] },
  { path: `${PANE}/changes`, controls: [en["changes.backAria.pane"], en["changes.filter.button"], en["changes.refreshAria"]] },
];

async function boxOf(target: Locator) {
  await expect(target).toBeVisible();
  return (await target.boundingBox())!;
}

const OFFERED = "1.12.0";

const OFFER: UpdateInfo = {
  current: "1.11.0",
  latest: OFFERED,
  latestUrl: null,
  releaseAvailable: true,
  majorAvailable: null,
  majorUrl: null,
  bridgeStale: false,
  checkedAt: Date.now(),
};

async function offerAnUpdate(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/snapshot",
    (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...fixtureSnapshot, update: OFFER }) }),
  );
}

async function hits(target: Locator, x: number, y: number): Promise<boolean> {
  return target.evaluate((el, [px, py]) => document.elementFromPoint(px, py)?.closest("button, a") === el, [x, y] as const);
}

async function openHeader(page: Page, route: HeaderRoute) {
  await page.goto(route.path);
  const banner = page.getByRole("banner");
  const controls = await Promise.all(route.controls.map((name) => boxOf(banner.getByRole("button", { name, exact: true }))));
  return { row: await boxOf(page.locator('[data-slot="header-row"]')), header: await boxOf(banner), controls };
}

test("the header row is 52px on every screen, and the banner ends on its 1px rule", async ({ page }) => {
  const heights: number[] = [];
  for (const route of ROUTES) {
    const { row, header } = await openHeader(page, route);
    expect(row.height, route.path).toBeCloseTo(52, 1);
    expect(header.y + header.height, route.path).toBeCloseTo(row.y + row.height + 1, 1);
    heights.push(row.height);
  }
  expect(heights.filter((height) => height !== heights[0])).toEqual([]);
});

test("every control in the header row is a 44px box that stays inside the row", async ({ page }) => {
  for (const route of ROUTES) {
    const { row, controls } = await openHeader(page, route);
    controls.forEach((box, i) => {
      const at = `${route.controls[i] ?? ""} on ${route.path}`;
      expect(box.width, at).toBeGreaterThanOrEqual(44);
      expect(box.height, at).toBeGreaterThanOrEqual(44);
      expect(box.y, at).toBeGreaterThanOrEqual(row.y);
      expect(box.y + box.height, at).toBeLessThanOrEqual(row.y + row.height);
    });
  }
});

test("a strip in the band takes no tap from a header control, and answers 44px from its own top edge down", async ({ page }) => {
  await offerAnUpdate(page);
  for (const route of ROUTES) {
    await page.goto(route.path);
    const strip = page.locator('[data-slot="strip-anchor"] [data-slot="notice"]');
    const band = await boxOf(strip);
    const dismiss = strip.getByRole("button", { name: en["updateRibbon.dismiss"], exact: true });
    const whole = strip.getByRole("button", { name: fill(en["updateRibbon.available"], { version: OFFERED }), exact: true });
    for (const [target, x] of [[dismiss, (await boxOf(dismiss)).x + 12], [whole, band.x + 8]] as const) {
      await expect.poll(() => hits(target, x, band.y + band.height + 10), route.path).toBe(true);
      expect(await hits(target, x, band.y + 1), route.path).toBe(true);
      expect(await hits(target, x, band.y - 1), route.path).toBe(false);
    }
    for (const control of await page.getByRole("banner").getByRole("button").all()) {
      const box = await control.boundingBox();
      if (box === null || box.height < 44) continue;
      const at = `${(await control.getAttribute("aria-label")) ?? ""} on ${route.path}`;
      expect(await hits(control, box.x + box.width / 2, box.y + box.height - 1), at).toBe(true);
    }
  }
});
