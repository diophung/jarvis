import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Layout } from '../../components/Layout.js';
import type { AuthMethods } from '../../lib/auth.js';
import { AuthProvider, RequireAuth, safeReturnTo } from '../../lib/auth.js';
import { ForgotPasswordPage } from './ForgotPasswordPage.js';
import { SignInPage } from './SignInPage.js';
import { SignUpPage } from './SignUpPage.js';

const ISO = new Date('2026-06-01T08:00:00Z').toISOString();

const user = {
  id: 'u-1',
  email: 'jarvis@example.com',
  name: 'Jarvis User',
  hasPassword: true,
  role: 'owner',
  emailVerified: true,
  avatarUrl: null,
  lastLoginAt: ISO,
  createdAt: ISO,
  updatedAt: ISO,
};
const workspace = {
  id: 'ws-1',
  ownerUserId: 'u-1',
  name: 'Jarvis',
  createdAt: ISO,
  updatedAt: ISO,
};

function meBody(authMode: 'local' | 'password') {
  return { user, workspace, authMode };
}

function methods(over: Partial<AuthMethods> = {}): AuthMethods {
  return { authMode: 'password', signupEnabled: true, oauthProviders: ['google'], ...over };
}

// ---- fetch stub with status-code support (the shared govern/test-utils
// stub only does 200s; auth needs 401/429) -----------------------------

interface StubRoute {
  method?: string;
  /** Exact path (query string ignored) or RegExp against the full URL. */
  url: string | RegExp;
  reply: (url: string, init?: RequestInit) => { status?: number; data: unknown };
}

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

let calls: Call[] = [];

function stubFetch(routes: StubRoute[]) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      let body: unknown;
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      calls.push({ url, method, body });
      for (const route of routes) {
        if ((route.method ?? 'GET').toUpperCase() !== method) continue;
        const path = url.split('?')[0];
        const matched = typeof route.url === 'string' ? path === route.url : route.url.test(url);
        if (!matched) continue;
        const { status = 200, data } = route.reply(url, init);
        return {
          ok: status < 400,
          status,
          statusText: '',
          json: async () => data,
        } as unknown as Response;
      }
      // Incidental queries (conversations, approvals, llm status…) resolve quietly.
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ items: [] }),
      } as unknown as Response;
    }),
  );
}

const signedOut: StubRoute = {
  url: '/api/me',
  reply: () => ({ status: 401, data: { error: { code: 'unauthorized', message: 'Sign in' } } }),
};

function methodsRoute(m: AuthMethods): StubRoute {
  return { url: '/api/auth/methods', reply: () => ({ data: m }) };
}

// ---- render harness ---------------------------------------------------

function renderAt(initialPath: string, protectedElement = <div data-testid="protected" />) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <AuthProvider>
          <Routes>
            <Route path="/signin" element={<SignInPage />} />
            <Route path="/signup" element={<SignUpPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="*" element={<RequireAuth>{protectedElement}</RequireAuth>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('safeReturnTo', () => {
  it('allows only in-app absolute paths', () => {
    expect(safeReturnTo('/tasks?x=1')).toBe('/tasks?x=1');
    expect(safeReturnTo(null)).toBe('/');
    expect(safeReturnTo('')).toBe('/');
    expect(safeReturnTo('https://evil.example')).toBe('/');
    expect(safeReturnTo('//evil.example')).toBe('/');
    expect(safeReturnTo('/\\evil.example')).toBe('/');
  });
});

describe('SignInPage', () => {
  it('always shows all three providers; only configured ones are live links', async () => {
    stubFetch([signedOut, methodsRoute(methods({ oauthProviders: ['google'] }))]);
    renderAt('/signin');

    const google = await screen.findByRole('link', { name: /continue with google/i });
    expect(google).toHaveAttribute(
      'href',
      '/api/auth/oauth/google/start?returnTo=%2F',
    );
    // Unconfigured providers render as disabled buttons, not links.
    const facebook = screen.getByRole('button', { name: /continue with facebook/i });
    expect(facebook).toBeDisabled();
    expect(facebook).toHaveAttribute('title', expect.stringContaining("isn't configured"));
    expect(screen.getByRole('button', { name: /continue with apple/i })).toBeDisabled();
    expect(screen.queryByRole('link', { name: /facebook/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /apple/i })).not.toBeInTheDocument();
  });

  it('shows all providers disabled when none are configured', async () => {
    stubFetch([signedOut, methodsRoute(methods({ oauthProviders: [] }))]);
    renderAt('/signin');

    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByText('or')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /continue with/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /continue with facebook/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /continue with apple/i })).toBeDisabled();
  });

  it('shows the generic message on a failed login and keeps the cause private', async () => {
    stubFetch([
      signedOut,
      methodsRoute(methods()),
      {
        method: 'POST',
        url: '/api/auth/login',
        reply: () => ({
          status: 401,
          data: { error: { code: 'invalid_credentials', message: 'Invalid email or password' } },
        }),
      },
    ]);
    renderAt('/signin');

    await userEvent.type(await screen.findByLabelText('Email'), 'jarvis@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password.');
  });

  it('shows the rate-limit message on 429', async () => {
    stubFetch([
      signedOut,
      methodsRoute(methods()),
      {
        method: 'POST',
        url: '/api/auth/login',
        reply: () => ({
          status: 429,
          data: { error: { code: 'rate_limited', message: 'Too many attempts' } },
        }),
      },
    ]);
    renderAt('/signin');

    await userEvent.type(await screen.findByLabelText('Email'), 'jarvis@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'whatever-pass');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts — try again in a few minutes.',
    );
  });

  it('logs in and navigates to a validated returnTo', async () => {
    let loggedIn = false;
    stubFetch([
      {
        url: '/api/me',
        reply: () =>
          loggedIn
            ? { data: meBody('password') }
            : { status: 401, data: { error: { code: 'unauthorized', message: 'Sign in' } } },
      },
      methodsRoute(methods()),
      {
        method: 'POST',
        url: '/api/auth/login',
        reply: () => {
          loggedIn = true;
          return { data: { user } };
        },
      },
    ]);
    renderAt('/signin?returnTo=%2Ftasks');

    await userEvent.type(await screen.findByLabelText('Email'), 'jarvis@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct-horse');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByTestId('protected')).toBeInTheDocument();
    const login = calls.find((c) => c.method === 'POST' && c.url === '/api/auth/login');
    expect(login?.body).toEqual({ email: 'jarvis@example.com', password: 'correct-horse' });
  });

  it('maps ?error=email_unverified to the link-in-settings copy', async () => {
    stubFetch([signedOut, methodsRoute(methods())]);
    renderAt('/signin?error=email_unverified');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That email already has an account. Sign in with your password, then link this provider in Settings.',
    );
  });

  it('maps ?error=oauth_denied to the cancelled copy', async () => {
    stubFetch([signedOut, methodsRoute(methods())]);
    renderAt('/signin?error=oauth_denied');

    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in was cancelled.');
  });

  it('redirects home in local mode instead of showing the form', async () => {
    stubFetch([
      { url: '/api/me', reply: () => ({ data: meBody('local') }) },
      methodsRoute(methods({ authMode: 'local', signupEnabled: false, oauthProviders: [] })),
    ]);
    renderAt('/signin');

    expect(await screen.findByTestId('protected')).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });
});

describe('SignUpPage', () => {
  async function fillForm(passwords: { password: string; confirm: string }) {
    await userEvent.type(await screen.findByLabelText('Name'), 'New User');
    await userEvent.type(screen.getByLabelText('Email'), 'new@example.com');
    await userEvent.type(screen.getByLabelText('Password'), passwords.password);
    await userEvent.type(screen.getByLabelText('Confirm password'), passwords.confirm);
    await userEvent.click(screen.getByRole('checkbox'));
  }

  it('posts {email, name, password} and lands on the app', async () => {
    let loggedIn = false;
    stubFetch([
      {
        url: '/api/me',
        reply: () =>
          loggedIn
            ? { data: meBody('password') }
            : { status: 401, data: { error: { code: 'unauthorized', message: 'Sign in' } } },
      },
      methodsRoute(methods()),
      {
        method: 'POST',
        url: '/api/auth/register',
        reply: () => {
          loggedIn = true;
          return { data: { user } };
        },
      },
    ]);
    renderAt('/signup');

    await fillForm({ password: 'hunter2hunter2', confirm: 'hunter2hunter2' });
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url === '/api/auth/register');
      expect(post?.body).toEqual({
        email: 'new@example.com',
        name: 'New User',
        password: 'hunter2hunter2',
      });
    });
    expect(await screen.findByTestId('protected')).toBeInTheDocument();
  });

  it('blocks submit when the password confirmation does not match', async () => {
    stubFetch([signedOut, methodsRoute(methods())]);
    renderAt('/signup');

    await fillForm({ password: 'hunter2hunter2', confirm: 'different-pass' });
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Passwords do not match.');
    expect(calls.find((c) => c.url === '/api/auth/register')).toBeUndefined();
  });

  it('surfaces the generic registration error verbatim', async () => {
    stubFetch([
      signedOut,
      methodsRoute(methods()),
      {
        method: 'POST',
        url: '/api/auth/register',
        reply: () => ({
          status: 400,
          data: {
            error: { code: 'registration_failed', message: 'Could not create the account.' },
          },
        }),
      },
    ]);
    renderAt('/signup');

    await fillForm({ password: 'hunter2hunter2', confirm: 'hunter2hunter2' });
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not create the account.');
  });

  it('redirects to /signin when sign-ups are disabled', async () => {
    stubFetch([signedOut, methodsRoute(methods({ signupEnabled: false }))]);
    renderAt('/signup');

    expect(await screen.findByText('Sign in to Jarvis')).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });
});

describe('ForgotPasswordPage', () => {
  it('explains the CLI reset honestly instead of faking an email form', async () => {
    stubFetch([signedOut, methodsRoute(methods())]);
    renderAt('/forgot-password');

    expect(await screen.findByText(/doesn’t send email/)).toBeInTheDocument();
    expect(screen.getByText(/reset-password\.ts/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });
});

describe('RequireAuth', () => {
  it('redirects to /signin with returnTo when /api/me 401s in password mode', async () => {
    stubFetch([signedOut, methodsRoute(methods({ oauthProviders: ['google'] }))]);
    renderAt('/tasks?view=week');

    expect(await screen.findByText('Sign in to Jarvis')).toBeInTheDocument();
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument();
    // The attempted location rides along into the OAuth start href too.
    expect(screen.getByRole('link', { name: /continue with google/i })).toHaveAttribute(
      'href',
      `/api/auth/oauth/google/start?returnTo=${encodeURIComponent('/tasks?view=week')}`,
    );
  });

  it('does not redirect in local mode (auto-login)', async () => {
    stubFetch([
      { url: '/api/me', reply: () => ({ data: meBody('local') }) },
      methodsRoute(methods({ authMode: 'local', signupEnabled: false, oauthProviders: [] })),
    ]);
    renderAt('/tasks');

    expect(await screen.findByTestId('protected')).toBeInTheDocument();
    expect(screen.queryByText('Sign in to Jarvis')).not.toBeInTheDocument();
  });
});

describe('logout (sidebar user block)', () => {
  function renderShell() {
    return renderAt(
      '/',
      <Layout>
        <div data-testid="shell-content" />
      </Layout>,
    );
  }

  it('POSTs /api/auth/logout and navigates to /signin in password mode', async () => {
    stubFetch([
      { url: '/api/me', reply: () => ({ data: meBody('password') }) },
      methodsRoute(methods()),
      { method: 'POST', url: '/api/auth/logout', reply: () => ({ data: { ok: true } }) },
    ]);
    renderShell();

    // Sign out lives inside the account menu opened from the user-name block.
    await userEvent.click(await screen.findByRole('button', { name: 'Account menu' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Sign out/ }));

    await waitFor(() => {
      expect(calls.find((c) => c.method === 'POST' && c.url === '/api/auth/logout')).toBeTruthy();
    });
    expect(await screen.findByText('Sign in to Jarvis')).toBeInTheDocument();
    expect(screen.queryByTestId('shell-content')).not.toBeInTheDocument();
  });

  it('account menu in local mode explains auto-login instead of offering Sign out', async () => {
    stubFetch([
      { url: '/api/me', reply: () => ({ data: meBody('local') }) },
      methodsRoute(methods({ authMode: 'local', signupEnabled: false, oauthProviders: [] })),
    ]);
    renderShell();

    expect(await screen.findByText('local mode')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(await screen.findByText(/signed in automatically/)).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Sign out/ })).not.toBeInTheDocument();
    // Settings stays reachable from the menu in both modes.
    expect(screen.getByRole('menuitem', { name: /Account settings/ })).toBeInTheDocument();
  });
});
