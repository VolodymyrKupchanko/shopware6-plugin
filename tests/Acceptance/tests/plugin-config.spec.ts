import { expect, test } from '@shopware-ag/acceptance-test-suite';
import type { Page, Response } from '@playwright/test';

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
    test('Test API Keys connects with the sales location', async ({ AdminPage }) => {
        const credentials = payCredentials();

        await step(AdminPage, 'Open the PAY. configuration screen', async () => {
            await AdminPage.addStyleTag({
                content: '.sf-toolbar, .sf-toolbar-block { display: none !important; }',
            }).catch(() => undefined);
            await AdminPage.goto('./#/sw/extension/config/PaynlPaymentShopware6');
            await expect(AdminPage).toHaveURL(/extension\/config\/PaynlPaymentShopware6/);
            await expect(configInput(AdminPage, 'PaynlPaymentShopware6.config.tokenCode', 'Token-Code')).toBeVisible();
        });

        await step(AdminPage, 'Fill Token-Code, API-token and Service-ID', async () => {
            await configInput(AdminPage, 'PaynlPaymentShopware6.config.tokenCode', 'Token-Code').fill(credentials.tokenCode);
            await configInput(AdminPage, 'PaynlPaymentShopware6.config.apiToken', 'API-token').fill(credentials.apiToken);
            await configInput(AdminPage, 'PaynlPaymentShopware6.config.serviceId', 'Service-ID').fill(credentials.serviceId);
        });

        const connection = await step(AdminPage, 'Click Test API Keys', async () => {
            const responsePromise = AdminPage.waitForResponse(
                (response) => response.url().includes('/paynl/test-api-keys') && response.request().method() === 'POST',
                { timeout: 60_000 },
            );
            await AdminPage.getByRole('button', { name: /test api keys|api-schlüssel testen|test api sleutel/i }).click();
            return responsePromise;
        });

        await step(AdminPage, 'Confirm the connection succeeded', async () => {
            const payload = await readConnectionResponse(connection);
            expect(payload.success, payload.message || 'Test API Keys did not return a successful response').toBe(true);
            expect(payload.message).toBe('paynlValidation.messages.correctCredentials');

            const notifications = AdminPage.locator('.sw-notifications');
            await expect(notifications).toBeVisible();
            await expect(notifications).toContainText(SUCCESS_TEXT);
        });
    });
});

async function readConnectionResponse(response: Response): Promise<{ success?: boolean; message?: string }> {
    const body = await response.text();
    expect(response.ok(), `Test API Keys failed: ${response.status()} ${body}`).toBeTruthy();
    return JSON.parse(body) as { success?: boolean; message?: string };
}
