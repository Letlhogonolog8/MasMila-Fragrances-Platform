import { type FormEvent, useState } from 'react';
import { Link } from 'wouter';
import { ArrowRight, Check } from 'lucide-react';
import { useSubmitResellerApplication, type ResellerApplicationInput } from '@workspace/api-client-react';
import { useMe } from '@/lib/auth';
import { errorMessage, PROVINCES } from '@/lib/format';
import { getReferral } from '@/lib/referral';
import { useSeo } from '@/lib/seo';
import { track } from '@/lib/analytics';

export default function ApplyPage() {
  const { data: me } = useMe();
  const referral = getReferral();
  const [form, setForm] = useState<ResellerApplicationInput>({
    firstName: me?.user?.firstName ?? '', surname: me?.user?.surname ?? '', mobile: me?.user?.mobile ?? '', email: me?.user?.email ?? '',
    province: '', city: '', contactMethod: 'WhatsApp', heardAbout: '', referringCode: referral?.code ?? '',
    termsAccepted: false, privacyAccepted: false, resellerTermsAccepted: false,
  });
  const application = useSubmitResellerApplication();
  useSeo({
    title: 'Become a Mas\'Mila Reseller — Start a perfume business in South Africa',
    description: 'Start a perfume business with Mas\'Mila. Buy fragrances at wholesale reseller prices, sell at retail and earn leadership incentives on real product sales. Apply online.',
  });
  const update = (key: keyof ResellerApplicationInput, value: string | boolean) => setForm((c) => ({ ...c, [key]: value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    application.mutate({ data: { ...form, referringCode: form.referringCode?.trim() || null } }, { onSuccess: () => track('reseller_application', { referred: Boolean(form.referringCode) }) });
  };

  if (me?.reseller) {
    return <main className="container-wide dashboard-wrap"><div className="empty-state"><h2>You're already a Mas'Mila reseller.</h2><Link className="btn-primary" href="/account/reseller">Open your portal <ArrowRight size={15} /></Link></div></main>;
  }
  if (application.isSuccess) {
    return (
      <main className="container-wide form-shell">
        <div className="form-aside"><span className="eyebrow">Application received</span><h1 className="display-lg">This could be<br />the beginning.</h1><p className="body-lg">Your application is in the Mas'Mila approval queue. We'll contact you by {form.contactMethod.toLowerCase()} with next steps.</p></div>
        <div className="form-card" style={{ alignSelf: 'center', textAlign: 'center', paddingBlock: 62 }} data-testid="state-application-success">
          <Check size={35} color="hsl(var(--primary))" />
          <h2>{application.data?.message}</h2>
          <p className="muted">Your application reference is <strong>{application.data?.id}</strong>. Once approved, sign in with <strong>{form.email}</strong> to access reseller pricing.</p>
          <Link className="btn-ink" href="/how-reselling-works">How reselling works</Link>
        </div>
      </main>
    );
  }
  const f = (key: 'firstName' | 'surname' | 'mobile' | 'email' | 'city', label: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="field"><label htmlFor={key}>{label}</label><input id={key} required value={form[key]} onChange={(e) => update(key, e.target.value)} data-testid={`input-${key}`} {...extra} /></div>
  );
  return (
    <main className="container-wide form-shell">
      <div className="form-aside">
        <span className="eyebrow">Become a Mas'Mila reseller</span>
        <h1 className="display-lg">Wear the fragrance.<br />Build the business.</h1>
        <p className="body-lg">Build a fragrance sales business around products people are proud to recommend — with earnings linked to actual product sales.</p>
        <div className="aside-note"><strong>How it works</strong><br />1. Apply below — Mas'Mila reviews every application.<br />2. Once approved, sign in to see reseller prices.<br />3. Place a 10-bottle opening order (mix any fragrances).<br />4. Sell at the recommended retail price and share your personal referral link.<br /><Link href="/how-reselling-works">Read the full guide →</Link></div>
        <p className="muted small-text">There is no joining fee, and no income is earned from recruiting. Leadership incentives are paid only on qualifying product sales.</p>
      </div>
      <form className="form-card" onSubmit={submit} data-testid="form-reseller-application">
        <h2>Tell us about yourself.</h2>
        {application.error ? <div className="form-message" data-testid="state-application-error">{errorMessage(application.error, 'We could not send that through. Please check your details and try again.')}</div> : null}
        <div className="form-grid">
          {f('firstName', 'First name', { autoComplete: 'given-name' })}
          {f('surname', 'Surname', { autoComplete: 'family-name' })}
          {f('mobile', 'Mobile number', { type: 'tel', minLength: 9, autoComplete: 'tel' })}
          {f('email', 'Email address', { type: 'email', autoComplete: 'email' })}
          <div className="field"><label htmlFor="province">Province</label><select id="province" required value={form.province} onChange={(e) => update('province', e.target.value)} data-testid="select-province"><option value="">Choose province</option>{PROVINCES.map((p) => <option key={p}>{p}</option>)}</select></div>
          {f('city', 'City / town', { autoComplete: 'address-level2' })}
          <div className="field"><label htmlFor="contactMethod">Preferred contact method</label><select id="contactMethod" value={form.contactMethod} onChange={(e) => update('contactMethod', e.target.value)} data-testid="select-contact-method"><option>WhatsApp</option><option>Phone call</option><option>Email</option><option>SMS</option></select></div>
          <div className="field"><label htmlFor="heardAbout">How did you hear about Mas'Mila?</label><select id="heardAbout" required value={form.heardAbout} onChange={(e) => update('heardAbout', e.target.value)} data-testid="select-heard-about"><option value="">Choose one</option><option>Friend or reseller</option><option>Instagram</option><option>Facebook</option><option>TikTok</option><option>WhatsApp</option><option>Event</option><option>Google search</option><option>Other</option></select></div>
          <div className="field full"><label htmlFor="referringCode">Referring reseller ID / code <span style={{ opacity: .55 }}>(optional)</span></label><input id="referringCode" placeholder="e.g. NOMDADE123 or MSM-000123" value={form.referringCode ?? ''} onChange={(e) => update('referringCode', e.target.value.toUpperCase())} data-testid="input-referring-code" /></div>
        </div>
        <label className="check-row"><input type="checkbox" required checked={form.termsAccepted} onChange={(e) => update('termsAccepted', e.target.checked)} data-testid="checkbox-terms" /><span>I consent to the Mas'Mila <Link href="/terms">terms & conditions</Link>.</span></label>
        <label className="check-row"><input type="checkbox" required checked={form.privacyAccepted} onChange={(e) => update('privacyAccepted', e.target.checked)} data-testid="checkbox-privacy" /><span>I consent to Mas'Mila processing my personal information as described in the <Link href="/privacy">privacy policy</Link> (POPIA).</span></label>
        <label className="check-row"><input type="checkbox" required checked={form.resellerTermsAccepted} onChange={(e) => update('resellerTermsAccepted', e.target.checked)} data-testid="checkbox-reseller-terms" /><span>I agree to the <Link href="/reseller-terms">reseller terms and conditions</Link> and understand this is an independent sales opportunity where earnings depend on product sales.</span></label>
        <div className="submit-row"><span className="count-label">Takes about 2 minutes</span><button className="btn-primary" type="submit" disabled={application.isPending} data-testid="button-submit-application">{application.isPending ? 'Sending application…' : 'Submit application'} <ArrowRight size={15} /></button></div>
      </form>
    </main>
  );
}
