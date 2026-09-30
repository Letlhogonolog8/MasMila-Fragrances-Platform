/**
 * Referral attribution: a visit through /r/CODE (link, QR code or landing
 * page) or ?ref=CODE is remembered for 30 days and sent with checkout.
 */
const KEY = 'masmila.referral';
const TTL_MS = 30 * 24 * 3600 * 1000;

export type StoredReferral = { code: string; source: string; name: string | null; savedAt: number };

export function saveReferral(code: string, source: string, name: string | null) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ code: code.toUpperCase(), source, name, savedAt: Date.now() }));
  } catch { /* storage unavailable */ }
}

export function getReferral(): StoredReferral | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as StoredReferral;
    if (!value.code || Date.now() - value.savedAt > TTL_MS) {
      window.localStorage.removeItem(KEY);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function clearReferral() {
  try { window.localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}

export const referralUrl = (code: string, source?: string) =>
  `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, '')}/r/${code}${source ? `?src=${source}` : ''}`;
