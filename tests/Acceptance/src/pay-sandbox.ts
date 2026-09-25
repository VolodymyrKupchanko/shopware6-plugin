import { expect, type Page } from '@playwright/test';

const PAY_HOST = /pay\.nl|achterelkebetaling\.nl|payments\.nl/i;
const ISSUER_HOST = /ideal\.nl|cloudflare/i;
const ORDER_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ENGLISH_SANDBOX = /^https:\/\/checkout\.pay\.nl\/en-us\/sandbox\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i;

function englishSandboxUrl(currentHref: string): string {
    const orderId = currentHref.match(ORDER_ID)?.[0];
    if (!orderId) {
        throw new Error(`PAY. checkout URL has no order id for the sandbox: ${currentHref}`);
    }
    return `https://checkout.pay.nl/en-us/sandbox/${orderId}`;
}

function sandboxSecret(): string {
    return process.env.PAY_SANDBOX_SECRET || '';
}

function secretField(page: Page) {
    return page.locator('input#secret');
}

async function isCloudflareChallenge(page: Page): Promise<boolean> {
    return page.getByRole('heading', { name: /performing security verification|verify you are human/i })
        .or(page.getByText(/verify you are human/i))
        .first()
        .isVisible()
        .catch(() => false);
}

async function leaveIssuerChallenge(page: Page): Promise<void> {
    if (!ISSUER_HOST.test(page.url()) && !(await isCloudflareChallenge(page))) {
        return;
    }

    if (page.url() !== 'about:blank') {
        await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    }
}

async function openEnglishSandbox(page: Page): Promise<void> {
    const target = englishSandboxUrl(page.url());
    if (page.url().replace(/\/$/, '') !== target) {
        await page.goto(target, { waitUntil: 'domcontentloaded' });
    }
    await expect(page).toHaveURL(ENGLISH_SANDBOX);
}

async function fillSandboxForm(page: Page, amount: string): Promise<void> {
    const secret = sandboxSecret();
    expect(
        secret,
        'PAY_SANDBOX_SECRET must be the sales-location secret from my.pay.nl (Settings → Sales location), not the API token.',
    ).not.toEqual('');

    await leaveIssuerChallenge(page);
    await openEnglishSandbox(page);

    const secretInput = secretField(page);
    await expect(secretInput, `Secret field #secret was not shown at ${page.url()}`).toBeVisible({ timeout: 30_000 });
    await secretInput.fill(secret);

    const paid = page.locator('input#captured');
    await expect(paid, 'Captured/Paid (#captured) was not shown on the PAY. sandbox').toBeVisible();
    await paid.check();

    const amountInput = page.getByPlaceholder(/amount|betrag|bedrag/i)
        .or(page.getByLabel(/amount|betrag|bedrag/i))
        .or(page.locator('input[name*="amount" i], input[id*="amount" i]'))
        .first();
    if (await amountInput.isVisible().catch(() => false)) {
        await amountInput.fill(amount);
    }

    const updateButton = page.locator('button[type="submit"]', { hasText: 'Update status' });
    await expect(updateButton).toBeVisible();
    await updateButton.click();

    const invalidSecret = page.getByText(/ungültiges geheimnis|invalid secret|ongeldig geheim/i);
    if (await invalidSecret.isVisible({ timeout: 5000 }).catch(() => false)) {
        throw new Error(
            'PAY. rejected the sandbox secret for this sales location. Set PAY_SANDBOX_SECRET to the sales-location secret from my.pay.nl (Settings → Sales location). Do not use PAY_API_TOKEN.',
        );
    }
}

export async function completePaySandbox(page: Page, amount: string): Promise<void> {
    await page.waitForURL(
        (url) => PAY_HOST.test(url.href) && !ISSUER_HOST.test(url.href),
        { timeout: 60_000 },
    );
    await fillSandboxForm(page, amount);

    await page.waitForURL(/checkout\/finish|PaynlPayment\/finalize-transaction/i, { timeout: 60_000 });
}

export function parseAmount(raw: string): { amount: number; currency: string; sandboxAmount: string } {
    const currencyMatch = raw.match(/[€£$]|EUR|GBP|USD/i);
    const currency = currencyMatch?.[0]?.replace('€', 'EUR').replace('£', 'GBP').replace('$', 'USD').toUpperCase() ?? 'EUR';
    const numeric = raw.replace(/[^0-9,.-]/g, '').replace(',', '.');
    return {
        amount: Number.parseFloat(numeric),
        currency: currency === 'EUR' || currency === 'GBP' || currency === 'USD' ? currency : 'EUR',
        sandboxAmount: Number.parseFloat(numeric).toFixed(2),
    };
}
