import { lazy, Suspense, useEffect } from 'react';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from '@/hooks/use-toast';
import { Link, Route, Router as WouterRouter, Switch, useLocation, useSearch } from 'wouter';
import { getReferral as fetchReferral } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SiteLayout } from '@/components/site';
import { AppAuthProvider, basePath } from '@/lib/auth';
import { CartProvider } from '@/lib/cart';
import { getReferral, saveReferral } from '@/lib/referral';
import { useSeo } from '@/lib/seo';
import HomePage from '@/pages/home';
import ShopPage from '@/pages/shop';
import ProductPage from '@/pages/product';
import { CartPage, CheckoutPage } from '@/pages/cart';
import OrderPage from '@/pages/order';
import ApplyPage from '@/pages/apply';
import ReferralPage from '@/pages/referral';
import { LoadingBlock } from '@/components/bits';
import { ResellerLoginPage, SignInPage, SignUpPage } from '@/pages/auth';
import {
  AboutPage, ContactPage, CookiesPage, CorporatePage, FaqPage, HowResellingWorksPage, PrivacyPage,
  ResellerTermsPage, ReturnsPage, ShippingPage, StoryPage, TermsPage,
} from '@/pages/content';

// Signed-in areas load on demand to keep the storefront bundle small on mobile.
const AccountPage = lazy(() => import('@/pages/account'));
const PortalPage = lazy(() => import('@/pages/portal'));
const AdminPage = lazy(() => import('@/pages/admin'));

const queryClient = new QueryClient({
  // Mutations opt into a confirmation toast with `meta: { success: '…' }`.
  mutationCache: new MutationCache({
    onSuccess: (_data, _vars, _ctx, mutation) => {
      const message = mutation.meta?.success;
      if (typeof message === 'string') toast({ title: message });
    },
  }),
  defaultOptions: {
    queries: {
      retry: (count, error) => count < 2 && ![401, 403, 404].includes((error as { status?: number })?.status ?? 0),
      refetchOnWindowFocus: false,
    },
  },
});

/** Captures ?ref=CODE on any page (shared product links). */
function ReferralCapture() {
  const search = useSearch();
  useEffect(() => {
    const code = new URLSearchParams(search).get('ref');
    if (!code || getReferral()?.code === code.toUpperCase()) return;
    fetchReferral({ code, source: 'link' })
      .then((r) => { if (r.valid) saveReferral(r.code, 'link', r.resellerName); })
      .catch(() => undefined);
  }, [search]);
  return null;
}

function NotFound() {
  useSeo({ title: 'Page not found', noindex: true });
  return (
    <main className="container-wide dashboard-wrap">
      <div className="empty-state"><span className="eyebrow">404</span><h2>This page has drifted away.</h2><p>The link may be old or mistyped.</p><Link className="btn-primary" href="/shop">SHOP MAS'MILA</Link></div>
    </main>
  );
}

function Routes() {
  return (
    <Switch>
      <Route path="/" component={HomePage} />
      <Route path="/shop">{() => <ShopPage />}</Route>
      <Route path="/shop/:collection">{(p) => <ShopPage key={p.collection} collection={p.collection} />}</Route>
      <Route path="/all-fragrances">{() => <ShopPage />}</Route>
      <Route path="/product/:slug">{(p) => <ProductPage key={p.slug} slug={p.slug} />}</Route>
      <Route path="/cart" component={CartPage} />
      <Route path="/checkout" component={CheckoutPage} />
      <Route path="/order/:orderNumber">{(p) => <OrderPage orderNumber={decodeURIComponent(p.orderNumber)} />}</Route>
      <Route path="/track-order">{() => <OrderPage />}</Route>
      <Route path="/about" component={AboutPage} />
      <Route path="/our-story" component={StoryPage} />
      <Route path="/become-a-reseller" component={ApplyPage} />
      <Route path="/reseller" component={ApplyPage} />
      <Route path="/reseller-login" component={ResellerLoginPage} />
      <Route path="/how-reselling-works" component={HowResellingWorksPage} />
      <Route path="/corporate" component={CorporatePage} />
      <Route path="/contact" component={ContactPage} />
      <Route path="/faqs" component={FaqPage} />
      <Route path="/shipping" component={ShippingPage} />
      <Route path="/returns" component={ReturnsPage} />
      <Route path="/privacy" component={PrivacyPage} />
      <Route path="/terms" component={TermsPage} />
      <Route path="/reseller-terms" component={ResellerTermsPage} />
      <Route path="/cookies" component={CookiesPage} />
      <Route path="/account/reseller" component={PortalPage} />
      <Route path="/portal" component={PortalPage} />
      <Route path="/account" component={AccountPage} />
      <Route path="/admin" component={AdminPage} />
      <Route path="/r/:code">{(p) => <ReferralPage key={p.code} code={p.code} />}</Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function AppRouter() {
  const [location] = useLocation();
  return (
    <ErrorBoundary resetKey={location}>
      <Switch>
        <Route path="/sign-in/*?" component={SignInPage} />
        <Route path="/sign-up/*?" component={SignUpPage} />
        <Route>
          <SiteLayout>
            <ReferralCapture />
            <Suspense fallback={<main className="container-wide dashboard-wrap"><LoadingBlock /></main>}><Routes /></Suspense>
          </SiteLayout>
        </Route>
      </Switch>
    </ErrorBoundary>
  );
}

export default function App() {
  return (
    <WouterRouter base={basePath}>
      <QueryClientProvider client={queryClient}>
        <AppAuthProvider>
          <CartProvider>
            <TooltipProvider>
              <AppRouter />
              <Toaster />
            </TooltipProvider>
          </CartProvider>
        </AppAuthProvider>
      </QueryClientProvider>
    </WouterRouter>
  );
}
