export const ALLOWED_STORE_KEYS = new Set([
  'crm_projects_v2',
  'crm_employees_v2',
  'crm_leads_v2',
  'crm_logs_v2',
  'crm_tasks_v2',
  'crm_work_projects_v1',
]);

export function isAllowedStoreKey(key: string): boolean {
  return ALLOWED_STORE_KEYS.has(key);
}
