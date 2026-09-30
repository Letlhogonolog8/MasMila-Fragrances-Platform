import { type FormEvent, type ReactNode, useState } from 'react';
import { Link } from 'wouter';
import { ArrowRight, Check, MessageCircle } from 'lucide-react';
import { useSubmitEnquiry, type EnquiryInput } from '@workspace/api-client-react';
import { useStoreConfig, whatsappLink } from '@/components/site';
import { errorMessage, money } from '@/lib/format';
import { useSeo } from '@/lib/seo';

function Page({ eyebrow, title, intro, seoTitle, seoDescription, children, jsonLd }: { eyebrow: string; title: string; intro?: string; seoTitle: string; seoDescription: string; children: ReactNode; jsonLd?: object }) {
  useSeo({ title: seoTitle, description: seoDescription, jsonLd });
  return (
    <main className="container-wide">
      <div className="page-intro"><span className="eyebrow">{eyebrow}</span><h1 className="display-lg">{title}</h1>{intro ? <p className="body-lg">{intro}</p> : null}</div>
      <div className="prose-page">{children}</div>
    </main>
  );
}

const LEGAL_NOTE = <p className="legal-note">This policy is provided as a working draft and must be reviewed by a South African legal adviser (CPA, ECTA, POPIA and direct-selling requirements) before launch.</p>;

export function AboutPage() {
  return (
    <Page eyebrow="About Mas'Mila" title="Scent belongs to everyone." seoTitle="About Mas'Mila — South African fragrance brand" seoDescription="Mas'Mila is a South African fragrance brand making affordable, long-lasting perfume — and a business opportunity for resellers.">
      <p className="body-lg">Mas'Mila is three things at once: a <strong>fragrance brand</strong> making long-lasting 50ml and 100ml scents; a <strong>lifestyle brand</strong> for people who like to leave a little impression; and a <strong>business opportunity</strong> for people who want to build a fragrance sales business with earnings linked to real product sales.</p>
      <div className="story-lines" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: 40 }}>
        <div><strong>Personal</strong><span>There is no one right way to wear a scent. Our range gives you room to make it yours.</span></div>
        <div><strong>Considered</strong><span>How it opens, how it settles, how it feels to gift — we care about the small things.</span></div>
        <div><strong>Possible</strong><span>Beautiful product at fair prices, and a business path that rewards showing up.</span></div>
      </div>
      <div className="hero-actions mt"><Link className="btn-primary" href="/shop">SHOP MAS'MILA <ArrowRight size={15} /></Link><Link className="btn-ghost" href="/our-story">Our story</Link></div>
    </Page>
  );
}

export function StoryPage() {
  return (
    <Page eyebrow="Our story" title="A bold idea in a small bottle." seoTitle="Our story" seoDescription="How Mas'Mila started — making fragrance more accessible for South Africans, and the opportunity to share it.">
      <p className="body-lg">Mas'Mila started with a simple observation: the right fragrance changes how you walk into a room — but great scent too often sits behind a glass counter at a price most people can't justify.</p>
      <p>We set out to make fragrance that performs like the expensive stuff, in sizes that make sense (50ml for trying and gifting, 100ml for your signature), at prices that feel fair. Then we noticed something else: the people who loved our scents were already selling them — to friends, colleagues, church groups and WhatsApp communities.</p>
      <p>So we built Mas'Mila to move from founder-led selling to a <strong>digital storefront, a reseller network and a sales-based leadership organisation</strong>. Resellers buy at wholesale prices and keep the retail margin. Those who build teams earn leadership incentives calculated only on qualifying product sales — never on recruitment.</p>
      <blockquote className="pull-quote">“Wear the fragrance. Build the business.”</blockquote>
      <div className="hero-actions"><Link className="btn-primary" href="/become-a-reseller">BECOME A RESELLER <ArrowRight size={15} /></Link></div>
    </Page>
  );
}

export function HowResellingWorksPage() {
  const config = useStoreConfig();
  const opening = config.data?.openingOrder ?? 10;
  return (
    <Page eyebrow="How reselling works" title="Start a perfume business with Mas'Mila." intro="A simple, transparent model: buy at reseller prices, sell at the recommended retail price, keep the difference. Grow a team and earn on their product sales." seoTitle="How reselling works — start a perfume business in South Africa" seoDescription="Become a perfume reseller in South Africa: wholesale fragrance prices, a 10-bottle opening order, and leadership incentives on real product sales.">
      <ol className="steps">
        <li><strong>Apply</strong><span>Complete the online application. Every application is reviewed by Mas'Mila.</span></li>
        <li><strong>Get approved</strong><span>You receive a Reseller ID (e.g. MSM-000123), a personal referral code and access to the reseller portal.</span></li>
        <li><strong>Opening order</strong><span>Place an opening order of at least {opening} bottles — mix any fragrances and sizes. No joining fee.</span></li>
        <li><strong>Sell</strong><span>Sell at the recommended retail price through WhatsApp, Instagram, TikTok, events and your networks. Customers can also buy online through your link or QR code — the sale is credited to you.</span></li>
        <li><strong>Grow</strong><span>Invite others to become resellers. You earn only when your team sells product — recruitment itself never earns commission.</span></li>
      </ol>
      <h2>Ranks & incentives</h2>
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Rank</th><th>Qualification (per calendar month)</th><th>Leadership incentive</th></tr></thead>
        <tbody>
          <tr><td><strong>Reseller</strong></td><td>Approved + opening order of {opening} bottles</td><td>Retail margin on your own sales</td></tr>
          <tr><td><strong>Team Leader</strong></td><td>5 active direct resellers · 20 personal bottles · 100 qualifying team bottles · good standing</td><td>5% of qualifying wholesale sales by your direct team</td></tr>
          <tr><td><strong>Manager</strong></td><td>3 active Team Leaders · 15 active resellers in organisation · 300 organisation bottles · 20 personal bottles</td><td>2% of qualifying sales by the Team Leaders directly under you</td></tr>
          <tr><td><strong>Director</strong> <small>(future phase)</small></td><td>5 active Managers · 50 active resellers · 1,000 bottles</td><td>1%</td></tr>
        </tbody>
      </table></div>
      <p className="muted small-text">Current requirements and percentages are set by Mas'Mila and shown in your portal. Example: 100 team bottles × R140 = R14,000 qualifying sales → 5% = R700 Team Leader incentive.</p>
      <h2>Staying active</h2>
      <p>Sell at least one bottle a month to stay active. If you sell nothing in a month your status becomes inactive — you keep your account and your stock, and you reactivate by selling 10 bottles in a month, with no rejoining fee. Team Leaders who miss their requirements get a coaching month before reverting to Reseller, and can re-qualify at any time.</p>
      <h2>Earnings disclaimer</h2>
      <p>Mas'Mila does not guarantee any income. Earnings depend entirely on actual product sales by you and your team. Incentives are never paid on joining, registration, membership fees, buying a "position" or recruiting.</p>
      <div className="hero-actions"><Link className="btn-primary" href="/become-a-reseller">Apply now <ArrowRight size={15} /></Link><Link className="btn-ghost" href="/reseller-terms">Reseller terms</Link></div>
    </Page>
  );
}

function EnquiryForm({ kind }: { kind: 'corporate' | 'contact' }) {
  const submit = useSubmitEnquiry();
  const [form, setForm] = useState<EnquiryInput>({ kind, contactPerson: '', email: '', phone: '', message: '', companyName: '', quantity: null, productPreference: '', requiredDate: '', deliveryLocation: '', brandingRequirements: '' });
  const set = (k: keyof EnquiryInput, v: string | number | null) => setForm((f) => ({ ...f, [k]: v }));
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const clean = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v === '' ? null : v])) as EnquiryInput;
    submit.mutate({ data: { ...clean, message: form.message } });
  };
  if (submit.isSuccess) return <div className="form-card" style={{ textAlign: 'center' }} data-testid="state-enquiry-success"><Check size={30} color="hsl(var(--primary))" /><h2>Thank you — we'll be in touch within one business day.</h2></div>;
  const input = (k: keyof EnquiryInput, label: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}, full = false) => (
    <div className={`field ${full ? 'full' : ''}`}><label htmlFor={`enq-${k}`}>{label}</label><input id={`enq-${k}`} value={(form[k] as string | number | null) ?? ''} onChange={(e) => set(k, extra.type === 'number' ? (e.target.value ? Number(e.target.value) : null) : e.target.value)} {...extra} /></div>
  );
  return (
    <form className="form-card" onSubmit={onSubmit} data-testid={`form-${kind}`}>
      <h2>{kind === 'corporate' ? 'Request a quote' : 'Send us a message'}</h2>
      {submit.error ? <div className="form-message">{errorMessage(submit.error)}</div> : null}
      <div className="form-grid">
        {kind === 'corporate' ? input('companyName', 'Company name', { required: true }) : null}
        {input('contactPerson', 'Contact person', { required: true })}
        {input('email', 'Email', { type: 'email', required: true })}
        {input('phone', 'Telephone', { type: 'tel' })}
        {kind === 'corporate' ? <>
          {input('quantity', 'Quantity required', { type: 'number', min: 1, required: true })}
          {input('requiredDate', 'Required date', { type: 'date' })}
          {input('productPreference', 'Product / fragrance preference', {}, true)}
          {input('deliveryLocation', 'Delivery location')}
          {input('brandingRequirements', 'Branding requirements')}
        </> : null}
        <div className="field full"><label htmlFor="enq-message">Message</label><textarea id="enq-message" rows={4} required={kind === 'contact'} value={form.message} onChange={(e) => set('message', e.target.value)} /></div>
      </div>
      <div className="submit-row"><span className="count-label">We reply within one business day</span><button className="btn-primary" type="submit" disabled={submit.isPending}>{submit.isPending ? 'Sending…' : 'Send'} <ArrowRight size={15} /></button></div>
    </form>
  );
}

export function CorporatePage() {
  useSeo({ title: 'Corporate & bulk perfume orders — fragrance gifts', description: 'Corporate gifts, events and bulk perfume orders from Mas\'Mila. Branded fragrance gifts delivered anywhere in South Africa.' });
  return (
    <main className="container-wide form-shell">
      <div className="form-aside"><span className="eyebrow">Corporate & bulk orders</span><h1 className="display-lg">Fragrance gifts that get remembered.</h1><p className="body-lg">Client gifts, staff recognition, events and weddings. Volume pricing, custom sleeves and branded packaging available.</p><div className="aside-note">Tell us the quantity, preferred scents, date and delivery location — we'll respond with a quote and samples.</div></div>
      <EnquiryForm kind="corporate" />
    </main>
  );
}

export function ContactPage() {
  const config = useStoreConfig();
  useSeo({ title: 'Contact Mas\'Mila', description: 'Contact Mas\'Mila Fragrances by WhatsApp, email or phone.' });
  return (
    <main className="container-wide form-shell">
      <div className="form-aside"><span className="eyebrow">Contact</span><h1 className="display-lg">We're here to help.</h1><p className="body-lg">Questions about a fragrance, an order or becoming a reseller? WhatsApp is the fastest way to reach us.</p>
        {config.data?.whatsappNumber ? <a className="btn-primary" href={whatsappLink(config.data.whatsappNumber, "Hi Mas'Mila!")} target="_blank" rel="noreferrer"><MessageCircle size={15} /> CHAT ON WHATSAPP</a> : null}
        <div className="aside-note">Email: hello@masmila.co.za<br />Hours: Mon–Fri 08:00–17:00, Sat 09:00–13:00<br /><Link href="/track-order">Track an order →</Link></div>
      </div>
      <EnquiryForm kind="contact" />
    </main>
  );
}

const FAQS: Array<[string, string]> = [
  ['How long do Mas\'Mila fragrances last?', 'Our eau de parfums are formulated for 6–8 hours of wear on skin, longer on clothing. Longevity varies with skin type and climate.'],
  ['Which size should I choose?', '50ml is perfect for trying a new scent or gifting. 100ml is the best value for your signature fragrance.'],
  ['How much is delivery?', 'Delivery anywhere in South Africa is a flat fee, and free on orders above the free-delivery threshold shown at checkout. Most orders arrive in 2–5 business days.'],
  ['How do I pay?', 'Pay by EFT using your order number as reference, or by card / Instant EFT through our secure checkout where available.'],
  ['Can I return a fragrance?', 'Unopened products can be returned within 30 days. Faulty or damaged products are replaced or refunded. See Returns & Refunds.'],
  ['How do I become a reseller?', 'Apply online. Once approved you can order at reseller prices, starting with a 10-bottle opening order (mix any fragrances).'],
  ['Do I pay to join as a reseller?', 'No. There is no joining or membership fee, and no income is ever earned from recruiting — only from product sales.'],
  ['How do customers buy through my link?', 'Share your referral URL or QR code from the reseller portal. Online purchases through your link are credited to you for 30 days.'],
  ['What happens if I am inactive for a month?', 'You keep your account and stock. Sell 10 bottles in a month to reactivate — no rejoining fee.'],
];

export function FaqPage() {
  return (
    <Page eyebrow="FAQs" title="Good questions." seoTitle="Frequently asked questions" seoDescription="Answers about Mas'Mila fragrances, delivery, payments, returns and becoming a reseller."
      jsonLd={{ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: FAQS.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) }}>
      <div className="faq">{FAQS.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}</div>
    </Page>
  );
}

export function ShippingPage() {
  const config = useStoreConfig();
  return (
    <Page eyebrow="Shipping & delivery" title="Delivered across South Africa." seoTitle="Shipping & delivery" seoDescription="Mas'Mila delivers perfume nationwide across South Africa by courier.">
      <ul>
        <li>We deliver to street addresses in all nine provinces via our courier partners (e.g. The Courier Guy, Bob Go, Pargo pick-up points).</li>
        <li>Delivery fee: {config.data ? money(config.data.shippingFlatRate) : 'a flat fee'}; free on orders over {config.data ? money(config.data.freeShippingThreshold) : 'the free-delivery threshold'}.</li>
        <li>Orders are dispatched within 1–2 business days of payment reflecting. Typical delivery: 2–3 business days to main centres, 3–5 to regional areas.</li>
        <li>You'll receive tracking details by email and in your account once your order ships. You can also <Link href="/track-order">track your order</Link> with your order number.</li>
      </ul>
      {LEGAL_NOTE}
    </Page>
  );
}

export function ReturnsPage() {
  return (
    <Page eyebrow="Returns & refunds" title="Fair, simple returns." seoTitle="Returns & refunds" seoDescription="Mas'Mila return and refund policy under the Consumer Protection Act.">
      <ul>
        <li><strong>Change of mind:</strong> unopened, sealed products may be returned within 30 days of delivery for a refund of the product price.</li>
        <li><strong>Faulty or damaged goods:</strong> in line with the Consumer Protection Act, defective products may be returned within six months for a repair, replacement or refund.</li>
        <li>Contact us with your order number to arrange a return. Refunds are processed to the original payment method within 7–10 business days of receiving the return.</li>
        <li><strong>Resellers:</strong> refunds, cancellations, returns and chargebacks automatically reverse any related leadership incentives.</li>
      </ul>
      {LEGAL_NOTE}
    </Page>
  );
}

export function PrivacyPage() {
  return (
    <Page eyebrow="Privacy policy" title="Your information, protected." seoTitle="Privacy policy (POPIA)" seoDescription="How Mas'Mila collects, uses and protects personal information under POPIA.">
      <p>Mas'Mila Fragrances ("we") processes personal information in accordance with the Protection of Personal Information Act 4 of 2013 (POPIA).</p>
      <h2>What we collect</h2><p>Name, contact details, delivery addresses, order history, reseller application details, sales and team data, and — with consent — analytics and marketing cookie data.</p>
      <h2>Why</h2><p>To fulfil orders, provide customer and reseller accounts, calculate reseller sales and incentives, prevent fraud, meet legal and tax obligations, and — only if you opt in — send marketing.</p>
      <h2>Sharing</h2><p>With service providers who help us operate (hosting, payment gateways, couriers, email/WhatsApp messaging, analytics), under contract and only as needed. Resellers see limited information about customers they referred (first name, initial, area). We never sell personal information.</p>
      <h2>Your rights</h2><p>You may request access to, correction or deletion of your information, object to processing, and withdraw marketing consent at any time. Contact our Information Officer at privacy@masmila.co.za. You may also complain to the Information Regulator.</p>
      <h2>Security & retention</h2><p>Access is role-based and audited. Order and incentive records are retained as required for tax and audit purposes.</p>
      {LEGAL_NOTE}
    </Page>
  );
}

export function TermsPage() {
  return (
    <Page eyebrow="Terms & conditions" title="Terms of sale." seoTitle="Terms & conditions" seoDescription="Terms and conditions for buying from Mas'Mila Fragrances.">
      <ol>
        <li>All prices are in South African Rand (ZAR), including VAT where applicable, and may change without notice. The price at checkout applies.</li>
        <li>An order is accepted once payment is received. We may cancel orders affected by stock errors or suspected fraud, with a full refund.</li>
        <li>Products must be used as directed. Discontinue use if irritation occurs.</li>
        <li>Delivery, returns and privacy are governed by our Shipping, Returns and Privacy policies.</li>
        <li>These terms are governed by the laws of the Republic of South Africa, including the Consumer Protection Act and the Electronic Communications and Transactions Act.</li>
      </ol>
      {LEGAL_NOTE}
    </Page>
  );
}

export function ResellerTermsPage() {
  const config = useStoreConfig();
  return (
    <Page eyebrow="Reseller terms" title="Reseller terms & conditions." seoTitle="Reseller terms & conditions" seoDescription="Terms for independent Mas'Mila resellers, Team Leaders and Managers.">
      <ol>
        <li><strong>Independent reseller.</strong> Resellers are independent contractors, not employees or agents of Mas'Mila.</li>
        <li><strong>Approval.</strong> Mas'Mila may approve, decline or request more information on any application, and may place an account on review, hold or suspension for breach of these terms or suspected abuse.</li>
        <li><strong>No joining fee.</strong> There is no fee to join. The opening order ({config.data?.openingOrder ?? 10} bottles minimum) is a purchase of saleable stock at reseller prices.</li>
        <li><strong>Pricing.</strong> Reseller prices are confidential. Resellers are encouraged to sell at the recommended retail price.</li>
        <li><strong>Incentives are sales-based only.</strong> Leadership incentives are calculated solely on qualifying product sales. No payment is made for recruitment, joining, registration, membership fees or "positions".</li>
        <li><strong>Qualification.</strong> Ranks, requirements and percentages are published in the portal, may be changed by Mas'Mila with notice, and are evaluated per calendar month.</li>
        <li><strong>Refunds.</strong> Incentives on cancelled, refunded, returned or charged-back orders are reversed or deducted from future payouts.</li>
        <li><strong>Prohibited conduct.</strong> Self-referral, duplicate accounts, false information, income claims, and misrepresenting the product or the opportunity are prohibited.</li>
        <li><strong>Inactivity.</strong> Accounts with no sales in a month become inactive but are retained; reactivation requires the published sales threshold with no fee.</li>
      </ol>
      {LEGAL_NOTE}
    </Page>
  );
}

export function CookiesPage() {
  return (
    <Page eyebrow="Cookie policy" title="Cookies, explained." seoTitle="Cookie policy" seoDescription="How Mas'Mila uses cookies and similar technologies.">
      <p><strong>Essential:</strong> keep you signed in, remember your bag and your referral (the reseller link you arrived through, for 30 days).</p>
      <p><strong>Analytics & marketing (optional):</strong> Google Analytics, Meta Pixel and TikTok Pixel help us understand which products and campaigns work. These load only after you accept them in the cookie banner.</p>
      <p>You can change your choice by clearing site data in your browser.</p>
      {LEGAL_NOTE}
    </Page>
  );
}
