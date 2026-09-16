import { test, expect } from '@shopware-ag/acceptance-test-suite';
import { assignPayPaymentMethod, waitForPaidOrder } from '../src/shopware-admin';
import { completePaySandbox, parseAmount } from '../src/pay-sandbox';
import { addProductToCart, enableGuestCheckout, isPasswordRequired, prepareStorefront } from '../src/storefront';

test.describe('PAY. checkout', () => {
    test('guest checkout reaches paid after PAY. sandbox payment', async ({
        StorefrontPage,
        StorefrontProductDetail,
        StorefrontCheckoutConfirm,
        StorefrontCheckoutFinish,
        ProductData,
        DefaultSalesChannel,
        AdminApiContext,
        TestDataService,
        ShopCustomer,
        Register,
    }) => {
        const payMethod = await assignPayPaymentMethod(
            AdminApiContext,
            TestDataService,
            DefaultSalesChannel.salesChannel.id,
        );

        await prepareStorefront(StorefrontPage);

        await ShopCustomer.goesTo(`detail/${ProductData.id}`);
        await addProductToCart(StorefrontPage);
        await StorefrontProductDetail.offCanvasCartGoToCheckoutButton.click();
        await StorefrontPage.waitForURL(/checkout\/(register|confirm)/);

        if (StorefrontPage.url().includes('/checkout/register')) {
            await enableGuestCheckout(StorefrontPage);
            const guest = !(await isPasswordRequired(StorefrontPage));
            await ShopCustomer.attemptsTo(Register({ isGuest: guest, password: 'shopware' }));
            await StorefrontPage.waitForURL(/checkout\/confirm/, { timeout: 30_000 });
        }

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
        const expected = parseAmount(totalText);
        expect(expected.amount, `Could not parse checkout total from "${totalText}"`).toBeGreaterThan(0);

        await StorefrontCheckoutConfirm.submitOrderButton.click();
        await completePaySandbox(StorefrontPage, expected.sandboxAmount);

        const confirmationHeading = StorefrontPage.locator('h1.finish-header, .finish-header, h1').first();
        await expect(confirmationHeading).toBeVisible({ timeout: 30_000 });
        await expect(confirmationHeading).toContainText(/thank you|successful|danke|bedankt|payment successful/i);

        const orderId = StorefrontCheckoutFinish.getOrderId();
        const orderNumber = await StorefrontCheckoutFinish.getOrderNumber().catch(() => null);
        expect(orderId || orderNumber, 'Order confirmation did not expose an order id or number').toBeTruthy();

        const order = await waitForPaidOrder(
            AdminApiContext,
            { orderId: orderId || undefined, orderNumber },
            {
                amount: expected.amount,
                currency: expected.currency,
            },
        );

        expect(order.transactions[0].stateMachineState.technicalName).toBe('paid');
    });
});
