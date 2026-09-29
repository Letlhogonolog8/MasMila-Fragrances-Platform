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

async function getShopifyStorefrontConfig(options: { forceRefresh?: boolean } = {}) {
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