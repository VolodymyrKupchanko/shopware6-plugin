import type { Page } from '@playwright/test';

const NOTIFICATION_CLOSE = '.sw-alert__close, .sw-notification__close, .mt-banner__close, .sw-modal__close';

export async function dismissAdminPopups(page: Page): Promise<void> {
    await hideProfiler(page);
    await page.locator('.sw-modal, .sw-alert').first()
        .waitFor({ state: 'visible', timeout: 2_000 })
        .catch(() => undefined);

    for (let attempt = 0; attempt < 10; attempt += 1) {
        if (await dismissShopwareUpdate(page) || await dismissUsageConsent(page)) {
            continue;
        }

        const closeButton = page.locator(NOTIFICATION_CLOSE).locator('visible=true').first();
        if (await closeButton.count() === 0) {
            return;
        }

        await closeButton.click();
    }
}

async function dismissShopwareUpdate(page: Page): Promise<boolean> {
    const updatePopup = page.locator('div').filter({
        hasText: /a new shopware version|eine neue shopware-version/i,
        has: page.getByRole('button', { name: /^(cancel|abbrechen)$/i }),
    }).last();

    if (!await updatePopup.isVisible().catch(() => false)) {
        return false;
    }

    await updatePopup.getByRole('button', { name: /^(cancel|abbrechen)$/i }).click();
    await updatePopup.waitFor({ state: 'hidden' });
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
    await page.getByRole('button', {
        name: /^(reject all|alle ablehnen|decline|ablehnen)$/i,
    }).click();
    await consentHeading.waitFor({ state: 'hidden' });
    return true;
}

async function hideProfiler(page: Page): Promise<void> {
    await page.evaluate(() => {
        document.querySelectorAll('.sf-toolbar, .sf-minitoolbar, .sf-toolbar-block').forEach((element) => {
            element.remove();
        });
    }).catch(() => undefined);
}
