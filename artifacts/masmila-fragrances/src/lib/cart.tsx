import { imageFor } from './bottle';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Product } from '@workspace/api-client-react';
import { track } from './analytics';

export type CartLine = {
  productId: number;
  slug: string;
  name: string;
  size: string;
  image: string;
  price: number;
  resellerPrice: number | null;
  quantity: number;
};

export type CartMode = 'retail' | 'reseller';

type CartApi = {
  lines: CartLine[];
  mode: CartMode;
  setMode: (mode: CartMode) => void;
  count: number;
  subtotal: number;
  add: (product: Product, quantity?: number) => void;
  setQuantity: (productId: number, quantity: number) => void;
  remove: (productId: number) => void;
  clear: () => void;
  unitPrice: (line: CartLine) => number;
  lastAdded: CartLine | null;
};

const CartContext = createContext<CartApi | null>(null);
const STORAGE_KEY = 'masmila.cart.v1';

function load(): { lines: CartLine[]; mode: CartMode } {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { lines: [], mode: 'retail' };
    const parsed = JSON.parse(raw) as { lines?: CartLine[]; mode?: CartMode };
    return { lines: Array.isArray(parsed.lines) ? parsed.lines : [], mode: parsed.mode === 'reseller' ? 'reseller' : 'retail' };
  } catch {
    return { lines: [], mode: 'retail' };
  }
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(load);
  const [lastAdded, setLastAdded] = useState<CartLine | null>(null);

  useEffect(() => {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
  }, [state]);

  const unitPrice = useCallback(
    (line: CartLine) => (state.mode === 'reseller' && line.resellerPrice != null ? line.resellerPrice : line.price),
    [state.mode],
  );

  const add = useCallback((product: Product, quantity = 1) => {
    const line: CartLine = {
      productId: product.id,
      slug: product.slug,
      name: product.name,
      size: product.size,
      image: imageFor(product),
      price: product.price,
      resellerPrice: product.resellerPrice,
      quantity,
    };
    setState((s) => {
      const existing = s.lines.find((l) => l.productId === product.id);
      const lines = existing
        ? s.lines.map((l) => (l.productId === product.id ? { ...l, quantity: Math.min(500, l.quantity + quantity), price: product.price, resellerPrice: product.resellerPrice } : l))
        : [...s.lines, line];
      return { ...s, lines };
    });
    setLastAdded(line);
    track('add_to_cart', { id: product.sku, name: product.name, price: product.price, quantity });
  }, []);

  const api = useMemo<CartApi>(() => ({
    lines: state.lines,
    mode: state.mode,
    setMode: (mode) => setState((s) => ({ ...s, mode })),
    count: state.lines.reduce((sum, l) => sum + l.quantity, 0),
    subtotal: state.lines.reduce((sum, l) => sum + unitPrice(l) * l.quantity, 0),
    add,
    setQuantity: (productId, quantity) =>
      setState((s) => ({ ...s, lines: s.lines.map((l) => (l.productId === productId ? { ...l, quantity: Math.max(1, Math.min(500, quantity)) } : l)) })),
    remove: (productId) => setState((s) => ({ ...s, lines: s.lines.filter((l) => l.productId !== productId) })),
    clear: () => setState((s) => ({ ...s, lines: [] })),
    unitPrice,
    lastAdded,
  }), [state, add, unitPrice, lastAdded]);

  return <CartContext.Provider value={api}>{children}</CartContext.Provider>;
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used inside <CartProvider>');
  return ctx;
}
