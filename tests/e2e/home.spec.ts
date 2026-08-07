import { expect, test } from "@playwright/test";

test("home displays the closed-beta Google entry", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", {
      name: "Build dependable video, one approved account at a time.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Continue with Google" }),
  ).toHaveAttribute("href", "/api/v1/auth/google/start");
  await expect(page.getByText("Closed beta", { exact: true })).toBeVisible();
});
