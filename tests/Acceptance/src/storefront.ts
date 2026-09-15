import type { Page } from '@playwright/test';

export async function acceptCookies(page: Page): Promise<void> {
    const button = page.getByRole('button', { name: /accept all cookies|alle cookies accepteren|alle cookies akzeptieren/i }).first();
    if (await button.isVisible({ timeout: 4000 }).catch(() => false)) {
        await button.click();
    }
}

export async function enableGuestCheckout(page: Page): Promise<boolean> {
    const createAccount = page.getByRole('checkbox', { name: /create a customer account/i });
    if (await createAccount.isVisible({ timeout: 3000 }).catch(() => false)) {
        if (await createAccount.isChecked()) {
            await createAccount.uncheck({ force: true });
        }
        await page.locator('#personalPassword, input[name="password"]').first()
            .waitFor({ state: 'hidden', timeout: 5000 })
            .catch(() => undefined);
        return true;
    }

    const guest = page.locator('#personalGuest, input[name="guest"]').first();
    if (await guest.isVisible({ timeout: 1000 }).catch(() => false)) {
        await guest.check({ force: true });
        return true;
    }

    return false;
}

export async function isPasswordRequired(page: Page): Promise<boolean> {
    const password = page.locator('#personalPassword, input[name="password"]').first();
    return password.isVisible({ timeout: 1000 }).catch(() => false);
}

export async function hideProfiler(page: Page): Promise<void> {
    await page.addStyleTag({
        content: '.sf-toolbar, .sf-toolbar-block { display: none !important; }',
    }).catch(() => undefined);
}
