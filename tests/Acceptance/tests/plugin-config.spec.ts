import { expect, test } from '@shopware-ag/acceptance-test-suite';
import type { Browser, Page, Response } from '@playwright/test';

const SUCCESS_TEXT = /correct credentials|link erfolgreich|koppeling geslaagd|paynlValidation\.messages\.correctCredentials/i;

async function step<T>(page: Page, title: string, body: () => Promise<T>): Promise<T> {
    return test.step(title, async () => {
        try {
            return await body();
        } catch (error) {
            const image = await page.screenshot({ fullPage: true, timeout: 5_000 }).catch(() => null);
            if (image) {
                await test.info().attach(title, { body: image, contentType: 'image/png' });
            }
            throw error;
        }
    });
}

function payCredentials(): { tokenCode: string; apiToken: string; serviceId: string } {
    const tokenCode = process.env.PAY_TOKEN_CODE || '';
    const apiToken = process.env.PAY_API_TOKEN || '';
    const serviceId = process.env.PAY_SERVICE_ID || '';
    expect(tokenCode && apiToken && serviceId, 'PAY_TOKEN_CODE, PAY_API_TOKEN and PAY_SERVICE_ID must be set').toBeTruthy();
    return { tokenCode, apiToken, serviceId };
}

function configInput(page: Page, name: string, label: string) {
    return page.locator(`input[name="${name}"], input[aria-label*="${label}"]`).first();
}

function adminBaseUrl(): string {
    if (process.env.ADMIN_URL) {
        return process.env.ADMIN_URL.endsWith('/') ? process.env.ADMIN_URL : `${process.env.ADMIN_URL}/`;
    }

    const appUrl = process.env.APP_URL || '';
    expect(appUrl, 'APP_URL must be set').toBeTruthy();
    return `${appUrl.replace(/\/$/, '')}/admin/`;
}

async function openAdmin(browser: Browser): Promise<Page> {
    const context = await browser.newContext({
        baseURL: adminBaseUrl(),
        ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    await context.addInitScript(() => {
        const style = document.createElement('style');
        style.textContent = '.sf-toolbar, .sf-toolbar-block { display: none !important; }';
        document.documentElement.appendChild(style);
    });

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

    return page;
}

test.describe('PAY. plugin config', () => {
    test('Test API Keys connects with the sales location', async ({ browser }) => {
        const credentials = payCredentials();
        const adminPage = await openAdmin(browser);

        try {
            await step(adminPage, 'Open the PAY. configuration screen', async () => {
                await adminPage.goto('./#/sw/extension/config/PaynlPaymentShopware6');
                await expect(adminPage).toHaveURL(/extension\/config\/PaynlPaymentShopware6/);
                await expect(configInput(adminPage, 'PaynlPaymentShopware6.config.tokenCode', 'Token-Code')).toBeVisible({
                    timeout: 60_000,
                });
            });

            await step(adminPage, 'Fill Token-Code, API-token and Service-ID', async () => {
                await configInput(adminPage, 'PaynlPaymentShopware6.config.tokenCode', 'Token-Code').fill(credentials.tokenCode);
                await configInput(adminPage, 'PaynlPaymentShopware6.config.apiToken', 'API-token').fill(credentials.apiToken);
                await configInput(adminPage, 'PaynlPaymentShopware6.config.serviceId', 'Service-ID').fill(credentials.serviceId);
            });

            const connection = await step(adminPage, 'Click Test API Keys', async () => {
                const responsePromise = adminPage.waitForResponse(
                    (response) => response.url().includes('/paynl/test-api-keys') && response.request().method() === 'POST',
                    { timeout: 60_000 },
                );
                await adminPage.getByRole('button', { name: /test api keys|api-schlüssel testen|test api sleutel/i }).click();
                return responsePromise;
            });

            await step(adminPage, 'Confirm the connection succeeded', async () => {
                const payload = await readConnectionResponse(connection);
                expect(payload.success, payload.message || 'Test API Keys did not return a successful response').toBe(true);
                expect(payload.message).toBe('paynlValidation.messages.correctCredentials');

                const notifications = adminPage.locator('.sw-notifications');
                await expect(notifications).toBeVisible();
                await expect(notifications).toContainText(SUCCESS_TEXT);
            });
        } finally {
            await adminPage.context().close();
        }
    });
});

async function readConnectionResponse(response: Response): Promise<{ success?: boolean; message?: string }> {
    const body = await response.text();
    expect(response.ok(), `Test API Keys failed: ${response.status()} ${body}`).toBeTruthy();
    return JSON.parse(body) as { success?: boolean; message?: string };
}
