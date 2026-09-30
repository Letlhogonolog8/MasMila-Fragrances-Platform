import { useEffect } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { ArrowRight } from 'lucide-react';
import { getGetReferralQueryKey, useGetReferral } from '@workspace/api-client-react';
import { LoadingBlock } from '@/components/bits';
import { saveReferral } from '@/lib/referral';
import { useSeo } from '@/lib/seo';
import { track } from '@/lib/analytics';

/**
 * Reseller landing page: masmila.co.za/r/NOMDADE123 (?src=qr for QR codes,
 * ?next=/product/... to deep-link a product). Stores the attribution and
 * welcomes the shopper on behalf of their reseller.
 */
export default function ReferralPage({ code }: { code: string }) {
  const params = new URLSearchParams(useSearch());
  const source = params.get('src') === 'qr' ? 'qr' : params.get('src') === 'landing' ? 'landing' : 'link';
  const next = params.get('next');
  const query = { code, source };
  const referral = useGetReferral(query, { query: { queryKey: getGetReferralQueryKey(query), retry: false, staleTime: Infinity } });
  const [, navigate] = useLocation();
  useSeo({ title: 'Shop Mas\'Mila with your reseller', noindex: true });

  useEffect(() => {
    if (!referral.data?.valid) return;
    saveReferral(referral.data.code, source, referral.data.resellerName);
    track('referral_visit', { code: referral.data.code, source });
    if (next && next.startsWith('/') && !next.startsWith('//')) navigate(next, { replace: true });
  }, [referral.data, source, next, navigate]);

  if (referral.isLoading) return <main className="container-wide dashboard-wrap"><LoadingBlock label="Opening the shop" /></main>;
  const name = referral.data?.valid ? referral.data.resellerName : null;
  return (
    <main className="container-wide">
      <section className="hero compact-hero" data-testid="referral-landing">
        <div className="hero-copy">
          <span className="eyebrow">{referral.data?.valid ? `Personal invitation · ${referral.data.code}` : 'Welcome to Mas\'Mila'}</span>
          <h1 className="display-xl">{name ? <>{name} picked these <em>for you.</em></> : <>Leave a little <em>impression.</em></>}</h1>
          <p className="body-lg">{name ? `Shop online and your order is credited to ${name}, your Mas'Mila reseller — same prices, same fast delivery.` : 'That referral code is not active, but the whole collection is waiting for you.'}</p>
          <div className="hero-actions"><Link className="btn-primary" href="/shop">SHOP MAS'MILA <ArrowRight size={15} /></Link><Link className="btn-ghost" href="/become-a-reseller">BECOME A RESELLER</Link></div>
        </div>
        <div className="hero-art"><div className="hero-bottle" /></div>
      </section>
    </main>
  );
}
