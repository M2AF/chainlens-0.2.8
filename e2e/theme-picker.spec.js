const { test, expect } = require('@playwright/test');

/**
 * The theme picker, and the gate in front of it.
 *
 * These run against the static server (e2e/static-server.js), so every /api call
 * is mocked here. The one that matters is /api/profile/themes: it answers both
 * "may this account use themes" and "which ones has MagicMoney synced", and the
 * picker is drawn entirely from that reply.
 */

const ME = {
  id: 'ec18dcf5-3271-46fd-8029-41e5b2f39eed',
  display_name: 'criptoejesus',
  avatar_url: null,
  provider: 'google',
  cl_wallets: [{ id: 'wallet-1', chain: 'evm', address: '0x01faf6dfc230d755141d84d7cb980dd68f5efe13', watch_only: false }],
  cl_linked_accounts: [{ id: 'social-1', provider: 'google', display_name: 'criptoejesus' }],
};

/** Crimson, from the wallet's shipped set — the theme these tests wear. */
const CRIMSON_PAGE = 'rgb(24, 6, 10)';
/** Stock Tailwind slate-50 / slate-950: the app with no theme on it. */
const STOCK_LIGHT_PAGE = 'rgb(248, 250, 252)';
const STOCK_DARK_PAGE = 'rgb(2, 6, 23)';

const SYNCED = {
  // A theme built in the wallet…
  'custom-cherry': { n: 'Cherry', c: { bg: '#2a0512', accent: '#ff2d6f', text: '#ffe3ee' }, t: 1755000000000 },
  // …and one deleted there. A tombstone is not an absence, so it arrives in the
  // payload and must not reach the picker.
  'custom-retired': { n: '', c: { bg: '', accent: '', text: '' }, t: 1755000001000, d: 1 },
};

async function installThemeMocks(page, { themes = null, signedIn = true } = {}) {
  if (signedIn) {
    await page.addInitScript(() => localStorage.setItem('cl_token', 'playwright-theme-token'));
  }
  await page.route('**/api/profile', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(ME),
  }));
  await page.route('**/api/profile/filters', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ entries: {} }),
  }));
  await page.route('**/api/profile/themes', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(themes || { eligible: false, walletLinked: false, socialLinked: false, entries: {} }),
  }));
  await page.route('**/api/chat/**', route => route.fulfill({
    status: 200, contentType: 'application/json', body: '{}',
  }));
}

const ELIGIBLE = { eligible: true, walletLinked: true, socialLinked: true, entries: SYNCED };

/** The app shell, whose background is the page colour a theme sets. */
const shell = (page) => page.locator('#root > div').first();

test('signed out, the control is still the Light/Dark switch', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await installThemeMocks(page, { signedIn: false });
  await page.goto('/');

  await expect(page.getByTestId('theme-toggle')).toBeVisible();
  await expect(page.getByTestId('theme-picker')).toHaveCount(0);
  await expect(shell(page)).toHaveCSS('background-color', STOCK_LIGHT_PAGE);

  await page.getByRole('switch', { name: 'Dark mode' }).click();
  await expect(shell(page)).toHaveCSS('background-color', STOCK_DARK_PAGE);
  expect(pageErrors).toEqual([]);
});

test('signed in without chat access, the themes stay locked away', async ({ page }) => {
  // Same rule as chat: a verified wallet AND a Google or Discord login. The
  // server says no, and the client must not draw the picker anyway.
  await installThemeMocks(page, {
    themes: { eligible: false, walletLinked: true, socialLinked: false, entries: SYNCED },
  });
  await page.goto('/');

  await expect(page.getByTestId('theme-toggle')).toBeVisible();
  await expect(page.getByTestId('theme-picker')).toHaveCount(0);
});

test('an eligible account gets the twelve shipped themes and its own synced ones', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await installThemeMocks(page, { themes: ELIGIBLE });
  await page.goto('/');

  await page.getByTestId('theme-picker-button').click();
  const menu = page.getByTestId('theme-menu');
  await expect(menu).toBeVisible();

  // Light and Dark, the twelve, and Cherry.
  await expect(menu.locator('[data-testid^="theme-option-"]')).toHaveCount(15);
  await expect(page.getByTestId('theme-option-moonlight')).toBeVisible();
  await expect(page.getByTestId('theme-option-sappy-seals')).toBeVisible();
  await expect(page.getByTestId('theme-option-custom-cherry')).toBeVisible();
  // Deleted in the wallet: the tombstone travels, the theme does not.
  await expect(page.getByTestId('theme-option-custom-retired')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('choosing a theme repaints the app and outlives a reload', async ({ page }) => {
  await installThemeMocks(page, { themes: ELIGIBLE });
  await page.goto('/');

  await page.getByTestId('theme-picker-button').click();
  await page.getByTestId('theme-option-crimson').click();

  await expect(page.getByTestId('theme-menu')).toHaveCount(0);
  await expect(shell(page)).toHaveCSS('background-color', CRIMSON_PAGE);
  await expect(page.getByTestId('theme-picker-button')).toContainText('Crimson');
  // A light theme would leave the dark utility classes rendering the light
  // branch, so the tone has to be stamped as well as the colours.
  await expect(page.locator('html')).toHaveAttribute('data-cl-tone', 'dark');

  await page.reload();
  await expect(shell(page)).toHaveCSS('background-color', CRIMSON_PAGE);
});

test('a synced theme renders from the colours the wallet wrote', async ({ page }) => {
  await installThemeMocks(page, { themes: ELIGIBLE });
  await page.goto('/');

  await page.getByTestId('theme-picker-button').click();
  await page.getByTestId('theme-option-custom-cherry').click();

  await expect(shell(page)).toHaveCSS('background-color', 'rgb(42, 5, 18)');
  await expect(page.getByTestId('theme-picker-button')).toContainText('Cherry');
});

test('losing access falls back to the tone the user was looking at', async ({ page }) => {
  await installThemeMocks(page, { themes: ELIGIBLE });
  await page.goto('/');
  await page.getByTestId('theme-picker-button').click();
  await page.getByTestId('theme-option-crimson').click();
  await expect(shell(page)).toHaveCSS('background-color', CRIMSON_PAGE);

  // The account stops qualifying — a wallet removed, or simply signed out. The
  // stored choice is still Crimson, but nothing may render it, and dropping the
  // user onto a white page would be the jarring answer.
  await page.unroute('**/api/profile/themes');
  await page.route('**/api/profile/themes', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ eligible: false, walletLinked: true, socialLinked: false, entries: {} }),
  }));
  await page.reload();

  await expect(page.getByTestId('theme-toggle')).toBeVisible();
  await expect(shell(page)).toHaveCSS('background-color', STOCK_DARK_PAGE);
});
