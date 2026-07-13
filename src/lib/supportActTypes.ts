export interface SupportActHourRow {
  id: string;
  date: string;
  task: string;
  hours: number;
  packageType: 'package' | 'overlimit';
}

export interface SupportAct {
  id: string;
  actNumber: string;
  periodFrom: string;
  periodTo: string;
  periodLabel: string;
  hoursLimit: number;
  overtimeRate: number;
  supportAmount: number;
  hourRows: SupportActHourRow[];
  createdAt: string;
  updatedAt: string;
}

export function normalizeSupportActHourRow(raw: Partial<SupportActHourRow>): SupportActHourRow {
  return {
    id: raw.id || crypto.randomUUID(),
    date: (raw.date || '').slice(0, 10),
    task: raw.task || '',
    hours: typeof raw.hours === 'number' && !Number.isNaN(raw.hours) ? raw.hours : 0,
    packageType: raw.packageType === 'overlimit' ? 'overlimit' : 'package',
  };
}

export function normalizeSupportAct(raw: Partial<SupportAct>): SupportAct {
  return {
    id: raw.id || crypto.randomUUID(),
    actNumber: raw.actNumber || '',
    periodFrom: (raw.periodFrom || '').slice(0, 10),
    periodTo: (raw.periodTo || '').slice(0, 10),
    periodLabel: raw.periodLabel || '',
    hoursLimit:
      typeof raw.hoursLimit === 'number' && !Number.isNaN(raw.hoursLimit) ? raw.hoursLimit : 20,
    overtimeRate:
      typeof raw.overtimeRate === 'number' && !Number.isNaN(raw.overtimeRate)
        ? raw.overtimeRate
        : 1000,
    supportAmount:
      typeof raw.supportAmount === 'number' && !Number.isNaN(raw.supportAmount)
        ? raw.supportAmount
        : 0,
    hourRows: Array.isArray(raw.hourRows)
      ? raw.hourRows.map(normalizeSupportActHourRow)
      : [],
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || new Date().toISOString(),
  };
}

export function sumActHours(act: SupportAct): { packageHours: number; overlimitHours: number } {
  let packageHours = 0;
  let overlimitHours = 0;
  for (const row of act.hourRows) {
    if (row.packageType === 'overlimit') overlimitHours += row.hours;
    else packageHours += row.hours;
  }
  return { packageHours, overlimitHours };
}
