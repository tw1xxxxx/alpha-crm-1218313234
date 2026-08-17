export type IncomingLead = {
  id: string;
  name: string;
  phone: string;
  budget: number;
  notes: string;
  source: string;
  createdAt: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function str(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  return '';
}

function pick(obj: Record<string, unknown>, keys: string[]): string {
  const lower = new Map(Object.keys(obj).map(k => [k.toLowerCase(), obj[k]]));
  for (const key of keys) {
    const v = obj[key] ?? lower.get(key.toLowerCase());
    const s = str(v);
    if (s) return s;
  }
  return '';
}

function unwrap(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) {
    return body.map(asRecord).filter((x): x is Record<string, unknown> => !!x);
  }
  const rec = asRecord(body);
  if (!rec) return [];
  for (const nest of ['data', 'lead', 'contact', 'payload', 'fields']) {
    const inner = rec[nest];
    if (Array.isArray(inner) || asRecord(inner)) return unwrap(inner);
  }
  return [rec];
}

function formatPhoneLoose(raw: string): string {
  const d = raw.replace(/\D/g, '');
  if (!d) return raw.trim();
  let digits = d;
  if (digits.startsWith('8') && digits.length >= 11) digits = '7' + digits.slice(1, 11);
  else if (digits.startsWith('7')) digits = digits.slice(0, 11);
  else digits = ('7' + digits).slice(0, 11);
  const n = digits.slice(1);
  if (n.length < 10) return raw.trim();
  return `+7 (${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6, 8)}-${n.slice(8, 10)}`;
}

function extraNotes(obj: Record<string, unknown>, used: Set<string>): string {
  const skip = new Set(
    [...used].map(k => k.toLowerCase()).concat([
      'phone', 'tel', 'mobile', 'name', 'fio', 'firstname', 'first_name',
      'lastname', 'last_name', 'email', 'comment', 'notes', 'source', 'token',
    ])
  );
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (skip.has(k.toLowerCase())) continue;
    if (v == null || typeof v === 'object') continue;
    const s = str(v);
    if (s) lines.push(`${k}: ${s}`);
  }
  return lines.join('\n');
}

export function parseIncomingLeads(body: unknown): IncomingLead[] {
  const now = new Date().toISOString();
  return unwrap(body).map(obj => {
    const phoneRaw = pick(obj, [
      'phone', 'Phone', 'tel', 'mobile', 'msisdn', 'number', 'телефон',
    ]);
    const first = pick(obj, ['first_name', 'firstname', 'name', 'Name', 'fio', 'ФИО', 'title']);
    const last = pick(obj, ['last_name', 'lastname', 'surname']);
    const name = [first, last].filter(Boolean).join(' ').trim() || 'Лид dmp.one';
    const email = pick(obj, ['email', 'mail']);
    const comment = pick(obj, ['comment', 'notes', 'message', 'text', 'описание']);
    const extras = extraNotes(obj, new Set(['phone', 'name', 'email', 'comment']));
    const notes = [comment, email ? `Email: ${email}` : '', extras]
      .filter(Boolean)
      .join('\n')
      .trim();

    return {
      id: crypto.randomUUID(),
      name,
      phone: phoneRaw ? formatPhoneLoose(phoneRaw) : '',
      budget: 0,
      notes,
      source: 'leadgen',
      createdAt: now,
    };
  }).filter(l => l.phone || l.name !== 'Лид dmp.one');
}
