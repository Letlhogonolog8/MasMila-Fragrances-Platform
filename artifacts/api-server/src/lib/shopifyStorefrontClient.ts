type ShopifyConnectionSettings = {
  shop_domain?: string;
  storefront_access_token?: string;
};

type ShopifyConnectionResponse = {
  items?: Array<{ settings?: ShopifyConnectionSettings }>;
};

type ShopifyStorefrontConfig = {
  shopDomain: string;
  storefrontAccessToken: string;
};

const STOREFRONT_API_VERSION = "2026-04";
const CONFIG_CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

let cachedConfig:
  | { value: ShopifyStorefrontConfig; expiresAt: number }
  | undefined;

function getOpenIntConnectionConfig() {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const token = process.env.REPL_IDENTITY
    ? `repl ${process.env.REPL_IDENTITY}`
    : process.env.WEB_REPL_RENEWAL
      ? `depl ${process.env.WEB_REPL_RENEWAL}`
      : null;

  if (!hostname || !token) {
    throw new Error("Missing Replit connector environment variables");
  }

  const protocol = hostname.startsWith("localhost") ? "http" : "https";
  const connectionUrl = new URL(`${protocol}://${hostname}/api/v2/connection`);
  connectionUrl.searchParams.set("include_secrets", "true");
  connectionUrl.searchParams.set("connector_names", "shopify-store");
  connectionUrl.searchParams.set("refresh_policy", "none");

  return { connectionUrl: connectionUrl.toString(), token };
}

/** Direct credentials (any host) take precedence over the Replit connector. */
function getEnvConfig(): ShopifyStorefrontConfig | null {
  const shopDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const storefrontAccessToken = process.env.SHOPIFY_STOREFRONT_TOKEN;
  return shopDomain && storefrontAccessToken ? { shopDomain, storefrontAccessToken } : null;
}

export function isShopifyConfigured() {
  return Boolean(getEnvConfig() || process.env.REPLIT_CONNECTORS_HOSTNAME);
}

async function getShopifyStorefrontConfig(options: { forceRefresh?: boolean } = {}) {
  const envConfig = getEnvConfig();
  if (envConfig) return envConfig;
  if (cachedConfig && !options.forceRefresh && Date.now() < cachedConfig.expiresAt) {
    return cachedConfig.value;
  }

  const { connectionUrl, token } = getOpenIntConnectionConfig();
  const response = await fetch(connectionUrl, {
    headers: { Accept: "application/json", X_REPLIT_TOKEN: token },
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Shopify connection: ${response.status}`);
  }

  const data = (await response.json()) as ShopifyConnectionResponse;
  const settings = data.items?.[0]?.settings;
  if (!settings?.shop_domain || !settings.storefront_access_token) {
    throw new Error("Shopify Store integration is missing Storefront settings");
  }

  cachedConfig = {
    value: {
      shopDomain: settings.shop_domain,
      storefrontAccessToken: settings.storefront_access_token,
    },
    expiresAt: Date.now() + CONFIG_CACHE_TTL_MS,
  };
  return cachedConfig.value;
}

export async function shopifyStorefrontRequest<T>(
  query: string,
  variables?: Record<string, unknown>,
  options: { retryOnUnauthorized?: boolean } = {},
): Promise<T> {
  const config = await getShopifyStorefrontConfig();
  const response = await fetch(
    `https://${config.shopDomain}/api/${STOREFRONT_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": config.storefrontAccessToken,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );

  if (
    options.retryOnUnauthorized !== false &&
    (response.status === 401 || response.status === 403)
  ) {
    cachedConfig = undefined;
    await getShopifyStorefrontConfig({ forceRefresh: true });
    return shopifyStorefrontRequest<T>(query, variables, {
      retryOnUnauthorized: false,
    });
  }

  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok || json.errors?.length) {
    throw new Error(
      `Shopify Storefront API error (${response.status}): ${JSON.stringify(json.errors ?? json)}`,
    );
  }
  return json.data as T;
}

type CartCreateResponse = {
  cartCreate: {
    cart: { id: string; checkoutUrl: string } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
};

/**
 * Create a Shopify cart for hosted checkout (payments + delivery rates are
 * configured in Shopify admin). The Mas'Mila order number and referral code
 * travel as cart attributes and come back on the order webhook.
 */
export async function createShopifyCheckout(input: {
  lines: Array<{ merchandiseId: string; quantity: number }>;
  email: string;
  attributes: Record<string, string>;
}) {
  const data = await shopifyStorefrontRequest<CartCreateResponse>(
    `#graphql
      mutation CartCreate($input: CartInput!) {
        cartCreate(input: $input) {
          cart { id checkoutUrl }
          userErrors { field message }
        }
      }
    `,
    {
      input: {
        lines: input.lines,
        buyerIdentity: { email: input.email, countryCode: "ZA" },
        attributes: Object.entries(input.attributes).map(([key, value]) => ({ key, value })),
      },
    },
  );
  const { cart, userErrors } = data.cartCreate;
  if (!cart || userErrors.length) {
    throw new Error(`Shopify cartCreate failed: ${userErrors.map((e) => e.message).join("; ")}`);
  }
  return cart.checkoutUrl;
}
