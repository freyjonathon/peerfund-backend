// src/utils/api.js
export const API_BASE_URL = (process.env.REACT_APP_API_URL || 'http://localhost:5050').replace(/\/$/, '');

export function getToken() {
  if (typeof window === 'undefined') return '';
  const t = localStorage.getItem('token') || '';
  return t.replace(/^"|"$/g, '');
}

export function apiUrl(path) {
  // allow already-absolute URLs
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

export async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = {
    ...(options.headers || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const res = await fetch(apiUrl(path), { ...options, headers });

  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  if (!contentType.includes('application/json')) {
    throw new Error(
      `Expected JSON but got "${contentType || 'unknown'}". Body starts: ${text.slice(0, 120)}`
    );
  }

  return text ? JSON.parse(text) : null;
}
