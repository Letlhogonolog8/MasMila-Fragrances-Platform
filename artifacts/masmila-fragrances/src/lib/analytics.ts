/**
 * Google Analytics 4, Meta Pixel and TikTok Pixel. Each loads only when its
 * ID is configured (VITE_GA_MEASUREMENT_ID, VITE_META_PIXEL_ID,
 * VITE_TIKTOK_PIXEL_ID) AND the visitor has accepted analytics cookies.
 * Shopify Analytics covers orders placed through Shopify checkout.
 */
type AnyFn = (...args: unknown[]) => void;
declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: AnyFn;
    fbq?: AnyFn & { queue?: unknown[]; loaded?: boolean; version?: string; callMethod?: AnyFn; push?: AnyFn };
    ttq?: { track: AnyFn; page: AnyFn; load: AnyFn; _i?: Record<string, unknown> } & Record<string, unknown>;
  }
}

const GA_ID = import.meta.env.VITE_GA_MEASUREMENT_ID as string | undefined;
const META_ID = import.meta.env.VITE_META_PIXEL_ID as string | undefined;
const TIKTOK_ID = import.meta.env.VITE_TIKTOK_PIXEL_ID as string | undefined;
const CONSENT_KEY = 'masmila.cookieConsent';

let started = false;

function loadScript(src: string) {
  const s = document.createElement('script');
  s.async = true;
  s.src = src;
  document.head.appendChild(s);
}

export function consentState(): 'accepted' | 'declined' | null {
  try {
    const v = window.localStorage.getItem(CONSENT_KEY);
    return v === 'accepted' || v === 'declined' ? v : null;
  } catch {
    return null;
  }
}

export function setConsent(value: 'accepted' | 'declined') {
  try { window.localStorage.setItem(CONSENT_KEY, value); } catch { /* storage unavailable */ }
  if (value === 'accepted') startAnalytics();
}

export const analyticsConfigured = Boolean(GA_ID || META_ID || TIKTOK_ID);

export function startAnalytics() {
  if (started || consentState() !== 'accepted') return;
  started = true;
  if (GA_ID) {
    loadScript(`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() {
      // eslint-disable-next-line prefer-rest-params
      window.dataLayer!.push(arguments);
    };
    window.gtag('js', new Date());
    window.gtag('config', GA_ID, { currency: 'ZAR' });
  }
  if (META_ID) {
    // Port of the official Meta Pixel base code.
    const fbq = function (...args: unknown[]) {
      if (fbq.callMethod) fbq.callMethod(...args);
      else fbq.queue!.push(args);
    } as NonNullable<Window['fbq']>;
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = '2.0';
    fbq.queue = [];
    window.fbq = fbq;
    (window as unknown as { _fbq: unknown })._fbq = fbq;
    loadScript('https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', META_ID);
    fbq('track', 'PageView');
  }
  if (TIKTOK_ID) {
    // Port of the official TikTok Pixel base code.
    const ttq = [] as unknown as Record<string, unknown> & unknown[];
    const methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie'];
    for (const method of methods) ttq[method] = (...args: unknown[]) => ttq.push([method, ...args]);
    ttq._i = { [TIKTOK_ID]: Object.assign([], { _u: 'https://analytics.tiktok.com/i18n/pixel/events.js' }) };
    ttq._t = { [TIKTOK_ID]: Date.now() };
    ttq._o = { [TIKTOK_ID]: {} };
    (window as unknown as { TiktokAnalyticsObject: string }).TiktokAnalyticsObject = 'ttq';
    window.ttq = ttq as unknown as Window['ttq'];
    loadScript(`https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=${TIKTOK_ID}&lib=ttq`);
    window.ttq!.page();
  }
}

type EventName = 'page_view' | 'view_item' | 'add_to_cart' | 'begin_checkout' | 'purchase' | 'reseller_application' | 'referral_visit' | 'search';

const META_EVENTS: Partial<Record<EventName, string>> = {
  view_item: 'ViewContent',
  add_to_cart: 'AddToCart',
  begin_checkout: 'InitiateCheckout',
  purchase: 'Purchase',
  reseller_application: 'Lead',
  search: 'Search',
};
const TIKTOK_EVENTS: Partial<Record<EventName, string>> = {
  view_item: 'ViewContent',
  add_to_cart: 'AddToCart',
  begin_checkout: 'InitiateCheckout',
  purchase: 'CompletePayment',
  reseller_application: 'SubmitForm',
};

export function track(event: EventName, params: Record<string, unknown> = {}) {
  if (!started) return;
  const withCurrency = { currency: 'ZAR', ...params };
  window.gtag?.('event', event === 'reseller_application' ? 'generate_lead' : event, withCurrency);
  if (META_EVENTS[event]) window.fbq?.('track', META_EVENTS[event], withCurrency);
  else if (event !== 'page_view') window.fbq?.('trackCustom', event, withCurrency);
  if (TIKTOK_EVENTS[event]) window.ttq?.track(TIKTOK_EVENTS[event], withCurrency);
}

export function trackPage(path: string) {
  if (!started) return;
  window.gtag?.('event', 'page_view', { page_path: path });
  window.fbq?.('track', 'PageView');
  window.ttq?.page();
}
