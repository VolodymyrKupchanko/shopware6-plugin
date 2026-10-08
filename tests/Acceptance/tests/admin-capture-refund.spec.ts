import { test, expect, type FixtureTypes } from '@shopware-ag/acceptance-test-suite';
import type { Page } from '@playwright/test';
import { captureAuthorizedOrder, refundOrder } from '../src/admin-order';
import { dismissAdminPopups, openAdmin } from '../src/admin-popups';
import { completePaySandbox, parseAmount, type SandboxPaymentStatus } from '../src/pay-sandbox';
import {
    assignPayPaymentMethod,
    ensureStorefrontDomainAliases,
    readPaynlTransactionState,
    setPayPluginConfig,
    waitForOrderPaymentState,
} from '../src/shopware-admin';
import { addProductToCart, enableGuestCheckout, isPasswordRequired, prepareStorefront } from '../src/storefront';

const REFUND_STATUS_CODES = [-72, -81, -82];

type CheckoutFixtures = Pick<
    FixtureTypes,
    | 'StorefrontPage'
    | 'StorefrontProductDetail'
    | 'StorefrontCheckoutConfirm'
    | 'StorefrontCheckoutFinish'
    | 'ProductData'
    | 'DefaultSalesChannel'
    | 'AdminApiContext'
    | 'ShopCustomer'
    | 'Register'
>;

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

async function placePayOrder(
    fixtures: CheckoutFixtures,
    status: SandboxPaymentStatus,
): Promise<{ orderId: string; orderNumber: string | null }> {
    const {
        StorefrontPage,
        StorefrontProductDetail,
        StorefrontCheckoutConfirm,
        StorefrontCheckoutFinish,
        ProductData,
        DefaultSalesChannel,
        AdminApiContext,
        ShopCustomer,
        Register,
    } = fixtures;

    const payMethod = await step(StorefrontPage, 'Assign PAY. payment method', () => assignPayPaymentMethod(
        AdminApiContext,
        DefaultSalesChannel.salesChannel.id,
    ));

    await step(StorefrontPage, 'Open the storefront', async () => {
        await ensureStorefrontDomainAliases(
            AdminApiContext,
            DefaultSalesChannel.url,
            DefaultSalesChannel.salesChannel.id,
        );
        await prepareStorefront(StorefrontPage);
        await StorefrontPage.goto('./', { waitUntil: 'domcontentloaded' });
    });

    await step(StorefrontPage, 'Add the product and go to checkout', async () => {
        await ShopCustomer.goesTo(`detail/${ProductData.id}`);
        await addProductToCart(StorefrontPage);
        await StorefrontProductDetail.offCanvasCartGoToCheckoutButton.click();
        await StorefrontPage.waitForURL(/checkout\/(register|confirm)/);
    });

    await step(StorefrontPage, 'Register as a guest', async () => {
        if (!StorefrontPage.url().includes('/checkout/register')) {
            return;
        }

        await enableGuestCheckout(StorefrontPage);
        const guest = !(await isPasswordRequired(StorefrontPage));
        await ShopCustomer.attemptsTo(Register({ isGuest: guest, password: 'shopware' }));
        await StorefrontPage.waitForURL(/checkout\/confirm/, { timeout: 30_000 });
    });

    const expected = await step(StorefrontPage, 'Choose PAY. and place the order', async () => {
        await expect(StorefrontCheckoutConfirm.headline).toBeVisible();

        const payRadio = StorefrontPage.locator(`input[name="paymentMethodId"][value="${payMethod.id}"]`);
        if (await payRadio.count()) {
            if (!(await payRadio.isChecked())) {
                await payRadio.check({ force: true });
                await StorefrontPage.waitForLoadState('domcontentloaded');
            }
        } else {
            await StorefrontPage.getByText(payMethod.name, { exact: true }).first().click();
        }

        const tos = StorefrontCheckoutConfirm.termsAndConditionsWithLegalGuaranteeRightsCheckbox
            .or(StorefrontCheckoutConfirm.termsAndConditionsCheckbox);
        if (await tos.isVisible().catch(() => false)) {
            await tos.check();
        }

        const totalText = (await StorefrontCheckoutConfirm.grandTotalPrice.textContent()) ?? '€ 10.00';
        const parsed = parseAmount(totalText);
        expect(parsed.amount, `Could not parse checkout total from "${totalText}"`).toBeGreaterThan(0);

        await StorefrontCheckoutConfirm.submitOrderButton.click();
        return parsed;
    });

    await step(StorefrontPage, `Complete the PAY. sandbox as ${status}`, () => completePaySandbox(
        StorefrontPage,
        expected.sandboxAmount,
        status,
    ));

    return step(StorefrontPage, 'Read the order from the thank you page', async () => {
        await StorefrontPage.waitForURL(/checkout\/finish/i, { timeout: 60_000 });
        const orderId = StorefrontCheckoutFinish.getOrderId();
        const orderNumber = await StorefrontCheckoutFinish.getOrderNumber().catch(() => null);
        expect(orderId || orderNumber, 'Order confirmation did not expose an order id or number').toBeTruthy();
        return { orderId, orderNumber };
    });
}

test.describe('PAY. admin capture and refund', () => {
    test('admin Paid on an authorised payment captures it', async ({
        browser,
        StorefrontPage,
        StorefrontProductDetail,
        StorefrontCheckoutConfirm,
        StorefrontCheckoutFinish,
        ProductData,
        DefaultSalesChannel,
        AdminApiContext,
        ShopCustomer,
        Register,
    }) => {
        test.setTimeout(300_000);

        const placed = await placePayOrder({
            StorefrontPage,
            StorefrontProductDetail,
            StorefrontCheckoutConfirm,
            StorefrontCheckoutFinish,
            ProductData,
            DefaultSalesChannel,
            AdminApiContext,
            ShopCustomer,
            Register,
        }, 'authorised');

        const authorized = await step(StorefrontPage, 'Wait until the payment is authorised', () => waitForOrderPaymentState(
            AdminApiContext,
            { orderId: placed.orderId || undefined, orderNumber: placed.orderNumber },
            'authorize',
        ));
        const before = await readPaynlTransactionState(AdminApiContext, authorized.id);
        expect(before.stateId).toBe(95);

        await setPayPluginConfig(AdminApiContext, {
            orderStateWithPaidTransaction: 'in_progress',
        });

        const adminPage = await openAdmin(browser);
        try {
            await step(adminPage, 'Close the Shopware consent and update popups', () => dismissAdminPopups(adminPage, 2_000));
            await step(adminPage, 'Capture by setting the payment to Paid', () => captureAuthorizedOrder(adminPage, authorized.id));

            const paid = await step(adminPage, 'Confirm Shopware shows the payment as paid', () => waitForOrderPaymentState(
                AdminApiContext,
                { orderId: authorized.id },
                'paid',
                30_000,
            ));
            expect(paid.stateMachineState?.technicalName).toBe('in_progress');

            const after = await readPaynlTransactionState(AdminApiContext, authorized.id);
            expect(after.stateId).toBe(100);
        } finally {
            await adminPage.context().close();
        }
    });

    test('admin refund of a paid payment refunds it at PAY.', async ({
        browser,
        StorefrontPage,
        StorefrontProductDetail,
        StorefrontCheckoutConfirm,
        StorefrontCheckoutFinish,
        ProductData,
        DefaultSalesChannel,
        AdminApiContext,
        ShopCustomer,
        Register,
    }) => {
        test.setTimeout(300_000);

        const placed = await placePayOrder({
            StorefrontPage,
            StorefrontProductDetail,
            StorefrontCheckoutConfirm,
            StorefrontCheckoutFinish,
            ProductData,
            DefaultSalesChannel,
            AdminApiContext,
            ShopCustomer,
            Register,
        }, 'captured');

        const paid = await step(StorefrontPage, 'Wait until the payment is paid', () => waitForOrderPaymentState(
            AdminApiContext,
            { orderId: placed.orderId || undefined, orderNumber: placed.orderNumber },
            'paid',
        ));
        const before = await readPaynlTransactionState(AdminApiContext, paid.id);
        expect(before.stateId).toBe(100);

        await setPayPluginConfig(AdminApiContext, { allowRefunds: true });

        const adminPage = await openAdmin(browser);
        try {
            await step(adminPage, 'Close the Shopware consent and update popups', () => dismissAdminPopups(adminPage, 2_000));
            await step(adminPage, 'Refund the order', () => refundOrder(adminPage, paid.id));

            const after = await readPaynlTransactionState(AdminApiContext, paid.id);
            expect(
                REFUND_STATUS_CODES,
                `PAY. transaction ${after.paynlTransactionId} stayed at state ${after.stateId}`,
            ).toContain(after.stateId);
        } finally {
            await adminPage.context().close();
        }
    });
});
