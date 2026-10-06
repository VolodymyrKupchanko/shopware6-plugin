import { expect, type Browser, type Locator, type Page } from '@playwright/test';

const NOTIFICATION_CLOSE = '.sw-alert__close, .sw-notification__close, .mt-banner__close, .sw-modal__close';

export async function dismissAdminPopups(page: Page): Promise<void> {
    await hideProfiler(page);

    for (let attempt = 0; attempt < 10; attempt += 1) {
        if (await dismissShopwareUpdate(page) || await dismissUsageConsent(page)) {
            continue;
        }

        const closeButton = page.locator(NOTIFICATION_CLOSE).locator('visible=true').first();
        if (!await closeButton.isVisible().catch(() => false)) {
            return;
        }

        // Dashboard banners animate while statistics load, so a normal click waits out actionTimeout.
        await closeButton.click({ force: true, timeout: 2_000 }).catch(() => undefined);
        if (await closeButton.isVisible().catch(() => false)) {
            await removeBanner(closeButton);
        }
    }
}

export async function openAdmin(browser: Browser): Promise<Page> {
    const context = await browser.newContext({
        baseURL: adminBaseUrl(),
        ignoreHTTPSErrors: true,
    });
    await context.addInitScript(() => {
        const hideProfiler = (): void => {
            document.querySelectorAll('.sf-toolbar, .sf-minitoolbar, .sf-toolbar-block').forEach((element) => {
                element.remove();
            });
        };
        hideProfiler();
        new MutationObserver(hideProfiler).observe(document.documentElement, { childList: true, subtree: true });
    });
    const page = await context.newPage();

    const username = process.env.SHOPWARE_ADMIN_USERNAME || 'admin';
    const password = process.env.SHOPWARE_ADMIN_PASSWORD || 'shopware';
    await page.goto('./#/login', { waitUntil: 'domcontentloaded' });

    const usernameField = page.getByRole('textbox', { name: /username|email address|benutzername|e-mailadresse|gebruikersnaam/i });
    await expect(usernameField).toBeVisible({ timeout: 60_000 });
    await usernameField.fill(username);
    await page.getByRole('textbox', { name: /^(password|passwort|wachtwoord)$/i }).fill(password);
    const loginButton = page.getByRole('button', { name: /^(log in|anmelden|inloggen)$/i });
    await expect(loginButton).toBeEnabled();
    await loginButton.click();
    await page.waitForURL((url) => {
        const hash = url.hash.toLowerCase();
        return hash.startsWith('#/') && !hash.includes('login');
    }, { timeout: 60_000 });
    await dismissAdminPopups(page);

    return page;
}

function adminBaseUrl(): string {
    if (process.env.ADMIN_URL) {
        return process.env.ADMIN_URL.endsWith('/') ? process.env.ADMIN_URL : `${process.env.ADMIN_URL}/`;
    }

    const appUrl = process.env.APP_URL || '';
    expect(appUrl, 'APP_URL must be set').toBeTruthy();
    return `${appUrl.replace(/\/$/, '')}/admin/`;
}

async function dismissShopwareUpdate(page: Page): Promise<boolean> {
    const updatePopup = page.locator('div').filter({
        hasText: /a new shopware version|eine neue shopware-version/i,
        has: page.getByRole('button', { name: /^(cancel|abbrechen)$/i }),
    }).last();

    if (!await updatePopup.isVisible().catch(() => false)) {
        return false;
    }

    const cancel = updatePopup.getByRole('button', { name: /^(cancel|abbrechen)$/i });
    await cancel.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    await updatePopup.waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => undefined);
    if (await updatePopup.isVisible().catch(() => false)) {
        await removeBanner(cancel);
    }
    return true;
}

async function dismissUsageConsent(page: Page): Promise<boolean> {
    const consentHeading = page.getByRole('heading', {
        name: /help us to improve shopware|hilf uns dabei, shopware zu verbessern/i,
    });

    if (!await consentHeading.isVisible().catch(() => false)) {
        return false;
    }

    await hideProfiler(page);
    const reject = page.getByRole('button', {
        name: /^(reject all|alle ablehnen|decline|ablehnen)$/i,
    });
    await reject.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    await consentHeading.waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => undefined);
    return true;
}

async function removeBanner(control: Locator): Promise<void> {
    await control.evaluate((element) => {
        element.closest('.mt-banner, .sw-alert, .sw-modal, .sw-notification')?.remove();
    }).catch(() => undefined);
}

async function hideProfiler(page: Page): Promise<void> {
    await page.evaluate(() => {
        document.querySelectorAll('.sf-toolbar, .sf-minitoolbar, .sf-toolbar-block').forEach((element) => {
            element.remove();
        });
    }).catch(() => undefined);
}
