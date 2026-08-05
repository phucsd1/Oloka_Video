import { expect, test } from "@playwright/test";

test("home displays live foundation status", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "A dependable start for every frame." }),
  ).toBeVisible();
  await expect(page.getByText("Connected")).toBeVisible();
  await expect(page.getByText("API online")).toBeVisible();
  await expect(page.locator("code", { hasText: "playwright" })).toBeVisible();
});
