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
      activeChatTripId: null,
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
    patch(endpoint, body, opts) { return this.request('PATCH', endpoint, body, opts); },
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
        if (data.mfaRequired && data.mfaToken) {
          sessionStorage.setItem('mfaToken', data.mfaToken);
          Store.setState({ isLoading: false });
          Router.navigate('mfa-verify');
          return;
        }
        localStorage.setItem(CONFIG.TOKEN_KEY, data.accessToken);
        localStorage.setItem(CONFIG.REFRESH_KEY, data.refreshToken);
        localStorage.setItem(CONFIG.USER_KEY, JSON.stringify(data.user));
        Store.setState({ isAuthenticated: true, user: data.user, isLoading: false });
        const tosOk = await enforceTosAcceptance();
        if (!tosOk) return;
        Toast.show('Welcome back!', 'success');
        subscribeToNotifications();
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
    },

    // Exchanges the short-lived oauth_code (from the redirect URL query string)
    // for the Klubz token pair and logs the user in.
    async handleOAuthCallback(code) {
      try {
        const data = await API.get(`/auth/oauth-session?code=${encodeURIComponent(code)}`);
        localStorage.setItem(CONFIG.TOKEN_KEY, data.accessToken);
        localStorage.setItem(CONFIG.REFRESH_KEY, data.refreshToken);
        localStorage.setItem(CONFIG.USER_KEY, JSON.stringify(data.user));
        Store.setState({ isAuthenticated: true, user: data.user, isLoading: false });
        const tosOk = await enforceTosAcceptance();
        if (!tosOk) return;
        Toast.show('Signed in successfully!', 'success');
        subscribeToNotifications();
        Router.navigate('home');
      } catch {
        Toast.show('OAuth sign-in failed. Please try again.', 'error');
        Router.navigate('login');
      }
    }
  };

  async function enforceTosAcceptance() {
    try {
      const pendingVersion = localStorage.getItem('klubz_pending_tos_version');
      if (pendingVersion) {
        await API.post('/users/tos-accept', { tosVersion: pendingVersion });
        localStorage.removeItem('klubz_pending_tos_version');
      }

      const profile = await API.get('/users/profile');
      if (!profile?.tosVersionAccepted) {
        const accepted = await showConfirmDialog({
          title: 'Terms of Service',
          message: 'Please accept the Klubz Terms of Service to continue.',
          confirmText: 'Accept and Continue',
          cancelText: 'Sign Out',
        });
        if (!accepted) {
          Auth.logout();
          return false;
        }
        await API.post('/users/tos-accept', { tosVersion: '1.0' });
      }
      return true;
    } catch {
      return true;
    }
  }

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
      toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
      toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
      toast.setAttribute('aria-atomic', 'true');
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

  function trapFocus(containerEl, onClose) {
    const focusableSelector = [
      'a[href]',
      'button:not([disabled])',
      'textarea:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');

    const getFocusable = () =>
      Array.from(containerEl.querySelectorAll(focusableSelector)).filter((el) =>
        el instanceof HTMLElement && !el.hasAttribute('hidden') && el.offsetParent !== null
      );

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const focusable = getFocusable();
      if (!focusable.length) {
        e.preventDefault();
        containerEl.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    containerEl.addEventListener('keydown', onKeyDown);
    return () => containerEl.removeEventListener('keydown', onKeyDown);
  }

  function createDialogScaffold(title, bodyMarkup) {
    const titleId = `dialog-title-${Math.random().toString(36).slice(2, 8)}`;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:4000;padding:var(--space-lg)';
    overlay.innerHTML = `
      <div role="dialog" aria-modal="true" aria-labelledby="${titleId}" tabindex="-1" style="width:min(460px,100%);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:var(--space-lg);box-shadow:0 18px 60px rgba(0,0,0,.35)">
        <h3 id="${titleId}" style="font-size:1rem;font-weight:700;margin:0 0 var(--space-sm)">${escapeHtml(title)}</h3>
        ${bodyMarkup}
      </div>
    `;
    return overlay;
  }

  function showConfirmDialog({
    title,
    message,
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    danger = false,
  }) {
    return new Promise((resolve) => {
      const returnFocusEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const overlay = createDialogScaffold(
        title,
        `<p style="color:var(--text-secondary);margin:0 0 var(--space-lg)">${escapeHtml(message)}</p>
         <div style="display:flex;justify-content:flex-end;gap:var(--space-sm)">
           <button type="button" class="btn btn--secondary" data-dialog-cancel>${escapeHtml(cancelText)}</button>
           <button type="button" class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-dialog-confirm>${escapeHtml(confirmText)}</button>
         </div>`,
      );

      document.body.appendChild(overlay);
      const dialogEl = overlay.querySelector('[role="dialog"]');
      const cancelBtn = overlay.querySelector('[data-dialog-cancel]');
      const confirmBtn = overlay.querySelector('[data-dialog-confirm]');
      let closed = false;

      const close = (result) => {
        if (closed) return;
        closed = true;
        cleanupTrap();
        overlay.remove();
        if (returnFocusEl) returnFocusEl.focus();
        resolve(result);
      };

      const cleanupTrap = trapFocus(dialogEl, () => close(false));
      cancelBtn?.addEventListener('click', () => close(false));
      confirmBtn?.addEventListener('click', () => close(true));
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(false);
      });
      (confirmBtn || dialogEl).focus();
    });
  }

  function showPromptDialog({
    title,
    message,
    placeholder = '',
    confirmText = 'Submit',
    cancelText = 'Cancel',
    type = 'text',
    minLength = 0,
    multiline = false,
    trim = true,
  }) {
    return new Promise((resolve) => {
      const returnFocusEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const fieldMarkup = multiline
        ? `<textarea id="dialog-input" class="form-input" rows="4" placeholder="${escapeHtml(placeholder)}" style="resize:vertical"></textarea>`
        : `<input id="dialog-input" class="form-input" type="${escapeHtml(type)}" placeholder="${escapeHtml(placeholder)}">`;

      const overlay = createDialogScaffold(
        title,
        `<p style="color:var(--text-secondary);margin:0 0 var(--space-sm)">${escapeHtml(message)}</p>
         <div style="margin-bottom:var(--space-xs)">${fieldMarkup}</div>
         <p id="dialog-error" style="display:none;color:var(--danger);font-size:0.8125rem;margin:0 0 var(--space-md)"></p>
         <div style="display:flex;justify-content:flex-end;gap:var(--space-sm)">
           <button type="button" class="btn btn--secondary" data-dialog-cancel>${escapeHtml(cancelText)}</button>
           <button type="button" class="btn btn--primary" data-dialog-confirm>${escapeHtml(confirmText)}</button>
         </div>`,
      );

      document.body.appendChild(overlay);
      const dialogEl = overlay.querySelector('[role="dialog"]');
      const inputEl = overlay.querySelector('#dialog-input');
      const errorEl = overlay.querySelector('#dialog-error');
      const cancelBtn = overlay.querySelector('[data-dialog-cancel]');
      const confirmBtn = overlay.querySelector('[data-dialog-confirm]');
      let closed = false;

      const close = (result) => {
        if (closed) return;
        closed = true;
        cleanupTrap();
        overlay.remove();
        if (returnFocusEl) returnFocusEl.focus();
        resolve(result);
      };

      const cleanupTrap = trapFocus(dialogEl, () => close(null));

      const submit = () => {
        const rawValue = String(inputEl?.value || '');
        const value = trim ? rawValue.trim() : rawValue;
        if (minLength > 0 && value.length < minLength) {
          if (errorEl) {
            errorEl.textContent = `Please enter at least ${minLength} characters.`;
            errorEl.style.display = '';
          }
          inputEl?.setAttribute('aria-invalid', 'true');
          inputEl?.focus();
          return;
        }
        close(value || null);
      };

      cancelBtn?.addEventListener('click', () => close(null));
      confirmBtn?.addEventListener('click', submit);
      inputEl?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !multiline) {
          e.preventDefault();
          submit();
        }
      });
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(null);
      });
      (inputEl || dialogEl).focus();
    });
  }

  function renderRatingModal(tripId, driverName) {
    return `
      <form id="rating-form" data-trip-id="${tripId}">
        <p style="color:var(--text-secondary);margin:0 0 var(--space-sm)">
          Rate your completed trip with ${escapeHtml(driverName || 'your driver')}.
        </p>
        <p id="rating-stars-label" style="font-size:0.8125rem;color:var(--text-secondary);margin:0 0 6px">Select a star rating</p>
        <p id="rating-stars-hint" style="font-size:0.75rem;color:var(--text-muted);margin:0 0 var(--space-xs)">Use left and right arrow keys to adjust rating.</p>
        <div id="rating-stars" role="radiogroup" aria-labelledby="rating-stars-label" aria-describedby="rating-stars-hint" style="display:flex;gap:6px;margin-bottom:var(--space-sm)">
          ${[1, 2, 3, 4, 5].map((score) => `
            <button
              type="button"
              class="btn btn--secondary btn--sm rating-star-btn"
              data-score="${score}"
              role="radio"
              aria-checked="${score === 5 ? 'true' : 'false'}"
              aria-label="${score} star${score > 1 ? 's' : ''}"
              tabindex="${score === 5 ? '0' : '-1'}"
            >
              ${Icons.star}
            </button>
          `).join('')}
        </div>
        <textarea id="rating-comment" class="form-input" rows="3" maxlength="500" placeholder="Optional feedback"></textarea>
        <p id="rating-error" style="display:none;color:var(--danger);font-size:0.8125rem;margin:var(--space-xs) 0 0"></p>
        <div style="display:flex;justify-content:flex-end;gap:var(--space-sm);margin-top:var(--space-md)">
          <button type="button" class="btn btn--secondary" data-rating-cancel>Cancel</button>
          <button type="submit" class="btn btn--primary">Submit Rating</button>
        </div>
      </form>
    `;
  }

  function showRatingDialog(tripId, driverName) {
    return new Promise((resolve) => {
      const returnFocusEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const overlay = createDialogScaffold('Rate Trip', renderRatingModal(tripId, driverName));
      document.body.appendChild(overlay);

      const dialogEl = overlay.querySelector('[role="dialog"]');
      const formEl = overlay.querySelector('#rating-form');
      const stars = Array.from(overlay.querySelectorAll('.rating-star-btn'));
      const cancelBtn = overlay.querySelector('[data-rating-cancel]');
      const commentEl = overlay.querySelector('#rating-comment');
      const errorEl = overlay.querySelector('#rating-error');
      let selectedScore = 5;
      let closed = false;

      const updateStars = () => {
        stars.forEach((star) => {
          const score = Number(star.dataset.score || '0');
          const isActive = score <= selectedScore;
          star.setAttribute('aria-checked', score === selectedScore ? 'true' : 'false');
          star.setAttribute('tabindex', score === selectedScore ? '0' : '-1');
          star.style.background = isActive ? 'var(--warning)' : '';
          star.style.color = isActive ? '#111827' : '';
          star.style.borderColor = isActive ? 'var(--warning)' : '';
        });
      };

      const close = (result) => {
        if (closed) return;
        closed = true;
        cleanupTrap();
        overlay.remove();
        if (returnFocusEl) returnFocusEl.focus();
        resolve(result);
      };

      const cleanupTrap = trapFocus(dialogEl, () => close(null));

      const selectScore = (score) => {
        const nextScore = Math.max(1, Math.min(5, Number(score || 5)));
        selectedScore = nextScore;
        updateStars();
        const selected = stars.find((star) => Number(star.dataset.score || '0') === nextScore);
        selected?.focus();
      };

      stars.forEach((star) => {
        star.addEventListener('click', () => {
          selectScore(Number(star.dataset.score || '0'));
        });
        star.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
            e.preventDefault();
            selectScore(selectedScore + 1);
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
            e.preventDefault();
            selectScore(selectedScore - 1);
          } else if (e.key === 'Home') {
            e.preventDefault();
            selectScore(1);
          } else if (e.key === 'End') {
            e.preventDefault();
            selectScore(5);
          } else if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            selectScore(Number(star.dataset.score || '0'));
          }
        });
      });

      cancelBtn?.addEventListener('click', () => close(null));
      formEl?.addEventListener('submit', (e) => {
        e.preventDefault();
        if (selectedScore < 1 || selectedScore > 5) {
          if (errorEl) {
            errorEl.textContent = 'Please select a rating between 1 and 5 stars.';
            errorEl.style.display = '';
          }
          return;
        }
        close({
          rating: selectedScore,
          comment: String(commentEl?.value || '').trim(),
        });
      });
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(null);
      });

      updateStars();
      (stars[stars.length - 1] || dialogEl).focus();
    });
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

  // ═══ Client-side Haversine ═══

  function clientHaversineKm(lat1, lng1, lat2, lng2) {
    var R = 6371; // Earth radius in km
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLng = (lng2 - lng1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
    a = Math.min(a, 1); // clamp to avoid NaN from floating-point errors
    var c = 2 * Math.asin(Math.sqrt(a));
    return R * c;
  }

  // ═══ Polyline Decoder ═══
  function decodePolyline(encoded, precision) {
    const factor = Math.pow(10, Number.isFinite(precision) ? precision : 5);
    var points = [];
    var index = 0, lat = 0, lng = 0;
    while (index < encoded.length) {
      var b, shift = 0, result = 0;
      do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : result >> 1;
      shift = 0; result = 0;
      do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lng += (result & 1) ? ~(result >> 1) : result >> 1;
      points.push([lat / factor, lng / factor]);
    }
    return points;
  }

  // ═══ Map Manager (Leaflet) ═══
  const MapManager = {
    _maps: {},
    init(containerId, center, zoom) {
      if (!window.L) return;
      if (this._maps[containerId]) { this._maps[containerId].remove(); delete this._maps[containerId]; }
      const el = document.getElementById(containerId);
      if (!el) return;
      const map = window.L.map(el, { zoomControl: true }).setView(center || [-29.858, 31.029], zoom || 12);
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19,
      }).addTo(map);
      this._maps[containerId] = { map, markers: {}, route: null };
    },
    setRoute(containerId, polylinePoints) {
      const m = this._maps[containerId];
      if (!m || !window.L) return;
      if (m.route) { m.route.remove(); m.route = null; }
      if (!polylinePoints || !polylinePoints.length) return;
      m.route = window.L.polyline(polylinePoints, { color: '#3B82F6', weight: 4, opacity: 0.8 }).addTo(m.map);
    },
    setMarker(containerId, key, latlng, opts) {
      const m = this._maps[containerId];
      if (!m || !window.L) return;
      if (m.markers[key]) { m.markers[key].setLatLng(latlng); return; }
      const icon = opts && opts.icon === 'car'
        ? window.L.divIcon({ html: '<div style="background:#3B82F6;border-radius:50%;width:16px;height:16px;border:3px solid #fff;box-shadow:0 0 4px rgba(0,0,0,.4)"></div>', iconSize: [16, 16], iconAnchor: [8, 8] })
        : window.L.divIcon({ html: '<div style="background:#EF4444;border-radius:50%;width:14px;height:14px;border:2px solid #fff"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });
      m.markers[key] = window.L.marker(latlng, { icon }).addTo(m.map);
      if (opts && opts.label) m.markers[key].bindPopup(opts.label);
    },
    removeMarker(containerId, key) {
      const m = this._maps[containerId];
      if (!m || !m.markers[key]) return;
      m.markers[key].remove();
      delete m.markers[key];
    },
    fitRoute(containerId) {
      const m = this._maps[containerId];
      if (!m) return;
      if (m.route) { m.map.fitBounds(m.route.getBounds(), { padding: [20, 20] }); return; }
      const pts = Object.values(m.markers).map(mk => mk.getLatLng());
      if (pts.length > 1) m.map.fitBounds(window.L.latLngBounds(pts), { padding: [20, 20] });
    },
    destroy(containerId) {
      const m = this._maps[containerId];
      if (!m) return;
      m.map.remove();
      delete this._maps[containerId];
    },
  };

  // ═══ Notification Badge ═══
  const NotificationBadge = {
    _count: parseInt(localStorage.getItem('klubz_notif_count') || '0', 10),
    set(count) {
      this._count = Math.max(0, Number(count) || 0);
      localStorage.setItem('klubz_notif_count', String(this._count));
      const badge = document.querySelector('.header-btn__badge');
      if (badge) badge.textContent = String(this._count);
    },
    increment() {
      this.set(this._count + 1);
    },
    reset() {
      this.set(0);
    },
  };

  function formatNotificationTime(value) {
    if (!value) return 'Now';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Now';
    return date.toLocaleString('en-ZA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function renderNotificationRows(rows) {
    if (!rows.length) {
      return `
        <div style="padding:var(--space-md);text-align:center;color:var(--text-muted)">
          No notifications yet.
        </div>
      `;
    }

    return rows.map((item) => {
      const isRead = item.status === 'read';
      const createdAt = item.createdAt || item.sentAt || item.deliveredAt || item.readAt;
      return `
        <article
          class="notification-item"
          data-notification-id="${item.id}"
          style="padding:var(--space-sm) 0;border-bottom:1px solid var(--border);opacity:${isRead ? '0.7' : '1'}"
        >
          <div style="display:flex;justify-content:space-between;gap:var(--space-sm);align-items:flex-start">
            <div style="min-width:0">
              <div style="font-size:0.875rem;font-weight:${isRead ? '500' : '700'};line-height:1.35">
                ${escapeHtml(item.subject || 'Notification')}
              </div>
              <div style="font-size:0.8125rem;color:var(--text-secondary);margin-top:2px;line-height:1.4">
                ${escapeHtml(item.message || '')}
              </div>
              <div style="font-size:0.75rem;color:var(--text-muted);margin-top:4px">
                ${escapeHtml(formatNotificationTime(createdAt))}
              </div>
            </div>
            ${!isRead ? `<button type="button" class="btn btn--secondary btn--sm notif-read-btn" data-id="${item.id}">Mark read</button>` : ''}
          </div>
        </article>
      `;
    }).join('');
  }

  async function openNotificationsPanel() {
    const returnFocusEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = createDialogScaffold(
      'Notifications',
      `
        <div id="notifications-panel-status" style="display:none;font-size:0.8125rem;color:var(--danger);margin-bottom:var(--space-xs)"></div>
        <div id="notifications-panel-list" style="max-height:50vh;overflow:auto;border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:0 var(--space-xs)">
          <div class="skeleton" style="height:120px;margin:var(--space-sm) 0"></div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:var(--space-md);gap:var(--space-sm)">
          <button type="button" class="btn btn--secondary" id="notifications-read-all-btn">Mark all as read</button>
          <button type="button" class="btn btn--primary" id="notifications-close-btn">Close</button>
        </div>
      `,
    );

    document.body.appendChild(overlay);
    const dialogEl = overlay.querySelector('[role="dialog"]');
    const listEl = overlay.querySelector('#notifications-panel-list');
    const statusEl = overlay.querySelector('#notifications-panel-status');
    const closeBtn = overlay.querySelector('#notifications-close-btn');
    const readAllBtn = overlay.querySelector('#notifications-read-all-btn');
    let closed = false;

    const close = () => {
      if (closed) return;
      closed = true;
      cleanupTrap();
      overlay.remove();
      if (returnFocusEl) returnFocusEl.focus();
    };
    const cleanupTrap = trapFocus(dialogEl, close);

    const syncBadgeWithRows = (rows) => {
      const unread = rows.filter((item) => item.status !== 'read').length;
      NotificationBadge.set(unread);
    };

    const renderRows = (rows) => {
      if (!listEl) return;
      listEl.innerHTML = renderNotificationRows(rows);
    };

    const fetchNotifications = async () => {
      try {
        const data = await API.get('/notifications?limit=25&offset=0');
        const rows = Array.isArray(data?.data) ? data.data : [];
        Store.setState({ notifications: rows });
        syncBadgeWithRows(rows);
        renderRows(rows);
      } catch (err) {
        if (statusEl) {
          statusEl.textContent = err.message || 'Unable to load notifications.';
          statusEl.style.display = '';
        }
        if (listEl) {
          listEl.innerHTML = '<div style="padding:var(--space-md);color:var(--text-muted)">Unable to load notifications.</div>';
        }
      }
    };

    closeBtn?.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    readAllBtn?.addEventListener('click', async () => {
      try {
        await API.post('/notifications/read-all', {});
        const current = Array.isArray(Store.state.notifications) ? Store.state.notifications : [];
        const rows = current.map((item) => ({ ...item, status: 'read', readAt: item.readAt || new Date().toISOString() }));
        Store.setState({ notifications: rows });
        syncBadgeWithRows(rows);
        renderRows(rows);
      } catch (err) {
        if (statusEl) {
          statusEl.textContent = err.message || 'Unable to mark notifications as read.';
          statusEl.style.display = '';
        }
      }
    });

    listEl?.addEventListener('click', async (e) => {
      const target = e.target instanceof HTMLElement ? e.target.closest('.notif-read-btn') : null;
      if (!target) return;
      const id = Number(target.getAttribute('data-id'));
      if (!Number.isFinite(id) || id <= 0) return;
      target.setAttribute('disabled', 'true');
      try {
        await API.patch(`/notifications/${id}/read`, {});
        const current = Array.isArray(Store.state.notifications) ? Store.state.notifications : [];
        const rows = current.map((item) => (Number(item.id) === id
          ? { ...item, status: 'read', readAt: item.readAt || new Date().toISOString() }
          : item));
        Store.setState({ notifications: rows });
        syncBadgeWithRows(rows);
        renderRows(rows);
      } catch {
        target.removeAttribute('disabled');
      }
    });

    await fetchNotifications();
    (closeBtn || dialogEl)?.focus();
  }

  // ═══ SSE Client ═══
  const SSEClient = {
    _es: null,
    _retryMs: 3000,
    connect() {
      if (this._es) return;
      const token = localStorage.getItem(CONFIG.TOKEN_KEY);
      if (!token) return;
      this._es = new EventSource(`${CONFIG.API_BASE}/events?token=${encodeURIComponent(token)}`);
      this._es.onmessage = (e) => {
        try { this._handle(JSON.parse(e.data)); } catch { /* ignore parse errors */ }
      };
      this._es.onerror = () => {
        this.disconnect();
        setTimeout(() => this.connect(), this._retryMs);
      };
    },
    disconnect() {
      if (this._es) { this._es.close(); this._es = null; }
    },
    _handle(event) {
      switch (event.type) {
        case 'booking:accepted':
          Toast.show('Your booking was accepted!', 'success');
          if (Store.state.currentScreen === 'my-trips') loadTrips('upcoming');
          NotificationBadge.increment();
          break;
        case 'booking:requested':
          Toast.show('New booking request received', 'info');
          if (Store.state.currentScreen === 'my-trips') loadTrips('upcoming');
          NotificationBadge.increment();
          break;
        case 'booking:rejected':
          Toast.show('A booking was rejected', 'warning');
          break;
        case 'booking:cancelled':
          Toast.show('A booking was cancelled', 'info');
          if (Store.state.currentScreen === 'my-trips') loadTrips('upcoming');
          break;
        case 'trip:cancelled':
          Toast.show('A trip was cancelled', 'error');
          if (Store.state.currentScreen === 'my-trips') loadTrips('upcoming');
          break;
        case 'trip:arrived':
          Toast.show('A rider has arrived at the pickup point.', 'info');
          NotificationBadge.increment();
          break;
        case 'match:confirmed':
          Toast.show('Match confirmed!', 'success');
          break;
        case 'location:update':
          if (event.data && event.data.coords) {
            MapManager.setMarker('trip-map', 'driver', [event.data.coords.lat, event.data.coords.lng], { icon: 'car' });
          }
          break;
        case 'payment:succeeded':
          Toast.show('Payment successful!', 'success');
          break;
        case 'new_message':
          if (Store.state.currentScreen === 'chat' && Number(Store.state.activeChatTripId) === Number(event.data?.tripId)) {
            loadChatMessages();
          } else {
            Toast.show('New trip message received', 'info');
            incrementChatUnread(event.data?.tripId);
          }
          break;
        case 'waitlist:promoted':
          Toast.show('Good news: you have been promoted from the waitlist!', 'success');
          clearWaitlistEntry(event.data?.tripId);
          if (Store.state.currentScreen === 'my-trips') loadTrips('upcoming');
          break;
      }
    },
  };

  // ═══ Push Notifications ═══
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
  }

  async function subscribeToNotifications() {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return;
    if (Notification.permission === 'denied') return;
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return;
      const vapidData = await API.get('/push/vapid-key');
      if (!vapidData || !vapidData.publicKey) return;
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidData.publicKey),
      });
      await API.post('/push/subscribe', sub.toJSON());
    } catch { /* Push not supported or denied — silent fail */ }
  }

  // ═══ Location Sharing ═══
  let locationWatcher = null;
  let activeTripLocationPoll = null;
  let navigationProgressPoll = null;

  async function loadActiveTripLocation(tripId) {
    if (!tripId) return;
    try {
      const data = await API.get(`/trips/${tripId}/location`);
      const location = data?.location;
      if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') return;
      MapManager.setMarker('trip-map', 'driver', [location.lat, location.lng], { icon: 'car' });
    } catch {
      // best-effort only; SSE and retries will eventually catch up
    }
  }

  function startActiveTripLocationPolling(tripId) {
    stopActiveTripLocationPolling();
    if (!tripId) return;
    activeTripLocationPoll = setInterval(() => {
      loadActiveTripLocation(tripId);
    }, 10000);
  }

  function stopActiveTripLocationPolling() {
    if (activeTripLocationPoll !== null) {
      clearInterval(activeTripLocationPoll);
      activeTripLocationPoll = null;
    }
  }

  function updateNavigationProgressFromLocation(lat, lng) {
    const steps = Store.state.navSteps;
    if (!Array.isArray(steps) || !steps.length) return;
    const currentIdx = Math.max(0, Number(Store.state.navStepIndex || 0));
    let bestIdx = currentIdx;
    let bestDistanceKm = Number.POSITIVE_INFINITY;

    for (let i = currentIdx; i < steps.length; i++) {
      const loc = steps[i]?.location;
      if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') continue;
      const distanceKm = clientHaversineKm(lat, lng, loc.lat, loc.lng);
      if (distanceKm < bestDistanceKm) {
        bestDistanceKm = distanceKm;
        bestIdx = i;
      }
    }

    if (bestIdx > currentIdx && bestDistanceKm <= 0.25) {
      Store.setState({ navStepIndex: bestIdx });
      updateNavDisplay();
    }
  }

  async function refreshNavigationLocation(tripId) {
    if (!tripId) return;
    try {
      const data = await API.get(`/trips/${tripId}/location`);
      const location = data?.location;
      if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') return;
      MapManager.setMarker('nav-map', 'driver', [location.lat, location.lng], { icon: 'car' });
      updateNavigationProgressFromLocation(location.lat, location.lng);
    } catch {
      // best-effort
    }
  }

  function startNavigationProgressPolling(tripId) {
    stopNavigationProgressPolling();
    if (!tripId) return;
    refreshNavigationLocation(tripId);
    navigationProgressPoll = setInterval(() => {
      refreshNavigationLocation(tripId);
    }, 10000);
  }

  function stopNavigationProgressPolling() {
    if (navigationProgressPoll !== null) {
      clearInterval(navigationProgressPoll);
      navigationProgressPoll = null;
    }
  }

  function startLocationSharing(tripId) {
    if (!navigator.geolocation || locationWatcher !== null) return;
    locationWatcher = navigator.geolocation.watchPosition(
      async (pos) => {
        try {
          await API.post(`/trips/${tripId}/location`, {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            heading: pos.coords.heading,
            speed: pos.coords.speed,
          });
        } catch { /* best-effort */ }
      },
      null,
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 },
    );
  }
  function stopLocationSharing() {
    if (locationWatcher !== null) {
      navigator.geolocation.clearWatch(locationWatcher);
      locationWatcher = null;
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

        <button id="google-signin-btn" class="social-btn" style="margin-bottom:var(--space-sm)">
          <svg viewBox="0 0 24 24" width="20" height="20"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
          Continue with Google
        </button>
        <button id="apple-signin-btn" class="social-btn" style="margin-bottom:var(--space-sm)">
          <span style="font-size:1.125rem;line-height:1">&#63743;</span>
          Continue with Apple
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
            <div class="tabs" id="role-tabs" role="tablist" aria-label="Account role">
              <button type="button" class="tab active" data-role="passenger" role="tab" aria-selected="true" tabindex="0">Ride</button>
              <button type="button" class="tab" data-role="driver" role="tab" aria-selected="false" tabindex="-1">Drive</button>
            </div>
          </div>
          <div class="form-group" style="margin-top:var(--space-sm)">
            <label style="display:flex;gap:8px;align-items:flex-start;font-size:0.8125rem;color:var(--text-secondary)">
              <input type="checkbox" id="reg-tos" required style="margin-top:2px">
              <span>I agree to the Terms of Service and Privacy Policy.</span>
            </label>
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

        <div class="trip-type-selector" style="display:flex;gap:var(--space-sm);margin-bottom:var(--space-md)">
          <button type="button" class="trip-type-btn active" data-type="daily" id="find-daily-btn" style="flex:1;padding:var(--space-sm);border-radius:var(--radius);border:2px solid var(--primary);background:var(--primary-bg);color:var(--text-primary);cursor:pointer;font-size:0.875rem;font-weight:600">
            Daily <span class="rate-badge" style="font-size:0.75rem;font-weight:400;color:var(--text-secondary)">R2.85/km</span>
          </button>
          <button type="button" class="trip-type-btn" data-type="monthly" id="find-monthly-btn" style="flex:1;padding:var(--space-sm);border-radius:var(--radius);border:2px solid var(--border);background:transparent;cursor:pointer;font-size:0.875rem;font-weight:600;color:var(--text-primary)">
            Monthly <span class="rate-badge" style="font-size:0.75rem;font-weight:400;color:var(--text-secondary)">R2.15/km</span>
          </button>
        </div>

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
              <label class="form-label" for="fr-date">Date</label>
              <input class="form-input" type="date" id="fr-date" required>
            </div>
            <div class="form-group" style="margin:0">
              <label class="form-label" for="fr-time">Time</label>
              <input class="form-input" type="time" id="fr-time" required>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">Seats needed</label>
            <div style="display:flex;gap:var(--space-sm)">
              ${[1,2,3,4].map(n => `<button type="button" class="btn btn--secondary btn--sm seat-btn${n===1?' active':''}" data-seats="${n}" style="flex:1">${n}</button>`).join('')}
            </div>
          </div>

          <div class="card" style="margin-bottom:var(--space-md)">
            <div style="font-size:0.8125rem;color:var(--text-muted);margin-bottom:var(--space-xs)">Have a promo code?</div>
            <div style="display:flex;gap:var(--space-sm)">
              <input class="form-input" id="promo-input" placeholder="Enter code">
              <button type="button" class="btn btn--secondary btn--sm" id="promo-apply-btn">Apply</button>
            </div>
            <div id="promo-status" style="font-size:0.75rem;color:var(--text-muted);margin-top:6px"></div>
          </div>

          <button type="submit" class="btn btn--primary btn--full btn--lg" id="find-rides-btn">
            ${Icons.search} Find Matches
          </button>
        </form>

        <div id="fr-map" class="map-container" style="display:none"></div>
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
              <label class="form-label" for="or-date">Date</label>
              <input class="form-input" type="date" id="or-date" required>
            </div>
            <div class="form-group" style="margin:0">
              <label class="form-label" for="or-time">Departure Time</label>
              <input class="form-input" type="time" id="or-time" required>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-sm);margin-bottom:var(--space-md)">
            <div class="form-group" style="margin:0">
              <label class="form-label" for="or-seats">Available Seats</label>
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
        <div id="or-map" class="map-container" style="margin-top:var(--space-md);display:none"></div>
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

        <div id="my-trips-sub-section" style="margin-top:var(--space-xl)">
          <h3 class="section-title" style="font-size:1rem;margin-bottom:var(--space-md)">Monthly Subscription</h3>
          <p class="loading-text" style="color:var(--text-muted);text-align:center">Loading...</p>
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
          <div class="carbon-widget__value"><span id="carbon-saved-value">—</span> <span class="carbon-widget__unit">kg CO₂</span></div>
          <div class="carbon-widget__label">total carbon emissions saved</div>
        </div>

        <div class="stats-grid" style="margin-bottom:var(--space-lg)">
          <div class="stat-card">
            <div class="stat-card__value" style="color:var(--accent)" id="carbon-trees">—</div>
            <div class="stat-card__label">Trees Equivalent</div>
          </div>
          <div class="stat-card">
            <div class="stat-card__value" style="color:var(--primary)" id="carbon-km">—</div>
            <div class="stat-card__label">km Shared</div>
          </div>
          <div class="stat-card">
            <div class="stat-card__value" style="color:var(--warning)" id="carbon-trips">—</div>
            <div class="stat-card__label">Trips Pooled</div>
          </div>
          <div class="stat-card">
            <div class="stat-card__value" style="color:#8B5CF6" id="carbon-cars">—</div>
            <div class="stat-card__label">Cars Off Road</div>
          </div>
        </div>

        <div class="card">
          <h4 style="font-size:0.875rem;font-weight:600;margin-bottom:var(--space-md)">Your Impact</h4>
          <div id="carbon-impact-detail" style="color:var(--text-muted);font-size:0.875rem;text-align:center;padding:var(--space-md) 0">
            Loading your carbon data…
          </div>
        </div>
      </div>
    `;
  }

  function renderProfileScreen() {
    const { user } = Store.state;
    return `
      <div class="screen fade-in">
        <div style="text-align:center;margin-bottom:var(--space-lg)">
          <div class="avatar-sm" style="width:72px;height:72px;font-size:1.5rem;margin:0 auto var(--space-md)">${getInitials(user?.name || user?.email)}</div>
          <h2 style="font-size:1.25rem;font-weight:700">${escapeHtml(user?.name || 'User')}</h2>
          <p style="color:var(--text-muted);font-size:0.875rem">${escapeHtml(user?.email || '')}</p>
          <div style="display:flex;justify-content:center;gap:var(--space-sm);margin-top:var(--space-sm)">
            <span class="chip chip--active">${escapeHtml(user?.role || 'passenger')}</span>
          </div>
        </div>

        <div id="profile-stats" class="stats-grid" style="margin-bottom:var(--space-lg)">
          <div class="stat-card"><div class="skeleton" style="height:40px"></div></div>
          <div class="stat-card"><div class="skeleton" style="height:40px"></div></div>
          <div class="stat-card"><div class="skeleton" style="height:40px"></div></div>
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
              <div class="list-item__subtitle" id="profile-carbon-subtitle">Loading…</div>
            </div>
            <div class="list-item__action">&rsaquo;</div>
          </div>
          <div class="list-item" id="profile-security-item" style="cursor:pointer">
            <div class="list-item__icon" style="background:rgba(139,92,246,0.12);color:#8B5CF6">${Icons.shield}</div>
            <div class="list-item__content">
              <div class="list-item__title">Security</div>
              <div class="list-item__subtitle">MFA, password, sessions</div>
            </div>
            <div class="list-item__action">&rsaquo;</div>
          </div>
          <div class="list-item" id="profile-docs-item" style="cursor:pointer">
            <div class="list-item__icon" style="background:rgba(59,130,246,0.12);color:var(--primary)">${Icons.check}</div>
            <div class="list-item__content">
              <div class="list-item__title">Driver Documents</div>
              <div class="list-item__subtitle">Upload license and verification docs</div>
            </div>
            <div class="list-item__action">&rsaquo;</div>
          </div>
          <div class="list-item" id="profile-earnings-item" style="cursor:pointer">
            <div class="list-item__icon" style="background:rgba(16,185,129,0.12);color:var(--accent)">${Icons.star}</div>
            <div class="list-item__content">
              <div class="list-item__title">Earnings</div>
              <div class="list-item__subtitle">Driver trip earnings summary</div>
            </div>
            <div class="list-item__action">&rsaquo;</div>
          </div>
          <div class="list-item" id="profile-payouts-item" style="cursor:pointer">
            <div class="list-item__icon" style="background:rgba(59,130,246,0.12);color:var(--primary)">${Icons.settings}</div>
            <div class="list-item__content">
              <div class="list-item__title">Payouts</div>
              <div class="list-item__subtitle">Stripe Connect onboarding and status</div>
            </div>
            <div class="list-item__action">&rsaquo;</div>
          </div>
          <div class="list-item" id="profile-referral-item" style="cursor:pointer">
            <div class="list-item__icon" style="background:rgba(245,158,11,0.12);color:var(--warning)">${Icons.plus}</div>
            <div class="list-item__content">
              <div class="list-item__title">Referral & Points</div>
              <div class="list-item__subtitle">Invite friends and earn rewards</div>
            </div>
            <div class="list-item__action">&rsaquo;</div>
          </div>
          <div class="list-item" id="profile-org-item" style="cursor:pointer">
            <div class="list-item__icon" style="background:rgba(99,102,241,0.14);color:#6366F1">${Icons.users}</div>
            <div class="list-item__content">
              <div class="list-item__title">Organization</div>
              <div class="list-item__subtitle">Create or join a team</div>
            </div>
            <div class="list-item__action">&rsaquo;</div>
          </div>
          <div class="list-item" id="theme-toggle-item" style="cursor:pointer">
            <div class="list-item__icon" style="background:rgba(245,158,11,0.12);color:var(--warning)">${Store.state.theme === 'dark' ? Icons.sun : Icons.moon}</div>
            <div class="list-item__content">
              <div class="list-item__title">Theme</div>
              <div class="list-item__subtitle">${Store.state.theme === 'dark' ? 'Dark' : 'Light'} mode</div>
            </div>
            <div class="list-item__action" style="font-size:0.8125rem;color:var(--primary-light)">Toggle</div>
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
    const user = Store.state.user || {};
    const mfaEnabled = !!(user.mfaEnabled || user.mfa_enabled);

    return `
      <div style="padding:var(--space-lg)">
        <div style="display:flex;align-items:center;gap:var(--space-md);margin-bottom:var(--space-xl)">
          <button class="icon-btn" id="settings-back-btn" aria-label="Back" style="background:none;border:none;cursor:pointer;font-size:1.5rem;color:var(--text-primary)">&#8592;</button>
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
          <h3 style="font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:var(--space-md)">Account Security</h3>
          ${mfaEnabled
            ? '<button class="btn btn--danger btn--full" id="settings-mfa-disable-btn">Disable Two-Factor Auth</button>'
            : '<button class="btn btn--primary btn--full" id="settings-mfa-enable-btn">Enable Two-Factor Auth</button>'
          }
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

  function renderSubscriptionScreen() {
    var now = new Date();
    var thisYear = now.getFullYear();
    var thisMonth = now.getMonth(); // 0-indexed
    // Build month options: current month and next month
    var months = [];
    for (var mi = 0; mi < 2; mi++) {
      var d = new Date(thisYear, thisMonth + mi, 1);
      var y = d.getFullYear();
      var m = String(d.getMonth() + 1).padStart(2, '0');
      var label = d.toLocaleString('default', { month: 'long', year: 'numeric' });
      months.push({ value: y + '-' + m, label: label });
    }
    var monthRadios = months.map(function(mo, idx) {
      return '<label class="radio-option" style="display:flex;align-items:center;gap:var(--space-sm);padding:var(--space-sm);border:1px solid var(--border);border-radius:var(--radius);cursor:pointer;margin-bottom:var(--space-xs)">' +
        '<input type="radio" name="sub-month" value="' + mo.value + '"' + (idx === 1 ? ' checked' : '') + '>' +
        '<span style="font-size:0.9rem">' + mo.label + '</span>' +
        '</label>';
    }).join('');
    var weekdays = [
      { label: 'Mon', day: 1 },
      { label: 'Tue', day: 2 },
      { label: 'Wed', day: 3 },
      { label: 'Thu', day: 4 },
      { label: 'Fri', day: 5 },
    ];
    var weekdayChips = weekdays.map(function(wd) {
      return '<button type="button" class="weekday-chip selected" data-day="' + wd.day + '" ' +
        'style="padding:6px 12px;border-radius:20px;border:1px solid var(--primary);background:var(--primary);color:#fff;font-size:0.8125rem;cursor:pointer;font-weight:600">' +
        wd.label + '</button>';
    }).join('');
    return '<div class="screen fade-in">' +
      '<h2 class="section-title" style="font-size:1.25rem">Monthly Subscription</h2>' +
      '<p class="section-subtitle">Lock in your commute for the month at a discounted rate</p>' +

      '<!-- Pricing comparison -->' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-sm);margin-bottom:var(--space-lg)">' +
        '<div style="padding:var(--space-md);border:1px solid var(--border);border-radius:var(--radius);text-align:center">' +
          '<div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:4px">Daily rate</div>' +
          '<div style="font-size:1.5rem;font-weight:800;color:var(--text-primary)">R2.85<span style="font-size:0.875rem;font-weight:400">/km</span></div>' +
        '</div>' +
        '<div style="padding:var(--space-md);border:2px solid var(--accent);border-radius:var(--radius);text-align:center;position:relative;background:var(--surface-2, var(--surface))">' +
          '<span style="position:absolute;top:-10px;left:50%;transform:translateX(-50%);background:var(--primary);color:#fff;font-size:0.6875rem;font-weight:700;padding:2px 10px;border-radius:10px;white-space:nowrap">MOST POPULAR</span>' +
          '<div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:4px">Monthly rate</div>' +
          '<div style="font-size:1.5rem;font-weight:800;color:var(--accent)">R2.15<span style="font-size:0.875rem;font-weight:400">/km</span></div>' +
          '<span style="background:#22c55e;color:#fff;font-size:0.6875rem;font-weight:700;padding:2px 8px;border-radius:10px">SAVE 25%</span>' +
        '</div>' +
      '</div>' +

      '<form id="sub-form" novalidate>' +

      '<!-- Month selector -->' +
      '<div class="form-group">' +
        '<label class="form-label">Select Month</label>' +
        monthRadios +
      '</div>' +

      '<!-- Weekday selector -->' +
      '<div class="form-group">' +
        '<label class="form-label">Commute Days</label>' +
        '<div style="display:flex;gap:var(--space-xs);flex-wrap:wrap">' +
          weekdayChips +
        '</div>' +
      '</div>' +

      '<!-- Morning time -->' +
      '<div class="form-group">' +
        '<label class="form-label" for="sub-morning-time">Morning Pickup Time</label>' +
        '<input class="form-input" type="time" id="sub-morning-time" value="07:30">' +
      '</div>' +

      '<!-- Evening toggle + time -->' +
      '<div class="form-group">' +
        '<label style="display:flex;align-items:center;gap:var(--space-sm);cursor:pointer;font-size:0.9rem;color:var(--text-secondary)">' +
          '<input type="checkbox" id="sub-evening-toggle" style="width:16px;height:16px"> Add return trip' +
        '</label>' +
        '<input class="form-input" type="time" id="sub-evening-time" value="17:30" style="display:none;margin-top:var(--space-xs)">' +
      '</div>' +

      '<!-- Addresses -->' +
      '<div class="form-group">' +
        '<label class="form-label" for="sub-pickup">Pickup Address</label>' +
        '<input class="form-input" type="text" id="sub-pickup" placeholder="Pickup address" required autocomplete="off">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="form-label" for="sub-dropoff">Dropoff Address</label>' +
        '<input class="form-input" type="text" id="sub-dropoff" placeholder="Dropoff address" required autocomplete="off">' +
      '</div>' +

      '<!-- Live estimate -->' +
      '<div id="sub-estimate" style="display:none;background:var(--surface-2, var(--surface));border:1px solid var(--accent);border-radius:var(--radius);padding:var(--space-md);margin-bottom:var(--space-md);text-align:center;font-size:0.9rem;color:var(--accent);font-weight:600"></div>' +

      '<button type="submit" class="btn btn--primary btn--full btn--lg" id="sub-submit-btn">Subscribe &amp; Pay Upfront</button>' +

      '</form>' +

      '<p style="text-align:center;font-size:0.75rem;color:var(--text-muted);margin-top:var(--space-md)">Billed upfront for next month. Cancel anytime before month starts.</p>' +
    '</div>';
  }

  function renderMonthlyCalendarScreen(subscriptionId) {
    var now = new Date();
    var year = now.getFullYear();
    var month = now.getMonth(); // 0-indexed

    // Determine first day of month and total days
    var firstDay = new Date(year, month, 1).getDay(); // 0=Sun
    // Convert to Mon-first: Mon=0 ... Sun=6
    var firstDayMon = (firstDay + 6) % 7;
    var daysInMonth = new Date(year, month + 1, 0).getDate();

    var monthLabel = now.toLocaleString('default', { month: 'long', year: 'numeric' });

    var headerCells = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(function(d) {
      return '<div style="text-align:center;font-size:0.6875rem;font-weight:700;color:var(--text-muted);padding:4px 0">' + d + '</div>';
    }).join('');

    // Build blank cells before first day
    var cells = '';
    for (var b = 0; b < firstDayMon; b++) {
      cells += '<div></div>';
    }
    for (var day = 1; day <= daysInMonth; day++) {
      var mm = String(month + 1).padStart(2, '0');
      var dd = String(day).padStart(2, '0');
      var dateStr = year + '-' + mm + '-' + dd;
      cells += '<div class="cal-day-cell" data-date="' + dateStr + '" ' +
        'style="border:1px solid var(--border);border-radius:var(--radius);padding:4px;min-height:44px;cursor:pointer;position:relative;font-size:0.8125rem;font-weight:600">' +
        '<div>' + day + '</div>' +
        '<div style="display:flex;gap:2px;margin-top:2px">' +
          // M and E indicator badges will be injected by loadMonthlyCalendar
        '</div>' +
      '</div>';
    }

    return '<div class="screen fade-in">' +
      '<div style="display:flex;align-items:center;gap:var(--space-md);margin-bottom:var(--space-lg)">' +
        '<button class="btn btn--secondary btn--sm" id="cal-back-btn" style="flex-shrink:0">&#8592; Back</button>' +
        '<div>' +
          '<h2 style="font-size:1.1rem;font-weight:800;margin:0">Subscription Calendar</h2>' +
          '<div style="font-size:0.75rem;color:var(--accent);font-weight:600">R2.15/km</div>' +
        '</div>' +
      '</div>' +

      '<div style="font-size:0.9rem;font-weight:700;margin-bottom:var(--space-sm)">' + monthLabel + '</div>' +

      '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-bottom:var(--space-lg)">' +
        headerCells +
        cells +
      '</div>' +

      '<!-- Day detail panel -->' +
      '<div id="day-detail-panel" style="display:none;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-md);margin-bottom:var(--space-md)">' +
        '<h3 id="day-detail-date" style="font-size:1rem;font-weight:700;margin-bottom:var(--space-md)"></h3>' +

        '<!-- Morning section -->' +
        '<div style="margin-bottom:var(--space-md)">' +
          '<div style="font-size:0.8125rem;font-weight:600;color:var(--text-secondary);margin-bottom:var(--space-xs)">Morning Trip</div>' +
          '<div style="display:flex;align-items:center;gap:var(--space-sm);flex-wrap:wrap">' +
            '<input class="form-input" type="time" id="day-morning-time" style="flex:1;min-width:100px">' +
            '<span id="day-morning-status" class="chip" style="font-size:0.6875rem"></span>' +
            '<button type="button" id="day-cancel-morning" class="link-btn" style="font-size:0.8125rem;color:var(--error, #ef4444);background:none;border:none;cursor:pointer;text-decoration:underline;padding:0">Cancel day</button>' +
          '</div>' +
        '</div>' +

        '<!-- Evening section -->' +
        '<div id="day-evening-section" style="margin-bottom:var(--space-md)">' +
          '<div style="font-size:0.8125rem;font-weight:600;color:var(--text-secondary);margin-bottom:var(--space-xs)">Evening Trip</div>' +
          '<div style="display:flex;align-items:center;gap:var(--space-sm);flex-wrap:wrap">' +
            '<input class="form-input" type="time" id="day-evening-time" style="flex:1;min-width:100px">' +
            '<button type="button" id="day-cancel-evening" class="link-btn" style="font-size:0.8125rem;color:var(--error, #ef4444);background:none;border:none;cursor:pointer;text-decoration:underline;padding:0">Cancel evening</button>' +
          '</div>' +
        '</div>' +

        '<!-- Destination change -->' +
        '<div style="margin-bottom:var(--space-md)">' +
          '<label style="display:flex;align-items:center;gap:var(--space-sm);cursor:pointer;font-size:0.875rem;color:var(--text-secondary)">' +
            '<input type="checkbox" id="day-dest-change-toggle" style="width:16px;height:16px"> Change dropoff for this day' +
          '</label>' +
          '<input class="form-input" type="text" id="day-dropoff-address" placeholder="New dropoff address" style="display:none;margin-top:var(--space-xs)">' +
        '</div>' +

        '<button type="button" class="btn btn--primary btn--full" id="day-detail-save">Save Changes</button>' +
      '</div>' +

      '<!-- Summary footer -->' +
      '<div id="cal-summary" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-md);text-align:center;font-size:0.875rem;color:var(--text-secondary)">' +
        'Loading summary...' +
      '</div>' +
    '</div>';
  }

  function renderTripCard(trip) {
    const statusColors = { scheduled: 'active', active: 'live', completed: 'completed', pending: 'pending', cancelled: 'cancelled' };
    const priceHtml = trip.fareDaily != null
      ? `R${trip.fareDaily.toFixed(2)}/trip${trip.fareMonthly != null ? ` <span class="price-monthly-hint">· R${trip.fareMonthly.toFixed(2)} monthly</span>` : ''}`
      : `R${(trip.price_per_seat || trip.price || 35).toFixed(2)}/trip`;
    return `
      <div class="trip-card card--interactive" data-trip-id="${trip.id}">
        <div class="trip-card__header">
          <div class="trip-card__driver">
            <div class="trip-card__driver-avatar">${getInitials(trip.driverName || 'D')}</div>
            <div class="trip-card__driver-info">
              <h4>${escapeHtml(trip.driverName || 'Driver')}</h4>
              <div class="trip-card__driver-rating">
                ${Icons.star} ${trip.driverRating != null ? trip.driverRating : 'New'}
              </div>
            </div>
          </div>
          <div class="trip-card__price">
            <div class="trip-price">${priceHtml}</div>
            ${trip.etaMinutes ? `<div class="trip-eta">≈ ${trip.etaMinutes} min</div>` : ''}
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
    const fareDaily = match.fareDaily != null ? match.fareDaily : null;
    const fareMonthly = match.fareMonthly != null ? match.fareMonthly : null;
    const fareHtml = (fareDaily != null || fareMonthly != null)
      ? `<div class="match-fare" style="margin:var(--space-xs) 0;font-size:0.8125rem;color:var(--text-primary)">
           ${fareDaily != null ? `Daily: <strong>R${fareDaily.toFixed(2)}/trip</strong>` : ''}
           ${fareDaily != null && fareMonthly != null ? ' | ' : ''}
           ${fareMonthly != null ? `Monthly: <strong>R${fareMonthly.toFixed(2)}/trip</strong>` : ''}
         </div>`
      : '';
    const { isAuthenticated } = Store.state;
    const subscribeHtml = isAuthenticated
      ? `<button class="btn btn--secondary btn--sm" id="match-subscribe-link" style="margin-top:var(--space-xs);font-size:0.75rem">Subscribe for R2.15/km &#8594;</button>`
      : '';

    const seatsRaw = match.availableSeats ?? match.driverTrip?.availableSeats;
    const availableSeats = Number.isFinite(Number(seatsRaw)) ? Number(seatsRaw) : 1;
    const requestedPassengers = Math.max(1, Number(Store.state.requestedPassengerCount || 1));
    const waitlistTripId = String(
      match.tripId
      ?? match.trip_id
      ?? match.id
      ?? match.driverTrip?.tripId
      ?? match.driverTrip?.trip_id
      ?? match.driverTripId
      ?? '',
    );
    const ctaHtml = availableSeats === 0
      ? (waitlistTripId
        ? `<button class="btn btn--secondary btn--full join-waitlist-btn" style="margin-top:var(--space-md)" data-trip-id="${escapeHtml(waitlistTripId)}" data-passengers="${requestedPassengers}">
             Join Waitlist
           </button>`
        : `<button class="btn btn--secondary btn--full" style="margin-top:var(--space-md)" disabled>
             Trip Full
           </button>`)
      : `<button class="btn btn--primary btn--full confirm-match-btn" style="margin-top:var(--space-md)" data-match-id="${escapeHtml(match.matchId || '')}" data-driver-trip-id="${escapeHtml(match.driverTripId)}" data-rider-request-id="${escapeHtml(match.riderRequestId)}">
           Request This Ride
         </button>`;

    return `
      <div class="trip-card" style="border-left:3px solid var(--${scoreClass === 'excellent' ? 'accent' : scoreClass === 'good' ? 'primary' : 'warning'})">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-sm)">
          <span class="match-badge match-badge--${scoreClass}">${scoreLabel} Match (${scorePercent}%)</span>
          <span style="font-size:0.75rem;color:var(--text-muted)">${(match.breakdown?.detourDistanceKm || 0).toFixed(1)} km detour</span>
        </div>

        ${fareHtml}
        ${subscribeHtml}

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
          <div class="trip-card__meta-item">${Icons.users} ${availableSeats} seats</div>
          <div class="trip-card__meta-item">${Icons.leaf} ${(match.carbonSavedKg || 0).toFixed(1)} kg saved</div>
        </div>

        ${match.explanation ? `<p style="font-size:0.75rem;color:var(--text-muted);margin-top:var(--space-sm);font-style:italic">"${escapeHtml(match.explanation)}"</p>` : ''}

        ${ctaHtml}
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

  // ═══ MFA Screen Renderers ═══

  function renderMfaVerifyScreen() {
    return `
      <div class="auth-screen">
        <div class="auth-screen__header">
          <div class="auth-screen__logo" style="font-size:2rem">🔐</div>
          <h2 style="font-size:1.25rem;margin-bottom:var(--space-xs)">Two-Factor Authentication</h2>
          <p class="auth-screen__subtitle">Enter the 6-digit code from your authenticator app</p>
        </div>
        <form id="mfa-verify-form" novalidate>
          <div class="form-group">
            <label class="form-label" for="mfa-code">Authentication Code</label>
            <input class="form-input" id="mfa-code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="000000" autocomplete="one-time-code" style="letter-spacing:0.3em;text-align:center;font-size:1.5rem">
          </div>
          <button type="submit" class="btn btn--primary btn--full btn--lg">Verify</button>
        </form>
        <p style="text-align:center;margin-top:var(--space-md);font-size:0.875rem;color:var(--text-secondary)">
          Lost access? <a href="#" id="mfa-backup-link" style="color:var(--primary-light);font-weight:600">Use a backup code</a>
        </p>
        <p style="text-align:center;margin-top:var(--space-sm);font-size:0.8125rem">
          <a href="#" id="mfa-cancel-link" style="color:var(--text-muted)">Cancel and go back</a>
        </p>
      </div>
    `;
  }

  function renderMfaSetupScreen(setupData) {
    return `
      <div class="auth-screen">
        <div class="auth-screen__header">
          <h2>Set Up Authenticator</h2>
          <p class="auth-screen__subtitle">Scan this QR code with Google Authenticator, Authy, or any TOTP app</p>
        </div>
        <div style="text-align:center;margin:var(--space-lg) 0">
          <img src="${escapeHtml(setupData.qrCodeUrl)}" alt="QR Code" style="width:180px;height:180px;border-radius:8px">
          <p style="font-size:0.8125rem;color:var(--text-muted);margin-top:var(--space-sm)">Or enter manually: <strong>${escapeHtml(setupData.secret)}</strong></p>
        </div>
        <div style="background:var(--surface-alt);border-radius:8px;padding:var(--space-md);margin-bottom:var(--space-lg)">
          <p style="font-size:0.8125rem;font-weight:600;margin-bottom:var(--space-xs)">Backup Codes (save these!)</p>
          <div style="font-family:monospace;font-size:0.8125rem;display:grid;grid-template-columns:1fr 1fr;gap:4px">
            ${(setupData.backupCodes || []).map(c => `<span>${escapeHtml(c)}</span>`).join('')}
          </div>
        </div>
        <form id="mfa-confirm-form" novalidate>
          <div class="form-group">
            <label class="form-label" for="mfa-confirm-code">Enter code to confirm</label>
            <input class="form-input" id="mfa-confirm-code" type="text" inputmode="numeric" maxlength="6" placeholder="000000" style="letter-spacing:0.3em;text-align:center;font-size:1.5rem">
          </div>
          <button type="submit" class="btn btn--primary btn--full">Activate MFA</button>
        </form>
        <button id="mfa-setup-cancel-btn" class="btn btn--ghost btn--full" style="margin-top:var(--space-sm)">Cancel</button>
      </div>
    `;
  }

  // ═══ Trip Active / Navigation Screen Renderers ═══

  function renderTripActiveScreen() {
    const trip = Store.state.activeTrip || {};
    const isDriver = trip.role === 'driver';
    return `
      <div class="screen" style="position:relative;height:100%">
        <div id="trip-map" class="map-container" style="height:300px;border-radius:0"></div>
        <div style="padding:var(--space-lg)">
          <h2 style="margin-bottom:var(--space-xs)">${isDriver ? 'You are driving' : 'Your ride is on the way'}</h2>
          <p style="color:var(--text-muted);font-size:0.875rem;margin-bottom:var(--space-lg)">${escapeHtml(trip.title || '')}</p>
          <div style="display:flex;gap:var(--space-md);margin-bottom:var(--space-lg)">
            <div style="flex:1;background:var(--surface-alt);padding:var(--space-md);border-radius:8px;text-align:center">
              <div style="font-size:0.75rem;color:var(--text-muted)">ETA</div>
              <div id="trip-eta" style="font-size:1.25rem;font-weight:700">--</div>
            </div>
            <div style="flex:1;background:var(--surface-alt);padding:var(--space-md);border-radius:8px;text-align:center">
              <div style="font-size:0.75rem;color:var(--text-muted)">Status</div>
              <div style="font-size:1rem;font-weight:600;color:var(--accent)">Active</div>
            </div>
          </div>
          ${isDriver ? `<button id="nav-start-btn" class="btn btn--primary btn--full" style="margin-bottom:var(--space-sm)">Start Navigation</button>` : ''}
          <button id="trip-chat-btn" class="btn btn--secondary btn--full" style="margin-bottom:var(--space-sm)">Open Chat</button>
          ${!isDriver ? '<button id="trip-arrived-btn" class="btn btn--secondary btn--full" style="margin-bottom:var(--space-sm)">I\'ve Arrived</button>' : ''}
          ${!isDriver ? '<button id="trip-share-eta-btn" class="btn btn--ghost btn--sm" style="margin-bottom:var(--space-sm)">Share ETA</button>' : ''}
          ${isDriver ? '<button id="trip-end-btn" class="btn btn--danger btn--full" style="margin-bottom:var(--space-sm)">End Trip</button>' : ''}
        </div>
        <button id="sos-btn" aria-label="Emergency SOS" style="position:fixed;bottom:90px;right:var(--space-lg);width:56px;height:56px;border-radius:50%;background:#EF4444;color:#fff;font-weight:700;font-size:0.875rem;border:none;box-shadow:0 4px 12px rgba(239,68,68,.5);cursor:pointer;z-index:1000">SOS</button>
      </div>
    `;
  }

  function renderNavigationScreen() {
    return `
      <div class="screen" style="position:relative">
        <div id="nav-map" class="map-container" style="height:50vh;border-radius:0"></div>
        <div style="background:var(--surface);padding:var(--space-lg);border-radius:12px 12px 0 0;margin-top:-12px;position:relative;z-index:1">
          <div style="display:flex;align-items:center;gap:var(--space-md);margin-bottom:var(--space-md)">
            <div id="nav-step-icon" style="width:40px;height:40px;background:var(--primary-bg);border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0">→</div>
            <div>
              <div id="nav-step-text" style="font-size:1rem;font-weight:600">Loading route...</div>
              <div id="nav-step-distance" style="font-size:0.8125rem;color:var(--text-muted)"></div>
            </div>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span id="nav-eta" style="font-size:0.875rem;color:var(--text-secondary)">Calculating ETA...</span>
            <button id="nav-end-btn" class="btn btn--danger btn--sm">End Trip</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderDriverDocsScreen() {
    const docs = [
      { key: 'drivers_license', label: 'Driver License' },
      { key: 'id_document', label: 'ID Document' },
      { key: 'vehicle_registration', label: 'Vehicle Registration' },
      { key: 'proof_of_insurance', label: 'Proof of Insurance' },
    ];

    return `
      <div class="screen fade-in">
        <div style="display:flex;align-items:center;gap:var(--space-sm);margin-bottom:var(--space-lg)">
          <button class="icon-btn" id="driver-docs-back-btn" aria-label="Back">&#8592;</button>
          <h2 class="section-title" style="margin:0;font-size:1.25rem">Driver Documents</h2>
        </div>
        <p class="section-subtitle">Upload and track verification status</p>
        <div id="driver-docs-list" class="card" style="padding:var(--space-md)">
          ${docs.map((doc) => `
            <div class="list-item" data-doc-type="${doc.key}">
              <div class="list-item__content">
                <div class="list-item__title">${doc.label}</div>
                <div class="list-item__subtitle" id="doc-status-${doc.key}">Not uploaded</div>
              </div>
              <button class="btn btn--secondary btn--sm doc-upload-btn" data-doc-type="${doc.key}">Upload</button>
            </div>
          `).join('')}
        </div>
        <input type="file" id="doc-file-input" accept=".pdf,image/*" style="display:none">
      </div>
    `;
  }

  function renderDriverEarningsScreen() {
    return `
      <div class="screen fade-in">
        <div style="display:flex;align-items:center;gap:var(--space-sm);margin-bottom:var(--space-lg)">
          <button class="icon-btn" id="driver-earnings-back-btn" aria-label="Back">&#8592;</button>
          <h2 class="section-title" style="margin:0;font-size:1.25rem">Driver Earnings</h2>
        </div>

        <div id="earnings-summary" class="stats-grid" style="margin-bottom:var(--space-lg)">
          <div class="stat-card"><div class="skeleton" style="height:40px"></div></div>
          <div class="stat-card"><div class="skeleton" style="height:40px"></div></div>
          <div class="stat-card"><div class="skeleton" style="height:40px"></div></div>
        </div>

        <div class="card">
          <h4 style="font-size:0.9375rem;font-weight:700;margin-bottom:var(--space-sm)">Monthly Breakdown</h4>
          <div id="earnings-table">
            <div class="skeleton" style="height:120px"></div>
          </div>
        </div>
      </div>
    `;
  }

  function renderReferralScreen() {
    return `
      <div class="screen fade-in">
        <div style="display:flex;align-items:center;gap:var(--space-sm);margin-bottom:var(--space-lg)">
          <button class="icon-btn" id="referral-back-btn" aria-label="Back">&#8592;</button>
          <h2 class="section-title" style="margin:0;font-size:1.25rem">Referral & Points</h2>
        </div>

        <div class="card" style="margin-bottom:var(--space-md)">
          <div style="font-size:0.8125rem;color:var(--text-muted);margin-bottom:var(--space-xs)">Your referral code</div>
          <div id="referral-code" style="font-size:1.125rem;font-weight:800;letter-spacing:0.08em">Loading...</div>
          <div style="display:flex;gap:var(--space-sm);margin-top:var(--space-sm)">
            <button class="btn btn--secondary btn--sm" id="referral-copy-btn">Copy</button>
            <button class="btn btn--secondary btn--sm" id="referral-share-btn">Share</button>
          </div>
        </div>

        <div class="card" style="margin-bottom:var(--space-md)">
          <div style="font-size:0.8125rem;color:var(--text-muted);margin-bottom:var(--space-xs)">Redeem a friend's code</div>
          <div style="display:flex;gap:var(--space-sm)">
            <input class="form-input" id="referral-input" placeholder="Enter code">
            <button class="btn btn--primary btn--sm" id="referral-redeem-btn">Redeem</button>
          </div>
        </div>

        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-sm)">
            <h4 style="font-size:0.9375rem;font-weight:700;margin:0">Points History</h4>
            <span id="points-balance" class="chip chip--active">0 pts</span>
          </div>
          <div id="points-history" style="display:flex;flex-direction:column;gap:var(--space-xs)"></div>
        </div>
      </div>
    `;
  }

  function renderOrganizationScreen() {
    return `
      <div class="screen fade-in">
        <div style="display:flex;align-items:center;gap:var(--space-sm);margin-bottom:var(--space-lg)">
          <button class="icon-btn" id="organization-back-btn" aria-label="Back">&#8592;</button>
          <h2 class="section-title" style="margin:0;font-size:1.25rem">Organization</h2>
        </div>

        <div id="organization-content">
          <div class="skeleton" style="height:180px"></div>
        </div>
      </div>
    `;
  }

  function renderChatScreen() {
    const trip = Store.state.activeTrip || {};
    return `
      <div class="screen fade-in">
        <div style="display:flex;align-items:center;gap:var(--space-sm);margin-bottom:var(--space-lg)">
          <button class="icon-btn" id="chat-back-btn" aria-label="Back">&#8592;</button>
          <div>
            <h2 class="section-title" style="margin:0;font-size:1.1rem">Trip Chat</h2>
            <div style="font-size:0.75rem;color:var(--text-muted)">${escapeHtml(trip.title || 'Conversation')}</div>
          </div>
        </div>

        <div id="chat-log" role="log" aria-live="polite" style="min-height:45vh;max-height:55vh;overflow:auto;padding:var(--space-sm);background:var(--surface-alt);border:1px solid var(--border);border-radius:8px;margin-bottom:var(--space-md)">
          <div class="skeleton" style="height:140px"></div>
        </div>

        <form id="chat-form" style="display:flex;gap:var(--space-sm)">
          <input class="form-input" id="chat-input" aria-label="Message input" placeholder="Type a message..." maxlength="2000" style="flex:1">
          <button class="btn btn--primary" type="submit">Send</button>
        </form>
      </div>
    `;
  }

  function renderPayoutsScreen() {
    return `
      <div class="screen fade-in">
        <div style="display:flex;align-items:center;gap:var(--space-sm);margin-bottom:var(--space-lg)">
          <button class="icon-btn" id="payouts-back-btn" aria-label="Back">&#8592;</button>
          <h2 class="section-title" style="margin:0;font-size:1.25rem">Driver Payouts</h2>
        </div>

        <div id="payouts-status-card" class="card" style="margin-bottom:var(--space-md)">
          <div class="skeleton" style="height:120px"></div>
        </div>

        <div style="display:flex;gap:var(--space-sm)">
          <button class="btn btn--primary" id="payouts-setup-btn">Set Up / Continue</button>
          <button class="btn btn--secondary" id="payouts-dashboard-btn">Dashboard</button>
        </div>
      </div>
    `;
  }

  // ═══ Renderer ═══
  // AbortController for the current screen's event listeners.
  // Aborted and replaced on every render so old listeners are cleaned up.
  let screenController = new AbortController();

  const Renderer = {
    render() {
      const { currentScreen, isAuthenticated } = Store.state;

      // Auth guard
      const publicScreens = ['login', 'register', 'forgot-password', 'reset-password', 'mfa-verify'];
      if (!isAuthenticated && !publicScreens.includes(currentScreen)) {
        Router.navigate('login');
        return;
      }

      // Teardown map instances from the leaving screen
      const prevScreen = Store.state.prevScreen;
      if (prevScreen && prevScreen !== currentScreen) {
        MapManager.destroy('fr-map');
        MapManager.destroy('or-map');
        MapManager.destroy('trip-map');
        MapManager.destroy('nav-map');
        stopLocationSharing();
        stopActiveTripLocationPolling();
        stopNavigationProgressPolling();
      }
      Store.setState({ prevScreen: currentScreen });

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
        case 'subscription': content.innerHTML = renderSubscriptionScreen(); break;
        case 'monthly-calendar': content.innerHTML = renderMonthlyCalendarScreen(currentSubscriptionId); break;
        case 'mfa-verify': content.innerHTML = renderMfaVerifyScreen(); break;
        case 'mfa-setup':
          content.innerHTML = mfaSetupData
            ? renderMfaSetupScreen(mfaSetupData)
            : '<div class="screen"><div class="skeleton" style="height:220px"></div></div>';
          break;
        case 'trip-active': content.innerHTML = renderTripActiveScreen(); break;
        case 'navigation': content.innerHTML = renderNavigationScreen(); break;
        case 'driver-docs': content.innerHTML = renderDriverDocsScreen(); break;
        case 'driver-earnings': content.innerHTML = renderDriverEarningsScreen(); break;
        case 'referral': content.innerHTML = renderReferralScreen(); break;
        case 'organization': content.innerHTML = renderOrganizationScreen(); break;
        case 'chat': content.innerHTML = renderChatScreen(); break;
        case 'payouts': content.innerHTML = renderPayoutsScreen(); break;
        default: content.innerHTML = renderHomeScreen(); break;
      }

      content.setAttribute('tabindex', '-1');
      content.focus();

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
          on('google-signin-btn', 'click', handleGoogleSignIn);
          on('apple-signin-btn', 'click', handleAppleSignIn);
          on('link-to-register', 'click', (e) => { e.preventDefault(); Router.navigate('register'); });
          on('link-to-forgot', 'click', (e) => { e.preventDefault(); Router.navigate('forgot-password'); });
          break;
        case 'register':
          on('register-form', 'submit', handleRegister);
          on('link-to-login', 'click', (e) => { e.preventDefault(); Router.navigate('login'); });
          onAll('#role-tabs .tab', 'click', (e) => {
            const tabs = Array.from(document.querySelectorAll('#role-tabs .tab'));
            tabs.forEach((t) => {
              t.classList.remove('active');
              t.setAttribute('aria-selected', 'false');
              t.setAttribute('tabindex', '-1');
            });
            e.currentTarget.classList.add('active');
            e.currentTarget.setAttribute('aria-selected', 'true');
            e.currentTarget.setAttribute('tabindex', '0');
          });
          onAll('#role-tabs .tab', 'keydown', (e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            e.preventDefault();
            const tabs = Array.from(document.querySelectorAll('#role-tabs .tab'));
            const currentIndex = tabs.indexOf(e.currentTarget);
            const nextIndex = e.key === 'ArrowRight'
              ? (currentIndex + 1) % tabs.length
              : (currentIndex - 1 + tabs.length) % tabs.length;
            tabs[nextIndex]?.click();
            tabs[nextIndex]?.focus();
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
          // Trip type selector buttons
          on('find-daily-btn', 'click', () => {
            document.querySelectorAll('.trip-type-btn').forEach(b => {
              b.classList.remove('active');
              b.style.borderColor = 'var(--border)';
              b.style.background = 'transparent';
            });
            const dailyBtn = document.getElementById('find-daily-btn');
            if (dailyBtn) {
              dailyBtn.classList.add('active');
              dailyBtn.style.borderColor = 'var(--primary)';
              dailyBtn.style.background = 'var(--primary-bg)';
              dailyBtn.style.color = 'var(--text-primary)';
            }
          });
          on('find-monthly-btn', 'click', () => {
            Router.navigate('subscription');
          });
          on('promo-apply-btn', 'click', handleApplyPromoCode);
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
          onAll('.report-issue-btn', 'click', (e) => {
            const tripId = parseInt(e.currentTarget.dataset.tripId || '0', 10);
            if (tripId > 0) handleReportIssue(tripId);
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
          on('profile-security-item', 'click', () => Router.navigate('settings'));
          on('profile-docs-item', 'click', () => Router.navigate('driver-docs'));
          on('profile-earnings-item', 'click', () => Router.navigate('driver-earnings'));
          on('profile-payouts-item', 'click', () => Router.navigate('payouts'));
          on('profile-referral-item', 'click', () => Router.navigate('referral'));
          on('profile-org-item', 'click', () => Router.navigate('organization'));
          on('logout-btn', 'click', () => Auth.logout());
          break;
        case 'settings':
          on('settings-back-btn', 'click', () => Router.navigate('profile'));
          on('settings-theme-btn', 'click', toggleTheme);
          on('settings-mfa-enable-btn', 'click', () => {
            mfaSetupData = null;
            Router.navigate('mfa-setup');
          });
          on('settings-mfa-disable-btn', 'click', handleMfaDisable);
          break;
        case 'forgot-password':
          on('forgot-form', 'submit', handleForgotPassword);
          on('link-forgot-to-login', 'click', (e) => { e.preventDefault(); Router.navigate('login'); });
          break;
        case 'reset-password':
          on('reset-form', 'submit', handleResetPassword);
          on('link-reset-to-login', 'click', (e) => { e.preventDefault(); Router.navigate('login'); });
          break;
        case 'subscription': {
          // Weekday chip toggles
          document.querySelectorAll('.weekday-chip').forEach(function(btn) {
            btn.addEventListener('click', function() {
              var day = parseInt(btn.dataset.day);
              btn.classList.toggle('selected');
              if (btn.classList.contains('selected')) {
                if (!subSelectedWeekdays.includes(day)) subSelectedWeekdays.push(day);
                btn.style.background = 'var(--primary)';
                btn.style.color = '#fff';
                btn.style.borderColor = 'var(--primary)';
              } else {
                subSelectedWeekdays = subSelectedWeekdays.filter(function(d) { return d !== day; });
                btn.style.background = 'transparent';
                btn.style.color = 'var(--text-primary)';
                btn.style.borderColor = 'var(--border)';
              }
              updateLiveEstimate();
            }, { signal: signal });
          });
          // Evening toggle
          var eveningToggle = document.getElementById('sub-evening-toggle');
          var eveningTime = document.getElementById('sub-evening-time');
          if (eveningToggle && eveningTime) {
            eveningToggle.addEventListener('change', function() {
              eveningTime.style.display = eveningToggle.checked ? 'block' : 'none';
              updateLiveEstimate();
            }, { signal: signal });
          }
          // Pickup/dropoff geocoding on blur
          var subPickupEl = document.getElementById('sub-pickup');
          var subDropoffEl = document.getElementById('sub-dropoff');
          if (subPickupEl) subPickupEl.addEventListener('blur', async function() {
            if (subPickupEl.value) {
              subPickupCoords = await geocodeAddress(subPickupEl.value);
              updateLiveEstimate();
            }
          }, { signal: signal });
          if (subDropoffEl) subDropoffEl.addEventListener('blur', async function() {
            if (subDropoffEl.value) {
              subDropoffCoords = await geocodeAddress(subDropoffEl.value);
              updateLiveEstimate();
            }
          }, { signal: signal });
          // Morning time change
          var morningTimeEl = document.getElementById('sub-morning-time');
          if (morningTimeEl) morningTimeEl.addEventListener('input', updateLiveEstimate, { signal: signal });
          // Month radio selection — set default to the checked radio
          document.querySelectorAll('input[name="sub-month"]').forEach(function(radio) {
            if (radio.checked) subSelectedMonth = radio.value;
            radio.addEventListener('change', function() {
              subSelectedMonth = radio.value;
              updateLiveEstimate();
            }, { signal: signal });
          });
          // Form submit
          var subFormEl = document.getElementById('sub-form');
          if (subFormEl) subFormEl.addEventListener('submit', handleCreateSubscription, { signal: signal });
          break;
        }
        case 'mfa-verify':
          on('mfa-verify-form', 'submit', handleMfaVerify);
          on('mfa-backup-link', 'click', async (e) => {
            e.preventDefault();
            const code = await showPromptDialog({
              title: 'Use Backup Code',
              message: 'Enter one of your backup codes to complete sign-in.',
              placeholder: 'Backup code',
              confirmText: 'Verify',
              minLength: 6,
            });
            if (code) handleMfaVerifyWithBackup(code);
          });
          on('mfa-cancel-link', 'click', (e) => {
            e.preventDefault();
            sessionStorage.removeItem('mfaToken');
            Router.navigate('login');
          });
          break;
        case 'mfa-setup':
          on('mfa-confirm-form', 'submit', handleMfaConfirm);
          on('mfa-setup-cancel-btn', 'click', () => Router.navigate('settings'));
          break;
        case 'trip-active': {
          const activeTripId = Store.state.activeTrip?.id;
          if (activeTripId) {
            setTimeout(() => {
              MapManager.init('trip-map', null, 14);
              if (Store.state.activeTrip?.role === 'driver') startLocationSharing(activeTripId);
              loadActiveTripLocation(activeTripId);
              if (Store.state.activeTrip?.role !== 'driver') startActiveTripLocationPolling(activeTripId);
            }, 100);
          }
          on('nav-start-btn', 'click', () => Router.navigate('navigation'));
          updateTripChatBadge();
          on('trip-end-btn', 'click', async () => {
            const confirmed = await showConfirmDialog({
              title: 'End Trip',
              message: 'Mark this trip as completed?',
              confirmText: 'End Trip',
              cancelText: 'Continue',
              danger: false,
            });
            if (!confirmed) return;

            const tripId = Store.state.activeTrip?.id;
            try {
              if (tripId) await API.post(`/trips/${tripId}/complete`, {});
              Toast.show('Trip completed.', 'success');
            } catch (err) {
              Toast.show(err.message || 'Unable to complete trip.', 'error');
            } finally {
              stopLocationSharing();
              stopActiveTripLocationPolling();
              stopNavigationProgressPolling();
              Store.setState({ activeTrip: null, activeChatTripId: null });
              Router.navigate('my-trips');
            }
          });
          on('trip-chat-btn', 'click', () => {
            const tripId = Store.state.activeTrip?.id;
            if (tripId) {
              clearChatUnread(tripId);
              Store.setState({ activeChatTripId: tripId });
            }
            Router.navigate('chat');
          });
          on('trip-arrived-btn', 'click', async () => {
            const tripId = Store.state.activeTrip?.id;
            if (!tripId) return;
            try {
              await API.post(`/trips/${tripId}/arrive`, {});
              const btn = document.getElementById('trip-arrived-btn');
              if (btn) {
                btn.textContent = 'Arrival Noted';
                btn.setAttribute('disabled', 'true');
              }
              Toast.show('Arrival noted. Your driver has been notified.', 'success');
            } catch (err) {
              Toast.show(err.message || 'Unable to mark your arrival.', 'error');
            }
          });
          on('trip-share-eta-btn', 'click', async () => {
            const trip = Store.state.activeTrip;
            const tripId = trip?.id;
            const destination = trip?.title || '';
            try {
              const loc = tripId ? await API.get(`/trips/${tripId}/location`) : null;
              const lat = loc?.location?.lat;
              const lng = loc?.location?.lng;
              const mapsUrl = Number.isFinite(lat) && Number.isFinite(lng)
                ? `https://maps.google.com/maps?q=${lat},${lng}`
                : `https://maps.google.com/maps?q=${encodeURIComponent(destination)}`;
              if (navigator.share) {
                await navigator.share({
                  title: 'My Ride ETA',
                  text: `Tracking my Klubz ride: ${destination}`,
                  url: mapsUrl,
                });
              } else {
                await navigator.clipboard.writeText(mapsUrl);
                Toast.show('Map link copied to clipboard.', 'success');
              }
            } catch {
              Toast.show('Unable to share ETA.', 'error');
            }
          });
          on('sos-btn', 'click', handleSOS);
          break;
        }
        case 'navigation': {
          setTimeout(async () => {
            MapManager.init('nav-map', null, 14);
            const tripId = Store.state.activeTrip?.id;
            if (tripId) {
              try {
                const routeData = await API.get(`/trips/${tripId}/route`);
                if (routeData.polyline) {
                  const pts = decodePolyline(routeData.polyline, 6);
                  MapManager.setRoute('nav-map', pts);
                  MapManager.fitRoute('nav-map');
                }
                if (routeData.steps && routeData.steps.length) {
                  Store.setState({ navSteps: routeData.steps, navStepIndex: 0 });
                  updateNavDisplay();
                }
                startNavigationProgressPolling(tripId);
              } catch { /* best-effort */ }
            }
          }, 100);
          on('nav-end-btn', 'click', () => {
            stopLocationSharing();
            stopActiveTripLocationPolling();
            stopNavigationProgressPolling();
            Store.setState({ activeTrip: null, activeChatTripId: null, navSteps: null, navStepIndex: 0 });
            Router.navigate('my-trips');
          });
          break;
        }
        case 'monthly-calendar': {
          var calBackBtn = document.getElementById('cal-back-btn');
          if (calBackBtn) calBackBtn.addEventListener('click', function() { Router.navigate('home'); }, { signal: signal });
          // Day cell clicks
          document.querySelectorAll('.cal-day-cell[data-date]').forEach(function(cell) {
            cell.addEventListener('click', function() {
              var date = cell.dataset.date;
              var morning = cell.dataset.morning ? JSON.parse(cell.dataset.morning) : null;
              var evening = cell.dataset.evening ? JSON.parse(cell.dataset.evening) : null;
              showDayDetail(date, morning, evening);
            }, { signal: signal });
          });
          // Day detail actions
          var calSaveBtn = document.getElementById('day-detail-save');
          if (calSaveBtn) calSaveBtn.addEventListener('click', handleSaveDayDetail, { signal: signal });
          var cancelMorningBtn = document.getElementById('day-cancel-morning');
          if (cancelMorningBtn) cancelMorningBtn.addEventListener('click', function() {
            var panel = document.getElementById('day-detail-panel');
            if (panel && panel.dataset.date) handleCancelDay(panel.dataset.date, 'morning');
          }, { signal: signal });
          var cancelEveningBtn = document.getElementById('day-cancel-evening');
          if (cancelEveningBtn) cancelEveningBtn.addEventListener('click', function() {
            var panel = document.getElementById('day-detail-panel');
            if (panel && panel.dataset.date) handleCancelDay(panel.dataset.date, 'evening');
          }, { signal: signal });
          var destToggleEl = document.getElementById('day-dest-change-toggle');
          if (destToggleEl) destToggleEl.addEventListener('change', toggleDestChange, { signal: signal });
          break;
        }
        case 'driver-docs':
          on('driver-docs-back-btn', 'click', () => Router.navigate('profile'));
          onAll('.doc-upload-btn', 'click', (e) => {
            const docType = e.currentTarget.dataset.docType;
            if (docType) handleDocumentUpload(docType);
          });
          break;
        case 'driver-earnings':
          on('driver-earnings-back-btn', 'click', () => Router.navigate('profile'));
          break;
        case 'referral':
          on('referral-back-btn', 'click', () => Router.navigate('profile'));
          on('referral-copy-btn', 'click', copyReferralCode);
          on('referral-share-btn', 'click', shareReferralCode);
          on('referral-redeem-btn', 'click', handleReferralRedeem);
          break;
        case 'organization':
          on('organization-back-btn', 'click', () => Router.navigate('profile'));
          on('org-create-form', 'submit', handleCreateOrganization);
          on('org-join-form', 'submit', handleJoinOrganization);
          on('org-copy-code-btn', 'click', copyOrganizationInviteCode);
          break;
        case 'chat':
          if (!Store.state.activeChatTripId && Store.state.activeTrip?.id) {
            Store.setState({ activeChatTripId: Store.state.activeTrip.id });
          }
          on('chat-back-btn', 'click', () => Router.navigate('my-trips'));
          on('chat-form', 'submit', handleChatSubmit);
          break;
        case 'payouts':
          on('payouts-back-btn', 'click', () => Router.navigate('profile'));
          on('payouts-setup-btn', 'click', handlePayoutSetup);
          on('payouts-dashboard-btn', 'click', handlePayoutDashboard);
          break;
      }
    },

    loadScreenData(screen) {
      switch (screen) {
        case 'home':
          loadUpcomingTrips();
          loadHomeStats();
          break;
        case 'find-ride': loadFindRide(); break;
        case 'my-trips': loadTrips('upcoming'); loadMyTripsSub(); break;
        case 'carbon': loadCarbonStats(); break;
        case 'profile': loadProfileStats(); break;
        case 'subscription':
          loadCurrentSubscription();
          break;
        case 'monthly-calendar':
          loadMonthlyCalendar();
          break;
        case 'mfa-setup':
          loadMfaSetupData();
          break;
        case 'driver-docs':
          loadDriverDocs();
          break;
        case 'driver-earnings':
          loadDriverEarnings();
          break;
        case 'referral':
          loadReferralData();
          break;
        case 'organization':
          loadOrganization();
          break;
        case 'chat':
          loadChatMessages();
          break;
        case 'payouts':
          loadPayoutStatus();
          break;
        case 'navigation':
        case 'trip-active':
          // data loaded via bindEvents after map init
          break;
      }
    }
  };

  // ═══ Event Handlers ═══

  // ─── MFA Handlers ───

  async function handleMfaVerify(e) {
    e.preventDefault();
    const code = document.getElementById('mfa-code')?.value?.trim();
    const mfaToken = sessionStorage.getItem('mfaToken');
    if (!code || !mfaToken) {
      Toast.show('Please enter your 6-digit code', 'error');
      return;
    }
    try {
      const data = await API.post('/auth/mfa/verify', { mfaToken, code });
      sessionStorage.removeItem('mfaToken');
      localStorage.setItem(CONFIG.TOKEN_KEY, data.accessToken);
      localStorage.setItem(CONFIG.REFRESH_KEY, data.refreshToken);
      localStorage.setItem(CONFIG.USER_KEY, JSON.stringify(data.user));
      Store.setState({ isAuthenticated: true, user: data.user });
      const tosOk = await enforceTosAcceptance();
      if (!tosOk) return;
      Toast.show('Signed in successfully!', 'success');
      subscribeToNotifications();
      Router.navigate('home');
    } catch (err) {
      Toast.show(err.message || 'Invalid code. Please try again.', 'error');
    }
  }

  async function handleMfaVerifyWithBackup(code) {
    const mfaToken = sessionStorage.getItem('mfaToken');
    if (!mfaToken) { Router.navigate('login'); return; }
    try {
      const data = await API.post('/auth/mfa/verify', { mfaToken, code, isBackupCode: true });
      sessionStorage.removeItem('mfaToken');
      localStorage.setItem(CONFIG.TOKEN_KEY, data.accessToken);
      localStorage.setItem(CONFIG.REFRESH_KEY, data.refreshToken);
      localStorage.setItem(CONFIG.USER_KEY, JSON.stringify(data.user));
      Store.setState({ isAuthenticated: true, user: data.user });
      const tosOk = await enforceTosAcceptance();
      if (!tosOk) return;
      Toast.show('Signed in with backup code. Please set up a new authenticator.', 'success');
      subscribeToNotifications();
      Router.navigate('home');
    } catch (err) {
      Toast.show(err.message || 'Invalid backup code.', 'error');
    }
  }

  async function loadMfaSetupData() {
    if (mfaSetupData) return;
    try {
      mfaSetupData = await API.post('/auth/mfa/setup', {});
      if (Store.state.currentScreen === 'mfa-setup') Renderer.render();
    } catch (err) {
      Toast.show(err.message || 'Unable to load MFA setup right now.', 'error');
      Router.navigate('settings');
    }
  }

  async function handleMfaConfirm(e) {
    e.preventDefault();
    const code = document.getElementById('mfa-confirm-code')?.value?.trim();
    if (!code || !/^[0-9]{6}$/.test(code)) {
      Toast.show('Enter a valid 6-digit authentication code', 'warning');
      return;
    }

    try {
      await API.post('/auth/mfa/confirm', { code });
      const user = { ...(Store.state.user || {}) };
      user.mfaEnabled = true;
      user.mfa_enabled = 1;
      Store.setState({ user });
      localStorage.setItem(CONFIG.USER_KEY, JSON.stringify(user));
      mfaSetupData = null;
      Toast.show('Two-factor authentication enabled.', 'success');
      Router.navigate('settings');
    } catch (err) {
      Toast.show(err.message || 'Could not enable two-factor authentication.', 'error');
    }
  }

  async function handleMfaDisable() {
    const password = await showPromptDialog({
      title: 'Disable Two-Factor Authentication',
      message: 'Enter your password to continue.',
      placeholder: 'Password',
      confirmText: 'Continue',
      type: 'password',
      trim: false,
    });
    if (!password) return;
    const code = await showPromptDialog({
      title: 'Disable Two-Factor Authentication',
      message: 'Enter your current 6-digit authenticator code.',
      placeholder: '000000',
      confirmText: 'Disable MFA',
      minLength: 6,
    });
    if (!code) return;

    try {
      await API.post('/auth/mfa/disable', { password, code });
      const user = { ...(Store.state.user || {}) };
      user.mfaEnabled = false;
      user.mfa_enabled = 0;
      Store.setState({ user });
      localStorage.setItem(CONFIG.USER_KEY, JSON.stringify(user));
      Toast.show('Two-factor authentication disabled.', 'success');
      Renderer.render();
    } catch (err) {
      Toast.show(err.message || 'Could not disable two-factor authentication.', 'error');
    }
  }

  // ─── SOS Handler ───

  async function handleSOS() {
    const confirmed = await showConfirmDialog({
      title: 'Emergency SOS',
      message: 'Send emergency SOS alert? This notifies your emergency contacts and Klubz safety team.',
      confirmText: 'Send SOS',
      cancelText: 'Cancel',
      danger: true,
    });
    if (!confirmed) return;
    try {
      const tripId = Store.state.activeTrip?.id;
      let lat, lng;
      if (navigator.geolocation) {
        await new Promise(resolve => {
          navigator.geolocation.getCurrentPosition(pos => {
            lat = pos.coords.latitude;
            lng = pos.coords.longitude;
            resolve();
          }, () => resolve(), { timeout: 5000 });
        });
      }
      await API.post('/safety/sos', { tripId, lat, lng });
      Toast.show('SOS alert sent! Help is on the way.', 'error');
    } catch {
      Toast.show('SOS sent (offline mode). Please call emergency services directly.', 'warning');
    }
  }

  // ─── Navigation Display ───

  function updateNavDisplay() {
    const steps = Store.state.navSteps;
    const idx = Store.state.navStepIndex || 0;
    if (!steps || !steps.length) return;
    const step = steps[idx];
    const stepText = document.getElementById('nav-step-text');
    const stepDist = document.getElementById('nav-step-distance');
    const eta = document.getElementById('nav-eta');
    if (stepText) stepText.textContent = step.instruction || step.name || 'Continue';
    if (stepDist) {
      const meters = Number(step.distance || 0);
      stepDist.textContent = meters >= 1000
        ? `${(meters / 1000).toFixed(1)} km`
        : (meters > 0 ? `${Math.round(meters)} m` : '');
    }
    if (eta) {
      const remaining = steps.slice(idx).reduce((s, st) => s + (st.duration || 0), 0);
      eta.textContent = `ETA: ${Math.round(remaining / 60)} min`;
    }
  }

  // ═══ Subscription State ═══

  var currentSubscriptionId = null;
  var subPickupCoords = null;
  var subDropoffCoords = null;
  var subSelectedWeekdays = [1, 2, 3, 4, 5];
  var subSelectedMonth = null; // set during bindEvents when month radio is read
  var activePromoCode = null;
  var mfaSetupData = null;
  var currentReferralCode = '';
  var currentOrganizationInviteCode = '';
  var waitlistByTripId = {};
  var chatUnreadByTripId = {};

  // ═══ Subscription Helpers ═══

  function countWeekdaysInMonth(yearMonthStr, weekdays) {
    // yearMonthStr: "YYYY-MM"
    if (!yearMonthStr || !weekdays || weekdays.length === 0) return 0;
    var parts = yearMonthStr.split('-');
    var year = parseInt(parts[0]);
    var month = parseInt(parts[1]) - 1; // 0-indexed
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var count = 0;
    for (var d = 1; d <= daysInMonth; d++) {
      var jsDay = new Date(year, month, d).getDay(); // 0=Sun, 1=Mon, ...6=Sat
      // Convert to ISO weekday: Mon=1 ... Sun=7
      var isoDay = jsDay === 0 ? 7 : jsDay;
      if (weekdays.indexOf(isoDay) !== -1) count++;
    }
    return count;
  }

  function updateLiveEstimate() {
    var estimateEl = document.getElementById('sub-estimate');
    if (!estimateEl) return;
    if (!subPickupCoords || !subDropoffCoords) {
      estimateEl.style.display = 'none';
      return;
    }
    var avgKmPerTrip = clientHaversineKm(
      subPickupCoords.lat, subPickupCoords.lng,
      subDropoffCoords.lat, subDropoffCoords.lng
    ) * 1.3; // road factor
    var days = countWeekdaysInMonth(subSelectedMonth, subSelectedWeekdays);
    var eveningToggle = document.getElementById('sub-evening-toggle');
    var tripsPerDay = (eveningToggle && eveningToggle.checked) ? 2 : 1;
    var totalTrips = days * tripsPerDay;
    var totalKm = avgKmPerTrip * totalTrips;
    var estimatedAmount = (totalKm * 2.15).toFixed(2);
    estimateEl.style.display = 'block';
    estimateEl.textContent = '≈ R' + estimatedAmount + '/month · ' + days + ' days · ' + Math.round(totalKm) + ' km';
  }

  async function handleCreateSubscription(e) {
    e.preventDefault();
    var pickupVal = document.getElementById('sub-pickup')?.value?.trim();
    var dropoffVal = document.getElementById('sub-dropoff')?.value?.trim();
    var morningTime = document.getElementById('sub-morning-time')?.value;
    var eveningToggle = document.getElementById('sub-evening-toggle');
    var eveningTime = document.getElementById('sub-evening-time')?.value;
    var hasEvening = eveningToggle ? eveningToggle.checked : false;

    if (!pickupVal || !dropoffVal) {
      Toast.show('Please enter pickup and dropoff addresses', 'warning');
      return;
    }
    if (!subSelectedMonth) {
      Toast.show('Please select a subscription month', 'warning');
      return;
    }
    if (subSelectedWeekdays.length === 0) {
      Toast.show('Please select at least one commute day', 'warning');
      return;
    }

    var btn = document.getElementById('sub-submit-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Processing...'; }

    try {
      // Geocode if not already done
      if (!subPickupCoords) subPickupCoords = await geocodeAddress(pickupVal);
      if (!subDropoffCoords) subDropoffCoords = await geocodeAddress(dropoffVal);
      if (!subPickupCoords || !subDropoffCoords) {
        Toast.show('Could not resolve one or both addresses. Try a more specific address.', 'error');
        return;
      }

      var body = {
        month: subSelectedMonth,
        weekdays: subSelectedWeekdays,
        morningTime: morningTime,
        eveningEnabled: hasEvening,
        eveningTime: hasEvening ? eveningTime : null,
        pickupAddress: pickupVal,
        dropoffAddress: dropoffVal,
        pickupCoords: subPickupCoords,
        dropoffCoords: subDropoffCoords,
      };
      var data = await API.post('/subscriptions', body);
      currentSubscriptionId = data.subscriptionId || data.id;

      // Initiate payment
      var payData = await API.post('/subscriptions/' + currentSubscriptionId + '/payment', {});
      if (payData.clientSecret) {
        // Stripe payment flow — for now show a toast and navigate to calendar
        Toast.show('Subscription created! Complete payment to activate.', 'success');
      } else {
        Toast.show('Subscription activated!', 'success');
      }
      Router.navigate('monthly-calendar');
    } catch (err) {
      Toast.show(err.message || 'Failed to create subscription', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Subscribe & Pay Upfront'; }
    }
  }

  async function loadCurrentSubscription() {
    try {
      var data = await API.get('/subscriptions/current');
      if (data && data.subscription && (data.subscription.status === 'active' || data.subscription.status === 'pending_payment')) {
        currentSubscriptionId = data.subscription.id;
        // If already subscribed, go straight to calendar
        Router.navigate('monthly-calendar');
      }
    } catch {
      // No active subscription — stay on the subscription form
    }
  }

  async function loadMonthlyCalendar() {
    if (!currentSubscriptionId) return;
    try {
      var data = await API.get('/subscriptions/' + currentSubscriptionId + '/calendar');
      var days = data.days || [];

      // Update each day cell with status and indicator badges
      days.forEach(function(day) {
        var cell = document.querySelector('.cal-day-cell[data-date="' + day.date + '"]');
        if (!cell) return;

        // Store data for click handler
        if (day.morning) cell.dataset.morning = JSON.stringify(day.morning);
        if (day.evening) cell.dataset.evening = JSON.stringify(day.evening);

        // Status colour
        var statusClass = day.morning ? ('status-' + (day.morning.status || 'scheduled')) : '';
        if (statusClass) cell.classList.add(statusClass);

        // Indicator badges
        var indicators = '';
        if (day.morning) {
          var mColor = day.morning.status === 'completed' ? '#22c55e' : day.morning.status === 'cancelled' ? '#9ca3af' : '#3b82f6';
          indicators += '<span style="background:' + mColor + ';color:#fff;font-size:0.5625rem;font-weight:700;padding:1px 4px;border-radius:3px">M</span>';
        }
        if (day.evening) {
          var eColor = day.evening.status === 'completed' ? '#22c55e' : day.evening.status === 'cancelled' ? '#9ca3af' : '#8b5cf6';
          indicators += '<span style="background:' + eColor + ';color:#fff;font-size:0.5625rem;font-weight:700;padding:1px 4px;border-radius:3px">E</span>';
        }
        var indicatorDiv = cell.querySelector('div + div');
        if (indicatorDiv) indicatorDiv.innerHTML = indicators;
      });

      // Update summary footer
      var summary = document.getElementById('cal-summary');
      if (summary && data.summary) {
        var s = data.summary;
        summary.textContent = (s.totalTrips || 0) + ' trips this month · ≈ ' + Math.round(s.totalKm || 0) + ' km · R' + ((s.amountPrepaid || 0).toFixed(2)) + ' prepaid';
      } else if (summary) {
        summary.textContent = 'No trips scheduled yet.';
      }
    } catch (err) {
      var summary = document.getElementById('cal-summary');
      if (summary) summary.textContent = 'Unable to load calendar.';
    }
  }

  function showDayDetail(date, morningData, eveningData) {
    var panel = document.getElementById('day-detail-panel');
    if (!panel) return;
    panel.dataset.date = date;
    panel.style.display = 'block';

    var dateHeading = document.getElementById('day-detail-date');
    if (dateHeading) {
      var d = new Date(date + 'T12:00:00'); // noon to avoid DST issues
      dateHeading.textContent = d.toLocaleDateString('default', { weekday: 'long', day: 'numeric', month: 'long' });
    }

    var morningTimeEl = document.getElementById('day-morning-time');
    var morningStatusEl = document.getElementById('day-morning-status');
    if (morningTimeEl) morningTimeEl.value = (morningData && morningData.time) ? morningData.time : '07:30';
    if (morningStatusEl) {
      var mStatus = morningData ? (morningData.status || 'scheduled') : 'not-set';
      morningStatusEl.textContent = mStatus.charAt(0).toUpperCase() + mStatus.slice(1);
      morningStatusEl.className = 'chip chip--' + (mStatus === 'completed' ? 'completed' : mStatus === 'cancelled' ? 'cancelled' : 'active');
    }

    var eveningSection = document.getElementById('day-evening-section');
    var eveningTimeEl = document.getElementById('day-evening-time');
    if (eveningSection) eveningSection.style.display = eveningData ? 'block' : 'none';
    if (eveningTimeEl) eveningTimeEl.value = (eveningData && eveningData.time) ? eveningData.time : '17:30';

    // Reset destination change fields
    var destToggle = document.getElementById('day-dest-change-toggle');
    var dropoffAddr = document.getElementById('day-dropoff-address');
    if (destToggle) destToggle.checked = false;
    if (dropoffAddr) {
      dropoffAddr.style.display = 'none';
      dropoffAddr.value = '';
    }

    // Scroll to panel
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function handleSaveDayDetail() {
    var panel = document.getElementById('day-detail-panel');
    if (!panel || !panel.dataset.date || !currentSubscriptionId) return;
    var date = panel.dataset.date;

    var morningTimeEl = document.getElementById('day-morning-time');
    var eveningTimeEl = document.getElementById('day-evening-time');
    var eveningSection = document.getElementById('day-evening-section');
    var destToggle = document.getElementById('day-dest-change-toggle');
    var dropoffAddr = document.getElementById('day-dropoff-address');

    var saveBtn = document.getElementById('day-detail-save');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }

    try {
      var morningBody = { time: morningTimeEl ? morningTimeEl.value : '07:30' };
      if (destToggle && destToggle.checked && dropoffAddr && dropoffAddr.value.trim()) {
        morningBody.dropoffAddress = dropoffAddr.value.trim();
      }
      await API.post('/subscriptions/' + currentSubscriptionId + '/days/' + date + '/morning', morningBody);

      var eveningVisible = eveningSection && eveningSection.style.display !== 'none';
      if (eveningVisible && eveningTimeEl) {
        await API.post('/subscriptions/' + currentSubscriptionId + '/days/' + date + '/evening', {
          time: eveningTimeEl.value,
        });
      }
      Toast.show('Day updated successfully', 'success');
      await loadMonthlyCalendar();
      // Hide the panel
      panel.style.display = 'none';
    } catch (err) {
      Toast.show(err.message || 'Failed to save day changes', 'error');
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; }
    }
  }

  async function handleCancelDay(date, type) {
    if (!currentSubscriptionId || !date || !type) return;
    try {
      await API.del('/subscriptions/' + currentSubscriptionId + '/days/' + date + '/' + type);
      Toast.show(type.charAt(0).toUpperCase() + type.slice(1) + ' trip cancelled', 'success');
      await loadMonthlyCalendar();
      var panel = document.getElementById('day-detail-panel');
      if (panel) panel.style.display = 'none';
    } catch (err) {
      Toast.show(err.message || 'Failed to cancel trip', 'error');
    }
  }

  function toggleDestChange() {
    var destToggle = document.getElementById('day-dest-change-toggle');
    var dropoffAddr = document.getElementById('day-dropoff-address');
    if (!destToggle || !dropoffAddr) return;
    dropoffAddr.style.display = destToggle.checked ? 'block' : 'none';
  }

  function handleGoogleSignIn() {
    // Redirect to the backend OAuth initiation endpoint.
    // The backend generates a CSRF state, stores it in KV, and redirects to Google.
    window.location.href = '/api/auth/google';
  }

  function handleAppleSignIn() {
    window.location.href = '/api/auth/apple';
  }

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
    const tosAccepted = document.getElementById('reg-tos')?.checked;

    if (!name || !email || !password) {
      Toast.show('Please fill in required fields', 'warning');
      return;
    }
    if (password.length < 8) {
      Toast.show('Password must be at least 8 characters', 'warning');
      return;
    }
    if (!tosAccepted) {
      Toast.show('You must accept the Terms of Service to register.', 'warning');
      return;
    }

    try {
      localStorage.setItem('klubz_pending_tos_version', '1.0');
      await Auth.register({ name, email, phone, password, role });
    } catch {}
  }

  async function handleApplyPromoCode() {
    const input = document.getElementById('promo-input');
    const statusEl = document.getElementById('promo-status');
    const code = input?.value?.trim();
    if (!code) {
      activePromoCode = null;
      if (statusEl) statusEl.textContent = 'Enter a promo code.';
      return;
    }

    try {
      const result = await API.get(`/promo-codes/validate?code=${encodeURIComponent(code)}`);
      if (!result.isValid) {
        activePromoCode = null;
        if (statusEl) statusEl.textContent = `Promo invalid: ${String(result.reason || 'not available').replace(/_/g, ' ')}`;
        return;
      }
      activePromoCode = code;
      if (statusEl) {
        const label = result.discountType === 'percent'
          ? `${result.discountValue}% off`
          : `${formatCurrency((result.discountValue || 0) / 100)} off`;
        statusEl.textContent = `Applied: ${label}`;
      }
    } catch (err) {
      activePromoCode = null;
      if (statusEl) statusEl.textContent = err.message || 'Unable to validate promo code.';
    }
  }

  async function handleFindRide(e) {
    e.preventDefault();
    const pickup = document.getElementById('fr-pickup')?.value?.trim();
    const dropoff = document.getElementById('fr-dropoff')?.value?.trim();
    const date = document.getElementById('fr-date')?.value;
    const time = document.getElementById('fr-time')?.value;
    const seats = parseInt(document.querySelector('.seat-btn.active')?.dataset?.seats || '1');
    Store.setState({ requestedPassengerCount: seats });

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

      // Show pickup/dropoff pins on map
      const frMapEl = document.getElementById('fr-map');
      if (frMapEl) frMapEl.style.display = '';
      MapManager.init('fr-map', [pickupCoords.lat, pickupCoords.lng], 13);
      MapManager.setMarker('fr-map', 'pickup', [pickupCoords.lat, pickupCoords.lng], { label: 'Pickup' });
      MapManager.setMarker('fr-map', 'dropoff', [dropoffCoords.lat, dropoffCoords.lng], { label: 'Dropoff' });
      MapManager.fitRoute('fr-map');

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
          resultsContainer.querySelectorAll('.join-waitlist-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
              const tripId = btn.dataset.tripId || '';
              const passengerCount = Number.parseInt(btn.dataset.passengers || `${seats}`, 10);
              handleJoinWaitlist(tripId, passengerCount);
            });
          });
          const matchSubLink = document.getElementById('match-subscribe-link');
          if (matchSubLink) {
            matchSubLink.addEventListener('click', () => Router.navigate('subscription'));
          }
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
    const priceInput = parseFloat(document.getElementById('or-price')?.value || '0');
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

      // Build post body — include coordinates so backend can compute fare automatically;
      // only include price_per_seat as a fallback if no coordinates resolved fare.
      const tripBody = {
        departure: departureCoords,
        destination: destinationCoords,
        departureTime: new Date(`${date}T${time}`).getTime(),
        arrivalTime: new Date(`${date}T${time}`).getTime() + 30 * 60000,
        availableSeats: seats,
        routePolyline: [],
        shiftLocation: departure,
        trip_type: 'daily',
        pickup_lat: departureCoords.lat,
        pickup_lng: departureCoords.lng,
        dropoff_lat: destinationCoords.lat,
        dropoff_lng: destinationCoords.lng,
      };
      // Only include price_per_seat as fallback when no coordinates-based fare can be computed
      if (priceInput > 0) {
        tripBody.price_per_seat = priceInput;
      }

      await API.post('/matching/driver-trips', tripBody);
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
      await API.post('/matching/confirm', {
        matchId,
        driverTripId,
        riderRequestId,
        promoCode: activePromoCode || undefined,
      });
      Toast.show('Ride confirmed! The driver will be notified.', 'success');
      Router.navigate('my-trips');
    } catch (err) {
      Toast.show(err.message || 'Failed to confirm ride. Please try again.', 'error');
    }
  }

  async function handleJoinWaitlist(tripId, passengerCount) {
    if (!tripId) {
      Toast.show('Unable to join waitlist for this ride.', 'error');
      return;
    }
    try {
      const data = await API.post(`/trips/${tripId}/waitlist`, { passengerCount: Math.max(1, Number(passengerCount || 1)) });
      waitlistByTripId[String(tripId)] = {
        tripId,
        position: Number(data?.waitlist?.position ?? 0),
        passengerCount: Math.max(1, Number(passengerCount || 1)),
      };
      Toast.show(`You're #${data?.waitlist?.position ?? '?'} on the waitlist.`, 'success');
      Store.setState({ matchResults: [] });
      Router.navigate('my-trips');
    } catch (err) {
      Toast.show(err.message || 'Unable to join waitlist.', 'error');
    }
  }

  async function handleLeaveWaitlist(tripId) {
    const confirmed = await showConfirmDialog({
      title: 'Leave Waitlist',
      message: 'Remove yourself from this waitlist?',
      confirmText: 'Leave',
      cancelText: 'Keep',
      danger: false,
    });
    if (!confirmed) return;

    try {
      await API.del(`/trips/${tripId}/waitlist`);
      clearWaitlistEntry(tripId);
      Toast.show('Removed from waitlist.', 'success');
      await loadTrips('upcoming');
    } catch (err) {
      Toast.show(err.message || 'Unable to leave waitlist.', 'error');
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

  function loadFindRide() {
    const dateEl = document.getElementById('fr-date');
    const timeEl = document.getElementById('fr-time');
    if (!dateEl || !timeEl) return;
    const now = new Date();
    dateEl.value = now.toISOString().slice(0, 10);
    // Round up to the next 15-minute boundary, at least 30 min from now
    now.setMinutes(Math.ceil((now.getMinutes() + 30) / 15) * 15, 0, 0);
    timeEl.value = now.toTimeString().slice(0, 5);
    activePromoCode = null;
    const promoStatus = document.getElementById('promo-status');
    if (promoStatus) promoStatus.textContent = '';
  }

  async function loadCarbonStats() {
    const user = Store.state.user;
    if (!user?.id) return;
    try {
      const data = await API.get(`/users/${user.id}`);
      const stats = data.stats || {};
      const carbonSaved = stats.carbonSaved ?? 0;
      const completed = stats.completedTrips ?? stats.totalTrips ?? 0;
      const trees = Math.floor(carbonSaved / 22);
      const cars = (carbonSaved / 4600).toFixed(1);
      const km = (completed * 30).toLocaleString();

      const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
      set('carbon-saved-value', carbonSaved.toFixed(1));
      set('carbon-trees', trees);
      set('carbon-km', km);
      set('carbon-trips', completed);
      set('carbon-cars', cars);

      const detail = document.getElementById('carbon-impact-detail');
      if (detail) {
        detail.innerHTML = completed > 0
          ? `You've completed <strong>${completed}</strong> shared trip${completed !== 1 ? 's' : ''}, saving the equivalent of <strong>${trees}</strong> tree${trees !== 1 ? 's' : ''} worth of CO₂ and removing <strong>${cars}</strong> car${cars !== '1.0' ? 's' : ''} from the road.`
          : `Complete your first shared trip to start tracking your environmental impact.`;
      }
    } catch {
      const el = document.getElementById('carbon-impact-detail');
      if (el) el.textContent = 'Unable to load carbon data.';
    }
  }

  async function loadProfileStats() {
    const user = Store.state.user;
    if (!user?.id) return;
    try {
      const data = await API.get('/users/profile');
      const stats = data.stats || {};
      const totalTrips = stats.totalTrips ?? 0;
      const rating = stats.rating ? Number(stats.rating).toFixed(1) : '—';
      const carbonSaved = stats.carbonSaved ? Number(stats.carbonSaved).toFixed(1) : '0.0';

      const statsEl = document.getElementById('profile-stats');
      if (statsEl) {
        statsEl.innerHTML = `
          <div class="stat-card">
            <div class="stat-card__value">${totalTrips}</div>
            <div class="stat-card__label">Trips</div>
          </div>
          <div class="stat-card">
            <div class="stat-card__value">${rating}</div>
            <div class="stat-card__label">Rating</div>
          </div>
          <div class="stat-card">
            <div class="stat-card__value" style="font-size:1rem">${carbonSaved}</div>
            <div class="stat-card__label">kg CO₂ Saved</div>
          </div>
        `;
      }

      const subtitleEl = document.getElementById('profile-carbon-subtitle');
      if (subtitleEl) subtitleEl.textContent = `${carbonSaved} kg CO₂ saved`;
    } catch {
      const statsEl = document.getElementById('profile-stats');
      if (statsEl) statsEl.innerHTML = '';
    }
  }

  async function loadChatMessages() {
    const tripId = Store.state.activeChatTripId || Store.state.activeTrip?.id;
    const logEl = document.getElementById('chat-log');
    if (!tripId || !logEl) return;
    clearChatUnread(tripId);

    try {
      const data = await API.get(`/trips/${tripId}/messages?limit=50&page=1`);
      const messages = data?.messages || [];
      const currentUserId = Number(Store.state.user?.id);

      if (!messages.length) {
        logEl.innerHTML = '<div style=\"text-align:center;color:var(--text-muted);padding:var(--space-lg)\">No messages yet. Start the conversation.</div>';
        return;
      }

      logEl.innerHTML = messages.map((msg) => {
        const mine = Number(msg.senderId) === currentUserId;
        const readIndicator = msg.readAt ? '✓✓' : '✓';
        return `
          <div style="display:flex;justify-content:${mine ? 'flex-end' : 'flex-start'};margin-bottom:var(--space-sm)">
            <div style="max-width:78%;padding:var(--space-sm);border-radius:10px;background:${mine ? 'var(--primary)' : 'var(--surface)'};color:${mine ? '#fff' : 'var(--text-primary)'};border:${mine ? 'none' : '1px solid var(--border)'}">
              <div style="font-size:0.6875rem;opacity:${mine ? '0.8' : '0.65'};margin-bottom:2px">${escapeHtml(msg.senderName || 'User')}</div>
              <div style="font-size:0.875rem;white-space:pre-wrap">${escapeHtml(msg.content || '')}</div>
              <div style="font-size:0.625rem;opacity:${mine ? '0.75' : '0.6'};margin-top:4px;display:flex;justify-content:flex-end;gap:4px">
                <span>${timeAgo(msg.sentAt)}</span>
                <span aria-label="${msg.readAt ? 'Read' : 'Sent'}">${readIndicator}</span>
              </div>
            </div>
          </div>
        `;
      }).join('');
      logEl.scrollTop = logEl.scrollHeight;

      const unreadIds = messages
        .filter((msg) => Number(msg.senderId) !== currentUserId && !msg.readAt)
        .map((msg) => msg.id);
      if (unreadIds.length) {
        Promise.all(
          unreadIds.map((id) => API.put(`/trips/${tripId}/messages/${id}/read`, {}).catch(() => null)),
        );
      }
    } catch (err) {
      logEl.innerHTML = `<div style=\"text-align:center;color:var(--danger);padding:var(--space-lg)\">${escapeHtml(err.message || 'Failed to load messages')}</div>`;
    }
  }

  async function handleChatSubmit(e) {
    e.preventDefault();
    const tripId = Store.state.activeChatTripId || Store.state.activeTrip?.id;
    const input = document.getElementById('chat-input');
    const content = input?.value?.trim();
    if (!tripId || !content) return;

    try {
      await API.post(`/trips/${tripId}/messages`, { content });
      input.value = '';
      await loadChatMessages();
    } catch (err) {
      Toast.show(err.message || 'Failed to send message', 'error');
    }
  }

  async function loadPayoutStatus() {
    const card = document.getElementById('payouts-status-card');
    if (!card) return;

    try {
      const status = await API.get('/payments/connect/status');
      const connected = !!status.connected;
      const ready = !!status.chargesEnabled && !!status.payoutsEnabled;
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-sm)">
          <h3 style="font-size:1rem;font-weight:700;margin:0">Stripe Connect</h3>
          <span class="chip chip--${ready ? 'active' : connected ? 'pending' : 'cancelled'}">${ready ? 'Payouts Ready' : connected ? 'Setup Incomplete' : 'Not Connected'}</span>
        </div>
        <div style="font-size:0.875rem;color:var(--text-muted)">
          ${connected ? `Account: ${escapeHtml(status.accountId || 'created')}` : 'No connected payout account yet.'}
        </div>
        <div style="font-size:0.8125rem;color:var(--text-muted);margin-top:var(--space-xs)">
          Charges: ${status.chargesEnabled ? 'Enabled' : 'Not enabled'} · Payouts: ${status.payoutsEnabled ? 'Enabled' : 'Not enabled'}
        </div>
      `;
    } catch (err) {
      card.innerHTML = `<div style=\"color:var(--danger)\">${escapeHtml(err.message || 'Unable to load payout status')}</div>`;
    }
  }

  async function handlePayoutSetup() {
    try {
      const data = await API.post('/payments/connect/onboard', {});
      if (data?.onboardingUrl) {
        window.location.href = data.onboardingUrl;
        return;
      }
      Toast.show('Onboarding URL unavailable.', 'warning');
    } catch (err) {
      Toast.show(err.message || 'Failed to start onboarding', 'error');
    }
  }

  async function handlePayoutDashboard() {
    try {
      const data = await API.get('/payments/connect/dashboard');
      if (data?.url) {
        window.location.href = data.url;
        return;
      }
      Toast.show('Dashboard link unavailable.', 'warning');
    } catch (err) {
      Toast.show(err.message || 'Failed to open dashboard', 'error');
    }
  }

  function openTripTracking(trip) {
    if (!trip?.id) return;
    const pickup = trip.pickupLocation?.address || trip.pickupLocation || trip.origin || 'Pickup';
    const dropoff = trip.dropoffLocation?.address || trip.dropoffLocation || trip.destination || 'Dropoff';
    Store.setState({
      activeTrip: {
        id: trip.id,
        role: trip.participantRole === 'driver' ? 'driver' : 'rider',
        title: trip.title || `${pickup} → ${dropoff}`,
        scheduledTime: trip.scheduledTime,
      },
    });
    Router.navigate('trip-active');
  }

  function openTripChat(trip) {
    if (!trip?.id) return;
    const pickup = trip.pickupLocation?.address || trip.pickupLocation || trip.origin || 'Pickup';
    const dropoff = trip.dropoffLocation?.address || trip.dropoffLocation || trip.destination || 'Dropoff';
    clearChatUnread(trip.id);
    Store.setState({
      activeTrip: {
        id: trip.id,
        role: trip.participantRole === 'driver' ? 'driver' : 'rider',
        title: trip.title || `${pickup} → ${dropoff}`,
        scheduledTime: trip.scheduledTime,
      },
      activeChatTripId: trip.id,
    });
    Router.navigate('chat');
  }

  function clearWaitlistEntry(tripId) {
    if (!tripId && tripId !== 0) return;
    delete waitlistByTripId[String(tripId)];
  }

  function incrementChatUnread(tripId) {
    const id = Number.parseInt(String(tripId || ''), 10);
    if (!Number.isFinite(id) || id <= 0) return;
    chatUnreadByTripId[String(id)] = Number(chatUnreadByTripId[String(id)] || 0) + 1;
    updateTripChatBadge();
  }

  function clearChatUnread(tripId) {
    const id = Number.parseInt(String(tripId || ''), 10);
    if (!Number.isFinite(id) || id <= 0) return;
    delete chatUnreadByTripId[String(id)];
    updateTripChatBadge();
  }

  function updateTripChatBadge() {
    const btn = document.getElementById('trip-chat-btn');
    if (!btn) return;
    const tripId = Number.parseInt(String(Store.state.activeTrip?.id || ''), 10);
    const unreadCount = Number.isFinite(tripId) ? Number(chatUnreadByTripId[String(tripId)] || 0) : 0;
    btn.textContent = unreadCount > 0 ? `Open Chat (${unreadCount})` : 'Open Chat';
    btn.setAttribute(
      'aria-label',
      unreadCount > 0 ? `Open Chat, ${unreadCount} unread messages` : 'Open Chat',
    );
  }

  function getCancellationEstimate(trip) {
    const departure = new Date(trip.scheduledTime || trip.departureTime || Date.now()).getTime();
    const hoursUntil = Number.isFinite(departure)
      ? (departure - Date.now()) / 3_600_000
      : -1;
    const refundPct = hoursUntil >= 24 ? 1 : hoursUntil >= 6 ? 0.5 : 0;
    const seatPrice = Number(trip.price ?? trip.pricePerSeat ?? 0);
    const passengers = Math.max(1, Number(trip.passengerCount ?? 1));
    return {
      refundPct,
      refundAmount: Math.max(0, seatPrice * passengers * refundPct),
    };
  }

  async function handleCancelBooking(trip) {
    const estimate = getCancellationEstimate(trip);
    const refundPctLabel = `${Math.round(estimate.refundPct * 100)}%`;
    const confirmed = await showConfirmDialog({
      title: 'Cancel Booking',
      message: `You will receive a ${refundPctLabel} refund (${formatCurrency(estimate.refundAmount)}). Continue?`,
      confirmText: 'Cancel Booking',
      cancelText: 'Keep Booking',
      danger: true,
    });
    if (!confirmed) return;

    try {
      const result = await API.del(`/trips/${trip.id}/book`);
      const finalRefund = Number(result?.cancellation?.refundAmount ?? estimate.refundAmount);
      Toast.show(`Booking cancelled. Refund: ${formatCurrency(finalRefund)}.`, 'success');
      await loadTrips('upcoming');
    } catch (err) {
      Toast.show(err.message || 'Unable to cancel booking.', 'error');
    }
  }

  async function handleRateTrip(trip, currentTab) {
    const ratingPayload = await showRatingDialog(trip.id, trip.driver?.name || trip.driverName || 'driver');
    if (!ratingPayload) return;
    try {
      await API.post(`/trips/${trip.id}/rate`, {
        rating: ratingPayload.rating,
        comment: ratingPayload.comment || undefined,
      });
      Toast.show('Thanks for your feedback.', 'success');
      await loadTrips(currentTab);
    } catch (err) {
      Toast.show(err.message || 'Unable to submit your rating.', 'error');
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
        const tripById = new Map((data.trips || []).map((trip) => [String(trip.id), trip]));
        container.innerHTML = data.trips.map((trip) => {
          const isWaitlisted = status === 'upcoming'
            && (trip.waitlistStatus === 'waiting' || trip.participantStatus === 'waitlisted');

          if (isWaitlisted) {
            waitlistByTripId[String(trip.id)] = {
              tripId: Number(trip.id),
              position: Number(trip.waitlistPosition || 0),
              passengerCount: Math.max(1, Number(trip.passengerCount || 1)),
            };
          } else if (status === 'upcoming' && trip.participantStatus === 'accepted') {
            clearWaitlistEntry(trip.id);
          }

          const card = renderTripCard(trip);
          const actions = [];

          if (status === 'completed' && trip.participantRole === 'rider') {
            if (trip.rating == null) {
              actions.push(`
                <button class="btn btn--secondary btn--sm trip-rate-btn" data-trip-id="${trip.id}">
                  Rate Trip
                </button>
              `);
            } else {
              const stars = '★'.repeat(Math.max(1, Math.min(5, Number(trip.rating))));
              actions.push(`
                <span class="chip chip--active" style="display:inline-flex">Rated ${stars}</span>
              `);
            }
            actions.push(`
              <button class="btn btn--ghost btn--sm report-issue-btn" data-trip-id="${trip.id}">
                Report Issue
              </button>
            `);
          }

          if (status === 'upcoming' && trip.participantStatus === 'accepted') {
            actions.push(`
              <button class="btn btn--secondary btn--sm trip-track-btn" data-trip-id="${trip.id}">
                Track Trip
              </button>
            `);
            actions.push(`
              <button class="btn btn--secondary btn--sm trip-chat-btn" data-trip-id="${trip.id}">
                Chat
              </button>
            `);
            if (trip.participantRole === 'rider') {
              actions.push(`
                <button class="btn btn--danger btn--sm trip-cancel-booking-btn" data-trip-id="${trip.id}">
                  Cancel Booking
                </button>
              `);
            }
          }

          if (isWaitlisted) {
            const position = Number(trip.waitlistPosition || waitlistByTripId[String(trip.id)]?.position || 0);
            actions.push(`<span class="chip chip--pending">Waitlisted${position > 0 ? ` · #${position}` : ''}</span>`);
            actions.push(`
              <button class="btn btn--secondary btn--sm trip-leave-waitlist-btn" data-trip-id="${trip.id}">
                Leave Waitlist
              </button>
            `);
          }

          if (actions.length) {
            return `
              <div style="margin-bottom:var(--space-md)">
                ${card}
                <div style="display:flex;gap:var(--space-sm);flex-wrap:wrap;margin-top:var(--space-sm)">
                  ${actions.join('')}
                </div>
              </div>
            `;
          }
          return card;
        }).join('');

        if (status === 'upcoming') {
          const fallbackWaitlistCards = Object.values(waitlistByTripId)
            .filter((entry) => !tripById.has(String(entry.tripId)))
            .map((entry) => `
              <div style="margin-bottom:var(--space-md)">
                <div class="card">
                  <div style="display:flex;justify-content:space-between;align-items:center;gap:var(--space-sm);margin-bottom:var(--space-sm)">
                    <h4 style="font-size:0.9375rem;font-weight:700;margin:0">Trip #${entry.tripId}</h4>
                    <span class="chip chip--pending">Waitlisted${entry.position > 0 ? ` · #${entry.position}` : ''}</span>
                  </div>
                  <p style="font-size:0.8125rem;color:var(--text-muted);margin-bottom:var(--space-sm)">
                    You're on the waitlist and will be notified when a seat opens.
                  </p>
                  <button class="btn btn--secondary btn--sm trip-leave-waitlist-btn" data-trip-id="${entry.tripId}">
                    Leave Waitlist
                  </button>
                </div>
              </div>
            `)
            .join('');
          if (fallbackWaitlistCards) {
            container.insertAdjacentHTML('beforeend', fallbackWaitlistCards);
          }
        }

        container.querySelectorAll('.trip-track-btn').forEach((btn) => {
          btn.addEventListener('click', () => {
            const trip = tripById.get(String(btn.dataset.tripId || ''));
            if (trip) openTripTracking(trip);
          });
        });
        container.querySelectorAll('.trip-cancel-booking-btn').forEach((btn) => {
          btn.addEventListener('click', () => {
            const trip = tripById.get(String(btn.dataset.tripId || ''));
            if (trip) handleCancelBooking(trip);
          });
        });
        container.querySelectorAll('.trip-chat-btn').forEach((btn) => {
          btn.addEventListener('click', () => {
            const trip = tripById.get(String(btn.dataset.tripId || ''));
            if (trip) openTripChat(trip);
          });
        });
        container.querySelectorAll('.trip-leave-waitlist-btn').forEach((btn) => {
          btn.addEventListener('click', () => {
            const tripId = Number.parseInt(btn.dataset.tripId || '0', 10);
            if (tripId > 0) handleLeaveWaitlist(tripId);
          });
        });
        container.querySelectorAll('.trip-rate-btn').forEach((btn) => {
          btn.addEventListener('click', () => {
            const trip = tripById.get(String(btn.dataset.tripId || ''));
            if (trip) handleRateTrip(trip, status);
          });
        });
        container.querySelectorAll('.report-issue-btn').forEach((btn) => {
          btn.addEventListener('click', () => {
            const tripId = parseInt(btn.dataset.tripId || '0', 10);
            if (tripId > 0) handleReportIssue(tripId);
          });
        });
      } else {
        const waitlistCards = status === 'upcoming'
          ? Object.values(waitlistByTripId).map((entry) => `
              <div style="margin-bottom:var(--space-md)">
                <div class="card">
                  <div style="display:flex;justify-content:space-between;align-items:center;gap:var(--space-sm);margin-bottom:var(--space-sm)">
                    <h4 style="font-size:0.9375rem;font-weight:700;margin:0">Trip #${entry.tripId}</h4>
                    <span class="chip chip--pending">Waitlisted${entry.position > 0 ? ` · #${entry.position}` : ''}</span>
                  </div>
                  <p style="font-size:0.8125rem;color:var(--text-muted);margin-bottom:var(--space-sm)">
                    You're on the waitlist and will be notified when a seat opens.
                  </p>
                  <button class="btn btn--secondary btn--sm trip-leave-waitlist-btn" data-trip-id="${entry.tripId}">
                    Leave Waitlist
                  </button>
                </div>
              </div>
            `).join('')
          : '';

        container.innerHTML = waitlistCards + `
          <div class="empty-state">
            <div class="empty-state__icon">${status === 'completed' ? '&#9989;' : status === 'cancelled' ? '&#10060;' : '&#128652;'}</div>
            <div class="empty-state__title">No ${status} trips</div>
            <div class="empty-state__desc">${status === 'upcoming' ? 'Find a ride or offer one to get started' : `You don't have any ${status} trips yet`}</div>
          </div>
        `;
        container.querySelectorAll('.trip-leave-waitlist-btn').forEach((btn) => {
          btn.addEventListener('click', () => {
            const tripId = Number.parseInt(btn.dataset.tripId || '0', 10);
            if (tripId > 0) handleLeaveWaitlist(tripId);
          });
        });
      }
    } catch {
      container.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:var(--space-xl)">Unable to load trips</p>';
    }
  }

  async function loadMyTripsSub() {
    const section = document.getElementById('my-trips-sub-section');
    if (!section) return;
    try {
      const data = await API.get('/subscriptions/current');
      const sub = data.subscription;
      if (sub) {
        const amount = (sub.estimated_amount_cents / 100).toFixed(2);
        section.innerHTML = `
          <h3 class="section-title" style="font-size:1rem;margin-bottom:var(--space-md)">Monthly Subscription</h3>
          <div class="sub-card card" style="padding:var(--space-md)">
            <div class="sub-month" style="font-weight:600;font-size:0.9375rem;margin-bottom:var(--space-xs)">${escapeHtml(sub.subscription_month)}</div>
            <div class="sub-status chip chip--${sub.status === 'active' ? 'active' : sub.status === 'pending_payment' ? 'pending' : 'cancelled'}" style="margin-bottom:var(--space-xs)">${escapeHtml(sub.status.replace('_', ' '))}</div>
            <div class="sub-amount" style="font-size:1rem;font-weight:700;color:var(--primary);margin-bottom:var(--space-xs)">R${amount}/month</div>
            <div class="sub-days" style="font-size:0.8125rem;color:var(--text-muted);margin-bottom:var(--space-md)">${sub.estimated_days || 0} days scheduled</div>
            <button class="btn btn--secondary btn--full" id="view-cal-btn">View Calendar</button>
          </div>
        `;
        const calBtn = document.getElementById('view-cal-btn');
        if (calBtn) {
          calBtn.addEventListener('click', () => {
            currentSubscriptionId = sub.id;
            Router.navigate('monthly-calendar');
          });
        }
      } else {
        section.innerHTML = `
          <h3 class="section-title" style="font-size:1rem;margin-bottom:var(--space-md)">Monthly Subscription</h3>
          <p style="color:var(--text-muted);font-size:0.875rem">No active subscription. <a href="#" id="sub-cta-link" style="color:var(--primary-light);text-decoration:none;font-weight:600">Subscribe to save 25% &#8594;</a></p>
        `;
        const ctaLink = document.getElementById('sub-cta-link');
        if (ctaLink) ctaLink.addEventListener('click', (e) => { e.preventDefault(); Router.navigate('subscription'); });
      }
    } catch {
      section.innerHTML = `
        <h3 class="section-title" style="font-size:1rem;margin-bottom:var(--space-md)">Monthly Subscription</h3>
        <p class="error-text" style="color:var(--danger);font-size:0.875rem">Could not load subscription.</p>
      `;
    }
  }

  async function loadDriverDocs() {
    try {
      const data = await API.get('/users/documents');
      const docsByType = {};
      (data.documents || []).forEach((doc) => {
        if (!docsByType[doc.doc_type]) docsByType[doc.doc_type] = doc;
      });

      ['drivers_license', 'id_document', 'vehicle_registration', 'proof_of_insurance'].forEach((type) => {
        const statusEl = document.getElementById(`doc-status-${type}`);
        const uploadBtn = document.querySelector(`.doc-upload-btn[data-doc-type="${type}"]`);
        const doc = docsByType[type];
        if (statusEl) {
          if (!doc) statusEl.textContent = 'Not uploaded';
          else statusEl.textContent = `Status: ${String(doc.status || 'pending').replace('_', ' ')}`;
        }
        if (uploadBtn) {
          uploadBtn.textContent = doc ? 'Re-upload' : 'Upload';
        }
      });
    } catch {
      Toast.show('Unable to load driver documents.', 'error');
    }
  }

  async function handleDocumentUpload(docType) {
    const input = document.getElementById('doc-file-input');
    if (!input) return;

    input.value = '';
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const uploadData = await API.post('/users/documents/upload-url', { docType });
        const token = localStorage.getItem(CONFIG.TOKEN_KEY);
        const uploadRes = await fetch(`${CONFIG.API_BASE}/users/documents/r2-upload?uploadToken=${encodeURIComponent(uploadData.uploadToken)}`, {
          method: 'POST',
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            'Content-Type': file.type || 'application/octet-stream',
          },
          body: file,
        });
        if (!uploadRes.ok) {
          const err = await uploadRes.json().catch(() => ({}));
          throw new Error(err.error?.message || 'Failed to upload file');
        }
        await API.post('/users/documents', {
          fileKey: uploadData.fileKey,
          docType,
          fileName: file.name,
        });
        Toast.show('Document uploaded successfully.', 'success');
        loadDriverDocs();
      } catch (err) {
        Toast.show(err.message || 'Document upload failed.', 'error');
      }
    };
    input.click();
  }

  async function loadDriverEarnings() {
    const summaryEl = document.getElementById('earnings-summary');
    const tableEl = document.getElementById('earnings-table');
    if (!summaryEl || !tableEl) return;

    try {
      const data = await API.get('/users/earnings');
      const summary = data.summary || {};
      const months = data.months || [];

      summaryEl.innerHTML = `
        <div class="stat-card">
          <div class="stat-card__value">${formatCurrency(summary.totalEarnings || 0)}</div>
          <div class="stat-card__label">Total</div>
        </div>
        <div class="stat-card">
          <div class="stat-card__value">${summary.totalTrips || 0}</div>
          <div class="stat-card__label">Trips</div>
        </div>
        <div class="stat-card">
          <div class="stat-card__value">${formatCurrency(summary.avgPerTrip || 0)}</div>
          <div class="stat-card__label">Avg / Trip</div>
        </div>
      `;

      if (!months.length) {
        tableEl.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:var(--space-md)">No completed driver trips yet.</p>';
        return;
      }

      tableEl.innerHTML = months.map((row) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:var(--space-sm) 0;border-bottom:1px solid var(--border)">
          <div>
            <div style="font-weight:600">${escapeHtml(row.month)}</div>
            <div style="font-size:0.8125rem;color:var(--text-muted)">${row.trip_count} trip${row.trip_count === 1 ? '' : 's'}</div>
          </div>
          <div style="font-weight:700">${formatCurrency(row.estimated_earnings || 0)}</div>
        </div>
      `).join('');
    } catch {
      tableEl.innerHTML = '<p style="color:var(--danger);text-align:center;padding:var(--space-md)">Unable to load earnings.</p>';
    }
  }

  async function handleReportIssue(tripId) {
    const reason = await showPromptDialog({
      title: 'Report Issue',
      message: 'Describe the issue with this trip.',
      placeholder: 'Provide details',
      confirmText: 'Submit Report',
      minLength: 10,
      multiline: true,
    });
    if (!reason) return;
    try {
      await API.post('/disputes', { tripId, reason: reason.trim() });
      Toast.show('Your report has been submitted.', 'success');
    } catch (err) {
      Toast.show(err.message || 'Unable to submit report.', 'error');
    }
  }

  async function loadReferralData() {
    try {
      const [ref, points] = await Promise.all([
        API.get('/users/referral'),
        API.get('/users/points'),
      ]);

      currentReferralCode = ref.code || '';
      const referralCodeEl = document.getElementById('referral-code');
      if (referralCodeEl) referralCodeEl.textContent = currentReferralCode || 'Unavailable';

      const balanceEl = document.getElementById('points-balance');
      if (balanceEl) balanceEl.textContent = `${points.balance || 0} pts`;

      const historyEl = document.getElementById('points-history');
      if (!historyEl) return;
      const history = points.history || [];
      if (!history.length) {
        historyEl.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem">No points activity yet.</p>';
        return;
      }
      historyEl.innerHTML = history.map((item) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:var(--space-xs) 0;border-bottom:1px solid var(--border)">
          <span style="font-size:0.8125rem">${escapeHtml(item.reason)}</span>
          <span class="chip chip--${item.delta >= 0 ? 'active' : 'cancelled'}">${item.delta >= 0 ? '+' : ''}${item.delta}</span>
        </div>
      `).join('');
    } catch {
      Toast.show('Unable to load referral data.', 'error');
    }
  }

  function copyReferralCode() {
    if (!currentReferralCode) return;
    navigator.clipboard.writeText(currentReferralCode).then(() => {
      Toast.show('Referral code copied.', 'success');
    }).catch(() => {
      Toast.show('Could not copy referral code.', 'error');
    });
  }

  async function shareReferralCode() {
    if (!currentReferralCode) return;
    const text = `Join me on Klubz! Use my referral code: ${currentReferralCode}`;
    if (navigator.share) {
      try {
        await navigator.share({ text });
        return;
      } catch {
        // fall back to copy
      }
    }
    await navigator.clipboard.writeText(text).catch(() => {});
    Toast.show('Referral message copied.', 'success');
  }

  async function handleReferralRedeem() {
    const input = document.getElementById('referral-input');
    const code = input?.value?.trim();
    if (!code) {
      Toast.show('Enter a referral code first.', 'warning');
      return;
    }
    try {
      await API.post('/referrals/redeem', { referralCode: code });
      Toast.show('Referral redeemed. 200 points added!', 'success');
      if (input) input.value = '';
      loadReferralData();
    } catch (err) {
      Toast.show(err.message || 'Could not redeem referral code.', 'error');
    }
  }

  async function loadOrganization() {
    const content = document.getElementById('organization-content');
    if (!content) return;

    try {
      const data = await API.get('/organizations/current');
      const org = data.organization;
      if (!org) {
        content.innerHTML = `
          <div class="card" style="margin-bottom:var(--space-md)">
            <h4 style="font-size:0.9375rem;font-weight:700;margin-bottom:var(--space-sm)">Create an organization</h4>
            <form id="org-create-form">
              <input class="form-input" id="org-name-input" placeholder="Organization name" required style="margin-bottom:var(--space-sm)">
              <button class="btn btn--primary btn--full" type="submit">Create</button>
            </form>
          </div>
          <div class="card">
            <h4 style="font-size:0.9375rem;font-weight:700;margin-bottom:var(--space-sm)">Join with invite code</h4>
            <form id="org-join-form" style="display:flex;gap:var(--space-sm)">
              <input class="form-input" id="org-invite-input" placeholder="Invite code" required>
              <button class="btn btn--secondary" type="submit">Join</button>
            </form>
          </div>
        `;
      } else {
        currentOrganizationInviteCode = org.inviteCode || '';
        content.innerHTML = `
          <div class="card">
            <div style="font-size:0.8125rem;color:var(--text-muted);margin-bottom:var(--space-xs)">Organization</div>
            <div style="font-size:1.125rem;font-weight:800;margin-bottom:var(--space-xs)">${escapeHtml(org.name)}</div>
            <div style="font-size:0.8125rem;color:var(--text-muted);margin-bottom:var(--space-sm)">${org.memberCount || 0} members</div>
            <div style="display:flex;gap:var(--space-sm);align-items:center">
              <span class="chip chip--active">${escapeHtml(currentOrganizationInviteCode || 'No invite code')}</span>
              <button class="btn btn--secondary btn--sm" id="org-copy-code-btn">Copy Code</button>
            </div>
          </div>
        `;
      }
      content.querySelector('#org-create-form')?.addEventListener('submit', handleCreateOrganization);
      content.querySelector('#org-join-form')?.addEventListener('submit', handleJoinOrganization);
      content.querySelector('#org-copy-code-btn')?.addEventListener('click', copyOrganizationInviteCode);
    } catch {
      content.innerHTML = '<p style="color:var(--danger)">Unable to load organization data.</p>';
    }
  }

  async function handleCreateOrganization(e) {
    e.preventDefault();
    const name = document.getElementById('org-name-input')?.value?.trim();
    if (!name) return;
    try {
      await API.post('/organizations', { name });
      Toast.show('Organization created successfully.', 'success');
      loadOrganization();
    } catch (err) {
      Toast.show(err.message || 'Could not create organization.', 'error');
    }
  }

  async function handleJoinOrganization(e) {
    e.preventDefault();
    const inviteCode = document.getElementById('org-invite-input')?.value?.trim();
    if (!inviteCode) return;
    try {
      await API.post('/organizations/join', { inviteCode });
      Toast.show('Joined organization successfully.', 'success');
      loadOrganization();
    } catch (err) {
      Toast.show(err.message || 'Could not join organization.', 'error');
    }
  }

  function copyOrganizationInviteCode() {
    if (!currentOrganizationInviteCode) return;
    navigator.clipboard.writeText(currentOrganizationInviteCode).then(() => {
      Toast.show('Invite code copied.', 'success');
    }).catch(() => {
      Toast.show('Unable to copy invite code.', 'error');
    });
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
            <span class="header-btn__badge">0</span>
          </button>
          <div class="avatar-sm" id="profile-avatar-btn" style="cursor:pointer" role="button" tabindex="0" aria-label="Profile">
            ${getInitials(Store.state.user?.name || Store.state.user?.email || 'U')}
          </div>
        </div>
      </header>

      <!-- Toast container -->
      <div class="toast-container" id="toast-container" aria-live="polite" aria-atomic="true"></div>

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
    document.getElementById('notifications-btn')?.addEventListener('click', openNotificationsPanel);

    // Profile avatar in header
    const avatarBtn = document.getElementById('profile-avatar-btn');
    avatarBtn?.addEventListener('click', () => {
      Router.navigate('profile');
    });
    avatarBtn?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        Router.navigate('profile');
      }
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

    // Wire SSE: connect when authenticated, disconnect on logout
    Store.subscribe((state) => {
      if (state.isAuthenticated) SSEClient.connect();
      else SSEClient.disconnect();
    });
    if (Store.state.isAuthenticated) {
      SSEClient.connect();
      subscribeToNotifications();
    }

    // Restore notification badge count
    NotificationBadge.set(NotificationBadge._count);

    // Handle redirects with URL query parameters (email verification, OAuth callbacks)
    const params = new URLSearchParams(window.location.search);

    if (params.get('verified') === '1') {
      // Email verification success (?verified=1 set by /api/auth/verify-email redirect)
      setTimeout(() => Toast.show('Email verified! You can now log in.', 'success'), 300);
      window.history.replaceState({}, '', window.location.hash || '/');

    } else if (params.get('oauth_code')) {
      // Google OAuth success — exchange the short-lived code for tokens
      const oauthCode = params.get('oauth_code');
      // Clean the URL immediately so the code is not reused on reload
      window.history.replaceState({}, '', window.location.hash || '/');
      Auth.handleOAuthCallback(oauthCode);

    } else if (params.get('oauth_error')) {
      // Google OAuth failure — show a user-friendly error and land on login screen
      const reason = params.get('oauth_error');
      window.history.replaceState({}, '', window.location.hash || '/');
      const errorMessages = {
        cancelled: 'Google sign-in was cancelled.',
        config: 'Google sign-in is not configured on this server.',
        state_invalid: 'Sign-in session expired — please try again.',
        state_missing: 'Sign-in request was invalid — please try again.',
        token_exchange: 'Google sign-in failed — please try again.',
        userinfo: 'Could not retrieve your Google profile — please try again.',
        no_email: 'Your Google account does not have a public email address.',
        db_unavailable: 'Service temporarily unavailable — please try again.',
        account_disabled: 'Your account has been disabled.',
        server_error: 'A server error occurred — please try again.',
        service_unavailable: 'Service temporarily unavailable — please try again.',
      };
      const msg = errorMessages[reason] || 'Google sign-in failed. Please try again.';
      setTimeout(() => Toast.show(msg, 'error'), 300);
    }
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
})();
