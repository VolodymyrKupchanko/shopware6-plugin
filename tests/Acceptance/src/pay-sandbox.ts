import { expect, type Page } from '@playwright/test';

const PAY_HOST = /pay\.nl|achterelkebetaling\.nl|payments\.nl/i;
const ISSUER_HOST = /ideal\.nl|cloudflare/i;
const ENGLISH_SANDBOX = /^https:\/\/checkout\.pay\.nl\/en-us\/sandbox\/?/i;

function toEnglishSandbox(currentHref: string): string {
    const current = new URL(currentHref);
    const target = new URL('https://checkout.pay.nl/en-us/sandbox/');
    const segments = current.pathname.split('/').filter(Boolean);
    const sandboxAt = segments.findIndex((segment) => segment.toLowerCase() === 'sandbox');
    const extra = sandboxAt >= 0 ? segments.slice(sandboxAt + 1) : [];
    target.pathname = ['/en-us/sandbox', ...extra].join('/') + '/';
    target.search = current.search;
    target.hash = current.hash;
    return target.toString();
}

function sandboxSecret(): string {
    return process.env.PAY_SANDBOX_SECRET || '';
}

function secretField(page: Page) {
    return page.getByPlaceholder(/verkaufsstelle|sales location secret|verkooplocatie|geheimnis|secret/i)
        .or(page.locator('input[name="secret"], input[id="secret"]'))
        .or(page.locator('input[type="password"]:not([name="save-secret"])'))
        .first();
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
    if (!ENGLISH_SANDBOX.test(page.url())) {
        await page.goto(toEnglishSandbox(page.url()), { waitUntil: 'domcontentloaded' });
    }
    await expect(page).toHaveURL(ENGLISH_SANDBOX);
}

async function selectSandboxPaymentMethod(page: Page): Promise<void> {
    await openEnglishSandbox(page);
    if (await secretField(page).isVisible().catch(() => false)) {
        return;
    }

    const sandbox = page.getByRole('link', { name: /sandbox/i })
        .or(page.getByRole('button', { name: /sandbox/i }))
        .or(page.getByText(/^sandbox$/i));
    if (await sandbox.first().isVisible({ timeout: 4000 }).catch(() => false)) {
        await sandbox.first().click();
        await openEnglishSandbox(page);
    }
}

async function fillSandboxForm(page: Page, amount: string): Promise<void> {
    const secret = sandboxSecret();
    expect(
        secret,
        'PAY_SANDBOX_SECRET must be the sales-location secret from my.pay.nl (Settings → Sales location), not the API token.',
    ).not.toEqual('');

    await leaveIssuerChallenge(page);
    await selectSandboxPaymentMethod(page);
    await leaveIssuerChallenge(page);

    const secretInput = secretField(page);
    await expect(
        secretInput,
        'PAY. sandbox secret field was not shown on https://checkout.pay.nl/en-us/sandbox/.',
    ).toBeVisible({ timeout: 30_000 });
    await secretInput.fill(secret);

    const paid = page.getByRole('radio', { name: /captured\s*\/\s*paid/i })
        .or(page.getByText(/captured\s*\/\s*paid/i));
    await expect(paid.first(), 'Captured/Paid was not shown on the PAY. sandbox').toBeVisible();
    await paid.first().click();

    const amountInput = page.getByPlaceholder(/amount|betrag|bedrag/i)
        .or(page.getByLabel(/amount|betrag|bedrag/i))
        .or(page.locator('input[name*="amount" i], input[id*="amount" i]'))
        .first();
    if (await amountInput.isVisible().catch(() => false)) {
        await amountInput.fill(amount);
    }

    const updateButton = page.getByRole('button', {
        name: /update status|status aktualisieren|status bijwerken|status updaten/i,
    }).first();
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
