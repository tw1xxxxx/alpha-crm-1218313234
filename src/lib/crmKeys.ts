export const CRM_STORE_KEYS = [
  'crm_projects_v2',
  'crm_employees_v2',
  'crm_leads_v2',
  'crm_logs_v2',
  'crm_tasks_v2',
  'crm_work_projects_v1',
  'crm_support_v1',
] as const;

export type CrmStoreKey = (typeof CRM_STORE_KEYS)[number];

export function isCrmStoreKey(key: string): key is CrmStoreKey {
  return (CRM_STORE_KEYS as readonly string[]).includes(key);
}
