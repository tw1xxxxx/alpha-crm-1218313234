import { CRM_STORE_KEYS, isCrmStoreKey, type CrmStoreKey } from './crmKeys';

declare global {
  interface Window {
    electronAPI?: {
      store: {
        get: (key: string) => Promise<unknown>;
        set: (key: string, value: unknown) => Promise<void>;
      };
    };
  }
}

export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI?.store;
}

export function isCloudSyncEnabled(): boolean {
  const token = import.meta.env.VITE_CRM_SYNC_SECRET;
  return typeof token === 'string' && token.length > 0;
}

function authHeaders(): HeadersInit {
  const token = import.meta.env.VITE_CRM_SYNC_SECRET;
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

export function readLocalKey(key: string): any[] | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeLocalKey(key: string, data: unknown[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    /* quota / private mode */
  }
}

export async function readElectronKey(key: string): Promise<any[] | null> {
  if (!window.electronAPI?.store) return null;
  const val = await window.electronAPI.store.get(key);
  return Array.isArray(val) ? val : [];
}

export async function writeElectronKey(key: string, data: unknown[]): Promise<void> {
  if (!window.electronAPI?.store) return;
  await window.electronAPI.store.set(key, data);
}

export async function fetchCloudKey(key: string): Promise<any[] | null> {
  if (!isCloudSyncEnabled()) return null;
  const res = await fetch(`/api/store/${encodeURIComponent(key)}`, {
    headers: authHeaders(),
  });
  if (res.status === 401 || res.status === 503) {
    throw new Error(`Cloud auth/config error (${res.status})`);
  }
  if (!res.ok) throw new Error(`Cloud GET failed (${res.status})`);
  const json = (await res.json()) as { data?: unknown };
  return Array.isArray(json.data) ? json.data : [];
}

export async function saveCloudKey(key: string, data: unknown[]): Promise<void> {
  if (!isCloudSyncEnabled()) return;
  const res = await fetch(`/api/store/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Cloud PUT ${key} failed (${res.status})`);
}

export async function fetchCloudBulk(): Promise<Partial<Record<CrmStoreKey, any[]>>> {
  if (!isCloudSyncEnabled()) return {};
  const res = await fetch('/api/store/bulk', { headers: authHeaders() });
  if (!res.ok) throw new Error(`Cloud bulk GET failed (${res.status})`);
  const json = (await res.json()) as { data?: Record<string, unknown> };
  const out: Partial<Record<CrmStoreKey, any[]>> = {};
  if (json.data && typeof json.data === 'object') {
    for (const [key, val] of Object.entries(json.data)) {
      if (isCrmStoreKey(key) && Array.isArray(val)) out[key] = val;
    }
  }
  return out;
}

export async function saveCloudBulk(data: Record<string, unknown[]>): Promise<void> {
  if (!isCloudSyncEnabled()) return;
  const res = await fetch('/api/store/bulk', {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({ data }),
  });
  if (!res.ok) throw new Error(`Cloud bulk PUT failed (${res.status})`);
}

export function saveCloudBulkKeepalive(data: Record<string, unknown[]>): void {
  if (!isCloudSyncEnabled()) return;
  fetch('/api/store/bulk', {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({ data }),
    keepalive: true,
  }).catch(() => {});
}

/** Слияние массивов по id (или content для задач) */
export function mergeRecords<T extends { id?: string; content?: string }>(
  primary: T[],
  secondary: T[]
): T[] {
  const map = new Map<string, T>();
  primary.forEach(item => map.set(item.id || item.content || '', item));
  secondary.forEach(item => {
    const id = item.id || item.content || '';
    if (!map.has(id)) map.set(id, item);
  });
  return Array.from(map.values());
}

const cloudTimers: Partial<Record<string, ReturnType<typeof setTimeout>>> = {};

export function scheduleCloudSave(key: string, data: unknown[]): void {
  if (!isCloudSyncEnabled()) return;
  const prev = cloudTimers[key];
  if (prev) clearTimeout(prev);
  cloudTimers[key] = setTimeout(() => {
    saveCloudKey(key, data).catch(err => console.warn('[crmStorage] cloud save', key, err));
    delete cloudTimers[key];
  }, 700);
}

export async function loadKeyFromStorage(key: string): Promise<any[]> {
  if (isElectron()) {
    let storeData = (await readElectronKey(key)) ?? [];
    const localData = readLocalKey(key);
    if (localData && localData.length > 0) {
      storeData = mergeRecords(storeData, localData);
      await writeElectronKey(key, storeData);
      writeLocalKey(key, storeData);
    }
    return storeData;
  }

  let cloudData: any[] | null = null;
  if (isCloudSyncEnabled()) {
    try {
      cloudData = await fetchCloudKey(key);
    } catch (err) {
      console.warn('[crmStorage] cloud load failed, using local cache', key, err);
    }
  }

  const localData = readLocalKey(key);

  if (cloudData && cloudData.length > 0) {
    const merged = localData?.length ? mergeRecords(cloudData, localData) : cloudData;
    writeLocalKey(key, merged);
    if (localData?.length && merged.length > cloudData.length) {
      scheduleCloudSave(key, merged);
    }
    return merged;
  }

  if (localData && localData.length > 0) {
    if (isCloudSyncEnabled()) scheduleCloudSave(key, localData);
    return localData;
  }

  return [];
}

export function persistKey(key: string, data: unknown[]): void {
  writeLocalKey(key, data);
  if (isElectron()) {
    void writeElectronKey(key, data);
  }
  scheduleCloudSave(key, data);
}

export function persistAllKeys(data: Record<string, unknown[]>): void {
  for (const key of CRM_STORE_KEYS) {
    const val = data[key];
    if (Array.isArray(val)) persistKey(key, val);
  }
}

export function flushCloudSnapshot(data: Record<string, unknown[]>): void {
  for (const key of CRM_STORE_KEYS) {
    const val = data[key];
    if (Array.isArray(val)) writeLocalKey(key, val);
  }
  if (isCloudSyncEnabled()) saveCloudBulkKeepalive(data);
}
