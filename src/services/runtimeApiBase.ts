// src/services/runtimeApiBase.ts
//
// Runtime override for the online-music (Netease) API base URL.
//
// Why this exists:
//   The build-time value comes from VITE_NETEASE_API_BASE and is baked into the
//   bundle. That is fine for a fixed deployment, but it makes a self-hosted /
//   tunnelled backend painful: every time the tunnel address changes you have to
//   rebuild and reinstall the app.
//
//   This module lets the user repoint the app at a different backend from the
//   Settings UI. The value is persisted in localStorage, so it survives app
//   restarts, and it takes precedence over the build-time value.
//
// Nothing here throws: a failure to read/write storage just falls back to the
// build-time configuration.

const STORAGE_KEY = 'folia.onlineMusic.apiBase';

const normalize = (value: string | null | undefined): string | null => {
    if (typeof value !== 'string') {
        return null;
    }
    // Trim whitespace and any trailing slashes so `${base}${endpoint}` never
    // produces a double slash.
    const trimmed = value.trim().replace(/\/+$/, '');
    return trimmed ? trimmed : null;
};

/**
 * Returns the user-configured API base, or null when the build-time value
 * should be used instead.
 */
export const getRuntimeNeteaseApiBase = (): string | null => {
    try {
        if (typeof window === 'undefined' || !window.localStorage) {
            return null;
        }
        return normalize(window.localStorage.getItem(STORAGE_KEY));
    } catch {
        return null;
    }
};

/**
 * Persists a new API base. Passing null/empty clears the override so the app
 * falls back to the build-time VITE_NETEASE_API_BASE.
 */
export const setRuntimeNeteaseApiBase = (value: string | null): void => {
    try {
        if (typeof window === 'undefined' || !window.localStorage) {
            return;
        }
        const normalized = normalize(value);
        if (normalized) {
            window.localStorage.setItem(STORAGE_KEY, normalized);
        } else {
            window.localStorage.removeItem(STORAGE_KEY);
        }
    } catch {
        // Storage can be unavailable (private mode, quota). Ignore silently.
    }
};

export const clearRuntimeNeteaseApiBase = (): void => {
    setRuntimeNeteaseApiBase(null);
};

/**
 * The build-time value, shown in the UI so the user can see what they are
 * overriding. Returns null when the build had no value baked in.
 */
export const getBuildTimeNeteaseApiBase = (): string | null => {
    const viteEnv = typeof import.meta !== 'undefined' ? (import.meta as any).env : undefined;
    if (viteEnv && typeof viteEnv.VITE_NETEASE_API_BASE === 'string' && viteEnv.VITE_NETEASE_API_BASE) {
        return normalize(viteEnv.VITE_NETEASE_API_BASE);
    }

    if (typeof process !== 'undefined' && typeof process.env?.VITE_NETEASE_API_BASE === 'string' && process.env.VITE_NETEASE_API_BASE) {
        return normalize(process.env.VITE_NETEASE_API_BASE);
    }

    return null;
};
