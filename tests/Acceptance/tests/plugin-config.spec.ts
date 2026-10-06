import { expect, test } from '@shopware-ag/acceptance-test-suite';
import type { Page, Response } from '@playwright/test';
import { dismissAdminPopups, openAdmin } from '../src/admin-popups';

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

test.describe('PAY. plugin config', () => {
    test('Test API Keys connects with the sales location', async ({ browser }) => {
        const credentials = payCredentials();
        const adminPage = await openAdmin(browser);

        try {
            await step(adminPage, 'Open the PAY. configuration screen', async () => {
                await dismissAdminPopups(adminPage);
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
                await dismissAdminPopups(adminPage);
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
