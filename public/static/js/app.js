/**
 * Klubz PWA - Mobile-First Application
 * Production-grade SPA rivaling Uber/Bolt/Lyft
 * ──────────────────────────────────────────────
 */

(function() {
  'use strict';

  // ═══ Configuration ═══
  const CONFIG = {
    API_BASE: window.location.origin + '/api',
    SW_PATH: '/sw.js',
    APP_VERSION: '3.0.0',
    TOKEN_KEY: 'klubz_access_token',
    REFRESH_KEY: 'klubz_refresh_token',
    THEME_KEY: 'klubz_theme',
    USER_KEY: 'klubz_user',
    TOAST_DURATION: 4000,
  };

  // ═══ State Management ═══
  const Store = {
    _state: {
      user: null,
      isAuthenticated: false,
      currentScreen: 'home',
      trips: [],
      notifications: [],
      theme: 'dark',
      isLoading: false,
      isOnline: navigator.onLine,
      matchConfig: null,
      matchResults: [],
    },
    _listeners: [],

    get state() { return this._state; },

    setState(updates) {
      Object.assign(this._state, updates);
      this._listeners.forEach(fn => fn(this._state));
    },

    subscribe(fn) {
      this._listeners.push(fn);
      return () => { this._listeners = this._listeners.filter(l => l !== fn); };
    },

    init() {
      const token = localStorage.getItem(CONFIG.TOKEN_KEY);
      const user = JSON.parse(localStorage.getItem(CONFIG.USER_KEY) || 'null');
      const theme = localStorage.getItem(CONFIG.THEME_KEY) || 'dark';

      this.setState({
        isAuthenticated: !!token,
        user,
        theme,
      });
      document.documentElement.setAttribute('data-theme', theme);
    }
  };

  // ═══ API Client ═══
  const API = {
    async request(method, endpoint, body = null, options = {}) {
      const token = localStorage.getItem(CONFIG.TOKEN_KEY);
      const headers = {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...options.headers,
      };

      try {
        const res = await fetch(`${CONFIG.API_BASE}${endpoint}`, {
          method,
          headers,
          body: body ? JSON.stringify(body) : null,
          signal: options.signal,
        });

        if (res.status === 401 && !options.skipRefresh) {
          const refreshed = await this.refreshToken();
          if (refreshed) return this.request(method, endpoint, body, { ...options, skipRefresh: true });
          Auth.logout();
          throw new Error('Session expired');
        }

        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || `Request failed (${res.status})`);
        return data;
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        throw err;
      }
    },

    get(endpoint, opts) { return this.request('GET', endpoint, null, opts); },
    post(endpoint, body, opts) { return this.request('POST', endpoint, body, opts); },
    put(endpoint, body, opts) { return this.request('PUT', endpoint, body, opts); },
    del(endpoint, opts) { return this.request('DELETE', endpoint, null, opts); },

    async refreshToken() {
      const refreshToken = localStorage.getItem(CONFIG.REFRESH_KEY);
      if (!refreshToken) return false;
      try {
        const data = await this.post('/auth/refresh', { refreshToken }, { skipRefresh: true });
        localStorage.setItem(CONFIG.TOKEN_KEY, data.accessToken);
        // Store rotated refresh token if server issued a new one
        if (data.refreshToken) localStorage.setItem(CONFIG.REFRESH_KEY, data.refreshToken);
        return true;
      } catch { return false; }
    }
  };

  // ═══ Authentication ═══
  const Auth = {
    async login(email, password, rememberMe = false) {
      Store.setState({ isLoading: true });
      try {
        const data = await API.post('/auth/login', { email, password, rememberMe });
        localStorage.setItem(CONFIG.TOKEN_KEY, data.accessToken);
        localStorage.setItem(CONFIG.REFRESH_KEY, data.refreshToken);
        localStorage.setItem(CONFIG.USER_KEY, JSON.stringify(data.user));
        Store.setState({ isAuthenticated: true, user: data.user, isLoading: false });
        Toast.show('Welcome back!', 'success');
        Router.navigate('home');
      } catch (err) {
        Store.setState({ isLoading: false });
        Toast.show(err.message || 'Login failed', 'error');
        throw err;
      }
    },

    async register(data) {
      Store.setState({ isLoading: true });
      try {
        const res = await API.post('/auth/register', data);
        Store.setState({ isLoading: false });
        Toast.show('Account created! Check your email to verify before logging in.', 'success');
        Router.navigate('login');
        return res;
      } catch (err) {
        Store.setState({ isLoading: false });
        Toast.show(err.message || 'Registration failed', 'error');
        throw err;
      }
    },

    logout() {
      const rt = localStorage.getItem(CONFIG.REFRESH_KEY);
      API.post('/auth/logout', rt ? { refreshToken: rt } : {}).catch(() => {});
      localStorage.removeItem(CONFIG.TOKEN_KEY);
      localStorage.removeItem(CONFIG.REFRESH_KEY);
      localStorage.removeItem(CONFIG.USER_KEY);
      Store.setState({ isAuthenticated: false, user: null });
      Router.navigate('login');
      Toast.show('Logged out', 'info');
    }
  };

  // ═══ Router ═══
  const Router = {
    navigate(screen) {
      Store.setState({ currentScreen: screen });
      window.history.pushState({ screen }, '', `/#${screen}`);
      Renderer.render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    init() {
      const hash = window.location.hash.replace('#', '') || 'home';
      Store.setState({ currentScreen: hash });
      window.addEventListener('popstate', (e) => {
        const screen = e.state?.screen || window.location.hash.replace('#', '') || 'home';
        Store.setState({ currentScreen: screen });
        Renderer.render();
      });
    }
  };

  // ═══ Toast Notifications ═══
  const Toast = {
    show(message, type = 'info') {
      const container = document.getElementById('toast-container');
      if (!container) return;

      const icons = {
        success: '<svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"/></svg>',
        error: '<svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"/></svg>',
        info: '<svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"/></svg>',
        warning: '<svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"/></svg>',
      };

      const toast = document.createElement('div');
      toast.className = `toast toast--${type}`;
      toast.innerHTML = `
        <span class="toast__icon" style="color:var(--${type === 'success' ? 'accent' : type === 'error' ? 'danger' : type === 'warning' ? 'warning' : 'primary'})">${icons[type]}</span>
        <span class="toast__message">${escapeHtml(message)}</span>
        <button class="toast__close" aria-label="Dismiss">&times;</button>
      `;
      toast.querySelector('.toast__close').addEventListener('click', () => toast.remove());
      container.appendChild(toast);
      setTimeout(() => toast.remove(), CONFIG.TOAST_DURATION);
    }
  };

  // ═══ Utility Functions ═══
  function escapeHtml(str) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(str).replace(/[&<>"']/g, c => map[c]);
  }

  function formatCurrency(amount, currency = 'ZAR') {
    return new Intl.NumberFormat('en-ZA', { style: 'currency', currency }).format(amount);
  }

  function formatDate(d) {
    return new Date(d).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function formatTime(d) {
    return new Date(d).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
  }

  function timeAgo(d) {
    const diff = Date.now() - new Date(d).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function getInitials(name) {
    return (name || 'U').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  }

  // ═══ SVG Icons ═══
  const Icons = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>',
    car: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m-4 0H3.6a.6.6 0 01-.6-.6v-3.8a.6.6 0 01.6-.6h2.154a.6.6 0 00.503-.272l2.09-3.221A.6.6 0 018.85 8H14.5l3.6 3.2h2.3a.6.6 0 01.6.6v4.6a.6.6 0 01-.6.6H19m0 0a2 2 0 10-4 0m4 0a2 2 0 11-4 0"/></svg>',
    trips: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg>',
    star: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87m-4-12a4 4 0 010 7.75"/></svg>',
    leaf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 8C8 10 5.9 16.17 3.82 21.34l1.89.66.95-2.3c.48.17.98.3 1.34.3C19 20 22 3 22 3c-1 2-8 2.25-13 3.25S2 11.5 2 13.5s1.75 3.75 1.75 3.75"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>',
    logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4m7 14l5-5-5-5m5 5H9"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    mapPin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',
  };

  // ═══ Geocoding ═══

  async function geocodeAddress(address) {
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`,
        { headers: { 'User-Agent': 'Klubz-Carpooling/3.0', 'Accept-Language': 'en' } }
      );
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.length) return null;
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    } catch {
      return null;
    }
  }

  // ═══ Screen Renderers ═══

  function renderLoginScreen() {
    return `
      <div class="auth-screen">
        <div class="auth-screen__header">
          <div class="auth-screen__logo">Klubz</div>
          <p class="auth-screen__subtitle">Smart carpooling for a greener commute</p>
        </div>

        <form id="login-form" novalidate>
          <div class="form-group">
            <label class="form-label" for="login-email">Email</label>
            <div class="input-group">
              <span class="input-group__icon">${Icons.user}</span>
              <input class="form-input" id="login-email" type="email" placeholder="you@company.com" required autocomplete="email" inputmode="email">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label" for="login-password">Password</label>
            <input class="form-input" id="login-password" type="password" placeholder="Enter your password" required autocomplete="current-password" minlength="8">
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-lg)">
            <label style="display:flex;align-items:center;gap:6px;font-size:0.8125rem;color:var(--text-secondary);cursor:pointer">
              <input type="checkbox" id="login-remember"> Remember me
            </label>
            <a href="#forgot-password" id="link-to-forgot" style="font-size:0.8125rem;font-weight:500">Forgot password?</a>
          </div>
          <button type="submit" class="btn btn--primary btn--full btn--lg" id="login-btn">
            ${Store.state.isLoading ? '<span class="animate-spin">&#9696;</span>' : 'Sign In'}
          </button>
        </form>

        <div class="auth-divider">or continue with</div>

        <button class="social-btn" style="margin-bottom:var(--space-sm)">
          <svg viewBox="0 0 24 24" width="20" height="20"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
          Google
        </button>

        <p style="text-align:center;margin-top:var(--space-lg);font-size:0.875rem;color:var(--text-secondary)">
          Don't have an account? <a href="#register" id="link-to-register" style="font-weight:600">Sign Up</a>
        </p>
      </div>
    `;
  }

  function renderRegisterScreen() {
    return `
      <div class="auth-screen">
        <div class="auth-screen__header">
          <div class="auth-screen__logo">Join Klubz</div>
          <p class="auth-screen__subtitle">Create your account to start carpooling</p>
        </div>

        <form id="register-form" novalidate>
          <div class="form-group">
            <label class="form-label" for="reg-name">Full Name</label>
            <input class="form-input" id="reg-name" type="text" placeholder="John Smith" required autocomplete="name" minlength="2">
          </div>
          <div class="form-group">
            <label class="form-label" for="reg-email">Email</label>
            <input class="form-input" id="reg-email" type="email" placeholder="you@company.com" required autocomplete="email" inputmode="email">
          </div>
          <div class="form-group">
            <label class="form-label" for="reg-phone">Phone (optional)</label>
            <input class="form-input" id="reg-phone" type="tel" placeholder="+27 81 555 1234" autocomplete="tel" inputmode="tel">
          </div>
          <div class="form-group">
            <label class="form-label" for="reg-password">Password</label>
            <input class="form-input" id="reg-password" type="password" placeholder="Min 8 characters" required autocomplete="new-password" minlength="8">
          </div>
          <div class="form-group">
            <label class="form-label">I want to</label>
            <div class="tabs" id="role-tabs">
              <button type="button" class="tab active" data-role="passenger">Ride</button>
              <button type="button" class="tab" data-role="driver">Drive</button>
            </div>
          </div>
          <button type="submit" class="btn btn--primary btn--full btn--lg" id="register-btn">Create Account</button>
        </form>

        <p style="text-align:center;margin-top:var(--space-lg);font-size:0.875rem;color:var(--text-secondary)">
          Already have an account? <a href="#login" id="link-to-login" style="font-weight:600">Sign In</a>
        </p>
      </div>
    `;
  }

  function renderHomeScreen() {
    const { user } = Store.state;
    const greeting = getGreeting();

    return `
      <div class="screen fade-in">
        <div style="margin-bottom:var(--space-xl)">
          <h2 style="font-size:1.5rem;font-weight:800;margin-bottom:2px">${greeting}${user ? ', ' + escapeHtml(user.name || user.email.split('@')[0]) : ''}</h2>
          <p style="color:var(--text-muted);font-size:0.875rem">Where are you heading today?</p>
        </div>

        <!-- Location Input (Uber-style) -->
        <div class="location-input-group" style="margin-bottom:var(--space-xl)">
          <div class="location-input">
            <div class="location-input__dot location-input__dot--pickup"></div>
            <input type="text" id="pickup-input" placeholder="Pickup location" autocomplete="off">
          </div>
          <div class="location-input">
            <div class="location-input__dot location-input__dot--dropoff"></div>
            <input type="text" id="dropoff-input" placeholder="Where to?" autocomplete="off">
          </div>
        </div>

        <!-- Quick Actions (Bolt-style) -->
        <div class="quick-actions">
          <div class="quick-action" data-action="find-ride">
            <div class="quick-action__icon quick-action__icon--ride">${Icons.search}</div>
            <span class="quick-action__label">Find a Ride</span>
            <span class="quick-action__desc">Match with drivers</span>
          </div>
          <div class="quick-action" data-action="offer-ride">
            <div class="quick-action__icon quick-action__icon--drive">${Icons.car}</div>
            <span class="quick-action__label">Offer a Ride</span>
            <span class="quick-action__desc">Drive & earn</span>
          </div>
          <div class="quick-action" data-action="my-trips">
            <div class="quick-action__icon quick-action__icon--schedule">${Icons.trips}</div>
            <span class="quick-action__label">My Trips</span>
            <span class="quick-action__desc">Upcoming & past</span>
          </div>
          <div class="quick-action" data-action="carbon">
            <div class="quick-action__icon quick-action__icon--carbon">${Icons.leaf}</div>
            <span class="quick-action__label">Impact</span>
            <span class="quick-action__desc">CO2 saved</span>
          </div>
        </div>

        <!-- Carbon Impact Widget -->
        <div class="carbon-widget">
          <div class="carbon-widget__value">25.1 <span class="carbon-widget__unit">kg CO2</span></div>
          <div class="carbon-widget__label">saved this month through carpooling</div>
        </div>

        <!-- Upcoming Trips -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-md)">
          <h3 class="section-title" style="margin-bottom:0">Upcoming Trips</h3>
          <a href="#my-trips" id="view-all-trips" style="font-size:0.8125rem;font-weight:600">View All</a>
        </div>

        <div id="upcoming-trips-container">
          <div class="skeleton" style="height:120px;margin-bottom:var(--space-md)"></div>
          <div class="skeleton" style="height:120px"></div>
        </div>

        <!-- Stats (populated by loadHomeStats) -->
        <h3 class="section-title" style="margin-top:var(--space-xl)">Your Stats</h3>
        <div id="home-stats-grid" class="stats-grid">
          <div class="stat-card"><div class="skeleton" style="height:60px"></div></div>
          <div class="stat-card"><div class="skeleton" style="height:60px"></div></div>
        </div>
      </div>
    `;
  }

  function renderFindRideScreen() {
    return `
      <div class="screen fade-in">
        <h2 class="section-title" style="font-size:1.25rem">Find a Ride</h2>
        <p class="section-subtitle">Smart matching finds the best carpool for your route</p>

        <form id="find-ride-form" novalidate>
          <div class="location-input-group" style="margin-bottom:var(--space-md)">
            <div class="location-input">
              <div class="location-input__dot location-input__dot--pickup"></div>
              <input type="text" id="fr-pickup" placeholder="Pickup location" required>
            </div>
            <div class="location-input">
              <div class="location-input__dot location-input__dot--dropoff"></div>
              <input type="text" id="fr-dropoff" placeholder="Dropoff location" required>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-sm);margin-bottom:var(--space-md)">
            <div class="form-group" style="margin:0">
              <label class="form-label">Date</label>
              <input class="form-input" type="date" id="fr-date" required>
            </div>
            <div class="form-group" style="margin:0">
              <label class="form-label">Time</label>
              <input class="form-input" type="time" id="fr-time" required>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">Seats needed</label>
            <div style="display:flex;gap:var(--space-sm)">
              ${[1,2,3,4].map(n => `<button type="button" class="btn btn--secondary btn--sm seat-btn${n===1?' active':''}" data-seats="${n}" style="flex:1">${n}</button>`).join('')}
            </div>
          </div>

          <button type="submit" class="btn btn--primary btn--full btn--lg" id="find-rides-btn">
            ${Icons.search} Find Matches
          </button>
        </form>

        <div id="match-results" style="margin-top:var(--space-xl)"></div>
      </div>
    `;
  }

  function renderOfferRideScreen() {
    return `
      <div class="screen fade-in">
        <h2 class="section-title" style="font-size:1.25rem">Offer a Ride</h2>
        <p class="section-subtitle">Share your commute, earn money, reduce emissions</p>

        <form id="offer-ride-form" novalidate>
          <div class="location-input-group" style="margin-bottom:var(--space-md)">
            <div class="location-input">
              <div class="location-input__dot location-input__dot--pickup"></div>
              <input type="text" id="or-departure" placeholder="Departure location" required>
            </div>
            <div class="location-input">
              <div class="location-input__dot location-input__dot--dropoff"></div>
              <input type="text" id="or-destination" placeholder="Destination" required>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-sm);margin-bottom:var(--space-md)">
            <div class="form-group" style="margin:0">
              <label class="form-label">Date</label>
              <input class="form-input" type="date" id="or-date" required>
            </div>
            <div class="form-group" style="margin:0">
              <label class="form-label">Departure Time</label>
              <input class="form-input" type="time" id="or-time" required>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-sm);margin-bottom:var(--space-md)">
            <div class="form-group" style="margin:0">
              <label class="form-label">Available Seats</label>
              <select class="form-input" id="or-seats">
                ${[1,2,3,4,5,6].map(n => `<option value="${n}"${n===3?' selected':''}>${n} seat${n>1?'s':''}</option>`).join('')}
              </select>
            </div>
            <div class="form-group" style="margin:0">
              <label class="form-label">Price (ZAR)</label>
              <input class="form-input" type="number" id="or-price" placeholder="35" min="0" step="5" inputmode="numeric">
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">Vehicle</label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-sm)">
              <input class="form-input" id="or-make" placeholder="Make" required>
              <input class="form-input" id="or-model" placeholder="Model" required>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">License Plate</label>
            <input class="form-input" id="or-plate" placeholder="ABC 123 GP" required style="text-transform:uppercase">
          </div>

          <div class="form-group">
            <label class="form-label">Notes (optional)</label>
            <textarea class="form-input" id="or-notes" placeholder="Air-conditioned, no smoking, etc." rows="2" style="resize:vertical"></textarea>
          </div>

          <button type="submit" class="btn btn--success btn--full btn--lg" id="offer-ride-btn">
            ${Icons.car} Publish Trip
          </button>
        </form>
      </div>
    `;
  }

  function renderMyTripsScreen() {
    return `
      <div class="screen fade-in">
        <h2 class="section-title" style="font-size:1.25rem">My Trips</h2>

        <div class="tabs" id="trips-tabs">
          <button class="tab active" data-tab="upcoming">Upcoming</button>
          <button class="tab" data-tab="completed">Completed</button>
          <button class="tab" data-tab="cancelled">Cancelled</button>
        </div>

        <div id="trips-list">
          <!-- Populated dynamically -->
          <div class="skeleton" style="height:140px;margin-bottom:var(--space-md)"></div>
          <div class="skeleton" style="height:140px;margin-bottom:var(--space-md)"></div>
        </div>
      </div>
    `;
  }

  function renderCarbonScreen() {
    return `
      <div class="screen fade-in">
        <h2 class="section-title" style="font-size:1.25rem">Environmental Impact</h2>
        <p class="section-subtitle">Your contribution to a greener planet</p>

        <div class="carbon-widget" style="margin-bottom:var(--space-lg)">
          <div style="font-size:3rem;margin-bottom:var(--space-sm)">&#127807;</div>
          <div class="carbon-widget__value">25.1 <span class="carbon-widget__unit">kg CO2</span></div>
          <div class="carbon-widget__label">total carbon emissions saved</div>
        </div>

        <div class="stats-grid" style="margin-bottom:var(--space-lg)">
          <div class="stat-card">
            <div class="stat-card__value" style="color:var(--accent)">12</div>
            <div class="stat-card__label">Trees Equivalent</div>
          </div>
          <div class="stat-card">
            <div class="stat-card__value" style="color:var(--primary)">1,250</div>
            <div class="stat-card__label">km Shared</div>
          </div>
          <div class="stat-card">
            <div class="stat-card__value" style="color:var(--warning)">42</div>
            <div class="stat-card__label">Trips Pooled</div>
          </div>
          <div class="stat-card">
            <div class="stat-card__value" style="color:#8B5CF6">0.6</div>
            <div class="stat-card__label">Cars Off Road</div>
          </div>
        </div>

        <div class="card">
          <h4 style="font-size:0.875rem;font-weight:600;margin-bottom:var(--space-md)">Monthly Breakdown</h4>
          <div id="carbon-chart" style="height:200px;display:flex;align-items:flex-end;gap:8px;padding-top:var(--space-md)">
            ${['Jan','Feb','Mar','Apr','May','Jun'].map((m, i) => {
              const h = [40, 55, 65, 50, 70, 85][i];
              return `<div style="flex:1;text-align:center">
                <div style="height:${h}%;background:linear-gradient(to top,var(--accent),var(--primary));border-radius:6px 6px 0 0;min-height:20px;transition:height 0.5s"></div>
                <div style="font-size:0.625rem;color:var(--text-muted);margin-top:4px">${m}</div>
              </div>`;
            }).join('')}
          </div>
        </div>
      </div>
    `;
  }

  function renderProfileScreen() {
    const { user } = Store.state;
    return `
      <div class="screen fade-in">
        <div style="text-align:center;margin-bottom:var(--space-xl)">
          <div class="avatar-sm" style="width:72px;height:72px;font-size:1.5rem;margin:0 auto var(--space-md)">${getInitials(user?.name || user?.email)}</div>
          <h2 style="font-size:1.25rem;font-weight:700">${escapeHtml(user?.name || 'User')}</h2>
          <p style="color:var(--text-muted);font-size:0.875rem">${escapeHtml(user?.email || '')}</p>
          <div style="display:flex;justify-content:center;gap:var(--space-sm);margin-top:var(--space-sm)">
            <span class="chip chip--active">${escapeHtml(user?.role || 'passenger')}</span>
          </div>
        </div>

        <div class="card" style="padding:0;overflow:hidden">
          <div class="list-item" id="profile-settings-item" style="cursor:pointer">
            <div class="list-item__icon" style="background:var(--primary-bg);color:var(--primary)">${Icons.settings}</div>
            <div class="list-item__content">
              <div class="list-item__title">Settings</div>
              <div class="list-item__subtitle">Notifications, privacy, preferences</div>
            </div>
            <div class="list-item__action">&rsaquo;</div>
          </div>
          <div class="list-item" id="profile-carbon-item" style="cursor:pointer">
            <div class="list-item__icon" style="background:rgba(16,185,129,0.12);color:var(--accent)">${Icons.leaf}</div>
            <div class="list-item__content">
              <div class="list-item__title">Carbon Impact</div>
              <div class="list-item__subtitle">25.1 kg CO2 saved</div>
            </div>
            <div class="list-item__action">&rsaquo;</div>
          </div>
          <div class="list-item" style="cursor:pointer">
            <div class="list-item__icon" style="background:rgba(139,92,246,0.12);color:#8B5CF6">${Icons.shield}</div>
            <div class="list-item__content">
              <div class="list-item__title">Security</div>
              <div class="list-item__subtitle">MFA, password, sessions</div>
            </div>
            <div class="list-item__action">&rsaquo;</div>
          </div>
          <div class="list-item" id="theme-toggle-item" style="cursor:pointer">
            <div class="list-item__icon" style="background:rgba(245,158,11,0.12);color:var(--warning)">${Store.state.theme === 'dark' ? Icons.sun : Icons.moon}</div>
            <div class="list-item__content">
              <div class="list-item__title">Theme</div>
              <div class="list-item__subtitle">${Store.state.theme === 'dark' ? 'Dark' : 'Light'} mode</div>
            </div>
            <div class="list-item__action" style="font-size:0.8125rem;color:var(--primary)">Toggle</div>
          </div>
        </div>

        <button class="btn btn--danger btn--full" style="margin-top:var(--space-xl)" id="logout-btn">
          ${Icons.logout} Sign Out
        </button>

        <p style="text-align:center;margin-top:var(--space-xl);font-size:0.75rem;color:var(--text-muted)">
          Klubz v${CONFIG.APP_VERSION} &middot; POPIA/GDPR Compliant
        </p>
      </div>
    `;
  }

  function renderSettingsScreen() {
    return `
      <div style="padding:var(--space-lg)">
        <div style="display:flex;align-items:center;gap:var(--space-md);margin-bottom:var(--space-xl)">
          <button class="icon-btn" id="settings-back-btn" style="background:none;border:none;cursor:pointer;font-size:1.5rem;color:var(--text-primary)">&#8592;</button>
          <h2 style="font-size:1.25rem;font-weight:700">Settings</h2>
        </div>
        <div class="card" style="margin-bottom:var(--space-md)">
          <h3 style="font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:var(--space-md)">Account</h3>
          <div style="display:flex;justify-content:space-between;align-items:center;padding:var(--space-md) 0;border-bottom:1px solid var(--border)">
            <span>${Icons.user} Edit Profile</span><span style="color:var(--text-muted)">&#8250;</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;padding:var(--space-md) 0">
            <span>${Icons.shield} Privacy &amp; Security</span><span style="color:var(--text-muted)">&#8250;</span>
          </div>
        </div>
        <div class="card" style="margin-bottom:var(--space-md)">
          <h3 style="font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:var(--space-md)">Appearance</h3>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span>${Store.state.theme === 'dark' ? Icons.moon : Icons.sun} ${Store.state.theme === 'dark' ? 'Dark' : 'Light'} Mode</span>
            <button class="btn btn--secondary btn--sm" id="settings-theme-btn">Toggle</button>
          </div>
        </div>
        <div class="card">
          <h3 style="font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:var(--space-md)">About</h3>
          <div style="color:var(--text-muted);font-size:0.875rem">Klubz v${CONFIG.APP_VERSION}</div>
        </div>
      </div>
    `;
  }

  function renderForgotPasswordScreen() {
    return `
      <div class="auth-screen">
        <div class="auth-screen__header">
          <div class="auth-screen__logo">Klubz</div>
          <p class="auth-screen__subtitle">Reset your password</p>
        </div>
        <form id="forgot-form" style="margin-top:var(--space-xl)">
          <div class="form-group" style="margin-bottom:var(--space-md)">
            <label class="form-label">Email Address</label>
            <input type="email" id="forgot-email" class="form-input" placeholder="your@email.com" required autocomplete="email">
          </div>
          <button type="submit" class="btn btn--primary btn--full btn--lg" id="forgot-btn">Send Reset Link</button>
        </form>
        <p style="text-align:center;margin-top:var(--space-lg);font-size:0.875rem;color:var(--text-secondary)">
          Remember your password? <a href="#login" id="link-forgot-to-login" style="font-weight:600">Sign In</a>
        </p>
      </div>
    `;
  }

  function renderResetPasswordScreen() {
    return `
      <div class="auth-screen">
        <div class="auth-screen__header">
          <div class="auth-screen__logo">Klubz</div>
          <p class="auth-screen__subtitle">Choose a new password</p>
        </div>
        <form id="reset-form" style="margin-top:var(--space-xl)">
          <div class="form-group" style="margin-bottom:var(--space-md)">
            <label class="form-label">New Password</label>
            <input type="password" id="reset-password" class="form-input" placeholder="At least 8 characters" minlength="8" required autocomplete="new-password">
          </div>
          <div class="form-group" style="margin-bottom:var(--space-md)">
            <label class="form-label">Confirm Password</label>
            <input type="password" id="reset-confirm" class="form-input" placeholder="Repeat new password" minlength="8" required autocomplete="new-password">
          </div>
          <button type="submit" class="btn btn--primary btn--full btn--lg" id="reset-btn">Set New Password</button>
        </form>
        <p style="text-align:center;margin-top:var(--space-lg);font-size:0.875rem;color:var(--text-secondary)">
          Remembered it? <a href="#login" id="link-reset-to-login" style="font-weight:600">Sign In</a>
        </p>
      </div>
    `;
  }

  function renderTripCard(trip) {
    const statusColors = { scheduled: 'active', active: 'live', completed: 'completed', pending: 'pending', cancelled: 'cancelled' };
    return `
      <div class="trip-card card--interactive" data-trip-id="${trip.id}">
        <div class="trip-card__header">
          <div class="trip-card__driver">
            <div class="trip-card__driver-avatar">${getInitials(trip.driverName || 'D')}</div>
            <div class="trip-card__driver-info">
              <h4>${escapeHtml(trip.driverName || 'Driver')}</h4>
              <div class="trip-card__driver-rating">
                ${Icons.star} ${trip.driverRating || '4.5'}
              </div>
            </div>
          </div>
          <div class="trip-card__price">
            <div class="trip-card__price-amount">${formatCurrency(trip.price || 0)}</div>
            <div class="trip-card__price-label">per seat</div>
          </div>
        </div>

        <div class="trip-card__route">
          <div class="trip-card__route-line">
            <div class="route-dot"></div>
            <div class="route-line-segment"></div>
            <div class="route-dot route-dot--end"></div>
          </div>
          <div class="trip-card__route-points">
            <div class="trip-card__route-point">
              <div class="trip-card__route-point-label">Pickup</div>
              <div class="trip-card__route-point-name">${escapeHtml(trip.pickupLocation?.address || trip.pickup || 'Location')}</div>
            </div>
            <div class="trip-card__route-point">
              <div class="trip-card__route-point-label">Dropoff</div>
              <div class="trip-card__route-point-name">${escapeHtml(trip.dropoffLocation?.address || trip.dropoff || 'Destination')}</div>
            </div>
          </div>
        </div>

        <div class="trip-card__meta">
          <div class="trip-card__meta-item">${Icons.clock} ${formatTime(trip.scheduledTime || trip.departureTime || new Date())}</div>
          <div class="trip-card__meta-item">${Icons.users} ${trip.availableSeats || 0} seats</div>
          <div class="trip-card__meta-item">${Icons.leaf} ${(trip.carbonSaved || 0).toFixed(1)} kg</div>
          <span class="chip chip--${statusColors[trip.status] || 'pending'}">${trip.status || 'pending'}</span>
        </div>
      </div>
    `;
  }

  function renderMatchResult(match) {
    const scoreClass = match.score <= 0.3 ? 'excellent' : match.score <= 0.6 ? 'good' : 'fair';
    const scoreLabel = match.score <= 0.3 ? 'Excellent' : match.score <= 0.6 ? 'Good' : 'Fair';
    const scorePercent = Math.round((1 - match.score) * 100);

    return `
      <div class="trip-card" style="border-left:3px solid var(--${scoreClass === 'excellent' ? 'accent' : scoreClass === 'good' ? 'primary' : 'warning'})">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-sm)">
          <span class="match-badge match-badge--${scoreClass}">${scoreLabel} Match (${scorePercent}%)</span>
          <span style="font-size:0.75rem;color:var(--text-muted)">${(match.breakdown?.detourDistanceKm || 0).toFixed(1)} km detour</span>
        </div>

        <div class="trip-card__route">
          <div class="trip-card__route-line">
            <div class="route-dot"></div>
            <div class="route-line-segment"></div>
            <div class="route-dot route-dot--end"></div>
          </div>
          <div class="trip-card__route-points">
            <div class="trip-card__route-point">
              <div class="trip-card__route-point-label">Pickup (${(match.breakdown?.pickupDistanceKm || 0).toFixed(1)} km)</div>
              <div class="trip-card__route-point-name">Near driver route</div>
            </div>
            <div class="trip-card__route-point">
              <div class="trip-card__route-point-label">Dropoff (${(match.breakdown?.dropoffDistanceKm || 0).toFixed(1)} km)</div>
              <div class="trip-card__route-point-name">Near destination</div>
            </div>
          </div>
        </div>

        <div class="trip-card__meta">
          <div class="trip-card__meta-item">${Icons.clock} ${(match.breakdown?.timeDiffMinutes || 0).toFixed(0)} min diff</div>
          <div class="trip-card__meta-item">${Icons.users} ${match.driverTrip?.availableSeats || 0} seats</div>
          <div class="trip-card__meta-item">${Icons.leaf} ${(match.carbonSavedKg || 0).toFixed(1)} kg saved</div>
        </div>

        ${match.explanation ? `<p style="font-size:0.75rem;color:var(--text-muted);margin-top:var(--space-sm);font-style:italic">"${escapeHtml(match.explanation)}"</p>` : ''}

        <button class="btn btn--primary btn--full confirm-match-btn" style="margin-top:var(--space-md)" data-match-id="${escapeHtml(match.matchId || '')}" data-driver-trip-id="${escapeHtml(match.driverTripId)}" data-rider-request-id="${escapeHtml(match.riderRequestId)}">
          Request This Ride
        </button>
      </div>
    `;
  }

  // ═══ Helpers ═══
  function getGreeting() {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  }

  // ═══ Renderer ═══
  // AbortController for the current screen's event listeners.
  // Aborted and replaced on every render so old listeners are cleaned up.
  let screenController = new AbortController();

  const Renderer = {
    render() {
      const { currentScreen, isAuthenticated } = Store.state;

      // Auth guard
      const publicScreens = ['login', 'register', 'forgot-password', 'reset-password'];
      if (!isAuthenticated && !publicScreens.includes(currentScreen)) {
        Router.navigate('login');
        return;
      }

      const content = document.getElementById('app-content');
      const nav = document.getElementById('bottom-nav');
      const header = document.getElementById('app-header');

      if (!content) return;

      const showChrome = isAuthenticated && !publicScreens.includes(currentScreen);
      if (header) header.style.display = showChrome ? '' : 'none';
      if (nav) nav.style.display = showChrome ? '' : 'none';

      // Render screen
      switch (currentScreen) {
        case 'login': content.innerHTML = renderLoginScreen(); break;
        case 'register': content.innerHTML = renderRegisterScreen(); break;
        case 'home': content.innerHTML = renderHomeScreen(); break;
        case 'find-ride': content.innerHTML = renderFindRideScreen(); break;
        case 'offer-ride': content.innerHTML = renderOfferRideScreen(); break;
        case 'my-trips': content.innerHTML = renderMyTripsScreen(); break;
        case 'carbon': content.innerHTML = renderCarbonScreen(); break;
        case 'profile': content.innerHTML = renderProfileScreen(); break;
        case 'settings': content.innerHTML = renderSettingsScreen(); break;
        case 'forgot-password': content.innerHTML = renderForgotPasswordScreen(); break;
        case 'reset-password': content.innerHTML = renderResetPasswordScreen(); break;
        default: content.innerHTML = renderHomeScreen(); break;
      }

      // Update nav active state
      document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.screen === currentScreen);
      });

      // Cancel all previous screen listeners then bind fresh ones
      screenController.abort();
      screenController = new AbortController();
      this.bindEvents(currentScreen, screenController.signal);
      this.loadScreenData(currentScreen);
    },

    bindEvents(screen, signal) {
      const on = (id, event, fn) => document.getElementById(id)?.addEventListener(event, fn, { signal });
      const onAll = (sel, event, fn) => document.querySelectorAll(sel).forEach(el => el.addEventListener(event, fn, { signal }));

      switch (screen) {
        case 'login':
          on('login-form', 'submit', handleLogin);
          on('link-to-register', 'click', (e) => { e.preventDefault(); Router.navigate('register'); });
          on('link-to-forgot', 'click', (e) => { e.preventDefault(); Router.navigate('forgot-password'); });
          break;
        case 'register':
          on('register-form', 'submit', handleRegister);
          on('link-to-login', 'click', (e) => { e.preventDefault(); Router.navigate('login'); });
          onAll('#role-tabs .tab', 'click', (e) => {
            document.querySelectorAll('#role-tabs .tab').forEach(t => t.classList.remove('active'));
            e.currentTarget.classList.add('active');
          });
          break;
        case 'find-ride': {
          on('find-ride-form', 'submit', handleFindRide);
          onAll('.seat-btn', 'click', (e) => {
            document.querySelectorAll('.seat-btn').forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
          });
          const dateInput = document.getElementById('fr-date');
          const timeInput = document.getElementById('fr-time');
          if (dateInput && !dateInput.value) dateInput.value = new Date().toISOString().split('T')[0];
          if (timeInput && !timeInput.value) timeInput.value = new Date().toTimeString().slice(0, 5);
          break;
        }
        case 'offer-ride': {
          on('offer-ride-form', 'submit', handleOfferRide);
          const orDate = document.getElementById('or-date');
          if (orDate && !orDate.value) orDate.value = new Date().toISOString().split('T')[0];
          break;
        }
        case 'my-trips':
          onAll('#trips-tabs .tab', 'click', (e) => {
            document.querySelectorAll('#trips-tabs .tab').forEach(t => t.classList.remove('active'));
            e.currentTarget.classList.add('active');
            loadTrips(e.currentTarget.dataset.tab);
          });
          break;
        case 'home':
          onAll('[data-action]', 'click', (e) => Router.navigate(e.currentTarget.dataset.action));
          on('view-all-trips', 'click', (e) => { e.preventDefault(); Router.navigate('my-trips'); });
          break;
        case 'profile':
          on('theme-toggle-item', 'click', toggleTheme);
          on('profile-settings-item', 'click', () => Router.navigate('settings'));
          on('profile-carbon-item', 'click', () => Router.navigate('carbon'));
          on('logout-btn', 'click', () => Auth.logout());
          break;
        case 'settings':
          on('settings-back-btn', 'click', () => Router.navigate('profile'));
          on('settings-theme-btn', 'click', toggleTheme);
          break;
        case 'forgot-password':
          on('forgot-form', 'submit', handleForgotPassword);
          on('link-forgot-to-login', 'click', (e) => { e.preventDefault(); Router.navigate('login'); });
          break;
        case 'reset-password':
          on('reset-form', 'submit', handleResetPassword);
          on('link-reset-to-login', 'click', (e) => { e.preventDefault(); Router.navigate('login'); });
          break;
      }
    },

    loadScreenData(screen) {
      switch (screen) {
        case 'home':
          loadUpcomingTrips();
          loadHomeStats();
          break;
        case 'my-trips': loadTrips('upcoming'); break;
      }
    }
  };

  // ═══ Event Handlers ═══

  async function handleForgotPassword(e) {
    e.preventDefault();
    const email = document.getElementById('forgot-email')?.value?.trim();
    if (!email) {
      Toast.show('Please enter your email address', 'warning');
      return;
    }
    const btn = document.getElementById('forgot-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="animate-spin">&#9696;</span> Sending...'; }
    try {
      await API.post('/auth/forgot-password', { email });
    } catch { /* intentionally swallow — show generic message for security */ }
    // Always show generic success to avoid email enumeration
    Toast.show('If that email is registered, a reset link has been sent.', 'success');
    Router.navigate('login');
    if (btn) { btn.disabled = false; btn.innerHTML = 'Send Reset Link'; }
  }

  async function handleResetPassword(e) {
    e.preventDefault();
    const password = document.getElementById('reset-password')?.value;
    const confirm = document.getElementById('reset-confirm')?.value;

    if (!password || password.length < 8) {
      Toast.show('Password must be at least 8 characters', 'warning');
      return;
    }
    if (password !== confirm) {
      Toast.show('Passwords do not match', 'warning');
      return;
    }

    // Read the reset token from the URL query string (?token=...)
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) {
      Toast.show('Invalid or missing reset link. Please request a new one.', 'error');
      Router.navigate('forgot-password');
      return;
    }

    const btn = document.getElementById('reset-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="animate-spin">&#9696;</span> Saving...'; }
    try {
      await API.post('/auth/reset-password', { token, newPassword: password });
      Toast.show('Password reset successful! Please log in.', 'success');
      Router.navigate('login');
    } catch (err) {
      Toast.show(err.message || 'Reset failed. The link may have expired.', 'error');
      if (btn) { btn.disabled = false; btn.innerHTML = 'Set New Password'; }
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    const email = document.getElementById('login-email')?.value?.trim();
    const password = document.getElementById('login-password')?.value;
    const remember = document.getElementById('login-remember')?.checked;

    if (!email || !password) {
      Toast.show('Please fill in all fields', 'warning');
      return;
    }

    try {
      await Auth.login(email, password, remember);
    } catch {}
  }

  async function handleRegister(e) {
    e.preventDefault();
    const name = document.getElementById('reg-name')?.value?.trim();
    const email = document.getElementById('reg-email')?.value?.trim();
    const phone = document.getElementById('reg-phone')?.value?.trim();
    const password = document.getElementById('reg-password')?.value;
    const role = document.querySelector('#role-tabs .tab.active')?.dataset?.role || 'passenger';

    if (!name || !email || !password) {
      Toast.show('Please fill in required fields', 'warning');
      return;
    }
    if (password.length < 8) {
      Toast.show('Password must be at least 8 characters', 'warning');
      return;
    }

    try {
      await Auth.register({ name, email, phone, password, role });
    } catch {}
  }

  async function handleFindRide(e) {
    e.preventDefault();
    const pickup = document.getElementById('fr-pickup')?.value?.trim();
    const dropoff = document.getElementById('fr-dropoff')?.value?.trim();
    const date = document.getElementById('fr-date')?.value;
    const time = document.getElementById('fr-time')?.value;
    const seats = parseInt(document.querySelector('.seat-btn.active')?.dataset?.seats || '1');

    if (!pickup || !dropoff) {
      Toast.show('Please enter pickup and dropoff locations', 'warning');
      return;
    }

    const resultsContainer = document.getElementById('match-results');
    if (resultsContainer) {
      resultsContainer.innerHTML = '<div class="skeleton" style="height:180px"></div>';
    }

    const btn = document.getElementById('find-rides-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="animate-spin">&#9696;</span> Searching...'; }

    try {
      // Geocode user-entered addresses to coordinates
      const [pickupCoords, dropoffCoords] = await Promise.all([
        geocodeAddress(pickup),
        geocodeAddress(dropoff),
      ]);
      if (!pickupCoords || !dropoffCoords) {
        Toast.show('Could not resolve one or both locations. Try a more specific address.', 'error');
        return;
      }

      // Use the smart matching API
      const timestamp = date && time ? new Date(`${date}T${time}`).getTime() : Date.now() + 3600000;
      const data = await API.post('/matching/find', {
        pickup: pickupCoords,
        dropoff: dropoffCoords,
        earliestDeparture: timestamp - 30 * 60000,
        latestDeparture: timestamp + 30 * 60000,
        seatsNeeded: seats,
      });

      if (resultsContainer) {
        if (data.matches && data.matches.length > 0) {
          resultsContainer.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-md)">
              <h3 class="section-title" style="margin:0">${data.matches.length} Match${data.matches.length > 1 ? 'es' : ''} Found</h3>
              <span style="font-size:0.75rem;color:var(--text-muted)">${data.stats?.candidatesTotal || 0} drivers searched</span>
            </div>
            ${data.matches.map(renderMatchResult).join('')}
          `;
          resultsContainer.querySelectorAll('.confirm-match-btn').forEach(btn => {
            btn.addEventListener('click', () => handleConfirmMatch(btn.dataset.matchId, btn.dataset.driverTripId, btn.dataset.riderRequestId));
          });
        } else {
          resultsContainer.innerHTML = `
            <div class="empty-state">
              <div class="empty-state__icon">&#128663;</div>
              <div class="empty-state__title">No Matches Found</div>
              <div class="empty-state__desc">Try adjusting your time window or locations. We'll notify you when new drivers match your route.</div>
              <button class="btn btn--secondary" id="no-match-home-btn">Back to Home</button>
            </div>
          `;
          document.getElementById('no-match-home-btn')?.addEventListener('click', () => {
            Router.navigate('home');
          });
        }
      }
    } catch (err) {
      if (resultsContainer) {
        resultsContainer.innerHTML = `
          <div class="empty-state">
            <div class="empty-state__icon">&#128663;</div>
            <div class="empty-state__title">No Rides Available</div>
            <div class="empty-state__desc">No drivers match your route right now. Try a different time or check back later.</div>
          </div>
        `;
      }
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = `${Icons.search} Find Matches`; }
    }
  }

  async function handleOfferRide(e) {
    e.preventDefault();
    const departure = document.getElementById('or-departure')?.value?.trim();
    const destination = document.getElementById('or-destination')?.value?.trim();
    const date = document.getElementById('or-date')?.value;
    const time = document.getElementById('or-time')?.value;
    const seats = parseInt(document.getElementById('or-seats')?.value || '3');
    const price = parseFloat(document.getElementById('or-price')?.value || '35');
    const make = document.getElementById('or-make')?.value?.trim();
    const model = document.getElementById('or-model')?.value?.trim();
    const plate = document.getElementById('or-plate')?.value?.trim();
    const notes = document.getElementById('or-notes')?.value?.trim();

    if (!departure || !destination || !date || !time || !make || !model || !plate) {
      Toast.show('Please fill in all required fields', 'warning');
      return;
    }

    const btn = document.getElementById('offer-ride-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="animate-spin">&#9696;</span> Publishing...'; }

    try {
      // Geocode driver's departure/destination addresses
      const [departureCoords, destinationCoords] = await Promise.all([
        geocodeAddress(departure),
        geocodeAddress(destination),
      ]);
      if (!departureCoords || !destinationCoords) {
        Toast.show('Could not resolve one or both locations. Try a more specific address.', 'error');
        return;
      }

      await API.post('/matching/driver-trips', {
        departure: departureCoords,
        destination: destinationCoords,
        departureTime: new Date(`${date}T${time}`).getTime(),
        arrivalTime: new Date(`${date}T${time}`).getTime() + 30 * 60000,
        availableSeats: seats,
        routePolyline: [],
        shiftLocation: departure,
      });
      Toast.show('Trip published successfully!', 'success');
      Router.navigate('my-trips');
    } catch (err) {
      Toast.show(err.message || 'Failed to publish trip', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = `${Icons.car} Publish Trip`; }
    }
  }

  async function handleConfirmMatch(matchId, driverTripId, riderRequestId) {
    if (!matchId || !driverTripId || !riderRequestId) {
      Toast.show('Match data missing. Please search again.', 'error');
      return;
    }
    try {
      await API.post('/matching/confirm', { matchId, driverTripId, riderRequestId });
      Toast.show('Ride confirmed! The driver will be notified.', 'success');
      Router.navigate('my-trips');
    } catch (err) {
      Toast.show(err.message || 'Failed to confirm ride. Please try again.', 'error');
    }
  }

  async function loadUpcomingTrips() {
    const container = document.getElementById('upcoming-trips-container');
    if (!container) return;

    try {
      const data = await API.get('/users/trips?status=scheduled&limit=3');
      if (data.trips && data.trips.length > 0) {
        container.innerHTML = data.trips.map(renderTripCard).join('');
      } else {
        container.innerHTML = `
          <div class="empty-state" style="padding:var(--space-lg) 0">
            <div class="empty-state__icon">&#128652;</div>
            <div class="empty-state__title">No Upcoming Trips</div>
            <div class="empty-state__desc">Find a ride or offer one to get started</div>
          </div>
        `;
      }
    } catch {
      container.innerHTML = `
        <div class="trip-card">
          <div class="trip-card__header">
            <div class="trip-card__driver">
              <div class="trip-card__driver-avatar">JS</div>
              <div class="trip-card__driver-info">
                <h4>John Smith</h4>
                <div class="trip-card__driver-rating">${Icons.star} 4.8</div>
              </div>
            </div>
            <div class="trip-card__price">
              <div class="trip-card__price-amount">${formatCurrency(45)}</div>
              <div class="trip-card__price-label">per seat</div>
            </div>
          </div>
          <div class="trip-card__route">
            <div class="trip-card__route-line">
              <div class="route-dot"></div>
              <div class="route-line-segment"></div>
              <div class="route-dot route-dot--end"></div>
            </div>
            <div class="trip-card__route-points">
              <div class="trip-card__route-point">
                <div class="trip-card__route-point-label">Pickup</div>
                <div class="trip-card__route-point-name">123 Main St, Johannesburg</div>
              </div>
              <div class="trip-card__route-point">
                <div class="trip-card__route-point-label">Dropoff</div>
                <div class="trip-card__route-point-name">456 Office Park, Sandton</div>
              </div>
            </div>
          </div>
          <div class="trip-card__meta">
            <div class="trip-card__meta-item">${Icons.clock} ${formatTime(new Date(Date.now() + 3600000))}</div>
            <div class="trip-card__meta-item">${Icons.users} 3 seats</div>
            <div class="trip-card__meta-item">${Icons.leaf} 2.1 kg</div>
            <span class="chip chip--active">Scheduled</span>
          </div>
        </div>
      `;
    }
  }

  async function loadHomeStats() {
    const grid = document.getElementById('home-stats-grid');
    if (!grid) return;
    const user = Store.state.user;
    if (!user?.id) return;
    try {
      const data = await API.get(`/users/${user.id}`);
      const stats = data.stats || {};
      const totalTrips = stats.totalTrips ?? 0;
      const rating = stats.rating ? Number(stats.rating).toFixed(1) : '—';
      grid.innerHTML = `
        <div class="stat-card">
          <div class="stat-card__value">${totalTrips}</div>
          <div class="stat-card__label">Total Trips</div>
        </div>
        <div class="stat-card">
          <div class="stat-card__value">${rating}</div>
          <div class="stat-card__label">Rating</div>
          <div class="stat-card__trend" style="color:var(--warning)">${rating !== '—' ? Icons.star : ''}</div>
        </div>
      `;
    } catch {
      grid.innerHTML = '';
    }
  }

  async function loadTrips(status) {
    const container = document.getElementById('trips-list');
    if (!container) return;

    container.innerHTML = '<div class="skeleton" style="height:140px;margin-bottom:var(--space-md)"></div>';

    try {
      const statusMap = { upcoming: 'scheduled', completed: 'completed', cancelled: 'cancelled' };
      const data = await API.get(`/users/trips?status=${statusMap[status] || ''}`);
      if (data.trips && data.trips.length > 0) {
        container.innerHTML = data.trips.map(renderTripCard).join('');
      } else {
        container.innerHTML = `
          <div class="empty-state">
            <div class="empty-state__icon">${status === 'completed' ? '&#9989;' : status === 'cancelled' ? '&#10060;' : '&#128652;'}</div>
            <div class="empty-state__title">No ${status} trips</div>
            <div class="empty-state__desc">${status === 'upcoming' ? 'Find a ride or offer one to get started' : `You don't have any ${status} trips yet`}</div>
          </div>
        `;
      }
    } catch {
      container.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:var(--space-xl)">Unable to load trips</p>';
    }
  }

  function toggleTheme() {
    const newTheme = Store.state.theme === 'dark' ? 'light' : 'dark';
    Store.setState({ theme: newTheme });
    localStorage.setItem(CONFIG.THEME_KEY, newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
    Renderer.render();
  }

  // ═══ PWA Install Prompt ═══
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    // Show install banner after 30 seconds
    setTimeout(() => {
      if (deferredPrompt) {
        Toast.show('Install Klubz for a better experience', 'info');
      }
    }, 30000);
  });

  // ═══ Online/Offline ═══
  window.addEventListener('online', () => {
    Store.setState({ isOnline: true });
    Toast.show('Back online', 'success');
  });

  window.addEventListener('offline', () => {
    Store.setState({ isOnline: false });
    Toast.show('You are offline', 'warning');
  });

  // ═══ App Shell ═══
  function renderAppShell() {
    const root = document.getElementById('app-root');
    if (!root) return;

    root.innerHTML = `
      <!-- Header -->
      <header class="app-header" id="app-header" style="display:none">
        <div style="display:flex;align-items:center;gap:var(--space-sm)">
          <span class="app-header__logo">K<span>lubz</span></span>
        </div>
        <div class="app-header__actions">
          <button class="header-btn" aria-label="Notifications" id="notifications-btn">
            ${Icons.bell}
            <span class="header-btn__badge">3</span>
          </button>
          <div class="avatar-sm" id="profile-avatar-btn" style="cursor:pointer" role="button" aria-label="Profile">
            ${getInitials(Store.state.user?.name || Store.state.user?.email || 'U')}
          </div>
        </div>
      </header>

      <!-- Toast container -->
      <div class="toast-container" id="toast-container"></div>

      <!-- Main content -->
      <main class="app-content" id="app-content"></main>

      <!-- Bottom Navigation -->
      <nav class="bottom-nav" id="bottom-nav" style="display:none" role="navigation" aria-label="Main navigation">
        <button class="nav-item active" data-screen="home" aria-label="Home">
          ${Icons.home}
          <span class="nav-item__label">Home</span>
        </button>
        <button class="nav-item" data-screen="find-ride" aria-label="Find Ride">
          ${Icons.search}
          <span class="nav-item__label">Find</span>
        </button>
        <button class="nav-item" data-screen="offer-ride" aria-label="Offer Ride">
          ${Icons.car}
          <span class="nav-item__label">Offer</span>
        </button>
        <button class="nav-item" data-screen="my-trips" aria-label="My Trips">
          ${Icons.trips}
          <span class="nav-item__label">Trips</span>
        </button>
        <button class="nav-item" data-screen="profile" aria-label="Profile">
          ${Icons.user}
          <span class="nav-item__label">Profile</span>
        </button>
      </nav>
    `;
  }

  // ═══ Service Worker Registration ═══
  async function registerSW() {
    if ('serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.register(CONFIG.SW_PATH, { scope: '/' });
        console.log('SW registered:', reg.scope);

        // Check for updates
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'activated') {
                Toast.show('App updated! Reload for latest version.', 'info');
              }
            });
          }
        });
      } catch (err) {
        console.warn('SW registration failed:', err);
      }
    }
  }

  // ═══ Shell-Level Event Bindings ═══
  // These elements are rendered once in renderAppShell() and persist across screen changes.
  function bindShellEvents() {
    // Bottom navigation — navigate to the screen stored in data-screen
    document.querySelectorAll('.nav-item[data-screen]').forEach(btn => {
      btn.addEventListener('click', () => {
        Router.navigate(btn.dataset.screen);
      });
    });

    // Notifications button in header
    document.getElementById('notifications-btn')?.addEventListener('click', () => {
      Toast.show('Notifications coming soon!', 'info');
    });

    // Profile avatar in header
    document.getElementById('profile-avatar-btn')?.addEventListener('click', () => {
      Router.navigate('profile');
    });
  }

  // ═══ Initialize App ═══
  function initApp() {
    Store.init();
    Router.init();
    renderAppShell();
    bindShellEvents();
    Renderer.render();
    registerSW();

    // Show success toast after email verification redirect (?verified=1)
    const params = new URLSearchParams(window.location.search);
    if (params.get('verified') === '1') {
      setTimeout(() => Toast.show('Email verified! You can now log in.', 'success'), 300);
      // Clean the query string without a page reload
      window.history.replaceState({}, '', window.location.hash || '/');
    }
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
})();
