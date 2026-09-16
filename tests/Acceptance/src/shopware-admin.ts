import { expect, type FixtureTypes } from '@shopware-ag/acceptance-test-suite';

type AdminApiContext = FixtureTypes['AdminApiContext'];

type SalesChannelPaymentAssigner = {
    assignSalesChannelPaymentMethod(salesChannelId: string, paymentMethodId: string): Promise<unknown>;
};

export type PayPaymentMethod = {
    id: string;
    name: string;
};

type SearchResponse<T> = {
    data: T[];
};

type PaymentMethodRecord = PayPaymentMethod & {
    active?: boolean;
    translated?: { name?: string };
    attributes?: {
        name?: string;
        active?: boolean;
        translated?: { name?: string };
        handlerIdentifier?: string;
    };
};

function mapPaymentMethod(method: PaymentMethodRecord): PayPaymentMethod & { active: boolean } {
    const attributes = method.attributes ?? method;
    return {
        id: method.id,
        name: attributes.name || attributes.translated?.name || method.name || '',
        active: Boolean(attributes.active),
    };
}

export async function findPayPaymentMethods(
    adminApi: AdminApiContext,
    activeOnly = true,
): Promise<Array<PayPaymentMethod & { active: boolean }>> {
    const filter: Array<Record<string, unknown>> = [
        {
            type: 'contains',
            field: 'handlerIdentifier',
            value: 'PaynlPayment',
        },
    ];
    if (activeOnly) {
        filter.push({ type: 'equals', field: 'active', value: true });
    }

    const response = await adminApi.post('./search/payment-method', {
        data: { limit: 50, filter },
    });

    expect(response.ok(), `Payment method search failed: ${response.status()} ${await response.text()}`).toBeTruthy();
    const payload = (await response.json()) as SearchResponse<PaymentMethodRecord>;
    return (payload.data ?? []).map(mapPaymentMethod);
}

async function writePayTestConfig(adminApi: AdminApiContext): Promise<void> {
    const tokenCode = process.env.PAY_TOKEN_CODE || '';
    const apiToken = process.env.PAY_API_TOKEN || '';
    const serviceId = process.env.PAY_SERVICE_ID || '';
    expect(tokenCode && apiToken && serviceId, 'PAY_TOKEN_CODE, PAY_API_TOKEN and PAY_SERVICE_ID must be set').toBeTruthy();

    const response = await adminApi.post('./_action/system-config', {
        data: {
            'PaynlPaymentShopware6.config.tokenCode': tokenCode,
            'PaynlPaymentShopware6.config.apiToken': apiToken,
            'PaynlPaymentShopware6.config.serviceId': serviceId,
            'PaynlPaymentShopware6.config.testMode': true,
            'PaynlPaymentShopware6.config.useSinglePaymentMethod': true,
            'PaynlPaymentShopware6.config.logging': true,
            'PaynlPaymentShopware6.config.paymentScreenLanguage': 'en',
        },
    });
    expect(response.ok(), `Could not write PAY. config: ${response.status()} ${await response.text()}`).toBeTruthy();
}

async function assertPluginInstalled(adminApi: AdminApiContext): Promise<void> {
    const response = await adminApi.post('./search/plugin', {
        data: {
            limit: 1,
            filter: [
                {
                    type: 'equals',
                    field: 'name',
                    value: 'PaynlPaymentShopware6',
                },
            ],
        },
    });
    expect(response.ok(), `Plugin search failed: ${response.status()} ${await response.text()}`).toBeTruthy();
    const payload = (await response.json()) as SearchResponse<{
        name?: string;
        active?: boolean;
        installedAt?: string | null;
        attributes?: { name?: string; active?: boolean; installedAt?: string | null };
    }>;
    const plugin = payload.data[0];
    const attributes = plugin?.attributes ?? plugin;
    const installed = Boolean(attributes?.installedAt);
    const active = Boolean(attributes?.active);

    expect(
        plugin && installed && active,
        'PaynlPaymentShopware6 must be installed and active before tests run. Start the shop, then: npm run env:plugin',
    ).toBeTruthy();
}

async function installPayPaymentMethods(adminApi: AdminApiContext): Promise<void> {
    const response = await adminApi.get(`paynl/install-payment-methods?_nocache=${Date.now()}`, {
        headers: {
            'Cache-Control': 'no-cache, no-store',
            Pragma: 'no-cache',
        },
    });
    const body = await response.text();
    expect(
        response.ok(),
        `Could not install PAY. payment methods (${response.status()}). PaynlPaymentShopware6 routes are missing — install and activate the plugin (npm run env:plugin).`,
    ).toBeTruthy();

    const payload = JSON.parse(body) as { success?: boolean; message?: string };
    expect(payload.success !== false, payload.message || 'install-payment-methods failed').toBeTruthy();
}

async function ensurePayPaymentMethods(adminApi: AdminApiContext): Promise<Array<PayPaymentMethod & { active: boolean }>> {
    await assertPluginInstalled(adminApi);
    let methods = await findPayPaymentMethods(adminApi, false);
    if (methods.length === 0) {
        await writePayTestConfig(adminApi);
        await installPayPaymentMethods(adminApi);
        methods = await findPayPaymentMethods(adminApi, false);
    }

    for (const method of methods.filter((item) => !item.active)) {
        const activate = await adminApi.patch(`./payment-method/${method.id}`, { data: { active: true } });
        expect(activate.ok(), `Could not activate ${method.name}: ${activate.status()}`).toBeTruthy();
        method.active = true;
    }

    return methods.filter((method) => method.active);
}

type DomainRecord = {
    id: string;
    url?: string;
    languageId?: string;
    currencyId?: string;
    snippetSetId?: string;
    attributes?: {
        url?: string;
        languageId?: string;
        currencyId?: string;
        snippetSetId?: string;
    };
};

export async function ensureStorefrontDomainAliases(
    adminApi: AdminApiContext,
    storefrontUrl: string,
    salesChannelId: string,
): Promise<void> {
    const canonical = storefrontUrl.replace(/\/$/, '');
    const wanted = [canonical];
    if (canonical.startsWith('https://')) {
        wanted.push(canonical.replace(/^https:/, 'http:'));
    }

    const search = await adminApi.post('./search/sales-channel-domain', {
        data: {
            limit: 50,
            filter: [{ type: 'equals', field: 'salesChannelId', value: salesChannelId }],
        },
    });
    expect(search.ok(), `Sales channel domain search failed: ${search.status()} ${await search.text()}`).toBeTruthy();
    const payload = (await search.json()) as SearchResponse<DomainRecord>;
    const existing = payload.data ?? [];
    const known = new Set(
        existing.map((domain) => (domain.attributes?.url ?? domain.url ?? '').replace(/\/$/, '')),
    );
    const template = existing[0];
    expect(template, `Sales channel ${salesChannelId} has no domain to copy`).toBeTruthy();

    for (const url of wanted) {
        if (known.has(url)) {
            continue;
        }
        const create = await adminApi.post('./sales-channel-domain?_response=detail', {
            data: {
                salesChannelId,
                url,
                languageId: template.attributes?.languageId ?? template.languageId,
                currencyId: template.attributes?.currencyId ?? template.currencyId,
                snippetSetId: template.attributes?.snippetSetId ?? template.snippetSetId,
            },
        });
        expect(
            create.ok(),
            `Could not add sales channel domain ${url}: ${create.status()} ${await create.text()}`,
        ).toBeTruthy();
        known.add(url);
    }

    await adminApi.delete('./_action/cache').catch(() => undefined);
}

export async function assignPayPaymentMethod(
    adminApi: AdminApiContext,
    testDataService: SalesChannelPaymentAssigner,
    salesChannelId: string,
    preferredName = process.env.PAY_PAYMENT_METHOD || 'Pay by PAY.',
): Promise<PayPaymentMethod> {
    const methods = await ensurePayPaymentMethods(adminApi);
    expect(
        methods.length,
        'No PAY. payment methods found. Install and activate PaynlPaymentShopware6, then retry.',
    ).toBeGreaterThan(0);

    const selected =
        methods.find((method) => method.name === preferredName)
        ?? methods.find((method) => method.name.toLowerCase().includes(preferredName.toLowerCase()))
        ?? methods[0];

    await testDataService.assignSalesChannelPaymentMethod(salesChannelId, selected.id);

    const patchResponse = await adminApi.patch(`./sales-channel/${salesChannelId}`, {
        data: {
            paymentMethodId: selected.id,
        },
    });
    expect(patchResponse.ok(), `Could not set default PAY. method: ${patchResponse.status()} ${await patchResponse.text()}`).toBeTruthy();

    return selected;
}

export type PaidOrder = {
    id: string;
    orderNumber: string;
    amountTotal: number;
    currency: { isoCode: string };
    transactions: Array<{
        id: string;
        amount: { totalPrice: number };
        stateMachineState: { technicalName: string };
        paymentMethod?: { name: string };
    }>;
};

export async function waitForPaidOrder(
    adminApi: AdminApiContext,
    lookup: { orderId?: string; orderNumber?: string | null },
    expected: { amount: number; currency: string },
    timeoutMs = Number(process.env.PAY_STATUS_TIMEOUT_MS || 120_000),
): Promise<PaidOrder> {
    const deadline = Date.now() + timeoutMs;
    let lastState = 'unknown';
    const filter = lookup.orderId
        ? [{ type: 'equals', field: 'id', value: lookup.orderId }]
        : [{ type: 'equals', field: 'orderNumber', value: lookup.orderNumber }];
    const label = lookup.orderNumber || lookup.orderId || 'unknown-order';

    while (Date.now() < deadline) {
        const response = await adminApi.post('./search/order', {
            data: {
                limit: 1,
                filter,
                associations: {
                    currency: {},
                    transactions: {
                        associations: {
                            stateMachineState: {},
                            paymentMethod: {},
                        },
                    },
                },
            },
        });

        expect(response.ok(), `Order search failed: ${response.status()} ${await response.text()}`).toBeTruthy();
        const payload = (await response.json()) as SearchResponse<PaidOrder>;
        const order = payload.data[0];

        if (order) {
            const transaction = order.transactions?.[0];
            lastState = transaction?.stateMachineState?.technicalName ?? 'missing-transaction';
            if (transaction?.stateMachineState?.technicalName === 'paid') {
                expect(order.currency.isoCode).toBe(expected.currency);
                expect(order.amountTotal).toBeCloseTo(expected.amount, 2);
                expect(transaction.amount.totalPrice).toBeCloseTo(expected.amount, 2);
                return order;
            }
        }

        await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    throw new Error(
        `Shopware transaction for order ${label} did not reach "paid" within ${timeoutMs}ms (last state: ${lastState})`,
    );
}
