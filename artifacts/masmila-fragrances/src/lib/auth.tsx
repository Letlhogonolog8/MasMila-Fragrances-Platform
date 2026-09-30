import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ClerkProvider, useAuth, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { useQueryClient } from '@tanstack/react-query';
import { getGetMeQueryKey, setAuthTokenGetter, useGetMe } from '@workspace/api-client-react';

export const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

// publishableKeyFromHost always derives a key from the hostname, so only use it
// when Clerk is actually configured — otherwise it points at clerk.<host>.
const configuredClerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
const clerkPubKey = configuredClerkKey ? publishableKeyFromHost(window.location.hostname, configuredClerkKey) : null;
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

/**
 * Clerk is used whenever a publishable key is configured. Without one (local
 * development / review), a demo sign-in lets you act as seeded accounts —
 * the API only honours demo tokens outside production.
 */
export const authMode: 'clerk' | 'demo' = clerkPubKey ? 'clerk' : 'demo';

type AuthApi = {
  mode: 'clerk' | 'demo';
  ready: boolean;
  signedIn: boolean;
  /** Clerk redirects to `redirectTo` (default home); demo mode leaves navigation to the caller. */
  signOut: (redirectTo?: string) => Promise<void>;
  /** Demo mode only. */
  demoSignIn: (email: string) => void;
};

const AuthContext = createContext<AuthApi | null>(null);

export function useAuthApi() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuthApi must be used inside <AppAuthProvider>');
  return ctx;
}

const DEMO_KEY = 'masmila.demoUser';

function readDemoUser() {
  try {
    return window.localStorage.getItem(DEMO_KEY);
  } catch {
    return null;
  }
}

function DemoAuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState<string | null>(readDemoUser);
  // Register synchronously so the very first /me request carries the token.
  setAuthTokenGetter(() => (email ? `demo:${encodeURIComponent(email)}` : null));
  const api = useMemo<AuthApi>(() => ({
    mode: 'demo',
    ready: true,
    signedIn: Boolean(email),
    signOut: async () => {
      try { window.localStorage.removeItem(DEMO_KEY); } catch { /* storage unavailable */ }
      setEmail(null);
      queryClient.clear();
    },
    demoSignIn: (next: string) => {
      try { window.localStorage.setItem(DEMO_KEY, next); } catch { /* storage unavailable */ }
      setEmail(next);
      queryClient.clear();
    },
  }), [email, queryClient]);
  return <AuthContext.Provider value={api}>{children}</AuthContext.Provider>;
}

function ClerkBridge({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const clerk = useClerk();
  const queryClient = useQueryClient();
  const previousUserId = useRef<string | null | undefined>(undefined);
  useEffect(() => clerk.addListener(({ user }) => {
    const userId = user?.id ?? null;
    if (previousUserId.current !== undefined && previousUserId.current !== userId) queryClient.clear();
    previousUserId.current = userId;
  }), [clerk, queryClient]);
  const api = useMemo<AuthApi>(() => ({
    mode: 'clerk',
    ready: isLoaded,
    signedIn: Boolean(isSignedIn),
    signOut: (redirectTo?: string) => clerk.signOut({ redirectUrl: `${basePath}${redirectTo ?? '/'}` }),
    demoSignIn: () => undefined,
  }), [clerk, isLoaded, isSignedIn]);
  return <AuthContext.Provider value={api}>{children}</AuthContext.Provider>;
}

export function AppAuthProvider({ children }: { children: ReactNode }) {
  if (authMode === 'demo') return <DemoAuthProvider>{children}</DemoAuthProvider>;
  return (
    <ClerkProvider
      publishableKey={clerkPubKey!}
      proxyUrl={clerkProxyUrl}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      appearance={{
        theme: shadcn,
        cssLayerName: 'clerk',
        options: { logoPlacement: 'inside', logoLinkUrl: basePath || '/', logoImageUrl: `${window.location.origin}${basePath}/logo.svg` },
        variables: { colorPrimary: '#c34e37', colorForeground: '#2d2738', colorMutedForeground: '#746d78', colorBackground: '#f8f2e9', colorInput: '#f8f2e9', colorInputForeground: '#2d2738', colorNeutral: '#d8cdbd', fontFamily: 'Manrope, sans-serif', borderRadius: '4px' },
        elements: { cardBox: 'bg-[#f8f2e9] rounded-xl w-[440px] max-w-full overflow-hidden', card: '!shadow-none !border-0 !bg-transparent', footer: '!shadow-none !border-0 !bg-transparent', formButtonPrimary: 'bg-[#c34e37] hover:bg-[#a9402f]', footerActionLink: 'text-[#c34e37]' },
      }}
    >
      <ClerkBridge>{children}</ClerkBridge>
    </ClerkProvider>
  );
}

/** The signed-in user's account, role and reseller record (from the API). */
export function useMe() {
  const auth = useAuthApi();
  const me = useGetMe({ query: { queryKey: getGetMeQueryKey(), enabled: auth.ready, staleTime: 30_000 } });
  return { ...me, auth };
}
