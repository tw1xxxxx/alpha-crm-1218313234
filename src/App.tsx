import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Plus, Trash2,
  Briefcase, Wallet, LayoutGrid, List,
  ChevronRight, Search, Bell, Settings,
  User, AlertCircle, ArrowLeft, Star,
  CheckCircle, ClipboardList,
  FileText, UserPlus, Palette, Settings2,
  Code2, PenTool, Send, Clock, Edit3, Save, X,
  UploadCloud, Paperclip,
  Activity, Users,
  Phone, UserCircle,
  TrendingUp, Target, MessageSquare, Tag, Radio,
  FolderKanban, GripVertical, LifeBuoy, Download,
  Calendar, ChevronLeft, FileCheck
} from 'lucide-react';
import {
  format, addDays, differenceInSeconds, isPast, differenceInHours,
  addMonths, startOfMonth, endOfMonth, eachDayOfInterval, isSameMonth,
  isWithinInterval, parseISO, startOfWeek, endOfWeek, isToday
} from 'date-fns';
import { ru } from 'date-fns/locale';
import { loadKeyFromStorage, persistKey, flushCloudSnapshot, isCloudSyncEnabled, isElectron } from './lib/crmStorage';

interface Stage {
  id: string;
  name: string;
  isCompleted: boolean;
  icon: any;
  estimatedDate: string;
  file?: {
    name: string;
    type: string;
    url?: string;
  };
}

interface Developer {
  id: string;
  name: string;
  rating: number;
  cost: number;
}

interface Employee {
  id: string;
  name: string;
  rating: number;
  role: string;
  avatar?: string;
  /** Базовая ставка (₽), подставляется при добавлении на проект */
  rate: number;
}

interface ProjectTeamMember {
  employeeId: string;
  /** Оплата этого сотрудника по проекту, ₽ */
  projectRate: number;
}

interface Lead {
  id: string;
  name: string;
  phone: string;
  budget: number;
  productType?: 'Site' | 'Mobile';
  siteType?: 'Vizitka' | 'Landing' | 'Store';
  notes: string;
  createdAt: string;
}

interface AppLog {
  id: string;
  action: string;
  details: string;
  timestamp: string;
}

interface Project {
  id: string;
  title: string;
  price: number;
  createdAt: string;
  deadlineDays: number;
  deadlineDate: string;
  status: 'active' | 'completed' | 'overdue';
  /** Несколько исполнителей; старое поле developer читается при загрузке и переносится в team */
  team?: ProjectTeamMember[];
  developer?: Developer;
  stages: Stage[];
  leadId?: string;
  source?: string;
}

/** Отдельные «живые» заказы на странице «В работе» — не смешиваются с CRM-проектами */
interface WorkProject {
  id: string;
  title: string;
  price: number;
  customer: string;
  deadlineDate: string;
  currentStage: string;
  createdAt: string;
  updatedAt: string;
}

interface SupportContractFile {
  name: string;
  type: string;
  dataUrl: string;
  uploadedAt: string;
}

interface SupportPaymentEntry {
  id: string;
  dueDate: string;
  amount: number;
  label: string;
  isPaid: boolean;
  paidAt?: string;
  note?: string;
}

type SupportEventType = 'act' | 'payment' | 'comment';

interface SupportCalendarEvent {
  id: string;
  date: string;
  type: SupportEventType;
  amount?: number;
  isPaid?: boolean;
  paidAt?: string;
  title?: string;
  text?: string;
}

interface SupportRecord {
  id: string;
  /** Название / тип сопровождения */
  title: string;
  /** Описание: что входит в сопровождение */
  description: string;
  comment: string;
  price: number;
  counterpartyName: string;
  /** Реквизиты контрагента */
  counterpartyDetails: string;
  /** Срок договора в месяцах */
  contractDurationMonths: number;
  /** Дата начала договора (yyyy-MM-dd) */
  contractStartDate: string;
  calendarEvents: SupportCalendarEvent[];
  /** @deprecated — мигрируется в calendarEvents */
  paymentSchedule?: SupportPaymentEntry[];
  contract?: SupportContractFile;
  createdAt: string;
  updatedAt: string;
}

const MAX_CONTRACT_BYTES = 4 * 1024 * 1024;

const SUPPORT_EVENT_META: Record<
  SupportEventType,
  { label: string; short: string; color: string; bg: string; border: string }
> = {
  act: {
    label: 'Акт по техподдержке',
    short: 'Акт',
    color: 'text-blue-700',
    bg: 'bg-blue-50',
    border: 'border-blue-200',
  },
  payment: {
    label: 'Оплата контрагента',
    short: 'Оплата',
    color: 'text-emerald-700',
    bg: 'bg-emerald-50',
    border: 'border-emerald-200',
  },
  comment: {
    label: 'Комментарий',
    short: 'Заметка',
    color: 'text-gray-700',
    bg: 'bg-gray-50',
    border: 'border-gray-200',
  },
};

function normalizeCalendarEvent(raw: Partial<SupportCalendarEvent>): SupportCalendarEvent {
  const type: SupportEventType =
    raw.type === 'act' || raw.type === 'payment' || raw.type === 'comment' ? raw.type : 'comment';
  return {
    id: raw.id || crypto.randomUUID(),
    date: (raw.date || new Date().toISOString()).slice(0, 10),
    type,
    amount: typeof raw.amount === 'number' && !Number.isNaN(raw.amount) ? raw.amount : 0,
    isPaid: !!raw.isPaid,
    paidAt: raw.paidAt?.slice(0, 10),
    title: raw.title || '',
    text: raw.text || '',
  };
}

function migratePaymentScheduleToEvents(schedule: SupportPaymentEntry[]): SupportCalendarEvent[] {
  return schedule.map(p => ({
    id: p.id || crypto.randomUUID(),
    date: (p.dueDate || new Date().toISOString()).slice(0, 10),
    type: 'payment' as const,
    amount: Number(p.amount) || 0,
    isPaid: !!p.isPaid,
    paidAt: p.paidAt?.slice(0, 10),
    title: p.label || 'Оплата контрагента',
    text: p.note || '',
  }));
}

function supportContractEndDate(start: string, months: number): Date | null {
  if (!start || !months || months < 1) return null;
  const d = parseISO(start);
  if (Number.isNaN(d.getTime())) return null;
  return addMonths(d, months);
}

function normalizeSupportRecord(raw: Partial<SupportRecord>): SupportRecord {
  let calendarEvents = Array.isArray(raw.calendarEvents)
    ? raw.calendarEvents.map(normalizeCalendarEvent)
    : [];
  if (
    calendarEvents.length === 0 &&
    Array.isArray(raw.paymentSchedule) &&
    raw.paymentSchedule.length > 0
  ) {
    calendarEvents = migratePaymentScheduleToEvents(raw.paymentSchedule);
  }
  return {
    id: raw.id || crypto.randomUUID(),
    title: raw.title || '',
    description: raw.description || '',
    comment: raw.comment || '',
    price: typeof raw.price === 'number' && !Number.isNaN(raw.price) ? raw.price : 0,
    counterpartyName: raw.counterpartyName || '',
    counterpartyDetails: raw.counterpartyDetails || '',
    contractDurationMonths:
      typeof raw.contractDurationMonths === 'number' && !Number.isNaN(raw.contractDurationMonths)
        ? Math.max(0, Math.round(raw.contractDurationMonths))
        : 0,
    contractStartDate: (raw.contractStartDate || '').slice(0, 10),
    calendarEvents,
    contract: raw.contract?.dataUrl ? raw.contract : undefined,
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || new Date().toISOString(),
  };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.readAsDataURL(file);
  });
}

/** Цифры номера: 7 + 10 цифр (8… → 7…) */
function phoneDigitsOnly(raw: string): string {
  const d = raw.replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('8') && d.length >= 11) return '7' + d.slice(1, 11);
  if (d.startsWith('7')) return d.slice(0, 11);
  return ('7' + d).slice(0, 11);
}

/** +7 (999) 919-62-61 — только отображение/ввод, исходные цифры не теряются */
function formatPhoneRu(raw: string): string {
  const d = phoneDigitsOnly(raw);
  if (!d) return '';
  const n = d.slice(1);
  let result = '+7';
  if (n.length === 0) return result;
  result += ' (' + n.slice(0, Math.min(3, n.length));
  if (n.length < 3) return result;
  result += ')';
  if (n.length <= 3) return result;
  result += ' ' + n.slice(3, Math.min(6, n.length));
  if (n.length <= 6) return result;
  result += '-' + n.slice(6, Math.min(8, n.length));
  if (n.length <= 8) return result;
  result += '-' + n.slice(8, Math.min(10, n.length));
  return result;
}

function displayPhone(raw: string): string {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  return digits ? formatPhoneRu(raw) : raw;
}

const TRAFFIC_SOURCES = [
  { key: 'yandex',  label: 'Яндекс Директ',    color: '#FF4233', bg: '#FFF1F0', Icon: Target },
  { key: 'vk',      label: 'ВК Реклама',        color: '#4C75A3', bg: '#EEF3FA', Icon: MessageSquare },
  { key: 'avito',   label: 'Авито',             color: '#00AEEF', bg: '#E0F7FD', Icon: Tag },
  { key: 'profi',   label: 'Профи.ру',          color: '#8B5CF6', bg: '#EDE9FE', Icon: Star },
  { key: 'word',    label: 'Сарафанное радио',  color: '#00B956', bg: '#E8F9F0', Icon: Radio },
] as const;

interface Task {
  id: string;
  content: string;
  isCompleted: boolean;
  order: number;
  createdAt: string;
}

const STAGE_CONFIG = [
  { name: 'Коммерческое предложение', icon: ClipboardList, dayOffset: 0 },
  { name: 'Заключение договора', icon: FileText, dayOffset: 1 },
  { name: 'Назначение разработчика', icon: UserPlus, dayOffset: 2 },
  { name: 'Разработка дизайна', icon: Palette, dayOffset: 4 },
  { name: 'Согласование дизайна', icon: Settings2, dayOffset: 5 },
  { name: 'Разработка функционала', icon: Code2, dayOffset: 12 },
  { name: 'Внесение правок', icon: PenTool, dayOffset: 14 },
  { name: 'Отправка акта', icon: Send, dayOffset: 15 },
];

function normalizeProjectTeam(p: Project): Project {
  const existing = (p.team ?? []).filter(Boolean);
  if (existing.length > 0) return { ...p, team: existing, developer: undefined };
  if (p.developer) {
    return {
      ...p,
      team: [{ employeeId: p.developer.id, projectRate: p.developer.cost || 0 }],
    };
  }
  return { ...p, team: [] };
}

function projectPayrollCost(p: Project): number {
  const teamSum = (p.team ?? []).reduce((s, m) => s + (Number(m.projectRate) || 0), 0);
  if (teamSum > 0) return teamSum;
  return p.developer?.cost || 0;
}

function projectHasTeam(p: Project): boolean {
  return (p.team?.length ?? 0) > 0 || !!p.developer;
}

function projectTeamNames(p: Project, staff: Employee[]): string {
  const ids = p.team?.map(m => m.employeeId) ?? [];
  if (!ids.length && p.developer) return p.developer.name;
  return ids
    .map(id => staff.find(e => e.id === id)?.name)
    .filter(Boolean)
    .join(', ');
}

function stripEmployeeFromProject(p: Project, employeeId: string): Project {
  const nextTeam = (p.team ?? []).filter(m => m.employeeId !== employeeId);
  let stages = p.stages;
  if (nextTeam.length === 0) {
    const st = p.stages.find(s => s.name === 'Назначение разработчика');
    if (st?.isCompleted) {
      stages = p.stages.map(s =>
        s.name === 'Назначение разработчика' ? { ...s, isCompleted: false } : s
      );
    }
  }
  return {
    ...p,
    team: nextTeam,
    developer: undefined,
    stages,
  };
}

function addMemberToProject(p: Project, emp: Employee): Project {
  const cur = p.team ?? [];
  if (cur.some(m => m.employeeId === emp.id)) return p;
  const defaultRate = emp.rate > 0 ? emp.rate : Math.round(p.price * 0.6);
  const nextTeam = [...cur, { employeeId: emp.id, projectRate: defaultRate }];
  let stages = p.stages;
  const assignmentStage = p.stages.find(s => s.name === 'Назначение разработчика');
  if (assignmentStage && !assignmentStage.isCompleted && nextTeam.length >= 1) {
    stages = p.stages.map(s =>
      s.id === assignmentStage.id ? { ...s, isCompleted: true } : s
    );
  }
  return { ...p, team: nextTeam, developer: undefined, stages };
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [title, setTitle] = useState('');
  const [priceInput, setPriceInput] = useState('');
  const [days, setDays] = useState('7');
  const [now, setNow] = useState(new Date());
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [activeTab, setActiveTab] = useState<'projects' | 'work' | 'support' | 'employees' | 'leads' | 'logs' | 'tasks' | 'finance' | 'traffic'>('projects');
  const [selectedSource, setSelectedSource] = useState('');
  const [trafficPeriod, setTrafficPeriod] = useState<'week' | 'month' | 'quarter' | 'year' | 'all'>('month');
  const [financePeriod, setFinancePeriod] = useState<'week' | 'month' | 'quarter' | 'year' | 'all'>('month');
  const [financeSection, setFinanceSection] = useState<'overview' | 'income' | 'expenses' | 'operations'>('overview');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [workProjects, setWorkProjects] = useState<WorkProject[]>([]);
  const [selectedWorkProject, setSelectedWorkProject] = useState<WorkProject | null>(null);
  const [supportRecords, setSupportRecords] = useState<SupportRecord[]>([]);
  const [selectedSupport, setSelectedSupport] = useState<SupportRecord | null>(null);
  const [supTitle, setSupTitle] = useState('');
  const [supDescription, setSupDescription] = useState('');
  const [supComment, setSupComment] = useState('');
  const [supPrice, setSupPrice] = useState('');
  const [supCounterpartyName, setSupCounterpartyName] = useState('');
  const [supCounterpartyDetails, setSupCounterpartyDetails] = useState('');
  const [supDurationMonths, setSupDurationMonths] = useState('12');
  const [supStartDate, setSupStartDate] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [supCalViewMonth, setSupCalViewMonth] = useState(() => startOfMonth(new Date()));
  const [supCalActiveDate, setSupCalActiveDate] = useState<string | null>(null);
  const [supEventModal, setSupEventModal] = useState<{ type: SupportEventType; date: string } | null>(null);
  const [supEventAmount, setSupEventAmount] = useState('');
  const [supEventText, setSupEventText] = useState('');
  const [supEventTitle, setSupEventTitle] = useState('');
  const [wpTitle, setWpTitle] = useState('');
  const [wpPrice, setWpPrice] = useState('');
  const [wpCustomer, setWpCustomer] = useState('');
  const [wpDays, setWpDays] = useState('14');
  const [draggingWorkId, setDraggingWorkId] = useState<string | null>(null);
  const [stageDraft, setStageDraft] = useState('');
  const stageSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedWorkProjectRef = useRef<WorkProject | null>(null);
  const stageDraftRef = useRef('');
  const lastOverWorkIdRef = useRef<string | null>(null);
  const suppressWorkCardClickRef = useRef(false);
  
  // Leads states
  const [leads, setLeads] = useState<Lead[]>([]);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [isAddingLead, setIsAddingLead] = useState(false);
  const [newLead, setNewLead] = useState<Partial<Lead>>({
    name: '',
    phone: '',
    budget: 0,
    notes: ''
  });

  // Tasks states
  const [tasks, setTasks] = useState<Task[]>([]);
  const [newTaskContent, setNewTaskContent] = useState('');

  // Logs states
  const [logs, setLogs] = useState<AppLog[]>([]);
  const [debugLog, setDebugLog] = useState<string[]>([]);

  const appStateRef = useRef({
    projects,
    employees,
    leads,
    logs,
    tasks,
    workProjects,
    supportRecords,
  });

  // Migration and loading
  useEffect(() => {
    const handleError = (e: ErrorEvent | PromiseRejectionEvent) => {
      const msg = 'reason' in e ? e.reason?.message : e.message;
      setDebugLog(prev => [...prev, `${new Date().toLocaleTimeString()}: ${msg}`]);
    };
    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleError);
    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleError);
    };
  }, []);

  useEffect(() => {
    const taskSetter = (val: any) => {
      if (Array.isArray(val)) {
        setTasks(val.sort((a: Task, b: Task) => a.order - b.order));
      } else {
        setTasks([]);
      }
    };

    const keys = [
      { key: 'crm_projects_v2', setter: setProjects as (v: any) => void },
      { key: 'crm_employees_v2', setter: setEmployees as (v: any) => void },
      { key: 'crm_leads_v2', setter: setLeads as (v: any) => void },
      { key: 'crm_logs_v2', setter: setLogs as (v: any) => void },
      { key: 'crm_tasks_v2', setter: taskSetter },
      { key: 'crm_work_projects_v1', setter: setWorkProjects as (v: any) => void },
      { key: 'crm_support_v1', setter: setSupportRecords as (v: any) => void },
    ];

    const loadData = async () => {
      for (const { key, setter } of keys) {
        let data = await loadKeyFromStorage(key);

        if (Array.isArray(data)) {
          if (key === 'crm_projects_v2') {
            setter(data.map((p: Project) => normalizeProjectTeam(p)));
          } else if (key === 'crm_employees_v2') {
            setter(
              data.map((em: Employee) => ({
                ...em,
                rate: typeof em.rate === 'number' && !Number.isNaN(em.rate) ? em.rate : 0,
              }))
            );
          } else if (key === 'crm_support_v1') {
            setter(data.map((r: SupportRecord) => normalizeSupportRecord(r)));
          } else {
            setter(data);
          }
        }
      }
    };

    loadData();
  }, []);

  const persist = useCallback((key: string, data: any[]) => {
    persistKey(key, data);
  }, []);

  const reorderWorkProjects = useCallback(
    (dragId: string, overId: string) => {
      setWorkProjects(prev => {
        const from = prev.findIndex(w => w.id === dragId);
        const to = prev.findIndex(w => w.id === overId);
        if (from < 0 || to < 0 || from === to) return prev;
        const next = [...prev];
        const [removed] = next.splice(from, 1);
        next.splice(to, 0, removed);
        persist('crm_work_projects_v1', next);
        return next;
      });
    },
    [persist]
  );

  useEffect(() => {
    appStateRef.current = { projects, employees, leads, logs, tasks, workProjects, supportRecords };
  }, [projects, employees, leads, logs, tasks, workProjects, supportRecords]);

  useEffect(() => {
    selectedWorkProjectRef.current = selectedWorkProject;
  }, [selectedWorkProject]);

  useEffect(() => {
    stageDraftRef.current = stageDraft;
  }, [stageDraft]);

  const flushAllToDisk = useCallback(() => {
    let workProjectsSnapshot = appStateRef.current.workProjects;
    const sel = selectedWorkProjectRef.current;
    const draft = stageDraftRef.current;
    if (sel && draft !== sel.currentStage) {
      if (stageSaveTimerRef.current) {
        clearTimeout(stageSaveTimerRef.current);
        stageSaveTimerRef.current = null;
      }
      const ts = new Date().toISOString();
      workProjectsSnapshot = workProjectsSnapshot.map(w =>
        w.id === sel.id ? { ...w, currentStage: draft, updatedAt: ts } : w
      );
      persist('crm_work_projects_v1', workProjectsSnapshot);
      appStateRef.current = { ...appStateRef.current, workProjects: workProjectsSnapshot };
      setWorkProjects(workProjectsSnapshot);
      setSelectedWorkProject(prev =>
        prev && prev.id === sel.id ? workProjectsSnapshot.find(w => w.id === sel.id)! : prev
      );
    }
    const s = appStateRef.current;
    const snapshot = {
      crm_projects_v2: s.projects,
      crm_employees_v2: s.employees,
      crm_leads_v2: s.leads,
      crm_logs_v2: s.logs,
      crm_tasks_v2: s.tasks,
      crm_work_projects_v1: workProjectsSnapshot,
      crm_support_v1: s.supportRecords,
    };
    flushCloudSnapshot(snapshot);
  }, [persist]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flushAllToDisk();
    };
    window.addEventListener('beforeunload', flushAllToDisk);
    document.addEventListener('visibilitychange', onHide);
    const interval = window.setInterval(flushAllToDisk, 20000);
    return () => {
      window.removeEventListener('beforeunload', flushAllToDisk);
      document.removeEventListener('visibilitychange', onHide);
      window.clearInterval(interval);
    };
  }, [flushAllToDisk]);

  // Logger function
  const addLog = useCallback((action: string, details: string) => {
    const newLog: AppLog = {
      id: Date.now().toString(),
      action,
      details,
      timestamp: new Date().toISOString()
    };
    setLogs(prev => {
      const updated = [newLog, ...prev].slice(0, 100);
      persistKey('crm_logs_v2', updated);
      return updated;
    });
  }, []);

  // Project editing states
  const [editingTeamEmpId, setEditingTeamEmpId] = useState<string | null>(null);
  const [tempTeamRate, setTempTeamRate] = useState('');
  const [isEditingProjectPrice, setIsEditingProjectPrice] = useState(false);
  const [isEditingProjectDeadline, setIsEditingProjectDeadline] = useState(false);
  const [tempProjectPrice, setTempProjectPrice] = useState('');
  const [tempProjectDeadline, setTempProjectDeadline] = useState('');
  const [tempWorkDeadline, setTempWorkDeadline] = useState('');

  // Employee creation states
  const [empName, setEmpName] = useState('');
  const [empRole, setEmpRole] = useState('Разработчик');
  const [empRating, setEmpRating] = useState('5.0');
  const [empRate, setEmpRate] = useState('');
  const [employeeEditId, setEmployeeEditId] = useState<string | null>(null);
  const [editEmpName, setEditEmpName] = useState('');
  const [editEmpRole, setEditEmpRole] = useState('');
  const [editEmpRating, setEditEmpRating] = useState('');
  const [editEmpRate, setEditEmpRate] = useState('');

  useEffect(() => {
    const timer = setInterval(() => {
      const tick = new Date();
      setNow(tick);
      // Auto-mark overdue projects
      setProjects(prev => {
        const hasNewOverdue = prev.some(
          p => p.status === 'active' && isPast(new Date(p.deadlineDate))
        );
        if (!hasNewOverdue) return prev;
        const updated = prev.map(p =>
          p.status === 'active' && isPast(new Date(p.deadlineDate))
            ? { ...p, status: 'overdue' as const }
            : p
        );
        persist('crm_projects_v2', updated);
        return updated;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const formatNumber = (val: string) => {
    const num = val.replace(/\D/g, '');
    return num.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  };

  const handlePriceChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPriceInput(formatNumber(e.target.value));
  };

  const addProject = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    const createdAt = new Date();
    const deadlineDate = addDays(createdAt, parseInt(days));
    const rawPrice = parseFloat(priceInput.replace(/\s/g, '')) || 0;

    const stages: Stage[] = STAGE_CONFIG.map((cfg, idx) => ({
      id: (idx + 1).toString(),
      name: cfg.name,
      isCompleted: false,
      icon: cfg.icon,
      estimatedDate: addDays(createdAt, cfg.dayOffset).toISOString()
    }));

    const newProject: Project = {
      id: crypto.randomUUID(),
      title,
      price: rawPrice,
      createdAt: createdAt.toISOString(),
      deadlineDays: parseInt(days),
      deadlineDate: deadlineDate.toISOString(),
      status: 'active',
      team: [],
      stages,
      leadId: selectedLead?.id,
      source: selectedSource || undefined,
    };

    const updated = [newProject, ...projects];
    setProjects(updated);
    persist('crm_projects_v2', updated);
    addLog('Создание проекта', `Создан новый проект: ${title}`);
    setTitle('');
    setPriceInput('');
    setDays('7');
    setSelectedLead(null);
    setSelectedSource('');
  };

  const addWorkProject = (e: React.FormEvent) => {
    e.preventDefault();
    if (!wpTitle.trim()) return;
    const createdAt = new Date();
    const deadlineDate = addDays(createdAt, parseInt(wpDays, 10) || 14);
    const rawPrice = parseFloat(wpPrice.replace(/\s/g, '')) || 0;
    const ts = createdAt.toISOString();
    const item: WorkProject = {
      id: crypto.randomUUID(),
      title: wpTitle.trim(),
      price: rawPrice,
      customer: wpCustomer.trim(),
      deadlineDate: deadlineDate.toISOString(),
      currentStage: '',
      createdAt: ts,
      updatedAt: ts,
    };
    const next = [item, ...workProjects];
    setWorkProjects(next);
    persist('crm_work_projects_v1', next);
    addLog('В работе', `Добавлен заказ: ${item.title}`);
    setWpTitle('');
    setWpPrice('');
    setWpCustomer('');
    setWpDays('14');
  };

  const updateWorkProjectDeadline = (id: string, isoDate: string) => {
    const d = new Date(isoDate);
    if (isNaN(d.getTime())) return;
    const ts = new Date().toISOString();
    const next = workProjects.map(w =>
      w.id === id ? { ...w, deadlineDate: d.toISOString(), updatedAt: ts } : w
    );
    setWorkProjects(next);
    persist('crm_work_projects_v1', next);
    setSelectedWorkProject(prev => (prev && prev.id === id ? next.find(x => x.id === id)! : prev));
    addLog('В работе', `Дедлайн обновлён (${next.find(w => w.id === id)?.title})`);
  };

  const schedulePersistWorkStage = useCallback(
    (id: string, text: string) => {
      if (stageSaveTimerRef.current) clearTimeout(stageSaveTimerRef.current);
      stageSaveTimerRef.current = setTimeout(() => {
        const ts = new Date().toISOString();
        setWorkProjects(prev => {
          const next = prev.map(w =>
            w.id === id ? { ...w, currentStage: text, updatedAt: ts } : w
          );
          persist('crm_work_projects_v1', next);
          return next;
        });
        setSelectedWorkProject(prev =>
          prev && prev.id === id ? { ...prev, currentStage: text, updatedAt: ts } : prev
        );
        stageSaveTimerRef.current = null;
      }, 450);
    },
    [persist]
  );

  useEffect(() => {
    return () => {
      if (stageSaveTimerRef.current) clearTimeout(stageSaveTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (stageSaveTimerRef.current) {
      clearTimeout(stageSaveTimerRef.current);
      stageSaveTimerRef.current = null;
    }
    if (selectedWorkProject) setStageDraft(selectedWorkProject.currentStage);
    // только смена заказа (id), иначе автосохранение сбросит текст при вводе
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWorkProject?.id]);

  useEffect(() => {
    if (selectedWorkProject) {
      setTempWorkDeadline(format(new Date(selectedWorkProject.deadlineDate), 'yyyy-MM-dd'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWorkProject?.id, selectedWorkProject?.deadlineDate]);

  const deleteWorkProject = (id: string) => {
    const w = workProjects.find(x => x.id === id);
    const next = workProjects.filter(x => x.id !== id);
    setWorkProjects(next);
    persist('crm_work_projects_v1', next);
    if (selectedWorkProject?.id === id) setSelectedWorkProject(null);
    addLog('В работе', `Удалён заказ: ${w?.title ?? id}`);
  };

  const patchWorkProject = (
    id: string,
    patch: Partial<Pick<WorkProject, 'title' | 'price' | 'customer'>>
  ) => {
    const ts = new Date().toISOString();
    setWorkProjects(prev => {
      const next = prev.map(w => (w.id === id ? { ...w, ...patch, updatedAt: ts } : w));
      persist('crm_work_projects_v1', next);
      return next;
    });
    setSelectedWorkProject(prev =>
      prev && prev.id === id ? { ...prev, ...patch, updatedAt: ts } : prev
    );
  };

  useEffect(() => {
    if (selectedSupport?.contractStartDate) {
      const d = parseISO(selectedSupport.contractStartDate);
      if (!Number.isNaN(d.getTime())) setSupCalViewMonth(startOfMonth(d));
    } else {
      setSupCalViewMonth(startOfMonth(new Date()));
    }
    setSupCalActiveDate(null);
    setSupEventModal(null);
    setSupEventAmount('');
    setSupEventText('');
    setSupEventTitle('');
  }, [selectedSupport?.id]);

  const addSupportRecord = (e: React.FormEvent) => {
    e.preventDefault();
    if (!supTitle.trim()) return;
    const ts = new Date().toISOString();
    const months = Math.max(0, parseInt(supDurationMonths, 10) || 0);
    const record: SupportRecord = {
      id: crypto.randomUUID(),
      title: supTitle.trim(),
      description: supDescription.trim(),
      comment: supComment.trim(),
      price: parseFloat(supPrice.replace(/\s/g, '')) || 0,
      counterpartyName: supCounterpartyName.trim(),
      counterpartyDetails: supCounterpartyDetails.trim(),
      contractDurationMonths: months,
      contractStartDate: supStartDate || format(new Date(), 'yyyy-MM-dd'),
      calendarEvents: [],
      createdAt: ts,
      updatedAt: ts,
    };
    const next = [...supportRecords, record];
    setSupportRecords(next);
    persist('crm_support_v1', next);
    addLog('Сопровождение', `Создано: ${record.title}`);
    setSupTitle('');
    setSupDescription('');
    setSupComment('');
    setSupPrice('');
    setSupCounterpartyName('');
    setSupCounterpartyDetails('');
    setSupDurationMonths('12');
    setSupStartDate(format(new Date(), 'yyyy-MM-dd'));
  };

  const patchSupportRecord = (id: string, patch: Partial<SupportRecord>) => {
    const ts = new Date().toISOString();
    setSupportRecords(prev => {
      const next = prev.map(r =>
        r.id === id ? normalizeSupportRecord({ ...r, ...patch, updatedAt: ts }) : r
      );
      persist('crm_support_v1', next);
      return next;
    });
    setSelectedSupport(prev =>
      prev && prev.id === id
        ? normalizeSupportRecord({ ...prev, ...patch, updatedAt: ts })
        : prev
    );
  };

  const deleteSupportRecord = (id: string) => {
    const rec = supportRecords.find(r => r.id === id);
    const next = supportRecords.filter(r => r.id !== id);
    setSupportRecords(next);
    persist('crm_support_v1', next);
    if (selectedSupport?.id === id) setSelectedSupport(null);
    addLog('Сопровождение', `Удалено: ${rec?.title ?? id}`);
  };

  const addSupportCalendarEvent = (
    supportId: string,
    date: string,
    type: SupportEventType,
    data: { amount?: number; title?: string; text?: string; isPaid?: boolean }
  ) => {
    const rec = supportRecords.find(r => r.id === supportId);
    if (!rec) return;
    const entry = normalizeCalendarEvent({
      id: crypto.randomUUID(),
      date: date.slice(0, 10),
      type,
      amount: type === 'payment' ? data.amount ?? rec.price : 0,
      isPaid: type === 'payment' ? !!data.isPaid : false,
      paidAt: type === 'payment' && data.isPaid ? date.slice(0, 10) : undefined,
      title:
        data.title?.trim() ||
        (type === 'act'
          ? 'Акт по техподдержке'
          : type === 'payment'
            ? 'Оплата контрагента'
            : ''),
      text: data.text?.trim() || '',
    });
    patchSupportRecord(supportId, {
      calendarEvents: [...rec.calendarEvents, entry],
    });
    addLog('Сопровождение', `${SUPPORT_EVENT_META[type].label} — ${format(parseISO(date), 'd MMM yyyy', { locale: ru })}`);
  };

  const updateSupportCalendarEvent = (
    supportId: string,
    eventId: string,
    patch: Partial<SupportCalendarEvent>
  ) => {
    const rec = supportRecords.find(r => r.id === supportId);
    if (!rec) return;
    const events = rec.calendarEvents.map(ev =>
      ev.id === eventId ? normalizeCalendarEvent({ ...ev, ...patch }) : ev
    );
    patchSupportRecord(supportId, { calendarEvents: events });
  };

  const toggleSupportEventPaid = (supportId: string, eventId: string) => {
    const rec = supportRecords.find(r => r.id === supportId);
    if (!rec) return;
    const ev = rec.calendarEvents.find(e => e.id === eventId);
    if (!ev || ev.type !== 'payment') return;
    const isPaid = !ev.isPaid;
    updateSupportCalendarEvent(supportId, eventId, {
      isPaid,
      paidAt: isPaid ? format(new Date(), 'yyyy-MM-dd') : undefined,
    });
  };

  const removeSupportCalendarEvent = (supportId: string, eventId: string) => {
    const rec = supportRecords.find(r => r.id === supportId);
    if (!rec) return;
    patchSupportRecord(supportId, {
      calendarEvents: rec.calendarEvents.filter(e => e.id !== eventId),
    });
  };

  const generateSupportMonthlyPayments = (supportId: string) => {
    const rec = supportRecords.find(r => r.id === supportId);
    if (!rec || !rec.contractStartDate || rec.contractDurationMonths < 1) return;
    const start = parseISO(rec.contractStartDate);
    if (Number.isNaN(start.getTime())) return;
    const existingPaymentDates = new Set(
      rec.calendarEvents.filter(e => e.type === 'payment').map(e => e.date.slice(0, 10))
    );
    const newEvents: SupportCalendarEvent[] = [];
    for (let i = 0; i < rec.contractDurationMonths; i++) {
      const d = addMonths(start, i);
      const dateStr = format(d, 'yyyy-MM-dd');
      if (existingPaymentDates.has(dateStr)) continue;
      newEvents.push(
        normalizeCalendarEvent({
          id: crypto.randomUUID(),
          date: dateStr,
          type: 'payment',
          amount: rec.price,
          isPaid: false,
          title: `Оплата за ${format(d, 'LLLL yyyy', { locale: ru })}`,
        })
      );
    }
    if (newEvents.length === 0) return;
    patchSupportRecord(supportId, {
      calendarEvents: [...rec.calendarEvents, ...newEvents],
    });
    addLog('Сопровождение', `Сгенерирован график: ${newEvents.length} оплат`);
  };

  const openSupportEventModal = (type: SupportEventType, date: string, defaultAmount?: number) => {
    setSupEventModal({ type, date });
    setSupEventAmount(defaultAmount ? formatNumber(String(defaultAmount)) : '');
    setSupEventText('');
    setSupEventTitle(
      type === 'act' ? 'Акт по техподдержке' : type === 'payment' ? 'Оплата контрагента' : ''
    );
  };

  const submitSupportEventModal = (supportId: string) => {
    if (!supEventModal) return;
    const { type, date } = supEventModal;
    if (type === 'comment' && !supEventText.trim()) return;
    addSupportCalendarEvent(supportId, date, type, {
      amount: parseFloat(supEventAmount.replace(/\s/g, '')) || 0,
      title: supEventTitle,
      text: supEventText,
      isPaid: false,
    });
    setSupEventModal(null);
    setSupEventAmount('');
    setSupEventText('');
    setSupEventTitle('');
  };

  const uploadSupportContract = async (supportId: string, file: File) => {
    if (file.size > MAX_CONTRACT_BYTES) {
      alert('Файл слишком большой (макс. 4 МБ)');
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const contract: SupportContractFile = {
        name: file.name,
        type: file.type || 'application/octet-stream',
        dataUrl,
        uploadedAt: new Date().toISOString(),
      };
      patchSupportRecord(supportId, { contract });
      addLog('Сопровождение', `Загружен договор: ${file.name}`);
    } catch {
      alert('Не удалось загрузить файл');
    }
  };

  const removeSupportContract = (supportId: string) => {
    patchSupportRecord(supportId, { contract: undefined });
  };

  const addEmployee = (e: React.FormEvent) => {
    e.preventDefault();
    if (!empName.trim()) return;

    const newEmp: Employee = {
      id: crypto.randomUUID(),
      name: empName,
      role: empRole,
      rating: parseFloat(empRating) || 5.0,
      rate: parseFloat(empRate.replace(/\s/g, '')) || 0,
    };

    const updated = [...employees, newEmp];
    setEmployees(updated);
    persist('crm_employees_v2', updated);
    addLog('Добавление сотрудника', `Добавлен новый сотрудник: ${empName} (${empRole})`);
    setEmpName('');
    setEmpRole('Разработчик');
    setEmpRating('5.0');
    setEmpRate('');
  };

  const deleteEmployee = (id: string) => {
    const emp = employees.find(e => e.id === id);
    const updatedEmps = employees.filter(e => e.id !== id);
    const updatedProjects = projects.map(p => stripEmployeeFromProject(p, id));
    setEmployees(updatedEmps);
    persist('crm_employees_v2', updatedEmps);
    setProjects(updatedProjects);
    persist('crm_projects_v2', updatedProjects);
    if (selectedProject?.id) {
      const sp = updatedProjects.find(p => p.id === selectedProject.id);
      if (sp) setSelectedProject(sp);
    }
    if (employeeEditId === id) setEmployeeEditId(null);
    addLog('Сотрудники', `Удалён сотрудник: ${emp?.name ?? id}`);
  };

  const saveEmployeeEdit = () => {
    if (!employeeEditId) return;
    const updated = employees.map(e =>
      e.id === employeeEditId
        ? {
            ...e,
            name: editEmpName.trim() || e.name,
            role: editEmpRole.trim() || e.role,
            rating: parseFloat(editEmpRating) || e.rating,
            rate: parseFloat(editEmpRate.replace(/\s/g, '')) || 0,
          }
        : e
    );
    setEmployees(updated);
    persist('crm_employees_v2', updated);
    setEmployeeEditId(null);
    addLog('Сотрудники', `Обновлены данные: ${editEmpName.trim()}`);
  };

  const addLead = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLead.name?.trim()) return;

    const lead: Lead = {
      id: crypto.randomUUID(),
      name: newLead.name,
      phone: newLead.phone ? formatPhoneRu(newLead.phone) : '',
      budget: newLead.budget || 0,
      notes: newLead.notes || '',
      productType: newLead.productType,
      siteType: newLead.siteType,
      createdAt: new Date().toISOString()
    };

    const updated = [lead, ...leads];
    setLeads(updated);
    persist('crm_leads_v2', updated);
    addLog('Создание лида', `Создан новый лид: ${lead.name}`);
    setNewLead({ name: '', phone: '', budget: 0, notes: '' });
    setIsAddingLead(false);
  };

  const deleteLead = (id: string) => {
    const lead = leads.find(l => l.id === id);
    const updated = leads.filter(l => l.id !== id);
    setLeads(updated);
    persist('crm_leads_v2', updated);
    addLog('Удаление лида', `Удален лид: ${lead?.name}`);
  };

  const addTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTaskContent.trim()) return;

    const newTask: Task = {
      id: crypto.randomUUID(),
      content: newTaskContent.trim(),
      isCompleted: false,
      order: tasks.length,
      createdAt: new Date().toISOString()
    };

    const updated = [...tasks, newTask];
    setTasks(updated);
    persist('crm_tasks_v2', updated);
    addLog('Создание задачи', `Добавлена задача: ${newTask.content}`);
    setNewTaskContent('');
  };

  const toggleTask = (id: string) => {
    const updatedTasks = tasks.map(t => {
      if (t.id === id) {
        const newStatus = !t.isCompleted;
        addLog('Обновление задачи', `Задача "${t.content}" отмечена как ${newStatus ? 'выполненная' : 'невыполненная'}`);
        return { ...t, isCompleted: newStatus };
      }
      return t;
    });
    setTasks(updatedTasks);
    persist('crm_tasks_v2', updatedTasks);
  };

  const deleteTask = (id: string) => {
    const task = tasks.find(t => t.id === id);
    const updated = tasks.filter(t => t.id !== id).map((t, idx) => ({ ...t, order: idx }));
    setTasks(updated);
    persist('crm_tasks_v2', updated);
    addLog('Удаление задачи', `Удалена задача: ${task?.content}`);
  };

  const [draggedTaskIndex, setDraggedTaskIndex] = useState<number | null>(null);

  const handleTaskDragStart = (e: React.DragEvent, index: number) => {
    setDraggedTaskIndex(index);
    e.dataTransfer.setData('taskIndex', index.toString());
  };

  const handleTaskDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedTaskIndex === null || draggedTaskIndex === index) return;

    const updatedTasks = [...tasks];
    const [movedTask] = updatedTasks.splice(draggedTaskIndex, 1);
    updatedTasks.splice(index, 0, movedTask);
    
    // Update orders
    const reorderedTasks = updatedTasks.map((t, idx) => ({ ...t, order: idx }));
    setTasks(reorderedTasks);
    setDraggedTaskIndex(index);
  };

  const handleTaskDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDraggedTaskIndex(null);
    
    setTasks(currentTasks => {
      persist('crm_tasks_v2', currentTasks);
      return currentTasks;
    });
    addLog('Перемещение задачи', 'Порядок задач изменен');
  };

  const updateProjectPrice = () => {
    if (!selectedProject) return;
    const newPrice = parseFloat(tempProjectPrice.replace(/\s/g, '')) || 0;
    const updatedProjects = projects.map(p => {
      if (p.id === selectedProject.id) {
        const updated = { ...p, price: newPrice };
        setSelectedProject(updated);
        addLog('Изменение бюджета', `Бюджет проекта "${p.title}" изменен на ${newPrice.toLocaleString()} ₽`);
        return updated;
      }
      return p;
    });
    setProjects(updatedProjects);
    persist('crm_projects_v2', updatedProjects);
    setIsEditingProjectPrice(false);
  };

  const updateProjectDeadline = () => {
    if (!selectedProject) return;
    const newDate = new Date(tempProjectDeadline);
    if (isNaN(newDate.getTime())) return;

    const updatedProjects = projects.map(p => {
      if (p.id === selectedProject.id) {
        const updated = { ...p, deadlineDate: newDate.toISOString() };
        setSelectedProject(updated);
        addLog('Изменение дедлайна', `Дедлайн проекта "${p.title}" изменен на ${format(newDate, 'dd.MM.yyyy')}`);
        return updated;
      }
      return p;
    });
    setProjects(updatedProjects);
    persist('crm_projects_v2', updatedProjects);
    setIsEditingProjectDeadline(false);
  };

  const addEmployeeToProject = (emp: Employee) => {
    if (!selectedProject) return;
    const updatedProjects = projects.map(p =>
      p.id === selectedProject.id ? addMemberToProject(p, emp) : p
    );
    const next = updatedProjects.find(p => p.id === selectedProject.id)!;
    setProjects(updatedProjects);
    setSelectedProject(next);
    persist('crm_projects_v2', updatedProjects);
    addLog('Команда проекта', `${emp.name} добавлен в «${next.title}»`);
  };

  const removeEmployeeFromProject = (employeeId: string) => {
    if (!selectedProject) return;
    const updatedProjects = projects.map(p =>
      p.id === selectedProject.id ? stripEmployeeFromProject(p, employeeId) : p
    );
    const next = updatedProjects.find(p => p.id === selectedProject.id)!;
    setProjects(updatedProjects);
    setSelectedProject(next);
    persist('crm_projects_v2', updatedProjects);
    const emp = employees.find(e => e.id === employeeId);
    addLog('Команда проекта', `${emp?.name ?? employeeId} снят с «${next.title}»`);
    setEditingTeamEmpId(null);
  };

  const saveTeamMemberRate = (employeeId: string) => {
    if (!selectedProject) return;
    const raw = parseFloat(tempTeamRate.replace(/\s/g, '')) || 0;
    const updatedProjects = projects.map(p => {
      if (p.id !== selectedProject.id) return p;
      const nextTeam = (p.team ?? []).map(m =>
        m.employeeId === employeeId ? { ...m, projectRate: raw } : m
      );
      return { ...p, team: nextTeam, developer: undefined };
    });
    const next = updatedProjects.find(p => p.id === selectedProject.id)!;
    setProjects(updatedProjects);
    setSelectedProject(next);
    persist('crm_projects_v2', updatedProjects);
    setEditingTeamEmpId(null);
    addLog('Команда проекта', `Ставка на проекте обновлена (${employees.find(e => e.id === employeeId)?.name})`);
  };

  const deleteProject = (id: string) => {
    const project = projects.find(p => p.id === id);
    const updated = projects.filter(p => p.id !== id);
    setProjects(updated);
    persist('crm_projects_v2', updated);
    addLog('Удаление проекта', `Удален проект: ${project?.title}`);
    if (selectedProject?.id === id) setSelectedProject(null);
  };

  const completeProject = useCallback(() => {
    if (!selectedProject) return;
    const updated = projects.map(p =>
      p.id === selectedProject.id ? { ...p, status: 'completed' as const } : p
    );
    const updatedProject = updated.find(p => p.id === selectedProject.id)!;
    setProjects(updated);
    setSelectedProject(updatedProject);
    persist('crm_projects_v2', updated);
    addLog('Завершение проекта', `Проект "${selectedProject.title}" отмечен как завершённый`);
  }, [selectedProject, projects, persist, addLog]);

  const reopenProject = useCallback(() => {
    if (!selectedProject) return;
    const updated = projects.map(p =>
      p.id === selectedProject.id ? { ...p, status: 'active' as const } : p
    );
    const updatedProject = updated.find(p => p.id === selectedProject.id)!;
    setProjects(updated);
    setSelectedProject(updatedProject);
    persist('crm_projects_v2', updated);
    addLog('Возобновление проекта', `Проект "${selectedProject.title}" возобновлён`);
  }, [selectedProject, projects, persist, addLog]);

  const toggleStage = (projectId: string, stageId: string) => {
    const updatedProjects = projects.map(p => {
      if (p.id === projectId) {
        const updatedStages = p.stages.map(s => {
          if (s.id === stageId) {
            const newStatus = !s.isCompleted;
            addLog('Обновление этапа', `Этап "${s.name}" в проекте "${p.title}" отмечен как ${newStatus ? 'завершенный' : 'незавершенный'}`);
            return { ...s, isCompleted: newStatus };
          }
          return s;
        });
        const newProject = { ...p, stages: updatedStages };
        if (selectedProject?.id === projectId) setSelectedProject(newProject);
        return newProject;
      }
      return p;
    });
    setProjects(updatedProjects);
    persist('crm_projects_v2', updatedProjects);
  };

  const handleFileUpload = (projectId: string, stageId: string, file: File) => {
    const updatedProjects = projects.map(p => {
      if (p.id === projectId) {
        let nextStageId: string | null = null;
        const currentStageIdx = p.stages.findIndex(s => s.id === stageId);
        
        const updatedStages = p.stages.map((s) => {
          if (s.id === stageId) {
            addLog('Загрузка файла', `К этапу "${s.name}" в проекте "${p.title}" прикреплен файл: ${file.name}`);
            // Auto-complete if it's CP or Contract stage
            const isCP = s.name === 'Коммерческое предложение';
            
            if (isCP && currentStageIdx < p.stages.length - 1) {
              nextStageId = p.stages[currentStageIdx + 1].id;
            }

            return { 
              ...s, 
              isCompleted: true, 
              file: { name: file.name, type: file.type } 
            };
          }
          return s;
        });

        // Auto-advance logic: if we have nextStageId, we should also handle it
        const finalStages = nextStageId 
          ? updatedStages.map(s => s.id === nextStageId ? { ...s, isCompleted: false } : s)
          : updatedStages;

        const newProject = { ...p, stages: finalStages };
        if (selectedProject?.id === projectId) setSelectedProject(newProject);
        return newProject;
      }
      return p;
    });
    setProjects(updatedProjects);
    persist('crm_projects_v2', updatedProjects);
  };

  const getRemainingTimeDisplay = (deadline: string) => {
    const diffSec = differenceInSeconds(new Date(deadline), now);
    if (diffSec <= 0) return "Срок истек";
    
    const days = Math.floor(diffSec / (24 * 3600));
    const hours = Math.floor((diffSec % (24 * 3600)) / 3600);
    
    if (days > 0) {
      return `${days} дн. ${hours} ч.`;
    }
    const mins = Math.floor((diffSec % 3600) / 60);
    return `${hours} ч. ${mins} мин.`;
  };

  const getStatusStyle = (deadline: string) => {
    const deadlineDate = new Date(deadline);
    const hoursLeft = differenceInHours(deadlineDate, now);
    if (isPast(deadlineDate)) return 'bg-rose-50 text-rose-600 border-rose-100';
    if (hoursLeft < 24) return 'bg-amber-50 text-amber-600 border-amber-100';
    return 'bg-emerald-50 text-emerald-600 border-emerald-100';
  };

  const filteredProjects = projects.filter(p => 
    p.title.toLowerCase().includes(search.toLowerCase())
  );

  const filteredWorkProjects = workProjects.filter(w =>
    w.title.toLowerCase().includes(search.toLowerCase()) ||
    w.customer.toLowerCase().includes(search.toLowerCase())
  );

  const filteredSupportRecords = supportRecords.filter(r =>
    r.title.toLowerCase().includes(search.toLowerCase()) ||
    r.counterpartyName.toLowerCase().includes(search.toLowerCase()) ||
    r.description.toLowerCase().includes(search.toLowerCase())
  );

  if (selectedSupport) {
    const s = selectedSupport;
    const paymentEvents = s.calendarEvents.filter(e => e.type === 'payment');
    const paidTotal = paymentEvents.filter(p => p.isPaid).reduce((sum, p) => sum + (p.amount || 0), 0);
    const scheduleTotal = paymentEvents.reduce((sum, p) => sum + (p.amount || 0), 0);
    const contractEnd = supportContractEndDate(s.contractStartDate, s.contractDurationMonths);
    const calMonthStart = startOfMonth(supCalViewMonth);
    const calMonthEnd = endOfMonth(supCalViewMonth);
    const calGridStart = startOfWeek(calMonthStart, { weekStartsOn: 1 });
    const calGridEnd = endOfWeek(calMonthEnd, { weekStartsOn: 1 });
    const calDays = eachDayOfInterval({ start: calGridStart, end: calGridEnd });
    const eventsByDate = s.calendarEvents.reduce<Record<string, SupportCalendarEvent[]>>((acc, ev) => {
      const d = ev.date.slice(0, 10);
      if (!acc[d]) acc[d] = [];
      acc[d].push(ev);
      return acc;
    }, {});
    const activeDayEvents = supCalActiveDate ? eventsByDate[supCalActiveDate] || [] : [];
    const contractStartParsed = s.contractStartDate ? parseISO(s.contractStartDate) : null;

    const isInContractPeriod = (day: Date) => {
      if (!contractStartParsed || !contractEnd || Number.isNaN(contractStartParsed.getTime())) return false;
      return isWithinInterval(day, { start: contractStartParsed, end: contractEnd });
    };

    return (
      <div className="flex h-screen bg-[#F8FAFC] text-[#1E293B] font-['Inter',sans-serif]">
        <main className="flex-1 overflow-y-auto p-10 max-w-5xl mx-auto w-full">
          <button
            type="button"
            onClick={() => {
              flushAllToDisk();
              setSelectedSupport(null);
            }}
            className="flex items-center gap-2 text-gray-500 hover:text-teal-600 font-bold mb-8 transition-colors group"
          >
            <ArrowLeft className="w-5 h-5 group-hover:-translate-x-1 transition-transform" /> Назад к сопровождению
          </button>

          <div className="space-y-8">
            <div className="bg-white rounded-[2.5rem] p-10 shadow-xl shadow-gray-200/50 border border-gray-100">
              <div className="flex flex-wrap items-start justify-between gap-6 mb-8">
                <div>
                  <span className="text-[10px] font-black text-teal-500 uppercase tracking-[0.2em]">Сопровождение</span>
                  <h1 className="text-3xl font-black text-[#0F172A] tracking-tight mt-2">{s.title || 'Без названия'}</h1>
                  <p className="text-gray-500 text-sm mt-1">Изменения сохраняются автоматически.</p>
                </div>
                <div className="text-right">
                  <div className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-400 mb-1">Стоимость</div>
                  <div className="text-2xl font-black text-teal-700 tabular-nums">{s.price.toLocaleString('ru-RU')} ₽</div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="md:col-span-2">
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-2 ml-1">Название / тип</label>
                  <input
                    type="text"
                    defaultValue={s.title}
                    key={s.id + s.title}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v && v !== s.title) patchSupportRecord(s.id, { title: v });
                    }}
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-teal-500 focus:ring-4 focus:ring-teal-500/10 font-medium"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-2 ml-1">Контрагент</label>
                  <input
                    type="text"
                    defaultValue={s.counterpartyName}
                    key={s.id + s.counterpartyName}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== s.counterpartyName) patchSupportRecord(s.id, { counterpartyName: v });
                    }}
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-teal-500 focus:ring-4 focus:ring-teal-500/10 font-medium"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-2 ml-1">Цена (₽)</label>
                  <input
                    type="text"
                    defaultValue={s.price ? s.price.toLocaleString('ru-RU') : ''}
                    key={s.id + '-price-' + s.price}
                    onBlur={(e) => {
                      const raw = parseFloat(e.target.value.replace(/\s/g, '')) || 0;
                      if (raw !== s.price) patchSupportRecord(s.id, { price: raw });
                    }}
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-teal-500 focus:ring-4 focus:ring-teal-500/10 font-medium"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-2 ml-1">Срок договора (мес.)</label>
                  <input
                    type="number"
                    min={1}
                    defaultValue={s.contractDurationMonths || ''}
                    key={s.id + '-months-' + s.contractDurationMonths}
                    onBlur={(e) => {
                      const v = Math.max(0, parseInt(e.target.value, 10) || 0);
                      if (v !== s.contractDurationMonths) patchSupportRecord(s.id, { contractDurationMonths: v });
                    }}
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-teal-500 focus:ring-4 focus:ring-teal-500/10 font-medium"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-2 ml-1">Дата начала договора</label>
                  <input
                    type="date"
                    defaultValue={s.contractStartDate}
                    key={s.id + s.contractStartDate}
                    onBlur={(e) => {
                      const v = e.target.value;
                      if (v !== s.contractStartDate) patchSupportRecord(s.id, { contractStartDate: v });
                    }}
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-teal-500 focus:ring-4 focus:ring-teal-500/10 font-medium"
                  />
                  {contractEnd && (
                    <p className="text-xs text-teal-600 font-semibold mt-2">
                      До {format(contractEnd, 'd MMMM yyyy', { locale: ru })}
                    </p>
                  )}
                </div>
                <div className="md:col-span-2">
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-2 ml-1">Реквизиты контрагента</label>
                  <textarea
                    defaultValue={s.counterpartyDetails}
                    key={s.id + s.counterpartyDetails}
                    rows={4}
                    placeholder="ИНН, КПП, расчётный счёт, банк, адрес…"
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== s.counterpartyDetails) patchSupportRecord(s.id, { counterpartyDetails: v });
                    }}
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-4 outline-none focus:bg-white focus:border-teal-500 focus:ring-4 focus:ring-teal-500/10 font-medium resize-y"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-2 ml-1">Что входит в сопровождение</label>
                  <textarea
                    defaultValue={s.description}
                    key={s.id + s.description}
                    rows={5}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== s.description) patchSupportRecord(s.id, { description: v });
                    }}
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-4 outline-none focus:bg-white focus:border-teal-500 focus:ring-4 focus:ring-teal-500/10 font-medium resize-y min-h-[120px]"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-2 ml-1">Комментарий</label>
                  <textarea
                    defaultValue={s.comment}
                    key={s.id + s.comment}
                    rows={3}
                    placeholder="Внутренние заметки по договорённостям…"
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== s.comment) patchSupportRecord(s.id, { comment: v });
                    }}
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-4 outline-none focus:bg-white focus:border-teal-500 focus:ring-4 focus:ring-teal-500/10 font-medium resize-y"
                  />
                </div>
              </div>
            </div>

            <div className="bg-white rounded-[2.5rem] p-10 shadow-xl shadow-gray-200/50 border border-gray-100">
              <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
                <div>
                  <h2 className="text-lg font-black text-[#0F172A] flex items-center gap-2">
                    <Calendar className="w-5 h-5 text-teal-600" /> Календарь сопровождения
                  </h2>
                  <p className="text-sm text-gray-500 mt-1">
                    Нажмите на дату — добавьте акт, оплату или комментарий. Срок договора подсвечен на календаре.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="text-sm font-semibold text-gray-600 tabular-nums">
                    Оплачено: <span className="text-emerald-600">{paidTotal.toLocaleString('ru-RU')} ₽</span>
                    {scheduleTotal > 0 && (
                      <span className="text-gray-400"> / {scheduleTotal.toLocaleString('ru-RU')} ₽</span>
                    )}
                  </div>
                  {s.contractDurationMonths > 0 && s.contractStartDate && (
                    <button
                      type="button"
                      onClick={() => generateSupportMonthlyPayments(s.id)}
                      className="text-xs font-bold text-teal-700 bg-teal-50 hover:bg-teal-100 border border-teal-200 px-4 py-2 rounded-xl transition-all"
                    >
                      Сгенерировать {s.contractDurationMonths} оплат
                    </button>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between mb-4">
                <button
                  type="button"
                  onClick={() => setSupCalViewMonth(prev => addMonths(prev, -1))}
                  className="p-2.5 rounded-xl hover:bg-gray-100 text-gray-600 transition-all"
                  aria-label="Предыдущий месяц"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <h3 className="text-base font-black text-[#0F172A] capitalize">
                  {format(supCalViewMonth, 'LLLL yyyy', { locale: ru })}
                </h3>
                <button
                  type="button"
                  onClick={() => setSupCalViewMonth(prev => addMonths(prev, 1))}
                  className="p-2.5 rounded-xl hover:bg-gray-100 text-gray-600 transition-all rotate-180"
                  aria-label="Следующий месяц"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
              </div>

              <div className="grid grid-cols-7 gap-1 mb-1">
                {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(wd => (
                  <div key={wd} className="text-center text-[10px] font-black text-gray-400 uppercase py-2">
                    {wd}
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-7 gap-1 mb-8">
                {calDays.map(day => {
                  const dateStr = format(day, 'yyyy-MM-dd');
                  const inMonth = isSameMonth(day, supCalViewMonth);
                  const dayEvents = eventsByDate[dateStr] || [];
                  const isActive = supCalActiveDate === dateStr;
                  const inContract = isInContractPeriod(day);
                  return (
                    <button
                      key={dateStr}
                      type="button"
                      onClick={() => setSupCalActiveDate(dateStr)}
                      className={`min-h-[72px] p-1.5 rounded-xl border text-left transition-all flex flex-col ${
                        !inMonth ? 'opacity-35' : ''
                      } ${
                        isActive
                          ? 'border-teal-500 bg-teal-50 ring-2 ring-teal-500/20 shadow-md'
                          : inContract
                            ? 'border-teal-100 bg-teal-50/40 hover:border-teal-300 hover:bg-teal-50'
                            : 'border-gray-100 bg-gray-50/50 hover:border-teal-200 hover:bg-white'
                      } ${isToday(day) && !isActive ? 'ring-1 ring-teal-300' : ''}`}
                    >
                      <span
                        className={`text-xs font-bold mb-1 w-6 h-6 flex items-center justify-center rounded-lg ${
                          isToday(day) ? 'bg-teal-600 text-white' : 'text-gray-700'
                        }`}
                      >
                        {format(day, 'd')}
                      </span>
                      <div className="flex flex-wrap gap-0.5 mt-auto">
                        {dayEvents.slice(0, 4).map(ev => (
                          <span
                            key={ev.id}
                            className={`w-1.5 h-1.5 rounded-full ${
                              ev.type === 'payment'
                                ? ev.isPaid
                                  ? 'bg-emerald-500'
                                  : 'bg-amber-400'
                                : ev.type === 'act'
                                  ? 'bg-blue-500'
                                  : 'bg-gray-400'
                            }`}
                          />
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="flex flex-wrap gap-4 mb-6 text-[10px] font-bold uppercase tracking-wider text-gray-500">
                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-teal-200 border border-teal-300" /> Срок договора</span>
                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500" /> Оплачено</span>
                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-400" /> Ожидает оплаты</span>
                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-blue-500" /> Акт</span>
                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-gray-400" /> Комментарий</span>
              </div>

              {supCalActiveDate ? (
                <div className="border border-teal-100 bg-gradient-to-br from-teal-50/80 to-white rounded-2xl p-6">
                  <div className="flex flex-wrap items-center justify-between gap-4 mb-5">
                    <h4 className="font-black text-[#0F172A]">
                      {format(parseISO(supCalActiveDate), 'd MMMM yyyy', { locale: ru })}
                    </h4>
                    <button
                      type="button"
                      onClick={() => setSupCalActiveDate(null)}
                      className="text-xs font-bold text-gray-400 hover:text-gray-600"
                    >
                      Закрыть
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
                    <button
                      type="button"
                      onClick={() => openSupportEventModal('act', supCalActiveDate)}
                      className="flex items-center gap-3 p-4 rounded-xl border border-blue-200 bg-blue-50 hover:bg-blue-100 text-left transition-all"
                    >
                      <FileCheck className="w-5 h-5 text-blue-600 shrink-0" />
                      <span className="text-sm font-bold text-blue-800">Акт по техподдержке</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => openSupportEventModal('payment', supCalActiveDate, s.price)}
                      className="flex items-center gap-3 p-4 rounded-xl border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 text-left transition-all"
                    >
                      <Wallet className="w-5 h-5 text-emerald-600 shrink-0" />
                      <span className="text-sm font-bold text-emerald-800">Оплата контрагента</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => openSupportEventModal('comment', supCalActiveDate)}
                      className="flex items-center gap-3 p-4 rounded-xl border border-gray-200 bg-gray-50 hover:bg-gray-100 text-left transition-all"
                    >
                      <MessageSquare className="w-5 h-5 text-gray-600 shrink-0" />
                      <span className="text-sm font-bold text-gray-800">Комментарий</span>
                    </button>
                  </div>

                  {activeDayEvents.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-4">На эту дату записей пока нет</p>
                  ) : (
                    <div className="space-y-3">
                      {[...activeDayEvents]
                        .sort((a, b) => a.type.localeCompare(b.type))
                        .map(ev => {
                          const meta = SUPPORT_EVENT_META[ev.type];
                          return (
                            <div
                              key={ev.id}
                              className={`flex flex-wrap items-start gap-3 p-4 rounded-xl border ${meta.bg} ${meta.border}`}
                            >
                              {ev.type === 'payment' && (
                                <button
                                  type="button"
                                  onClick={() => toggleSupportEventPaid(s.id, ev.id)}
                                  className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center transition-all ${
                                    ev.isPaid
                                      ? 'bg-emerald-500 text-white'
                                      : 'bg-white border border-gray-300 text-gray-400 hover:border-emerald-400'
                                  }`}
                                  title={ev.isPaid ? 'Оплачено' : 'Отметить оплату'}
                                >
                                  <CheckCircle className="w-4 h-4" />
                                </button>
                              )}
                              {ev.type === 'act' && (
                                <FileCheck className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
                              )}
                              {ev.type === 'comment' && (
                                <MessageSquare className="w-5 h-5 text-gray-500 shrink-0 mt-0.5" />
                              )}
                              <div className="flex-1 min-w-0">
                                <div className={`text-[10px] font-black uppercase tracking-wider mb-1 ${meta.color}`}>
                                  {meta.label}
                                </div>
                                {ev.title && (
                                  <div className="font-bold text-sm text-[#0F172A]">{ev.title}</div>
                                )}
                                {ev.type === 'payment' && (
                                  <div className="text-sm font-bold text-emerald-700 tabular-nums mt-1">
                                    {(ev.amount || 0).toLocaleString('ru-RU')} ₽
                                    {ev.isPaid && ev.paidAt && (
                                      <span className="text-emerald-600 font-semibold ml-2 text-xs">
                                        ✓ {format(parseISO(ev.paidAt), 'd.MM.yyyy')}
                                      </span>
                                    )}
                                  </div>
                                )}
                                {ev.text && (
                                  <p className="text-sm text-gray-600 mt-1 whitespace-pre-wrap">{ev.text}</p>
                                )}
                              </div>
                              <button
                                type="button"
                                onClick={() => removeSupportCalendarEvent(s.id, ev.id)}
                                className="p-2 text-gray-400 hover:text-rose-500 hover:bg-rose-50 rounded-lg transition-all"
                                title="Удалить"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          );
                        })}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-gray-400 text-center py-6 border-2 border-dashed border-gray-200 rounded-2xl">
                  Выберите дату на календаре выше
                </p>
              )}

              {supEventModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
                  <div className="bg-white rounded-[2rem] p-8 max-w-md w-full shadow-2xl border border-gray-100">
                    <h3 className="text-lg font-black text-[#0F172A] mb-1">
                      {SUPPORT_EVENT_META[supEventModal.type].label}
                    </h3>
                    <p className="text-sm text-gray-500 mb-6">
                      {format(parseISO(supEventModal.date), 'd MMMM yyyy', { locale: ru })}
                    </p>
                    {supEventModal.type !== 'comment' && (
                      <div className="mb-4">
                        <label className="block text-[10px] font-black text-gray-400 uppercase tracking-wider mb-2">
                          {supEventModal.type === 'act' ? 'Название акта' : 'Назначение'}
                        </label>
                        <input
                          type="text"
                          value={supEventTitle}
                          onChange={(e) => setSupEventTitle(e.target.value)}
                          className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 outline-none focus:border-teal-500 font-medium"
                        />
                      </div>
                    )}
                    {supEventModal.type === 'payment' && (
                      <div className="mb-6">
                        <label className="block text-[10px] font-black text-gray-400 uppercase tracking-wider mb-2">
                          Сумма (₽)
                        </label>
                        <input
                          type="text"
                          value={supEventAmount}
                          onChange={(e) => setSupEventAmount(formatNumber(e.target.value))}
                          className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 outline-none focus:border-teal-500 font-medium"
                        />
                      </div>
                    )}
                    {(supEventModal.type === 'comment' || supEventModal.type === 'act') && (
                      <div className="mb-6">
                        <label className="block text-[10px] font-black text-gray-400 uppercase tracking-wider mb-2">
                          {supEventModal.type === 'comment' ? 'Текст комментария' : 'Примечание (необязательно)'}
                        </label>
                        <textarea
                          value={supEventText}
                          onChange={(e) => setSupEventText(e.target.value)}
                          rows={3}
                          className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 outline-none focus:border-teal-500 font-medium resize-y"
                          autoFocus={supEventModal.type === 'comment'}
                        />
                      </div>
                    )}
                    <div className="flex gap-3">
                      <button
                        type="button"
                        onClick={() => setSupEventModal(null)}
                        className="flex-1 py-3 rounded-xl font-bold text-gray-600 bg-gray-100 hover:bg-gray-200 transition-all"
                      >
                        Отмена
                      </button>
                      <button
                        type="button"
                        onClick={() => submitSupportEventModal(s.id)}
                        className="flex-1 py-3 rounded-xl font-bold text-white bg-teal-600 hover:bg-teal-700 transition-all"
                      >
                        Добавить
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="bg-white rounded-[2.5rem] p-10 shadow-xl shadow-gray-200/50 border border-gray-100">
              <h2 className="text-lg font-black text-[#0F172A] mb-2">Договор</h2>
              <p className="text-sm text-gray-500 mb-6">PDF, DOC или DOCX до 4 МБ. Файл хранится локально / в облаке вместе с CRM.</p>

              {s.contract ? (
                <div className="flex flex-wrap items-center gap-4 p-5 bg-teal-50/50 border border-teal-100 rounded-2xl">
                  <Paperclip className="w-5 h-5 text-teal-600 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-[#0F172A] truncate">{s.contract.name}</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      Загружен {format(new Date(s.contract.uploadedAt), 'd MMM yyyy, HH:mm', { locale: ru })}
                    </div>
                  </div>
                  <a
                    href={s.contract.dataUrl}
                    download={s.contract.name}
                    className="inline-flex items-center gap-2 bg-white border border-teal-200 text-teal-700 font-bold px-4 py-2.5 rounded-xl hover:bg-teal-50 transition-all text-sm"
                  >
                    <Download className="w-4 h-4" /> Скачать
                  </a>
                  <label className="inline-flex items-center gap-2 bg-teal-600 hover:bg-teal-700 text-white font-bold px-4 py-2.5 rounded-xl cursor-pointer transition-all text-sm">
                    <UploadCloud className="w-4 h-4" /> Заменить
                    <input
                      type="file"
                      accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) uploadSupportContract(s.id, f);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => removeSupportContract(s.id)}
                    className="p-2.5 text-rose-500 hover:bg-rose-50 rounded-xl transition-all"
                    title="Удалить договор"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <label className="flex flex-col items-center justify-center gap-3 p-12 border-2 border-dashed border-gray-200 rounded-2xl cursor-pointer hover:border-teal-300 hover:bg-teal-50/30 transition-all">
                  <UploadCloud className="w-10 h-10 text-teal-400" />
                  <span className="font-bold text-gray-600">Прикрепить договор</span>
                  <span className="text-xs text-gray-400">PDF, DOC, DOCX — до 4 МБ</span>
                  <input
                    type="file"
                    accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) uploadSupportContract(s.id, f);
                      e.target.value = '';
                    }}
                  />
                </label>
              )}
            </div>

            <div className="flex justify-between items-center gap-4 pb-10">
              <button
                type="button"
                onClick={() => deleteSupportRecord(s.id)}
                className="text-rose-600 font-bold text-sm hover:underline"
              >
                Удалить сопровождение
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (selectedWorkProject) {
    const w = selectedWorkProject;
    return (
      <div className="flex h-screen bg-[#F8FAFC] text-[#1E293B] font-['Inter',sans-serif]">
        <main className="flex-1 overflow-y-auto p-10 max-w-4xl mx-auto w-full">
          <button
            type="button"
            onClick={() => {
              flushAllToDisk();
              setSelectedWorkProject(null);
            }}
            className="flex items-center gap-2 text-gray-500 hover:text-indigo-600 font-bold mb-8 transition-colors group"
          >
            <ArrowLeft className="w-5 h-5 group-hover:-translate-x-1 transition-transform" /> Назад к «В работе»
          </button>

          <div className="space-y-8">
            <div className="bg-white rounded-[2.5rem] p-10 shadow-xl shadow-gray-200/50 border border-gray-100">
              <div className="flex flex-wrap items-start justify-between gap-6 mb-8">
                <div>
                  <span className="text-[10px] font-black text-indigo-500 uppercase tracking-[0.2em]">Заказ в работе</span>
                  <h1 className="text-3xl font-black text-[#0F172A] tracking-tight mt-2">Редактирование</h1>
                  <p className="text-gray-500 text-sm mt-1">Изменения сохраняются автоматически (в т.ч. при сворачивании окна).</p>
                </div>
                <span className={`px-4 py-2 rounded-xl text-[10px] font-black tracking-widest uppercase border ${getStatusStyle(w.deadlineDate)}`}>
                  {isPast(new Date(w.deadlineDate)) ? 'Дедлайн прошёл' : 'В сроке'}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-2 ml-1">Название</label>
                  <input
                    type="text"
                    defaultValue={w.title}
                    key={w.id + w.title}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v && v !== w.title) patchWorkProject(w.id, { title: v });
                    }}
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 font-medium"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-2 ml-1">Заказчик</label>
                  <input
                    type="text"
                    defaultValue={w.customer}
                    key={w.id + w.customer}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== w.customer) patchWorkProject(w.id, { customer: v });
                    }}
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 font-medium"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-2 ml-1">Цена (₽)</label>
                  <input
                    type="text"
                    defaultValue={w.price ? w.price.toLocaleString() : ''}
                    key={w.id + '-price-' + w.price}
                    onBlur={(e) => {
                      const raw = parseFloat(e.target.value.replace(/\s/g, '')) || 0;
                      if (raw !== w.price) patchWorkProject(w.id, { price: raw });
                    }}
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 font-medium"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-2 ml-1">Дедлайн</label>
                  <div className="flex flex-wrap items-center gap-3">
                    <input
                      type="date"
                      value={tempWorkDeadline}
                      onChange={(e) => setTempWorkDeadline(e.target.value)}
                      className="bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-indigo-500 font-medium"
                    />
                    <button
                      type="button"
                      onClick={() => updateWorkProjectDeadline(w.id, tempWorkDeadline)}
                      className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-6 py-3.5 rounded-2xl transition-all shadow-lg shadow-indigo-500/25"
                    >
                      Сохранить дату
                    </button>
                  </div>
                  <p className="text-xs text-gray-400 mt-2">
                    Осталось: <span className="font-bold text-indigo-600">{getRemainingTimeDisplay(w.deadlineDate)}</span>
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-[2.5rem] p-10 shadow-xl shadow-gray-200/50 border border-gray-100">
              <h2 className="text-lg font-black text-[#0F172A] mb-2">Текущий этап</h2>
              <p className="text-sm text-gray-500 mb-4">Опишите, на чём сейчас остановились. Текст сохраняется через короткую паузу после ввода.</p>
              <textarea
                value={stageDraft}
                onChange={(e) => {
                  const v = e.target.value;
                  setStageDraft(v);
                  schedulePersistWorkStage(w.id, v);
                }}
                rows={8}
                placeholder="Например: ждём макеты от заказчика, правки по блоку «Контакты»…"
                className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-4 outline-none focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 font-medium resize-y min-h-[180px]"
              />
            </div>

            <div className="flex justify-between items-center gap-4 pb-10">
              <button
                type="button"
                onClick={() => deleteWorkProject(w.id)}
                className="text-rose-600 font-bold text-sm hover:underline"
              >
                Удалить заказ
              </button>
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                Обновлено: {format(new Date(w.updatedAt), 'dd.MM.yyyy HH:mm', { locale: ru })}
              </span>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (selectedProject) {
    const completedStages = selectedProject.stages.map((s, idx) => ({ ...s, idx })).filter(s => s.isCompleted);
    const maxCompletedIdx = completedStages.length > 0 ? Math.max(...completedStages.map(s => s.idx)) : -1;
    const totalStages = selectedProject.stages.length;
    const isContractSigned = selectedProject.stages.find(s => s.name === 'Заключение договора')?.isCompleted;
    const isCPCompleted = selectedProject.stages.find(s => s.name === 'Коммерческое предложение')?.isCompleted;
    
    // Calculate progress based on the furthest completed stage
    // Each stage fills its segment plus half of the segment to the next stage
    // If the last stage is completed, it's 100%
    let progressPercent = 0;
    if (maxCompletedIdx !== -1) {
      if (maxCompletedIdx === totalStages - 1) {
        progressPercent = 100;
      } else {
        // First stage is at 0%. Last stage is at 100%.
        // There are (totalStages - 1) gaps.
        const gapSize = 100 / (totalStages - 1);
        progressPercent = maxCompletedIdx * gapSize + (gapSize / 2);
      }
    }

    return (
      <div className="flex h-screen bg-[#F8FAFC] text-[#1E293B] font-['Inter',sans-serif]">
        <main className="flex-1 overflow-y-auto p-10">
          <button 
            type="button"
            onClick={() => { flushAllToDisk(); setSelectedProject(null); }}
            className="flex items-center gap-2 text-gray-500 hover:text-blue-600 font-bold mb-8 transition-colors group"
          >
            <ArrowLeft className="w-5 h-5 group-hover:-translate-x-1 transition-transform" /> Назад к списку
          </button>

          <div className="space-y-8">
            {/* Header Card */}
            <div className="bg-white rounded-[2.5rem] p-10 shadow-xl shadow-gray-200/50 border border-gray-100 relative overflow-hidden">
              <div className="absolute top-0 left-0 w-2 h-full bg-blue-600"></div>
              
              <div className="flex justify-between items-start">
                <div>
                  <div className="flex items-center gap-4 mb-3">
                    <h1 className="text-4xl font-black text-[#0F172A] tracking-tight">{selectedProject.title}</h1>
                    <div className={`px-4 py-1.5 rounded-xl text-[10px] font-black tracking-widest uppercase border ${
                      selectedProject.status === 'completed'
                        ? 'bg-emerald-50 text-emerald-600 border-emerald-100'
                        : getStatusStyle(selectedProject.deadlineDate)
                    }`}>
                      {selectedProject.status === 'completed' ? 'ЗАВЕРШЁН' : isPast(new Date(selectedProject.deadlineDate)) ? 'ПРОСРОЧЕНО' : 'В ПРОЦЕССЕ'}
                    </div>
                  </div>
                  <p className="text-gray-400 font-bold flex items-center gap-2">
                    <Clock className="w-4 h-4" /> Осталось: <span className="text-blue-600 uppercase tracking-tighter">{getRemainingTimeDisplay(selectedProject.deadlineDate)}</span>
                  </p>
                </div>
                <div className="text-right group">
                  <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest block mb-1">Общий бюджет</span>
                  {isEditingProjectPrice ? (
                    <div className="flex items-center gap-3 justify-end">
                      <input 
                        type="text"
                        autoFocus
                        value={tempProjectPrice}
                        onChange={(e) => setTempProjectPrice(formatNumber(e.target.value))}
                        className="bg-gray-50 border border-blue-500 rounded-xl px-4 py-2 text-2xl font-black text-blue-600 w-48 text-right outline-none"
                      />
                      <button onClick={updateProjectPrice} className="p-2 bg-emerald-500 text-white rounded-xl hover:bg-emerald-600 transition-colors">
                        <Save className="w-5 h-5" />
                      </button>
                      <button onClick={() => setIsEditingProjectPrice(false)} className="p-2 bg-rose-500 text-white rounded-xl hover:bg-rose-600 transition-colors">
                        <X className="w-5 h-5" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-4 justify-end">
                      <span className="text-4xl font-black text-blue-600">{selectedProject.price.toLocaleString()} ₽</span>
                      <button 
                        onClick={() => {
                          setTempProjectPrice(formatNumber(selectedProject.price.toString()));
                          setIsEditingProjectPrice(true);
                        }}
                        className="p-2.5 bg-gray-50 rounded-xl hover:bg-gray-100 transition-all opacity-0 group-hover:opacity-100"
                      >
                        <Edit3 className="w-4 h-4 text-gray-400" />
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Horizontal Progress Bar */}
              <div className="mt-12">
                <div className="flex justify-between items-end mb-6">
                  <h3 className="text-lg font-black text-[#0F172A] flex items-center gap-2">
                    Прогресс выполнения <span className="text-blue-600 text-sm bg-blue-50 px-2 py-0.5 rounded-lg">{Math.round(progressPercent)}%</span>
                  </h3>
                  <span className="text-xs font-bold text-gray-400 uppercase tracking-widest">{completedStages.length} из {selectedProject.stages.length} этапов</span>
                </div>
                
                <div className="relative pt-8 pb-12 px-20">
                  {/* Track line - aligned with dots centers */}
                  <div className="absolute top-1/2 left-[104px] right-[104px] h-1.5 bg-gray-100 -translate-y-1/2 rounded-full overflow-hidden">
                    <div 
                      className="absolute top-0 left-0 h-full bg-blue-600 transition-all duration-700 shadow-lg shadow-blue-500/20"
                      style={{ width: `${progressPercent}%` }}
                    ></div>
                  </div>

                  {/* Stages dots */}
                  <div className="relative flex justify-between">
                    {selectedProject.stages.map((stage) => {
                      const Icon = (typeof stage.icon === 'function' ? stage.icon : null) ?? STAGE_CONFIG.find(c => c.name === stage.name)?.icon ?? AlertCircle;
                      
                      return (
                        <div 
                          key={stage.id} 
                          className="flex flex-col items-center group cursor-pointer relative"
                          onClick={() => {
                            if (stage.name === 'Коммерческое предложение' && !stage.isCompleted) {
                              document.getElementById('file-upload-cp')?.click();
                              return;
                            }
                            if (stage.name === 'Заключение договора' && !stage.isCompleted) {
                              if (!isCPCompleted) return;
                              document.getElementById('file-upload-contract')?.click();
                              return;
                            }
                            if (stage.name === 'Назначение разработчика' && !stage.isCompleted) {
                              return;
                            }
                            toggleStage(selectedProject.id, stage.id);
                          }}
                        >
                          <div className={`w-12 h-12 rounded-2xl flex items-center justify-center border-4 border-white shadow-xl transition-all z-10 ${
                            stage.isCompleted ? 'bg-blue-600 text-white scale-110' : 'bg-white text-gray-300 group-hover:border-blue-100 group-hover:text-blue-400'
                          }`}>
                            <Icon className="w-5 h-5" />
                          </div>

                          <div className="absolute top-16 text-center w-40 flex flex-col items-center">
                            <span className={`text-[13px] font-black uppercase tracking-tight leading-tight mb-1.5 transition-colors ${
                              stage.isCompleted ? 'text-blue-600' : 'text-gray-400'
                            }`}>{stage.name}</span>
                            
                            {stage.file ? (
                              <div className="flex items-center gap-1.5 bg-blue-50 px-2 py-1 rounded-lg border border-blue-100 mt-1">
                                <Paperclip className="w-3 h-3 text-blue-600" />
                                <span className="text-[10px] font-bold text-blue-600 truncate max-w-[100px]">{stage.file.name}</span>
                              </div>
                            ) : (
                              <span className="text-[11px] font-bold text-gray-400 italic">
                                {format(new Date(stage.estimatedDate), 'd MMMM', { locale: ru })}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
              <div className="lg:col-span-2 space-y-8">
                {/* Команда проекта */}
                {isContractSigned && (() => {
                  const teamMembers = selectedProject.team ?? [];
                  const teamPayroll = projectPayrollCost(selectedProject);
                  const assignedIds = new Set(teamMembers.map(m => m.employeeId));
                  const availableEmployees = employees.filter(e => !assignedIds.has(e.id));
                  return (
                    <div className={`bg-[#0F172A] rounded-[2.5rem] transition-all duration-500 shadow-xl shadow-blue-900/20 ${
                      teamMembers.length ? 'p-6' : 'p-8'
                    }`}>
                      <div className="flex flex-col gap-4 sm:flex-row sm:justify-between sm:items-start mb-8">
                        <div>
                          <h4 className="text-xl font-black flex items-center gap-3 text-white">
                            <Users className="w-6 h-6 text-blue-400" />
                            Команда проекта
                          </h4>
                          <p className="text-gray-500 text-xs mt-1 font-medium italic">
                            Несколько исполнителей; ставка по проекту задаётся отдельно от базовой ставки в карточке сотрудника
                          </p>
                        </div>
                        <div className="text-right">
                          <span className="text-[10px] font-black text-blue-400 uppercase tracking-widest bg-blue-400/10 px-4 py-1.5 rounded-xl border border-blue-400/20 block sm:inline-block">
                            ФОТ по команде: {teamPayroll.toLocaleString()} ₽
                          </span>
                          <span className="text-[10px] font-black text-gray-500 uppercase tracking-widest block mt-2">
                            Ориентир 60%: {Math.round(selectedProject.price * 0.6).toLocaleString()} ₽
                          </span>
                        </div>
                      </div>

                      {teamMembers.length > 0 && (
                        <div className="space-y-4 mb-8">
                          {teamMembers.map(m => {
                            const emp = employees.find(e => e.id === m.employeeId);
                            return (
                              <div
                                key={m.employeeId}
                                className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between bg-white/5 border border-white/10 rounded-[1.5rem] p-5 text-white"
                              >
                                <div className="flex items-center gap-4 min-w-0">
                                  <div className="w-12 h-12 bg-gray-800 rounded-2xl flex items-center justify-center shrink-0">
                                    <User className="w-6 h-6 text-blue-400" />
                                  </div>
                                  <div className="min-w-0">
                                    <p className="font-black truncate">{emp?.name ?? 'Не найден в штате'}</p>
                                    <div className="flex flex-wrap items-center gap-2 text-[10px] text-gray-500 font-bold uppercase tracking-wider">
                                      <span>{emp?.role ?? '—'}</span>
                                      {emp ? (
                                        <span className="flex items-center gap-1 text-amber-400/90">
                                          <Star className="w-3 h-3 fill-amber-400" /> {emp.rating}
                                        </span>
                                      ) : null}
                                      {emp != null && emp.rate > 0 ? (
                                        <span className="text-emerald-400/90">база {emp.rate.toLocaleString()} ₽</span>
                                      ) : null}
                                    </div>
                                  </div>
                                </div>

                                <div className="flex flex-wrap items-center gap-3">
                                  {editingTeamEmpId === m.employeeId ? (
                                    <>
                                      <input
                                        type="text"
                                        autoFocus
                                        value={tempTeamRate}
                                        onChange={(e) => setTempTeamRate(formatNumber(e.target.value))}
                                        className="bg-gray-800 border border-blue-500 rounded-xl px-3 py-2 text-sm font-black text-white w-36 text-right outline-none"
                                        placeholder="₽ по проекту"
                                      />
                                      <button
                                        type="button"
                                        onClick={() => saveTeamMemberRate(m.employeeId)}
                                        className="p-2 bg-emerald-500 rounded-xl hover:bg-emerald-600"
                                      >
                                        <Save className="w-4 h-4 text-white" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setEditingTeamEmpId(null)}
                                        className="p-2 bg-rose-500/80 rounded-xl hover:bg-rose-500"
                                      >
                                        <X className="w-4 h-4 text-white" />
                                      </button>
                                    </>
                                  ) : (
                                    <>
                                      <span className="text-lg font-black text-emerald-400 tabular-nums">
                                        {(m.projectRate || 0).toLocaleString()} ₽
                                      </span>
                                      <span className="text-[9px] font-bold text-gray-500 uppercase">на проекте</span>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setTempTeamRate(formatNumber((m.projectRate || 0).toString()));
                                          setEditingTeamEmpId(m.employeeId);
                                        }}
                                        className="p-2 bg-white/5 rounded-xl hover:bg-white/10"
                                      >
                                        <Edit3 className="w-4 h-4 text-gray-400" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => removeEmployeeFromProject(m.employeeId)}
                                        className="p-2 bg-white/5 rounded-xl hover:bg-rose-500/20 hover:text-rose-400 text-gray-400"
                                        title="Снять с проекта"
                                      >
                                        <Trash2 className="w-4 h-4" />
                                      </button>
                                    </>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {availableEmployees.length > 0 ? (
                        <div>
                          <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-4">
                            {teamMembers.length ? 'Добавить в команду' : 'Выберите специалистов'}
                          </p>
                          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {availableEmployees.map(emp => (
                              <div
                                key={emp.id}
                                className="bg-white/5 border border-white/10 rounded-[2rem] p-6 hover:border-blue-500/50 hover:bg-blue-600/5 transition-all group relative overflow-hidden"
                              >
                                <div className="flex items-center gap-5 mb-6 text-white">
                                  <div className="w-14 h-14 bg-gray-800 rounded-2xl flex items-center justify-center ring-4 ring-gray-700/30 group-hover:ring-blue-500/20 transition-all">
                                    <User className="w-7 h-7 text-gray-400 group-hover:text-blue-400" />
                                  </div>
                                  <div>
                                    <p className="font-black group-hover:text-blue-400 transition-colors">{emp.name}</p>
                                    <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider">{emp.role}</p>
                                  </div>
                                </div>
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-1.5 bg-white/5 px-3 py-1.5 rounded-xl border border-white/5">
                                    <Star className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
                                    <span className="text-xs font-black text-gray-300">{emp.rating}</span>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => addEmployeeToProject(emp)}
                                    className="bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-black uppercase tracking-widest px-5 py-2.5 rounded-xl transition-all active:scale-95 shadow-lg shadow-blue-600/20"
                                  >
                                    Добавить
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : teamMembers.length === 0 ? (
                        <p className="text-sm text-gray-500 text-center py-6">В штате пока никого нет — добавьте сотрудников во вкладке «Сотрудники».</p>
                      ) : null}
                    </div>
                  );
                })()}

                {/* Functional Plaques (Instead of Notes) */}
                {!isCPCompleted && (
                  <div className="p-8 bg-blue-50 border-2 border-dashed border-blue-200 rounded-[2.5rem] flex items-center justify-between animate-in fade-in slide-in-from-bottom-4 duration-500 shadow-lg shadow-blue-100/50">
                    <div className="flex items-center gap-6">
                      <div className="w-16 h-16 bg-blue-100 rounded-[1.5rem] flex items-center justify-center shadow-inner">
                        <ClipboardList className="w-8 h-8 text-blue-600" />
                      </div>
                      <div>
                        <h4 className="text-xl font-black text-blue-900">Коммерческое предложение</h4>
                        <p className="text-blue-700/70 text-sm font-bold uppercase tracking-wider mt-1">Ожидается прикрепление КП в формате DOCX</p>
                      </div>
                    </div>
                    <button 
                      onClick={() => document.getElementById('file-upload-cp')?.click()}
                      className="bg-blue-600 hover:bg-blue-700 text-white px-8 py-4 rounded-2xl font-black text-sm transition-all shadow-xl shadow-blue-600/30 flex items-center gap-3 active:scale-95"
                    >
                      <UploadCloud className="w-5 h-5" /> Прикрепить DOCX
                    </button>
                    <input 
                      id="file-upload-cp"
                      type="file"
                      className="hidden"
                      accept=".docx"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        const stageId = selectedProject.stages.find(s => s.name === 'Коммерческое предложение')?.id;
                        if (file && stageId) handleFileUpload(selectedProject.id, stageId, file);
                      }}
                    />
                  </div>
                )}

                {isCPCompleted && !isContractSigned && (
                  <div className="p-8 bg-amber-50 border-2 border-dashed border-amber-200 rounded-[2.5rem] flex items-center justify-between animate-in fade-in slide-in-from-bottom-4 duration-500 shadow-lg shadow-amber-100/50">
                    <div className="flex items-center gap-6">
                      <div className="w-16 h-16 bg-amber-100 rounded-[1.5rem] flex items-center justify-center shadow-inner">
                        <FileText className="w-8 h-8 text-amber-600" />
                      </div>
                      <div>
                        <h4 className="text-xl font-black text-amber-900">Заключение договора</h4>
                        <p className="text-amber-700/70 text-sm font-bold uppercase tracking-wider mt-1">Ожидается прикрепление договора в формате PDF</p>
                      </div>
                    </div>
                    <button 
                      onClick={() => document.getElementById('file-upload-contract')?.click()}
                      className="bg-amber-600 hover:bg-amber-700 text-white px-8 py-4 rounded-2xl font-black text-sm transition-all shadow-xl shadow-amber-600/30 flex items-center gap-3 active:scale-95"
                    >
                      <UploadCloud className="w-5 h-5" /> Прикрепить PDF
                    </button>
                    <input 
                      id="file-upload-contract"
                      type="file"
                      className="hidden"
                      accept=".pdf"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        const stageId = selectedProject.stages.find(s => s.name === 'Заключение договора')?.id;
                        if (file && stageId) handleFileUpload(selectedProject.id, stageId, file);
                      }}
                    />
                  </div>
                )}
              </div>

              <div className="space-y-8">
                <div className="bg-white rounded-[2.5rem] p-8 border border-gray-100 shadow-lg shadow-gray-200/50">
                  <h3 className="text-lg font-black text-[#0F172A] mb-6">Сводка по времени</h3>
                  <div className="space-y-4">
                    <div className="p-5 bg-gray-50 rounded-2xl flex items-center justify-between">
                      <span className="text-xs font-bold text-gray-400 uppercase">Старт</span>
                      <span className="font-black text-gray-700">{format(new Date(selectedProject.createdAt), 'dd.MM.yyyy')}</span>
                    </div>
                    <div className="p-5 bg-gray-50 rounded-2xl flex items-center justify-between group">
                      <span className="text-xs font-bold text-gray-400 uppercase">Финиш</span>
                      {isEditingProjectDeadline ? (
                        <div className="flex items-center gap-2">
                          <input 
                            type="date"
                            autoFocus
                            value={tempProjectDeadline}
                            onChange={(e) => setTempProjectDeadline(e.target.value)}
                            className="bg-white border border-blue-500 rounded-lg px-2 py-1 text-sm font-black text-gray-700 outline-none"
                          />
                          <button onClick={updateProjectDeadline} className="p-1 bg-emerald-500 text-white rounded-md hover:bg-emerald-600">
                            <Save className="w-4 h-4" />
                          </button>
                          <button onClick={() => setIsEditingProjectDeadline(false)} className="p-1 bg-rose-500 text-white rounded-md hover:bg-rose-600">
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-3">
                          <span className="font-black text-gray-700">{format(new Date(selectedProject.deadlineDate), 'dd.MM.yyyy')}</span>
                          <button 
                            onClick={() => {
                              setTempProjectDeadline(format(new Date(selectedProject.deadlineDate), 'yyyy-MM-dd'));
                              setIsEditingProjectDeadline(true);
                            }}
                            className="p-1.5 bg-white rounded-lg hover:bg-gray-100 transition-all opacity-0 group-hover:opacity-100"
                          >
                            <Edit3 className="w-3.5 h-3.5 text-gray-400" />
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="p-6 bg-blue-600 rounded-2xl text-white shadow-lg shadow-blue-500/30 text-center">
                      <span className="text-[10px] font-black uppercase tracking-widest block mb-2 opacity-70">Осталось до сдачи</span>
                      <span className="text-2xl font-black italic">{getRemainingTimeDisplay(selectedProject.deadlineDate)}</span>
                    </div>
                  </div>
                </div>

                {selectedProject.status === 'completed' ? (
                  <button
                    onClick={reopenProject}
                    className="w-full bg-gray-200 hover:bg-gray-300 text-gray-700 py-6 rounded-[2rem] font-black transition-all active:scale-95 flex items-center justify-center gap-3"
                  >
                    <ArrowLeft className="w-6 h-6" /> Возобновить проект
                  </button>
                ) : (
                  <button
                    onClick={completeProject}
                    className="w-full bg-emerald-500 hover:bg-emerald-600 text-white py-6 rounded-[2rem] font-black transition-all active:scale-95 shadow-xl shadow-emerald-500/20 flex items-center justify-center gap-3"
                  >
                    <CheckCircle className="w-6 h-6" /> Завершить проект
                  </button>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-[#F8FAFC] text-[#1E293B] font-['Inter',sans-serif]">
      {/* Sidebar */}
      <aside className="w-72 bg-[#0F172A] text-white flex flex-col shadow-2xl z-20">
        <div className="p-8 flex items-center gap-4">
          <div className="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-500/30">
            <Briefcase className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-extrabold tracking-tight">CRM.Alpha</h1>
            <p className="text-[10px] text-blue-400 font-bold uppercase tracking-[0.2em]">Management</p>
          </div>
        </div>

        <nav className="flex-1 px-4 space-y-1.5 mt-6">
          <button 
            onClick={() => { setActiveTab('projects'); setSelectedProject(null); setSelectedWorkProject(null); setSelectedSupport(null); }}
            className={`w-full flex items-center gap-3 px-5 py-3.5 rounded-2xl font-semibold transition-all ${
              activeTab === 'projects' ? 'bg-blue-600/10 text-blue-400' : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
            }`}
          >
            <LayoutGrid className="w-5 h-5" /> Проекты
          </button>
          <button 
            onClick={() => { setActiveTab('work'); setSelectedProject(null); setSelectedWorkProject(null); setSelectedSupport(null); }}
            className={`w-full flex items-center gap-3 px-5 py-3.5 rounded-2xl font-semibold transition-all ${
              activeTab === 'work' ? 'bg-indigo-500/15 text-indigo-300' : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
            }`}
          >
            <FolderKanban className="w-5 h-5" /> В работе
          </button>
          <button 
            onClick={() => { setActiveTab('support'); setSelectedProject(null); setSelectedWorkProject(null); setSelectedSupport(null); }}
            className={`w-full flex items-center gap-3 px-5 py-3.5 rounded-2xl font-semibold transition-all ${
              activeTab === 'support' ? 'bg-teal-500/15 text-teal-300' : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
            }`}
          >
            <LifeBuoy className="w-5 h-5" /> Сопровождение
          </button>
          <button 
            onClick={() => { setActiveTab('employees'); setSelectedProject(null); setSelectedWorkProject(null); setSelectedSupport(null); }}
            className={`w-full flex items-center gap-3 px-5 py-3.5 rounded-2xl font-semibold transition-all ${
              activeTab === 'employees' ? 'bg-blue-600/10 text-blue-400' : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
            }`}
          >
            <User className="w-5 h-5" /> Сотрудники
          </button>
          <button 
            onClick={() => { setActiveTab('leads'); setSelectedProject(null); setSelectedWorkProject(null); setSelectedSupport(null); }}
            className={`w-full flex items-center gap-3 px-5 py-3.5 rounded-2xl font-semibold transition-all ${
              activeTab === 'leads' ? 'bg-blue-600/10 text-blue-400' : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
            }`}
          >
            <Users className="w-5 h-5" /> Лиды
          </button>
          <button 
            onClick={() => { setActiveTab('logs'); setSelectedProject(null); setSelectedWorkProject(null); setSelectedSupport(null); }}
            className={`w-full flex items-center gap-3 px-5 py-3.5 rounded-2xl font-semibold transition-all ${
              activeTab === 'logs' ? 'bg-blue-600/10 text-blue-400' : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
            }`}
          >
            <Activity className="w-5 h-5" /> Логи
          </button>
          <button 
            onClick={() => { setActiveTab('tasks'); setSelectedProject(null); setSelectedWorkProject(null); setSelectedSupport(null); }}
            className={`w-full flex items-center gap-3 px-5 py-3.5 rounded-2xl font-semibold transition-all ${
              activeTab === 'tasks' ? 'bg-blue-600/10 text-blue-400' : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
            }`}
          >
            <List className="w-5 h-5" /> Задачи
          </button>
          <button
            onClick={() => { setActiveTab('finance'); setSelectedProject(null); setSelectedWorkProject(null); setSelectedSupport(null); }}
            className={`w-full flex items-center gap-3 px-5 py-3.5 rounded-2xl font-semibold transition-all ${
              activeTab === 'finance' ? 'bg-yellow-500/10 text-yellow-400' : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
            }`}
          >
            <Wallet className="w-5 h-5" /> Финансы
          </button>
          <button
            onClick={() => { setActiveTab('traffic'); setSelectedProject(null); setSelectedWorkProject(null); setSelectedSupport(null); }}
            className={`w-full flex items-center gap-3 px-5 py-3.5 rounded-2xl font-semibold transition-all ${
              activeTab === 'traffic' ? 'bg-emerald-500/10 text-emerald-400' : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
            }`}
          >
            <TrendingUp className="w-5 h-5" /> ТрафикТам
          </button>
        </nav>

        <div className="p-6 mt-auto border-t border-gray-800/50 flex items-center gap-4 bg-gray-900/50">
          <div className="w-11 h-11 bg-gray-700 rounded-2xl flex items-center justify-center ring-2 ring-gray-800">
            <User className="w-6 h-6 text-gray-300" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-bold">Admin User</span>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
              <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">
                {isElectron() ? 'Desktop' : isCloudSyncEnabled() ? 'Облако + кэш' : 'Локально'}
              </span>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto flex flex-col relative">
        <header className="bg-white/80 backdrop-blur-md border-b border-gray-200/60 px-10 py-5 flex items-center justify-between sticky top-0 z-10 shadow-sm">
          <div className="relative w-[450px]">
            <Search className="w-5 h-5 absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
            <input 
              type="text" 
              placeholder={
                activeTab === 'projects'
                  ? 'Поиск по активным проектам...'
                  : activeTab === 'work'
                    ? 'Поиск по заказам и заказчикам...'
                    : activeTab === 'support'
                      ? 'Поиск по сопровождению и контрагентам...'
                      : activeTab === 'employees'
                      ? 'Поиск по специалистам...'
                      : 'Поиск...'
              }
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-gray-100/50 border border-transparent rounded-2xl pl-12 pr-5 py-3 focus:bg-white focus:border-blue-500/5 focus:ring-4 focus:ring-blue-500/5 transition-all outline-none text-sm font-medium"
            />
          </div>
          <div className="flex items-center gap-5">
            <button className="p-3 text-gray-500 hover:bg-gray-100 rounded-2xl relative transition-all active:scale-95">
              <Bell className="w-5 h-5" />
              <span className="absolute top-3 right-3 w-2.5 h-2.5 bg-red-500 rounded-full border-2 border-white"></span>
            </button>
            <button className="p-3 text-gray-500 hover:bg-gray-100 rounded-2xl transition-all active:scale-95">
              <Settings className="w-5 h-5" />
            </button>
          </div>
        </header>

        {activeTab === 'projects' ? (
          <div className="p-10 max-w-7xl mx-auto w-full">
            <div className="flex justify-between items-end mb-10">
              <div>
                <h1 className="text-3xl font-black text-[#0F172A] tracking-tight">Управление проектами</h1>
                <p className="text-gray-500 font-medium mt-1.5">Мониторинг дедлайнов и финансовых показателей</p>
              </div>
              <div className="flex bg-gray-100 p-1.5 rounded-2xl border border-gray-200/50 shadow-inner">
                <button 
                  onClick={() => setView('grid')}
                  className={`px-4 py-2 rounded-xl transition-all font-bold text-xs flex items-center gap-2 ${view === 'grid' ? 'bg-white text-blue-600 shadow-md' : 'text-gray-400'}`}
                >
                  <LayoutGrid className="w-4 h-4" /> Сетка
                </button>
                <button 
                  onClick={() => setView('list')}
                  className={`px-4 py-2 rounded-xl transition-all font-bold text-xs flex items-center gap-2 ${view === 'list' ? 'bg-white text-blue-600 shadow-md' : 'text-gray-400'}`}
                >
                  <List className="w-4 h-4" /> Список
                </button>
              </div>
            </div>

            {/* Financial Summary Strip */}
            {(() => {
              const mn = new Date();
              const mStart = new Date(mn.getFullYear(), mn.getMonth(), 1);
              const monthProjects = projects.filter(p => new Date(p.createdAt) >= mStart);
              const monthRevenue = monthProjects.reduce((s, p) => s + (p.price || 0), 0);
              const completedAll = projects.filter(p => p.status === 'completed');
              const activeAll = projects.filter(p => p.status === 'active');
              const receivedProfit = completedAll.reduce((s, p) => {
                const c = projectPayrollCost(p);
                return s + p.price - c - Math.round(p.price * 0.13);
              }, 0);
              const activeExpected = activeAll.reduce((s, p) => {
                const c = projectPayrollCost(p);
                return s + p.price - c - Math.round(p.price * 0.13);
              }, 0);
              const fmt2 = (n: number) => n >= 1000000 ? `${(n/1000000).toFixed(1)}М` : n >= 1000 ? `${(n/1000).toFixed(0)}К` : n.toString();
              return (
                <div className="grid grid-cols-4 gap-4 mb-8">
                  <div className="rounded-[1.5rem] p-5" style={{ background: '#FFDD2D' }}>
                    <div className="text-[10px] font-black uppercase tracking-widest mb-2" style={{ color: '#1C1C1E80' }}>Текущий месяц</div>
                    <div className="text-2xl font-black" style={{ color: '#1C1C1E' }}>{fmt2(monthRevenue)} ₽</div>
                    <div className="text-xs font-semibold mt-1" style={{ color: '#1C1C1E60' }}>{monthProjects.length} проект{monthProjects.length === 1 ? '' : monthProjects.length < 5 ? 'а' : 'ов'}</div>
                  </div>
                  <div className="bg-white rounded-[1.5rem] p-5 border border-gray-200/60 shadow-sm">
                    <div className="text-[10px] font-black uppercase tracking-widest mb-2 text-gray-400">Полученная прибыль</div>
                    <div className="text-2xl font-black" style={{ color: receivedProfit >= 0 ? '#00B956' : '#F52222' }}>{receivedProfit >= 0 ? '+' : ''}{fmt2(receivedProfit)} ₽</div>
                    <div className="text-xs font-semibold mt-1 text-gray-400">{completedAll.length} завершено</div>
                  </div>
                  <div className="bg-white rounded-[1.5rem] p-5 border border-gray-200/60 shadow-sm">
                    <div className="text-[10px] font-black uppercase tracking-widest mb-2 text-gray-400">Прибыль в работе</div>
                    <div className="text-2xl font-black" style={{ color: '#6366F1' }}>{activeExpected >= 0 ? '+' : ''}{fmt2(activeExpected)} ₽</div>
                    <div className="text-xs font-semibold mt-1 text-gray-400">{activeAll.length} активных</div>
                  </div>
                  <div className="bg-white rounded-[1.5rem] p-5 border border-gray-200/60 shadow-sm">
                    <div className="text-[10px] font-black uppercase tracking-widest mb-2 text-gray-400">Всего проектов</div>
                    <div className="text-2xl font-black text-gray-800">{projects.length}</div>
                    <div className="flex items-center gap-2 mt-2">
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: '#E8F9F0', color: '#00B956' }}>{completedAll.length} готово</span>
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: '#EEF2FF', color: '#6366F1' }}>{activeAll.length} активно</span>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* New Project Form */}
            <section className="bg-white rounded-[2rem] border border-gray-200/60 p-8 mb-12 shadow-xl shadow-gray-200/40">
              <form onSubmit={addProject} className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-5 gap-6 items-end">
                  <div className="md:col-span-2">
                    <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3 ml-1">Название проекта</label>
                    <input
                      type="text"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="Напр. Дизайн-система"
                      className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all font-medium"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3 ml-1">Стоимость (₽)</label>
                    <input
                      type="text"
                      value={priceInput}
                      onChange={handlePriceChange}
                      placeholder="0"
                      className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all font-medium"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3 ml-1">Срок выполнения (дней)</label>
                    <input
                      type="number"
                      value={days}
                      onChange={(e) => setDays(e.target.value)}
                      className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all font-medium"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3 ml-1">Лид (опционально)</label>
                    <select
                      value={selectedLead?.id || ''}
                      onChange={(e) => { const lead = leads.find(l => l.id === e.target.value); setSelectedLead(lead || null); }}
                      className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all font-medium"
                    >
                      <option value="">Без лида</option>
                      {leads.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-5 gap-6 items-end">
                  <div className="md:col-span-2">
                    <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3 ml-1">Источник трафика</label>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => setSelectedSource('')}
                        className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all border ${!selectedSource ? 'bg-gray-800 text-white border-gray-800' : 'bg-gray-50 text-gray-400 border-gray-200 hover:border-gray-300'}`}
                      >Не указан</button>
                      {TRAFFIC_SOURCES.map(s => (
                        <button key={s.key} type="button" onClick={() => setSelectedSource(s.key)}
                          className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all border flex items-center gap-1.5 ${selectedSource === s.key ? 'text-white border-transparent' : 'bg-gray-50 border-gray-200 hover:border-gray-300'}`}
                          style={selectedSource === s.key ? { background: s.color, borderColor: s.color } : { color: s.color }}
                        >
                          <s.Icon className="w-3.5 h-3.5" />{s.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="md:col-span-3 flex justify-end">
                    <button
                      type="submit"
                      className="bg-blue-600 hover:bg-blue-700 active:scale-95 text-white font-bold px-10 py-4 rounded-2xl flex items-center justify-center gap-2.5 transition-all shadow-lg shadow-blue-500/25 group"
                    >
                      <Plus className="w-5 h-5 group-hover:rotate-90 transition-transform duration-300" /> Создать проект
                    </button>
                  </div>
                </div>
              </form>
            </section>

            {/* Projects View */}
            <div className={view === 'grid' ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8" : "space-y-5"}>
              {filteredProjects.length === 0 ? (
                <div className="col-span-full py-24 text-center bg-gray-50 rounded-[2.5rem] border-2 border-dashed border-gray-200 flex flex-col items-center justify-center">
                  <div className="w-20 h-20 bg-gray-100 rounded-3xl flex items-center justify-center mb-6">
                    <AlertCircle className="w-10 h-10 text-gray-300" />
                  </div>
                  <h3 className="text-xl font-bold text-gray-400">Список проектов пуст</h3>
                  <p className="text-gray-400 text-sm mt-1">Добавьте свой первый проект, используя форму выше</p>
                </div>
              ) : (
                filteredProjects.map(p => (
                  <div 
                    key={p.id} 
                    onClick={() => { setSelectedWorkProject(null); setSelectedSupport(null); setSelectedProject(p); }}
                    className={`bg-white rounded-[2rem] border border-gray-200/70 p-7 shadow-lg shadow-gray-200/40 hover:shadow-2xl hover:shadow-gray-300/50 transition-all group relative overflow-hidden cursor-pointer ${view === 'list' ? 'flex items-center justify-between py-6' : ''}`}
                  >
                    <div className={view === 'list' ? 'flex items-center gap-10 flex-1' : ''}>
                      <div className="flex items-center justify-between mb-6">
                        <div className={`px-4 py-1.5 rounded-xl text-[10px] font-black tracking-widest uppercase border ${
                          p.status === 'completed'
                            ? 'bg-emerald-50 text-emerald-600 border-emerald-100'
                            : p.status === 'overdue'
                              ? 'bg-rose-50 text-rose-600 border-rose-100'
                              : getStatusStyle(p.deadlineDate)
                        }`}>
                          {p.status === 'completed' ? 'ЗАВЕРШЁН' : p.status === 'overdue' ? 'ПРОСРОЧЕНО' : 'В ПРОЦЕССЕ'}
                        </div>
                        {view === 'grid' && (
                          <button 
                            onClick={(e) => { e.stopPropagation(); deleteProject(p.id); }}
                            className="opacity-0 group-hover:opacity-100 p-2 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all active:scale-90"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                      
                      <h3 className="text-xl font-extrabold text-[#0F172A] mb-3 group-hover:text-blue-600 transition-colors line-clamp-1">{p.title}</h3>
                      {projectHasTeam(p) ? (
                        <div className={`flex items-start gap-2 text-sm text-gray-600 ${view === 'list' ? 'mb-3 max-w-md' : 'mb-4'}`}>
                          <Users className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
                          <div className="min-w-0">
                            <span className="text-[9px] font-black text-gray-400 uppercase tracking-widest block mb-0.5">Команда</span>
                            <span className="font-semibold line-clamp-2">{projectTeamNames(p, employees) || '—'}</span>
                          </div>
                        </div>
                      ) : null}
                      
                      <div className={`grid grid-cols-2 gap-6 ${view === 'list' ? 'flex-1 mb-0' : 'mb-8'}`}>
                        <div className="flex flex-col">
                          <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1">Бюджет</span>
                          <div className="flex items-center gap-2 text-gray-700">
                            <Wallet className="w-4 h-4 text-emerald-500" />
                            <span className="font-bold">{p.price.toLocaleString()} ₽</span>
                          </div>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1">Дедлайн</span>
                          <div className="flex items-center gap-2 text-gray-700">
                            <Clock className="w-4 h-4 text-blue-500" />
                            <span className="font-bold">{getRemainingTimeDisplay(p.deadlineDate)}</span>
                          </div>
                        </div>
                      </div>

                      <div className={`pt-6 border-t border-gray-100 flex items-center justify-between ${view === 'list' ? 'pt-0 border-t-0 ml-auto' : ''}`}>
                        <div className="flex flex-col">
                          <span className="text-[9px] font-black text-gray-400 uppercase tracking-[0.2em] mb-1.5">Статус времени</span>
                          <div className="flex items-center gap-3">
                            <span className="text-sm font-black text-blue-600 bg-blue-50 px-3 py-1 rounded-lg border border-blue-100 italic">
                              {getRemainingTimeDisplay(p.deadlineDate)}
                            </span>
                          </div>
                        </div>
                        <div className="w-10 h-10 bg-gray-50 rounded-xl flex items-center justify-center group-hover:bg-blue-600 group-hover:text-white transition-all shadow-inner">
                          <ChevronRight className="w-5 h-5" />
                        </div>
                      </div>
                    </div>
                    {view === 'list' && (
                      <button 
                        onClick={(e) => { e.stopPropagation(); deleteProject(p.id); }}
                        className="ml-8 p-3 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-2xl transition-all active:scale-90"
                      >
                        <Trash2 className="w-5 h-5" />
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        ) : activeTab === 'work' ? (
          <div className="p-10 max-w-7xl mx-auto w-full">
            <div className="mb-10 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h1 className="text-3xl font-black text-[#0F172A] tracking-tight">В работе</h1>
                <p className="text-gray-500 font-medium mt-1.5 max-w-2xl">
                  Заказы с названием, ценой и заказчиком. Данные пишутся на диск и в Electron — не пропадут при перезапуске.
                </p>
              </div>
              <div className="rounded-[1.5rem] border border-indigo-100 bg-gradient-to-br from-indigo-50 to-white px-8 py-5 shadow-lg shadow-indigo-100/60 shrink-0">
                <div className="text-[10px] font-black uppercase tracking-[0.2em] text-indigo-500/80 mb-1">Сумма всех заказов</div>
                <div className="text-3xl font-black text-indigo-700 tabular-nums">
                  {workProjects.reduce((s, w) => s + (Number(w.price) || 0), 0).toLocaleString('ru-RU')} ₽
                </div>
                <div className="text-xs font-semibold text-gray-500 mt-1">
                  {(() => {
                    const n = workProjects.length;
                    const w =
                      n % 10 === 1 && n % 100 !== 11
                        ? 'проект'
                        : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)
                          ? 'проекта'
                          : 'проектов';
                    return `${n} ${w}`;
                  })()}
                </div>
              </div>
            </div>

            <section className="bg-white rounded-[2rem] border border-gray-200/60 p-8 mb-12 shadow-xl shadow-gray-200/40">
              <form onSubmit={addWorkProject} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-6 items-end">
                <div className="lg:col-span-2">
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3 ml-1">Название</label>
                  <input
                    type="text"
                    value={wpTitle}
                    onChange={(e) => setWpTitle(e.target.value)}
                    placeholder="Например: Лендинг для салона"
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 font-medium"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3 ml-1">Цена (₽)</label>
                  <input
                    type="text"
                    value={wpPrice}
                    onChange={(e) => setWpPrice(formatNumber(e.target.value))}
                    placeholder="0"
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 font-medium"
                  />
                </div>
                <div className="lg:col-span-2">
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3 ml-1">Заказчик</label>
                  <input
                    type="text"
                    value={wpCustomer}
                    onChange={(e) => setWpCustomer(e.target.value)}
                    placeholder="Имя или компания"
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 font-medium"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3 ml-1">Срок (дней)</label>
                  <input
                    type="number"
                    min={1}
                    value={wpDays}
                    onChange={(e) => setWpDays(e.target.value)}
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 font-medium"
                  />
                </div>
                <div className="lg:col-span-6 flex justify-end">
                  <button
                    type="submit"
                    className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-10 py-4 rounded-2xl flex items-center gap-2 shadow-lg shadow-indigo-500/25 transition-all active:scale-95"
                  >
                    <Plus className="w-5 h-5" /> Добавить в работу
                  </button>
                </div>
              </form>
            </section>

            <p className="text-xs font-semibold text-gray-500 mb-4 flex items-center gap-2">
              <GripVertical className="w-4 h-4 text-indigo-400 shrink-0" />
              Перетащите карточку за ручку слева — остальные сдвигаются, порядок сохраняется.
            </p>

            <div
              className={`grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 ${draggingWorkId ? 'relative' : ''}`}
              onDragLeave={(e) => {
                if (!draggingWorkId) return;
                if (e.currentTarget === e.target) lastOverWorkIdRef.current = null;
              }}
            >
              {filteredWorkProjects.length === 0 ? (
                <div className="col-span-full py-20 text-center bg-gray-50 rounded-[2.5rem] border-2 border-dashed border-gray-200">
                  <FolderKanban className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                  <h3 className="text-lg font-bold text-gray-400">Пока нет заказов</h3>
                  <p className="text-gray-400 text-sm mt-1">Создайте первый через форму выше</p>
                </div>
              ) : (
                filteredWorkProjects.map((item) => (
                  <div
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      if (!draggingWorkId || draggingWorkId === item.id) return;
                      if (lastOverWorkIdRef.current === item.id) return;
                      lastOverWorkIdRef.current = item.id;
                      reorderWorkProjects(draggingWorkId, item.id);
                    }}
                    onClick={() => {
                      if (suppressWorkCardClickRef.current) return;
                      setSelectedProject(null);
                      setSelectedSupport(null);
                      setSelectedWorkProject(item);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedProject(null);
                        setSelectedWorkProject(item);
                      }
                    }}
                    className={`bg-white rounded-[2rem] border border-gray-200/70 p-7 pl-14 shadow-lg shadow-gray-200/40 hover:shadow-2xl hover:border-indigo-200 transition-[transform,opacity,box-shadow,border-color] duration-200 cursor-pointer text-left group relative ${
                      draggingWorkId === item.id ? 'opacity-70 ring-2 ring-indigo-400 ring-offset-2 scale-[0.99] z-10' : ''
                    }`}
                  >
                    <div
                      role="presentation"
                      draggable
                      onDragStart={(e) => {
                        lastOverWorkIdRef.current = null;
                        setDraggingWorkId(item.id);
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', item.id);
                      }}
                      onDragEnd={() => {
                        lastOverWorkIdRef.current = null;
                        setDraggingWorkId(null);
                        suppressWorkCardClickRef.current = true;
                        window.requestAnimationFrame(() => {
                          window.requestAnimationFrame(() => {
                            suppressWorkCardClickRef.current = false;
                          });
                        });
                      }}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                      className="absolute left-3 top-1/2 -translate-y-1/2 p-2 rounded-xl text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 cursor-grab active:cursor-grabbing touch-none"
                      title="Переместить"
                      aria-label="Переместить карточку"
                    >
                      <GripVertical className="w-5 h-5" />
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteWorkProject(item.id);
                      }}
                      className="absolute top-5 right-5 p-2 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-xl opacity-0 group-hover:opacity-100 transition-all"
                      title="Удалить"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                    <div className={`inline-block px-3 py-1 rounded-lg text-[9px] font-black uppercase tracking-wider border mb-4 ${getStatusStyle(item.deadlineDate)}`}>
                      {isPast(new Date(item.deadlineDate)) ? 'Дедлайн' : 'Активно'}
                    </div>
                    <h3 className="text-xl font-extrabold text-[#0F172A] mb-3 group-hover:text-indigo-600 transition-colors line-clamp-2">{item.title}</h3>
                    <div className="space-y-3 text-sm">
                      <div className="flex items-center gap-2 text-gray-600">
                        <UserCircle className="w-4 h-4 text-indigo-500 shrink-0" />
                        <span className="font-semibold truncate">{item.customer || '—'}</span>
                      </div>
                      <div className="flex items-center gap-2 text-gray-600">
                        <Wallet className="w-4 h-4 text-emerald-500 shrink-0" />
                        <span className="font-bold">{item.price.toLocaleString()} ₽</span>
                      </div>
                      <div className="flex items-center gap-2 text-gray-600">
                        <Clock className="w-4 h-4 text-blue-500 shrink-0" />
                        <span className="font-medium">{getRemainingTimeDisplay(item.deadlineDate)}</span>
                      </div>
                    </div>
                    {item.currentStage.trim() ? (
                      <p className="mt-4 text-xs text-gray-500 line-clamp-2 border-t border-gray-100 pt-4">{item.currentStage}</p>
                    ) : null}
                    <div className="mt-6 flex justify-end">
                      <span className="w-10 h-10 bg-gray-50 rounded-xl flex items-center justify-center group-hover:bg-indigo-600 group-hover:text-white transition-all">
                        <ChevronRight className="w-5 h-5" />
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : activeTab === 'support' ? (
          <div className="p-10 max-w-7xl mx-auto w-full">
            <div className="mb-10 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h1 className="text-3xl font-black text-[#0F172A] tracking-tight">Сопровождение</h1>
                <p className="text-gray-500 font-medium mt-1.5 max-w-2xl">
                  Договоры на сопровождение: контрагент, реквизиты, график оплат и прикреплённый договор.
                </p>
              </div>
              <div className="rounded-[1.5rem] border border-teal-100 bg-gradient-to-br from-teal-50 to-white px-8 py-5 shadow-lg shadow-teal-100/60 shrink-0">
                <div className="text-[10px] font-black uppercase tracking-[0.2em] text-teal-500/80 mb-1">Сумма всех договоров</div>
                <div className="text-3xl font-black text-teal-700 tabular-nums">
                  {supportRecords.reduce((sum, r) => sum + (Number(r.price) || 0), 0).toLocaleString('ru-RU')} ₽
                </div>
                <div className="text-xs font-semibold text-gray-500 mt-1">
                  {(() => {
                    const n = supportRecords.length;
                    const w =
                      n % 10 === 1 && n % 100 !== 11
                        ? 'договор'
                        : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)
                          ? 'договора'
                          : 'договоров';
                    return `${n} ${w}`;
                  })()}
                </div>
              </div>
            </div>

            <section className="bg-white rounded-[2rem] border border-gray-200/60 p-8 mb-12 shadow-xl shadow-gray-200/40">
              <form onSubmit={addSupportRecord} className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="md:col-span-2">
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3 ml-1">Название / тип сопровождения *</label>
                  <input
                    type="text"
                    value={supTitle}
                    onChange={(e) => setSupTitle(e.target.value)}
                    placeholder="Например: Техподдержка сайта"
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-teal-500 focus:ring-4 focus:ring-teal-500/10 font-medium"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3 ml-1">Контрагент</label>
                  <input
                    type="text"
                    value={supCounterpartyName}
                    onChange={(e) => setSupCounterpartyName(e.target.value)}
                    placeholder="ООО или ФИО"
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-teal-500 focus:ring-4 focus:ring-teal-500/10 font-medium"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3 ml-1">Цена (₽) / мес.</label>
                  <input
                    type="text"
                    value={supPrice}
                    onChange={(e) => setSupPrice(formatNumber(e.target.value))}
                    placeholder="0"
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-teal-500 focus:ring-4 focus:ring-teal-500/10 font-medium"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3 ml-1">Срок (мес.)</label>
                  <input
                    type="number"
                    min={1}
                    value={supDurationMonths}
                    onChange={(e) => setSupDurationMonths(e.target.value)}
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-teal-500 focus:ring-4 focus:ring-teal-500/10 font-medium"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3 ml-1">Начало договора</label>
                  <input
                    type="date"
                    value={supStartDate}
                    onChange={(e) => setSupStartDate(e.target.value)}
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-teal-500 focus:ring-4 focus:ring-teal-500/10 font-medium"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3 ml-1">Реквизиты контрагента</label>
                  <textarea
                    value={supCounterpartyDetails}
                    onChange={(e) => setSupCounterpartyDetails(e.target.value)}
                    rows={3}
                    placeholder="ИНН, счёт, банк…"
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-teal-500 focus:ring-4 focus:ring-teal-500/10 font-medium resize-y"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3 ml-1">Что входит в сопровождение</label>
                  <textarea
                    value={supDescription}
                    onChange={(e) => setSupDescription(e.target.value)}
                    rows={3}
                    placeholder="Обновления, мониторинг, правки…"
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-teal-500 focus:ring-4 focus:ring-teal-500/10 font-medium resize-y"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3 ml-1">Комментарий</label>
                  <textarea
                    value={supComment}
                    onChange={(e) => setSupComment(e.target.value)}
                    rows={2}
                    placeholder="Внутренние заметки"
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-teal-500 focus:ring-4 focus:ring-teal-500/10 font-medium resize-y"
                  />
                </div>
                <div className="md:col-span-2 flex justify-end">
                  <button
                    type="submit"
                    className="bg-teal-600 hover:bg-teal-700 text-white font-bold px-10 py-4 rounded-2xl flex items-center gap-2 shadow-lg shadow-teal-500/25 transition-all active:scale-95"
                  >
                    <Plus className="w-5 h-5" /> Создать сопровождение
                  </button>
                </div>
              </form>
            </section>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
              {filteredSupportRecords.length === 0 ? (
                <div className="col-span-full py-20 text-center bg-gray-50 rounded-[2.5rem] border-2 border-dashed border-gray-200">
                  <LifeBuoy className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                  <h3 className="text-lg font-bold text-gray-400">Пока нет сопровождений</h3>
                  <p className="text-gray-400 text-sm mt-1">Создайте первое через форму выше</p>
                </div>
              ) : (
                filteredSupportRecords.map((item) => {
                  const paymentEv = item.calendarEvents.filter(e => e.type === 'payment');
                  const paidCount = paymentEv.filter(p => p.isPaid).length;
                  const totalPayments = paymentEv.length;
                  const monthsLabel = item.contractDurationMonths
                    ? `${item.contractDurationMonths} мес.`
                    : null;
                  return (
                    <div
                      key={item.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        setSelectedProject(null);
                        setSelectedWorkProject(null);
                        setSelectedSupport(item);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelectedProject(null);
                          setSelectedWorkProject(null);
                          setSelectedSupport(item);
                        }
                      }}
                      className="bg-white rounded-[2rem] border border-gray-200/70 p-7 shadow-lg shadow-gray-200/40 hover:shadow-2xl hover:border-teal-200 transition-all cursor-pointer text-left group relative"
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteSupportRecord(item.id);
                        }}
                        className="absolute top-5 right-5 p-2 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-xl opacity-0 group-hover:opacity-100 transition-all"
                        title="Удалить"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                      <div className="inline-flex items-center gap-2 px-3 py-1 rounded-lg text-[9px] font-black uppercase tracking-wider border mb-4 bg-teal-50 text-teal-600 border-teal-100">
                        <LifeBuoy className="w-3 h-3" /> Сопровождение
                      </div>
                      <h3 className="text-xl font-extrabold text-[#0F172A] mb-3 group-hover:text-teal-600 transition-colors line-clamp-2 pr-8">
                        {item.title}
                      </h3>
                      <div className="space-y-3 text-sm">
                        <div className="flex items-center gap-2 text-gray-600">
                          <UserCircle className="w-4 h-4 text-teal-500 shrink-0" />
                          <span className="font-semibold truncate">{item.counterpartyName || '—'}</span>
                        </div>
                        <div className="flex items-center gap-2 text-gray-600">
                          <Wallet className="w-4 h-4 text-emerald-500 shrink-0" />
                          <span className="font-bold">
                            {item.price.toLocaleString('ru-RU')} ₽
                            {monthsLabel && (
                              <span className="text-gray-400 font-semibold ml-1">/ {monthsLabel}</span>
                            )}
                          </span>
                        </div>
                        {totalPayments > 0 && (
                          <div className="flex items-center gap-2 text-gray-600">
                            <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0" />
                            <span className="font-medium">
                              Оплаты: {paidCount}/{totalPayments}
                            </span>
                          </div>
                        )}
                        {item.contract && (
                          <div className="flex items-center gap-2 text-gray-600">
                            <Paperclip className="w-4 h-4 text-teal-500 shrink-0" />
                            <span className="font-medium truncate">{item.contract.name}</span>
                          </div>
                        )}
                      </div>
                      {item.description.trim() ? (
                        <p className="mt-4 text-xs text-gray-500 line-clamp-2 border-t border-gray-100 pt-4">{item.description}</p>
                      ) : null}
                      <div className="mt-6 flex justify-end">
                        <span className="w-10 h-10 bg-gray-50 rounded-xl flex items-center justify-center group-hover:bg-teal-600 group-hover:text-white transition-all">
                          <ChevronRight className="w-5 h-5" />
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        ) : activeTab === 'employees' ? (
          <div className="p-10 max-w-7xl mx-auto w-full">
            <div className="flex justify-between items-end mb-10">
              <div>
                <h1 className="text-3xl font-black text-[#0F172A] tracking-tight">Управление командой</h1>
                <p className="text-gray-500 font-medium mt-1.5">Всего специалистов в штате: {employees.length}</p>
              </div>
            </div>

            <section className="bg-white rounded-[2rem] border border-gray-200/60 p-8 mb-12 shadow-xl shadow-gray-200/40">
              <form onSubmit={addEmployee} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-6 items-end">
                <div className="lg:col-span-2">
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3 ml-1">Имя сотрудника</label>
                  <input 
                    type="text" 
                    value={empName}
                    onChange={(e) => setEmpName(e.target.value)}
                    placeholder="Напр. Артем Волков"
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all font-medium"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3 ml-1">Роль</label>
                  <input 
                    type="text" 
                    value={empRole}
                    onChange={(e) => setEmpRole(e.target.value)}
                    placeholder="Разработчик"
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all font-medium"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3 ml-1">Рейтинг</label>
                  <input 
                    type="text" 
                    value={empRating}
                    onChange={(e) => setEmpRating(e.target.value)}
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all font-medium"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3 ml-1">Ставка (₽)</label>
                  <input 
                    type="text" 
                    value={empRate}
                    onChange={(e) => setEmpRate(formatNumber(e.target.value))}
                    placeholder="0"
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all font-medium"
                  />
                </div>
                <button 
                  type="submit"
                  className="bg-blue-600 hover:bg-blue-700 active:scale-95 text-white font-bold py-4 rounded-2xl flex items-center justify-center gap-2.5 transition-all shadow-lg shadow-blue-500/25 group"
                >
                  <Plus className="w-5 h-5 group-hover:rotate-90 transition-transform duration-300" /> Добавить
                </button>
              </form>
            </section>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
              {employees.filter(e => e.name.toLowerCase().includes(search.toLowerCase())).map(e => {
                const empProjects = projects.filter(p => (p.team ?? []).some(m => m.employeeId === e.id));
                const isEditing = employeeEditId === e.id;
                return (
                  <div 
                    key={e.id}
                    className="bg-white rounded-[2.5rem] p-8 border border-gray-100 shadow-lg shadow-gray-200/40 hover:shadow-2xl transition-all group text-left relative"
                  >
                    {!isEditing ? (
                      <>
                        <div className="w-20 h-20 bg-gray-50 rounded-3xl mb-6 flex items-center justify-center ring-4 ring-gray-50 group-hover:ring-blue-50 transition-all shadow-inner">
                          <User className="w-10 h-10 text-gray-300 group-hover:text-blue-400 transition-colors" />
                        </div>
                        <h3 className="text-xl font-black text-[#0F172A] mb-1">{e.name}</h3>
                        <p className="text-xs font-bold text-blue-500 uppercase tracking-widest mb-3">{e.role}</p>
                        <div className="flex flex-wrap items-center gap-3 mb-4">
                          <div className="flex items-center gap-2 bg-gray-50 py-2 px-4 rounded-xl">
                            <Star className="w-4 h-4 text-amber-400 fill-amber-400" />
                            <span className="font-black text-sm text-gray-700">{e.rating}</span>
                          </div>
                          <div className="flex items-center gap-2 bg-emerald-50 py-2 px-4 rounded-xl border border-emerald-100">
                            <Wallet className="w-4 h-4 text-emerald-600" />
                            <span className="font-black text-sm text-emerald-800">{e.rate.toLocaleString()} ₽</span>
                          </div>
                        </div>
                        <div className="border-t border-gray-100 pt-4 mb-4">
                          <span className="text-[9px] font-black text-gray-400 uppercase tracking-widest">Проекты</span>
                          {empProjects.length === 0 ? (
                            <p className="text-sm text-gray-400 mt-2">Не назначен ни на один проект</p>
                          ) : (
                            <ul className="mt-2 space-y-2">
                              {empProjects.map(p => {
                                const pr = (p.team ?? []).find(m => m.employeeId === e.id)?.projectRate ?? 0;
                                return (
                                  <li key={p.id}>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setSelectedWorkProject(null);
                                        setSelectedSupport(null);
                                        setActiveTab('projects');
                                        setSelectedProject(p);
                                      }}
                                      className="text-sm font-bold text-blue-600 hover:underline text-left w-full truncate"
                                    >
                                      {p.title}
                                    </button>
                                    <span className="text-xs text-gray-400 block">
                                      {pr.toLocaleString()} ₽ на проекте
                                    </span>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </div>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setEmployeeEditId(e.id);
                              setEditEmpName(e.name);
                              setEditEmpRole(e.role);
                              setEditEmpRating(String(e.rating));
                              setEditEmpRate(e.rate ? formatNumber(e.rate.toString()) : '');
                            }}
                            className="flex-1 py-3 rounded-xl bg-gray-100 hover:bg-gray-200 text-sm font-bold text-gray-800 transition-colors"
                          >
                            Изменить
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (confirm(`Удалить сотрудника «${e.name}»? Он будет снят со всех проектов.`)) deleteEmployee(e.id);
                            }}
                            className="py-3 px-4 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-600 transition-colors"
                            title="Удалить"
                          >
                            <Trash2 className="w-5 h-5" />
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="space-y-4">
                        <h4 className="font-black text-gray-800">Редактирование</h4>
                        <div>
                          <label className="block text-[10px] font-black text-gray-400 uppercase mb-1">Имя</label>
                          <input
                            type="text"
                            value={editEmpName}
                            onChange={(ev) => setEditEmpName(ev.target.value)}
                            className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 font-medium outline-none focus:border-blue-500"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-black text-gray-400 uppercase mb-1">Роль</label>
                          <input
                            type="text"
                            value={editEmpRole}
                            onChange={(ev) => setEditEmpRole(ev.target.value)}
                            className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 font-medium outline-none focus:border-blue-500"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-[10px] font-black text-gray-400 uppercase mb-1">Рейтинг</label>
                            <input
                              type="text"
                              value={editEmpRating}
                              onChange={(ev) => setEditEmpRating(ev.target.value)}
                              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 font-medium outline-none focus:border-blue-500"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] font-black text-gray-400 uppercase mb-1">Ставка ₽</label>
                            <input
                              type="text"
                              value={editEmpRate}
                              onChange={(ev) => setEditEmpRate(formatNumber(ev.target.value))}
                              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 font-medium outline-none focus:border-blue-500"
                            />
                          </div>
                        </div>
                        <div className="flex gap-2 pt-2">
                          <button
                            type="button"
                            onClick={saveEmployeeEdit}
                            className="flex-1 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm"
                          >
                            Сохранить
                          </button>
                          <button
                            type="button"
                            onClick={() => setEmployeeEditId(null)}
                            className="py-3 px-4 rounded-xl bg-gray-100 font-bold text-sm text-gray-700"
                          >
                            Отмена
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : activeTab === 'leads' ? (
          <div className="p-10 max-w-7xl mx-auto w-full">
            <div className="flex justify-between items-end mb-10">
              <div>
                <h1 className="text-3xl font-black text-[#0F172A] tracking-tight">Управление лидами</h1>
                <p className="text-gray-500 font-medium mt-1.5">Потенциальные клиенты и запросы</p>
              </div>
              <button 
                onClick={() => setIsAddingLead(!isAddingLead)}
                className="bg-blue-600 hover:bg-blue-700 active:scale-95 text-white font-bold px-6 py-3.5 rounded-2xl flex items-center gap-2.5 transition-all shadow-lg shadow-blue-500/25 group"
              >
                <UserPlus className="w-5 h-5" /> {isAddingLead ? 'Закрыть' : 'Новый лид'}
              </button>
            </div>

            {isAddingLead && (
              <section className="bg-white rounded-[2rem] border border-gray-200/60 p-8 mb-12 shadow-xl shadow-gray-200/40 animate-in fade-in slide-in-from-top-4 duration-300">
                <form onSubmit={addLead} className="grid grid-cols-1 md:grid-cols-3 gap-8 items-start">
                  <div>
                    <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3 ml-1">Имя клиента</label>
                    <input 
                      type="text" 
                      value={newLead.name}
                      onChange={(e) => setNewLead({...newLead, name: e.target.value})}
                      placeholder="Иван Иванов"
                      className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all font-medium"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3 ml-1">Телефон</label>
                    <input 
                      type="tel" 
                      value={newLead.phone}
                      onChange={(e) => setNewLead({...newLead, phone: formatPhoneRu(e.target.value)})}
                      placeholder="+7 (999) 919-62-61"
                      className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all font-medium"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3 ml-1">Бюджет (₽)</label>
                    <input 
                      type="text" 
                      value={newLead.budget ? formatNumber(newLead.budget.toString()) : ''}
                      onChange={(e) => setNewLead({...newLead, budget: parseFloat(e.target.value.replace(/\s/g, '')) || 0})}
                      placeholder="0"
                      className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all font-medium"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3 ml-1">Тип продукта</label>
                    <div className="flex gap-2">
                      <button 
                        type="button"
                        onClick={() => setNewLead({...newLead, productType: 'Site'})}
                        className={`flex-1 py-3 rounded-xl font-bold text-sm transition-all border ${newLead.productType === 'Site' ? 'bg-blue-600 text-white border-blue-600' : 'bg-gray-50 text-gray-400 border-gray-200'}`}
                      >
                        Сайт
                      </button>
                      <button 
                        type="button"
                        onClick={() => setNewLead({...newLead, productType: 'Mobile'})}
                        className={`flex-1 py-3 rounded-xl font-bold text-sm transition-all border ${newLead.productType === 'Mobile' ? 'bg-blue-600 text-white border-blue-600' : 'bg-gray-50 text-gray-400 border-gray-200'}`}
                      >
                        Приложение
                      </button>
                    </div>
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3 ml-1">Заметки</label>
                    <textarea 
                      value={newLead.notes}
                      onChange={(e) => setNewLead({...newLead, notes: e.target.value})}
                      placeholder="Особенности проекта, пожелания..."
                      className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 outline-none focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all font-medium h-[4.5rem] resize-none"
                    />
                  </div>
                  <div className="md:col-span-3">
                    <button 
                      type="submit"
                      className="w-full bg-blue-600 hover:bg-blue-700 active:scale-95 text-white font-bold py-4 rounded-2xl flex items-center justify-center gap-2.5 transition-all shadow-lg shadow-blue-500/25 group"
                    >
                      <Plus className="w-5 h-5 group-hover:rotate-90 transition-transform duration-300" /> Добавить лида
                    </button>
                  </div>
                </form>
              </section>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
              {leads.filter(l => l.name.toLowerCase().includes(search.toLowerCase())).map(l => (
                <div 
                  key={l.id}
                  className="bg-white rounded-[2rem] border border-gray-200/70 p-7 shadow-lg shadow-gray-200/40 hover:shadow-2xl transition-all group"
                >
                  <div className="flex justify-between items-start mb-6">
                    <div className="w-14 h-14 bg-blue-50 rounded-2xl flex items-center justify-center text-blue-600">
                      <UserCircle className="w-8 h-8" />
                    </div>
                    <div className="flex gap-2">
                      <button 
                        onClick={() => {
                          setTitle(l.name);
                          setPriceInput(formatNumber(l.budget.toString()));
                          setSelectedLead(l);
                          setSelectedWorkProject(null);
                          setSelectedSupport(null);
                          setActiveTab('projects');
                        }}
                        className="p-2 text-gray-300 hover:text-blue-500 hover:bg-blue-50 rounded-xl transition-all"
                        title="Создать проект"
                      >
                        <Briefcase className="w-5 h-5" />
                      </button>
                      <button 
                        onClick={() => deleteLead(l.id)}
                        className="p-2 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all"
                      >
                        <Trash2 className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                  <h3 className="text-xl font-black text-[#0F172A] mb-1">{l.name}</h3>
                  <div className="flex items-center gap-2 text-gray-500 text-sm font-medium mb-4">
                    <Phone className="w-3.5 h-3.5" /> {displayPhone(l.phone)}
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4 mb-6">
                    <div className="bg-gray-50 p-3 rounded-2xl">
                      <span className="text-[9px] font-black text-gray-400 uppercase block mb-1">Бюджет</span>
                      <span className="text-sm font-black text-emerald-600">{l.budget.toLocaleString()} ₽</span>
                    </div>
                    <div className="bg-gray-50 p-3 rounded-2xl">
                      <span className="text-[9px] font-black text-gray-400 uppercase block mb-1">Продукт</span>
                      <span className="text-sm font-black text-blue-600">{l.productType === 'Site' ? 'Сайт' : 'Приложение'}</span>
                    </div>
                  </div>

                  {l.notes && (
                    <div className="pt-4 border-t border-gray-50">
                      <span className="text-[9px] font-black text-gray-400 uppercase block mb-2">Заметки</span>
                      <p className="text-xs text-gray-500 line-clamp-2 italic">"{l.notes}"</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : activeTab === 'logs' ? (
          <div className="p-10 max-w-7xl mx-auto w-full">
            <div className="mb-10">
              <h1 className="text-3xl font-black text-[#0F172A] tracking-tight">История действий</h1>
              <p className="text-gray-500 font-medium mt-1.5">Логирование системных событий и изменений</p>
            </div>

            <div className="bg-white rounded-[2.5rem] border border-gray-200/60 shadow-xl shadow-gray-200/40 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-100">
                      <th className="px-8 py-5 text-[10px] font-black text-gray-400 uppercase tracking-widest">Действие</th>
                      <th className="px-8 py-5 text-[10px] font-black text-gray-400 uppercase tracking-widest">Подробности</th>
                      <th className="px-8 py-5 text-[10px] font-black text-gray-400 uppercase tracking-widest">Время</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {logs.map(log => (
                      <tr key={log.id} className="hover:bg-gray-50/50 transition-colors">
                        <td className="px-8 py-5">
                          <span className="inline-flex items-center px-3 py-1 rounded-lg bg-blue-50 text-blue-600 text-xs font-black">
                            {log.action}
                          </span>
                        </td>
                        <td className="px-8 py-5 text-sm font-medium text-gray-600">{log.details}</td>
                        <td className="px-8 py-5 text-sm font-bold text-gray-400">
                          {format(new Date(log.timestamp), 'HH:mm:ss')}
                          <span className="block text-[10px] opacity-60 font-medium">{format(new Date(log.timestamp), 'dd.MM.yyyy')}</span>
                        </td>
                      </tr>
                    ))}
                    {logs.length === 0 && (
                      <tr>
                        <td colSpan={3} className="px-8 py-20 text-center text-gray-400 font-bold">
                          Логов пока нет
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : activeTab === 'tasks' ? (
          <div className="p-10 max-w-4xl mx-auto w-full">
            <div className="mb-10 text-center">
              <h1 className="text-4xl font-black text-[#0F172A] tracking-tight mb-3">Список задач</h1>
              <p className="text-gray-500 font-medium">Планируйте дела и перемещайте их для расстановки приоритетов</p>
            </div>

            <section className="bg-white rounded-[2rem] border border-gray-200/60 p-6 mb-10 shadow-xl shadow-gray-200/40">
              <form onSubmit={addTask} className="flex gap-4">
                <input 
                  type="text" 
                  value={newTaskContent}
                  onChange={(e) => setNewTaskContent(e.target.value)}
                  placeholder="Что нужно сделать?"
                  className="flex-1 bg-gray-50 border border-gray-200 rounded-2xl px-6 py-4 outline-none focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all font-medium text-lg"
                />
                <button 
                  type="submit"
                  className="bg-blue-600 hover:bg-blue-700 active:scale-95 text-white font-bold px-8 rounded-2xl flex items-center justify-center gap-2.5 transition-all shadow-lg shadow-blue-500/25 group"
                >
                  <Plus className="w-6 h-6 group-hover:rotate-90 transition-transform duration-300" />
                </button>
              </form>
            </section>

            <div className="space-y-4">
              {tasks.length === 0 ? (
                <div className="py-20 text-center bg-gray-50 rounded-[2.5rem] border-2 border-dashed border-gray-200 flex flex-col items-center justify-center">
                  <div className="w-20 h-20 bg-gray-100 rounded-3xl flex items-center justify-center mb-6">
                    <ClipboardList className="w-10 h-10 text-gray-300" />
                  </div>
                  <h3 className="text-xl font-bold text-gray-400">Список задач пуст</h3>
                  <p className="text-gray-400 text-sm mt-1">Добавьте первую задачу в поле выше</p>
                </div>
              ) : (
                tasks.map((task, index) => (
                  <div 
                    key={task.id}
                    draggable
                    onDragStart={(e) => handleTaskDragStart(e, index)}
                    onDragOver={(e) => handleTaskDragOver(e, index)}
                    onDrop={handleTaskDrop}
                    onDragEnd={() => setDraggedTaskIndex(null)}
                    className={`bg-white rounded-2xl border border-gray-200/70 p-5 shadow-sm hover:shadow-md transition-all flex items-center gap-4 group cursor-move ${task.isCompleted ? 'opacity-60' : ''} ${draggedTaskIndex === index ? 'opacity-20 scale-95 border-blue-400 border-2' : ''}`}
                  >
                    <button 
                      onClick={() => toggleTask(task.id)}
                      className={`w-7 h-7 rounded-lg border-2 flex items-center justify-center transition-all ${task.isCompleted ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-gray-200 hover:border-blue-400'}`}
                    >
                      {task.isCompleted && <CheckCircle className="w-4 h-4" />}
                    </button>
                    
                    <span className={`flex-1 font-bold text-gray-700 transition-all ${task.isCompleted ? 'line-through text-gray-400' : ''}`}>
                      {task.content}
                    </span>

                    <button 
                      onClick={() => deleteTask(task.id)}
                      className="opacity-0 group-hover:opacity-100 p-2 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all"
                    >
                      <Trash2 className="w-5 h-5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : activeTab === 'finance' ? (() => {
          // --- Period filter logic ---
          const now2 = new Date();
          const periodStart = (() => {
            if (financePeriod === 'week') { const d = new Date(now2); d.setDate(d.getDate() - 7); return d; }
            if (financePeriod === 'month') { const d = new Date(now2); d.setMonth(d.getMonth() - 1); return d; }
            if (financePeriod === 'quarter') { const d = new Date(now2); d.setMonth(d.getMonth() - 3); return d; }
            if (financePeriod === 'year') { const d = new Date(now2); d.setFullYear(d.getFullYear() - 1); return d; }
            return null;
          })();
          const filteredProjects = projects.filter(p => {
            if (!periodStart) return true;
            return new Date(p.createdAt) >= periodStart;
          });
          const completedProjects = filteredProjects.filter(p => p.status === 'completed');
          const activeProjects = filteredProjects.filter(p => p.status === 'active');
          const overdueProjects = filteredProjects.filter(p => p.status === 'overdue');
          const revenue = filteredProjects.reduce((s, p) => s + (p.price || 0), 0);
          const completedRevenue = completedProjects.reduce((s, p) => s + (p.price || 0), 0);
          const activeRevenue = activeProjects.reduce((s, p) => s + (p.price || 0), 0);
          const devCosts = filteredProjects.reduce((s, p) => s + projectPayrollCost(p), 0);
          const overhead = Math.round(revenue * 0.08);
          const marketing = Math.round(revenue * 0.05);
          const totalExpenses = devCosts + overhead + marketing;
          const netProfit = revenue - totalExpenses;
          const margin = revenue > 0 ? Math.round((netProfit / revenue) * 100) : 0;
          const avgProjectValue = filteredProjects.length > 0 ? Math.round(revenue / filteredProjects.length) : 0;

          // --- Monthly bar data (last 6 months) ---
          const barMonths: { label: string; rev: number; exp: number; profit: number }[] = [];
          for (let i = 5; i >= 0; i--) {
            const d = new Date(now2);
            d.setMonth(d.getMonth() - i);
            const label = d.toLocaleString('ru', { month: 'short' });
            const monthStart = new Date(d.getFullYear(), d.getMonth(), 1);
            const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59);
            const mProjects = projects.filter(p => { const cd = new Date(p.createdAt); return cd >= monthStart && cd <= monthEnd; });
            const mRev = mProjects.reduce((s, p) => s + (p.price || 0), 0);
            const mExp = mProjects.reduce((s, p) => s + projectPayrollCost(p), 0) + Math.round(mRev * 0.13);
            barMonths.push({ label, rev: mRev, exp: mExp, profit: mRev - mExp });
          }
          const maxBarVal = Math.max(...barMonths.map(m => Math.max(m.rev, m.exp)), 1);

          // --- Transactions sorted ---
          const transactions = [...filteredProjects]
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

          const fmt = (n: number) => n.toLocaleString('ru-RU');

          const sectionTabs = [
            { key: 'overview' as const, label: 'Обзор' },
            { key: 'income' as const, label: 'Доходы' },
            { key: 'expenses' as const, label: 'Расходы' },
            { key: 'operations' as const, label: 'Деятельность' },
          ];

          return (
            <div className="flex-1 overflow-y-auto" style={{ background: '#F6F7F8' }}>
              <div className="px-10 py-8 max-w-6xl mx-auto w-full">

                {/* Header */}
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <h1 className="text-3xl font-black tracking-tight" style={{ color: '#1C1C1E' }}>Финансы</h1>
                    <p className="text-sm font-medium mt-1" style={{ color: '#999999' }}>Доходы, расходы и чистая прибыль по проектам</p>
                  </div>
                  <div className="flex items-center gap-1 p-1 rounded-2xl bg-white shadow-sm border border-gray-100">
                    {(['week','month','quarter','year','all'] as const).map(p => (
                      <button key={p} onClick={() => setFinancePeriod(p)}
                        className="px-4 py-2 rounded-xl text-xs font-bold transition-all"
                        style={financePeriod === p ? { background: '#FFDD2D', color: '#1C1C1E' } : { color: '#999999' }}
                      >
                        {{ week: 'Неделя', month: 'Месяц', quarter: 'Квартал', year: 'Год', all: 'Всё время' }[p]}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Section tabs */}
                <div className="flex gap-1 mb-6 p-1 bg-white rounded-2xl border border-gray-100 shadow-sm w-fit">
                  {sectionTabs.map(s => (
                    <button key={s.key} onClick={() => setFinanceSection(s.key)}
                      className="px-5 py-2.5 rounded-xl text-sm font-bold transition-all"
                      style={financeSection === s.key
                        ? { background: '#1C1C1E', color: '#FFFFFF' }
                        : { color: '#999999' }
                      }
                    >
                      {s.label}
                    </button>
                  ))}
                </div>

                {/* ===== ОБЗОР ===== */}
                {financeSection === 'overview' && (
                  <>
                    <div className="grid grid-cols-4 gap-4 mb-6">
                      <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100">
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-xs font-bold uppercase tracking-widest" style={{ color: '#999999' }}>Выручка</span>
                          <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: '#E8F9F0' }}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" stroke="#00B956" strokeWidth="2" strokeLinecap="round"/></svg>
                          </div>
                        </div>
                        <div className="text-2xl font-black mb-1" style={{ color: '#1C1C1E' }}>{fmt(revenue)} ₽</div>
                        <div className="text-xs font-medium" style={{ color: '#00B956' }}>↑ {filteredProjects.length} проект{filteredProjects.length === 1 ? '' : filteredProjects.length < 5 ? 'а' : 'ов'}</div>
                      </div>
                      <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100">
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-xs font-bold uppercase tracking-widest" style={{ color: '#999999' }}>Расходы</span>
                          <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: '#FEF0F0' }}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M3 12h18M3 6h18M3 18h18" stroke="#F52222" strokeWidth="2" strokeLinecap="round"/></svg>
                          </div>
                        </div>
                        <div className="text-2xl font-black mb-1" style={{ color: '#1C1C1E' }}>{fmt(totalExpenses)} ₽</div>
                        <div className="text-xs font-medium" style={{ color: '#F52222' }}>↓ {revenue > 0 ? Math.round((totalExpenses/revenue)*100) : 0}% от выручки</div>
                      </div>
                      <div className="rounded-3xl p-6 shadow-sm" style={{ background: '#FFDD2D' }}>
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-xs font-bold uppercase tracking-widest" style={{ color: '#1C1C1E80' }}>Чистая прибыль</span>
                          <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.08)' }}>
                            <Wallet className="w-4 h-4" style={{ color: '#1C1C1E' }} />
                          </div>
                        </div>
                        <div className="text-2xl font-black mb-1" style={{ color: '#1C1C1E' }}>{fmt(netProfit)} ₽</div>
                        <div className="text-xs font-bold" style={{ color: '#1C1C1E80' }}>Маржа {margin}%</div>
                      </div>
                      <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100">
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-xs font-bold uppercase tracking-widest" style={{ color: '#999999' }}>Средний чек</span>
                          <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: '#EEF2FF' }}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M22 12h-4l-3 9L9 3l-3 9H2" stroke="#6366F1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          </div>
                        </div>
                        <div className="text-2xl font-black mb-1" style={{ color: '#1C1C1E' }}>{fmt(avgProjectValue)} ₽</div>
                        <div className="flex items-center gap-2 mt-2">
                          <div className="flex-1 h-1.5 rounded-full" style={{ background: '#F0F0F0' }}>
                            <div className="h-1.5 rounded-full" style={{ width: `${Math.max(0, Math.min(100, margin))}%`, background: margin >= 30 ? '#00B956' : margin >= 10 ? '#FFDD2D' : '#F52222' }} />
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-6">
                      <div className="col-span-2 bg-white rounded-3xl p-6 shadow-sm border border-gray-100">
                        <div className="flex items-center justify-between mb-6">
                          <h2 className="text-base font-black" style={{ color: '#1C1C1E' }}>Динамика за 6 месяцев</h2>
                          <div className="flex items-center gap-4 text-xs font-semibold" style={{ color: '#999999' }}>
                            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm inline-block" style={{ background: '#FFDD2D' }}></span>Выручка</span>
                            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm inline-block" style={{ background: '#1C1C1E' }}></span>Расходы</span>
                          </div>
                        </div>
                        <div className="flex items-end gap-3 h-40">
                          {barMonths.map((m, i) => (
                            <div key={i} className="flex-1 flex flex-col items-center gap-1">
                              <div className="w-full flex items-end gap-0.5 h-32">
                                <div className="flex-1 rounded-t-lg transition-all" style={{ height: `${(m.rev / maxBarVal) * 100}%`, background: '#FFDD2D', minHeight: m.rev > 0 ? 4 : 0 }} title={`Выручка: ${fmt(m.rev)} ₽`} />
                                <div className="flex-1 rounded-t-lg transition-all" style={{ height: `${(m.exp / maxBarVal) * 100}%`, background: '#1C1C1E', minHeight: m.exp > 0 ? 4 : 0 }} title={`Расходы: ${fmt(m.exp)} ₽`} />
                              </div>
                              <span className="text-[10px] font-bold uppercase" style={{ color: '#999999' }}>{m.label}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100">
                        <h2 className="text-base font-black mb-5" style={{ color: '#1C1C1E' }}>Статус проектов</h2>
                        <div className="space-y-4">
                          {[
                            { label: 'Завершены', count: completedProjects.length, value: completedRevenue, color: '#00B956', bg: '#E8F9F0' },
                            { label: 'В работе', count: activeProjects.length, value: activeRevenue, color: '#6366F1', bg: '#EEF2FF' },
                            { label: 'Просрочены', count: overdueProjects.length, value: overdueProjects.reduce((s,p) => s+(p.price||0),0), color: '#F52222', bg: '#FEF0F0' },
                          ].map(item => (
                            <div key={item.label} className="flex items-center gap-3 p-3 rounded-2xl" style={{ background: item.bg }}>
                              <div className="w-2 h-8 rounded-full flex-shrink-0" style={{ background: item.color }} />
                              <div className="flex-1">
                                <div className="text-xs font-bold" style={{ color: '#1C1C1E' }}>{item.label}</div>
                                <div className="text-[10px] font-semibold" style={{ color: '#999999' }}>{item.count} проект{item.count === 1 ? '' : item.count < 5 ? 'а' : 'ов'}</div>
                              </div>
                              <div className="text-sm font-black" style={{ color: item.color }}>{fmt(item.value)} ₽</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {/* ===== ДОХОДЫ ===== */}
                {financeSection === 'income' && (
                  <>
                    <div className="grid grid-cols-3 gap-4 mb-6">
                      <div className="rounded-3xl p-6 shadow-sm" style={{ background: '#FFDD2D' }}>
                        <div className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: '#1C1C1E80' }}>Выручка всего</div>
                        <div className="text-3xl font-black mb-1" style={{ color: '#1C1C1E' }}>{fmt(revenue)} ₽</div>
                        <div className="text-xs font-bold" style={{ color: '#1C1C1E60' }}>{filteredProjects.length} проект{filteredProjects.length === 1 ? '' : filteredProjects.length < 5 ? 'а' : 'ов'}</div>
                      </div>
                      <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100">
                        <div className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: '#999999' }}>Получено (завершённые)</div>
                        <div className="text-3xl font-black mb-1" style={{ color: '#00B956' }}>{fmt(completedRevenue)} ₽</div>
                        <div className="text-xs font-semibold" style={{ color: '#999999' }}>{completedProjects.length} проект{completedProjects.length === 1 ? '' : completedProjects.length < 5 ? 'а' : 'ов'}</div>
                      </div>
                      <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100">
                        <div className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: '#999999' }}>Ожидается (в работе)</div>
                        <div className="text-3xl font-black mb-1" style={{ color: '#6366F1' }}>{fmt(activeRevenue)} ₽</div>
                        <div className="text-xs font-semibold" style={{ color: '#999999' }}>{activeProjects.length} проект{activeProjects.length === 1 ? '' : activeProjects.length < 5 ? 'а' : 'ов'}</div>
                      </div>
                    </div>

                    <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden mb-6">
                      <div className="px-6 py-5 border-b border-gray-50">
                        <h2 className="text-base font-black" style={{ color: '#1C1C1E' }}>Доходы по месяцам</h2>
                      </div>
                      <div className="p-6">
                        <div className="flex items-end gap-4 h-44">
                          {barMonths.map((m, i) => (
                            <div key={i} className="flex-1 flex flex-col items-center gap-2">
                              <div className="text-[10px] font-black" style={{ color: m.rev > 0 ? '#1C1C1E' : '#CCCCCC' }}>{m.rev > 0 ? fmt(m.rev) : '—'}</div>
                              <div className="w-full rounded-t-xl transition-all" style={{ height: `${(m.rev / maxBarVal) * 140}px`, background: i === 5 ? '#FFDD2D' : '#F0F0F0', minHeight: m.rev > 0 ? 8 : 2 }} />
                              <span className="text-[10px] font-bold uppercase" style={{ color: '#999999' }}>{m.label}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
                      <div className="px-6 py-5 border-b border-gray-50 flex items-center justify-between">
                        <h2 className="text-base font-black" style={{ color: '#1C1C1E' }}>Завершённые проекты</h2>
                        <span className="text-xs font-semibold px-3 py-1 rounded-full" style={{ background: '#E8F9F0', color: '#00B956' }}>{completedProjects.length} завершено</span>
                      </div>
                      {completedProjects.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12">
                          <p className="font-bold text-sm" style={{ color: '#999999' }}>Нет завершённых проектов за период</p>
                        </div>
                      ) : (
                        <div className="divide-y divide-gray-50">
                          {completedProjects.map(p => {
                            const cost = projectPayrollCost(p);
                            const profit = p.price - cost - Math.round(p.price * 0.13);
                            const teamLbl = projectTeamNames(p, employees);
                            return (
                              <div key={p.id} className="flex items-center gap-4 px-6 py-4 hover:bg-gray-50/50 transition-colors">
                                <div className="w-10 h-10 rounded-2xl flex items-center justify-center flex-shrink-0" style={{ background: '#E8F9F0' }}>
                                  <CheckCircle className="w-5 h-5" style={{ color: '#00B956' }} />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="font-bold text-sm truncate" style={{ color: '#1C1C1E' }}>{p.title}</div>
                                  <div className="text-xs font-medium mt-0.5" style={{ color: '#999999' }}>{format(new Date(p.createdAt), 'd MMM yyyy', { locale: ru })}{teamLbl ? ` · ${teamLbl}` : ''}</div>
                                </div>
                                <div className="text-right">
                                  <div className="text-sm font-black" style={{ color: '#00B956' }}>+{fmt(p.price)} ₽</div>
                                  <div className="text-xs font-semibold" style={{ color: '#999999' }}>выручка</div>
                                </div>
                                <div className="text-right w-28">
                                  <div className="text-sm font-black" style={{ color: profit >= 0 ? '#1C1C1E' : '#F52222' }}>{profit >= 0 ? '+' : ''}{fmt(profit)} ₽</div>
                                  <div className="text-[10px] font-semibold uppercase" style={{ color: '#999999' }}>прибыль</div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </>
                )}

                {/* ===== РАСХОДЫ ===== */}
                {financeSection === 'expenses' && (
                  <>
                    <div className="grid grid-cols-3 gap-4 mb-6">
                      <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100">
                        <div className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: '#999999' }}>Зарплаты разработчиков</div>
                        <div className="text-3xl font-black mb-1" style={{ color: '#6366F1' }}>{fmt(devCosts)} ₽</div>
                        <div className="text-xs font-semibold" style={{ color: '#999999' }}>{totalExpenses > 0 ? Math.round((devCosts/totalExpenses)*100) : 0}% от расходов</div>
                      </div>
                      <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100">
                        <div className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: '#999999' }}>Накладные расходы</div>
                        <div className="text-3xl font-black mb-1" style={{ color: '#F59E0B' }}>{fmt(overhead)} ₽</div>
                        <div className="text-xs font-semibold" style={{ color: '#999999' }}>8% от выручки</div>
                      </div>
                      <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100">
                        <div className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: '#999999' }}>Маркетинг</div>
                        <div className="text-3xl font-black mb-1" style={{ color: '#EC4899' }}>{fmt(marketing)} ₽</div>
                        <div className="text-xs font-semibold" style={{ color: '#999999' }}>5% от выручки</div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-6 mb-6">
                      <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100">
                        <h2 className="text-base font-black mb-5" style={{ color: '#1C1C1E' }}>Структура расходов</h2>
                        <div className="space-y-5">
                          {[
                            { label: 'Разработчики', value: devCosts, color: '#6366F1', pct: totalExpenses > 0 ? Math.round((devCosts/totalExpenses)*100) : 0 },
                            { label: 'Накладные', value: overhead, color: '#F59E0B', pct: totalExpenses > 0 ? Math.round((overhead/totalExpenses)*100) : 0 },
                            { label: 'Маркетинг', value: marketing, color: '#EC4899', pct: totalExpenses > 0 ? Math.round((marketing/totalExpenses)*100) : 0 },
                          ].map(item => (
                            <div key={item.label}>
                              <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2">
                                  <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: item.color }} />
                                  <span className="text-sm font-bold" style={{ color: '#1C1C1E' }}>{item.label}</span>
                                </div>
                                <div className="text-right">
                                  <span className="text-sm font-black" style={{ color: '#1C1C1E' }}>{fmt(item.value)} ₽</span>
                                  <span className="text-xs font-bold ml-2" style={{ color: '#999999' }}>{item.pct}%</span>
                                </div>
                              </div>
                              <div className="h-2.5 rounded-full" style={{ background: '#F0F0F0' }}>
                                <div className="h-2.5 rounded-full transition-all" style={{ width: `${item.pct}%`, background: item.color }} />
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="mt-6 pt-5 border-t border-gray-100 flex justify-between items-center">
                          <span className="text-sm font-bold" style={{ color: '#999999' }}>Итого расходов</span>
                          <span className="text-xl font-black" style={{ color: '#F52222' }}>{fmt(totalExpenses)} ₽</span>
                        </div>
                      </div>

                      <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100">
                        <h2 className="text-base font-black mb-5" style={{ color: '#1C1C1E' }}>Расходы по месяцам</h2>
                        <div className="flex items-end gap-3 h-44">
                          {barMonths.map((m, i) => (
                            <div key={i} className="flex-1 flex flex-col items-center gap-2">
                              <div className="text-[9px] font-black" style={{ color: m.exp > 0 ? '#F52222' : '#CCCCCC' }}>{m.exp > 0 ? fmt(m.exp) : '—'}</div>
                              <div className="w-full rounded-t-xl" style={{ height: `${(m.exp / maxBarVal) * 140}px`, background: i === 5 ? '#F52222' : '#FFCDD2', minHeight: m.exp > 0 ? 8 : 2 }} />
                              <span className="text-[10px] font-bold uppercase" style={{ color: '#999999' }}>{m.label}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
                      <div className="px-6 py-5 border-b border-gray-50 flex items-center justify-between">
                        <h2 className="text-base font-black" style={{ color: '#1C1C1E' }}>Расходы по проектам</h2>
                        <span className="text-xs font-semibold px-3 py-1 rounded-full" style={{ background: '#F6F7F8', color: '#999999' }}>{filteredProjects.filter(p => projectPayrollCost(p) > 0).length} с командой</span>
                      </div>
                      {filteredProjects.filter(p => projectPayrollCost(p) > 0).length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12">
                          <p className="font-bold text-sm" style={{ color: '#999999' }}>Нет проектов с назначенными исполнителями</p>
                        </div>
                      ) : (
                        <div className="divide-y divide-gray-50">
                          {filteredProjects.filter(p => projectPayrollCost(p) > 0).map(p => {
                            const cost = projectPayrollCost(p);
                            const oh = Math.round(p.price * 0.08);
                            const mk = Math.round(p.price * 0.05);
                            const total = cost + oh + mk;
                            return (
                              <div key={p.id} className="flex items-center gap-4 px-6 py-4 hover:bg-gray-50/50 transition-colors">
                                <div className="w-10 h-10 rounded-2xl flex items-center justify-center flex-shrink-0" style={{ background: '#FEF0F0' }}>
                                  <User className="w-5 h-5" style={{ color: '#F52222' }} />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="font-bold text-sm truncate" style={{ color: '#1C1C1E' }}>{p.title}</div>
                                  <div className="text-xs font-medium mt-0.5" style={{ color: '#999999' }}>{projectTeamNames(p, employees)} · {format(new Date(p.createdAt), 'd MMM yyyy', { locale: ru })}</div>
                                </div>
                                <div className="flex gap-4 text-right text-xs">
                                  <div><div className="font-black" style={{ color: '#6366F1' }}>{fmt(cost)} ₽</div><div style={{ color: '#999999' }}>разраб.</div></div>
                                  <div><div className="font-black" style={{ color: '#F59E0B' }}>{fmt(oh)} ₽</div><div style={{ color: '#999999' }}>наклад.</div></div>
                                  <div><div className="font-black" style={{ color: '#EC4899' }}>{fmt(mk)} ₽</div><div style={{ color: '#999999' }}>маркет.</div></div>
                                </div>
                                <div className="text-right w-28">
                                  <div className="text-sm font-black" style={{ color: '#F52222' }}>−{fmt(total)} ₽</div>
                                  <div className="text-[10px] font-semibold uppercase" style={{ color: '#999999' }}>итого</div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </>
                )}

                {/* ===== ОПЕРАЦИОННАЯ ДЕЯТЕЛЬНОСТЬ ===== */}
                {financeSection === 'operations' && (
                  <>
                    <div className="grid grid-cols-4 gap-4 mb-6">
                      {[
                        { label: 'Всего операций', value: filteredProjects.length, sub: 'проектов', color: '#1C1C1E', bg: '#FFDD2D' },
                        { label: 'Завершено', value: completedProjects.length, sub: `${fmt(completedRevenue)} ₽`, color: '#00B956', bg: '#E8F9F0' },
                        { label: 'В работе', value: activeProjects.length, sub: `${fmt(activeRevenue)} ₽`, color: '#6366F1', bg: '#EEF2FF' },
                        { label: 'Просрочено', value: overdueProjects.length, sub: `${fmt(overdueProjects.reduce((s,p)=>s+(p.price||0),0))} ₽`, color: '#F52222', bg: '#FEF0F0' },
                      ].map(item => (
                        <div key={item.label} className="rounded-3xl p-5 shadow-sm" style={{ background: item.bg }}>
                          <div className="text-xs font-bold uppercase tracking-widest mb-2" style={{ color: item.color + '99' }}>{item.label}</div>
                          <div className="text-3xl font-black mb-1" style={{ color: item.color }}>{item.value}</div>
                          <div className="text-xs font-semibold" style={{ color: item.color + '80' }}>{item.sub}</div>
                        </div>
                      ))}
                    </div>

                    <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
                      <div className="flex items-center justify-between px-6 py-5 border-b border-gray-50">
                        <h2 className="text-base font-black" style={{ color: '#1C1C1E' }}>Операционная деятельность</h2>
                        <span className="text-xs font-semibold px-3 py-1 rounded-full" style={{ background: '#F6F7F8', color: '#999999' }}>{transactions.length} записей</span>
                      </div>

                      {transactions.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-16">
                          <div className="w-16 h-16 rounded-3xl flex items-center justify-center mb-4" style={{ background: '#F6F7F8' }}>
                            <Wallet className="w-8 h-8" style={{ color: '#CCCCCC' }} />
                          </div>
                          <p className="font-bold text-sm" style={{ color: '#999999' }}>Нет данных за выбранный период</p>
                        </div>
                      ) : (
                        <div className="divide-y divide-gray-50">
                          {transactions.map(p => {
                            const cost = projectPayrollCost(p);
                            const teamLbl = projectTeamNames(p, employees);
                            const oh = Math.round(p.price * 0.08);
                            const mk = Math.round(p.price * 0.05);
                            const profit = p.price - cost - oh - mk;
                            const isCompleted = p.status === 'completed';
                            const isOverdue = p.status === 'overdue';
                            return (
                              <div key={p.id} className="flex items-center gap-4 px-6 py-4 hover:bg-gray-50/50 transition-colors">
                                <div className="w-10 h-10 rounded-2xl flex items-center justify-center flex-shrink-0"
                                  style={{ background: isCompleted ? '#E8F9F0' : isOverdue ? '#FEF0F0' : '#EEF2FF' }}>
                                  <Briefcase className="w-5 h-5" style={{ color: isCompleted ? '#00B956' : isOverdue ? '#F52222' : '#6366F1' }} />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="font-bold text-sm truncate" style={{ color: '#1C1C1E' }}>{p.title}</div>
                                  <div className="text-xs font-medium mt-0.5" style={{ color: '#999999' }}>
                                    {format(new Date(p.createdAt), 'd MMM yyyy', { locale: ru })}
                                    {teamLbl ? <span className="ml-2">· {teamLbl}</span> : null}
                                  </div>
                                </div>
                                <div className="flex gap-5 text-right text-xs">
                                  <div><div className="font-black" style={{ color: '#00B956' }}>+{fmt(p.price)} ₽</div><div style={{ color: '#999999' }}>выручка</div></div>
                                  {cost > 0 && <div><div className="font-black" style={{ color: '#F52222' }}>−{fmt(cost)} ₽</div><div style={{ color: '#999999' }}>разраб.</div></div>}
                                  <div><div className="font-black" style={{ color: '#F59E0B' }}>−{fmt(oh+mk)} ₽</div><div style={{ color: '#999999' }}>прочие</div></div>
                                </div>
                                <div className="text-right w-28">
                                  <div className="text-sm font-black" style={{ color: profit >= 0 ? '#1C1C1E' : '#F52222' }}>{profit >= 0 ? '+' : ''}{fmt(profit)} ₽</div>
                                  <div className="text-[10px] font-semibold uppercase" style={{ color: '#999999' }}>прибыль</div>
                                </div>
                                <div className="flex-shrink-0">
                                  <span className="text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wide"
                                    style={isCompleted ? { background: '#E8F9F0', color: '#00B956' } : isOverdue ? { background: '#FEF0F0', color: '#F52222' } : { background: '#EEF2FF', color: '#6366F1' }}
                                  >
                                    {isCompleted ? 'Завершён' : isOverdue ? 'Просрочен' : 'Активен'}
                                  </span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </>
                )}

              </div>
            </div>
          );
        })() : activeTab === 'traffic' ? (() => {
          const now3 = new Date();
          const tStart = (() => {
            if (trafficPeriod === 'week') { const d = new Date(now3); d.setDate(d.getDate() - 7); return d; }
            if (trafficPeriod === 'month') { const d = new Date(now3); d.setMonth(d.getMonth() - 1); return d; }
            if (trafficPeriod === 'quarter') { const d = new Date(now3); d.setMonth(d.getMonth() - 3); return d; }
            if (trafficPeriod === 'year') { const d = new Date(now3); d.setFullYear(d.getFullYear() - 1); return d; }
            return null;
          })();
          const tProjects = projects.filter(p => !tStart || new Date(p.createdAt) >= tStart);
          const fmt3 = (n: number) => n.toLocaleString('ru-RU');
          const fmtShort = (n: number) => n >= 1000000 ? `${(n/1000000).toFixed(1)}М` : n >= 1000 ? `${(n/1000).toFixed(0)}К` : n.toString();

          const sourceStats = TRAFFIC_SOURCES.map(src => {
            const ps = tProjects.filter(p => p.source === src.key);
            const revenue = ps.reduce((s, p) => s + (p.price || 0), 0);
            const devCosts = ps.reduce((s, p) => s + projectPayrollCost(p), 0);
            const profit = revenue - devCosts - Math.round(revenue * 0.13);
            const completed = ps.filter(p => p.status === 'completed').length;
            const avgCheck = ps.length > 0 ? Math.round(revenue / ps.length) : 0;
            const convRate = ps.length > 0 ? Math.round((completed / ps.length) * 100) : 0;
            return { ...src, ps, count: ps.length, revenue, profit, completed, avgCheck, convRate };
          });

          const unknownProjects = tProjects.filter(p => !p.source);
          const totalRevenue = tProjects.reduce((s, p) => s + (p.price || 0), 0);
          const maxRevenue = Math.max(...sourceStats.map(s => s.revenue), 1);
          const best = sourceStats.reduce((a, b) => b.revenue > a.revenue ? b : a, sourceStats[0]);

          // Monthly trend per source (last 6 months)
          const trendMonths: { label: string; data: Record<string, number> }[] = [];
          for (let i = 5; i >= 0; i--) {
            const d = new Date(now3);
            d.setMonth(d.getMonth() - i);
            const label = d.toLocaleString('ru', { month: 'short' });
            const ms = new Date(d.getFullYear(), d.getMonth(), 1);
            const me = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59);
            const data: Record<string, number> = {};
            TRAFFIC_SOURCES.forEach(src => {
              const ps = projects.filter(p => p.source === src.key && new Date(p.createdAt) >= ms && new Date(p.createdAt) <= me);
              data[src.key] = ps.reduce((s, p) => s + (p.price || 0), 0);
            });
            trendMonths.push({ label, data });
          }
          const maxTrend = Math.max(...trendMonths.flatMap(m => Object.values(m.data)), 1);

          return (
            <div className="flex-1 overflow-y-auto" style={{ background: '#F6F7F8' }}>
              <div className="px-10 py-8 max-w-6xl mx-auto w-full">

                {/* Header */}
                <div className="flex items-center justify-between mb-8">
                  <div>
                    <div className="flex items-center gap-3 mb-1">
                      <div className="w-10 h-10 rounded-2xl flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #00B956 0%, #00D97E 100%)' }}>
                        <TrendingUp className="w-5 h-5 text-white" />
                      </div>
                      <h1 className="text-3xl font-black tracking-tight" style={{ color: '#1C1C1E' }}>ТрафикТам</h1>
                    </div>
                    <p className="text-sm font-medium ml-1" style={{ color: '#999999' }}>Эффективность источников трафика по проектам</p>
                  </div>
                  <div className="flex items-center gap-1 p-1 rounded-2xl bg-white shadow-sm border border-gray-100">
                    {(['week','month','quarter','year','all'] as const).map(p => (
                      <button key={p} onClick={() => setTrafficPeriod(p)}
                        className="px-4 py-2 rounded-xl text-xs font-bold transition-all"
                        style={trafficPeriod === p ? { background: '#00B956', color: '#fff' } : { color: '#999999' }}
                      >
                        {{ week: 'Неделя', month: 'Месяц', quarter: 'Квартал', year: 'Год', all: 'Всё время' }[p]}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Best source hero */}
                {best.count > 0 && (
                  <div className="rounded-3xl p-6 mb-6 flex items-center gap-6 overflow-hidden relative"
                    style={{ background: `linear-gradient(135deg, ${best.color} 0%, ${best.color}CC 100%)` }}>
                    <div className="absolute right-0 top-0 bottom-0 w-48 opacity-10">
                      <best.Icon className="w-full h-full" />
                    </div>
                    <div className="w-14 h-14 rounded-2xl bg-white/20 flex items-center justify-center flex-shrink-0">
                      <best.Icon className="w-7 h-7 text-white" />
                    </div>
                    <div className="flex-1">
                      <div className="text-xs font-black uppercase tracking-widest text-white/60 mb-1">Лучший источник</div>
                      <div className="text-2xl font-black text-white">{best.label}</div>
                      <div className="text-sm font-semibold text-white/70 mt-0.5">{best.count} проект{best.count === 1 ? '' : best.count < 5 ? 'а' : 'ов'} · {fmtShort(best.profit)} ₽ прибыль</div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="text-3xl font-black text-white">{fmtShort(best.revenue)} ₽</div>
                      <div className="text-xs font-bold text-white/60 mt-1">{totalRevenue > 0 ? Math.round((best.revenue/totalRevenue)*100) : 0}% от выручки</div>
                    </div>
                  </div>
                )}

                {/* Source cards */}
                <div className="grid grid-cols-5 gap-4 mb-6">
                  {sourceStats.map(src => (
                    <div key={src.key} className="bg-white rounded-3xl p-5 shadow-sm border border-gray-100 relative overflow-hidden">
                      <div className="absolute top-0 right-0 w-16 h-16 rounded-bl-3xl flex items-center justify-center" style={{ background: src.bg }}>
                        <src.Icon className="w-6 h-6" style={{ color: src.color }} />
                      </div>
                      <div className="text-[10px] font-black uppercase tracking-widest mb-3 pr-12" style={{ color: '#999999' }}>{src.label}</div>
                      <div className="text-2xl font-black mb-0.5" style={{ color: src.count > 0 ? '#1C1C1E' : '#CCCCCC' }}>{src.count}</div>
                      <div className="text-[10px] font-semibold mb-3" style={{ color: '#999999' }}>проект{src.count === 1 ? '' : src.count < 5 ? 'а' : 'ов'}</div>
                      <div className="text-sm font-black mb-1" style={{ color: src.revenue > 0 ? src.color : '#CCCCCC' }}>{fmtShort(src.revenue)} ₽</div>
                      <div className="h-1.5 rounded-full mt-2" style={{ background: '#F0F0F0' }}>
                        <div className="h-1.5 rounded-full transition-all" style={{ width: `${(src.revenue / maxRevenue) * 100}%`, background: src.color }} />
                      </div>
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-3 gap-6 mb-6">
                  {/* Bar chart: Revenue by source */}
                  <div className="col-span-2 bg-white rounded-3xl p-6 shadow-sm border border-gray-100">
                    <h2 className="text-base font-black mb-1" style={{ color: '#1C1C1E' }}>Выручка по источникам</h2>
                    <p className="text-xs font-medium mb-6" style={{ color: '#999999' }}>Сравнение источников за выбранный период</p>
                    <div className="space-y-4">
                      {sourceStats.map(src => (
                        <div key={src.key}>
                          <div className="flex items-center justify-between mb-1.5">
                            <div className="flex items-center gap-2">
                              <src.Icon className="w-4 h-4" style={{ color: src.color }} />
                              <span className="text-sm font-bold" style={{ color: '#1C1C1E' }}>{src.label}</span>
                            </div>
                            <div className="flex items-center gap-3 text-right">
                              <span className="text-xs font-semibold" style={{ color: '#999999' }}>{src.count} пр.</span>
                              <span className="text-sm font-black w-24" style={{ color: src.revenue > 0 ? src.color : '#CCCCCC' }}>{fmt3(src.revenue)} ₽</span>
                            </div>
                          </div>
                          <div className="h-3 rounded-full overflow-hidden" style={{ background: '#F0F0F0' }}>
                            <div className="h-3 rounded-full transition-all duration-500"
                              style={{ width: `${(src.revenue / maxRevenue) * 100}%`, background: `linear-gradient(90deg, ${src.color} 0%, ${src.color}99 100%)` }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Conversion + avg check */}
                  <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100">
                    <h2 className="text-base font-black mb-1" style={{ color: '#1C1C1E' }}>Конверсия в закрытие</h2>
                    <p className="text-xs font-medium mb-5" style={{ color: '#999999' }}>% завершённых проектов</p>
                    <div className="space-y-4">
                      {sourceStats.map(src => (
                        <div key={src.key} className="flex items-center gap-3">
                          <div className="w-7 h-7 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: src.bg }}>
                            <src.Icon className="w-3.5 h-3.5" style={{ color: src.color }} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-xs font-bold truncate" style={{ color: '#1C1C1E' }}>{src.label}</span>
                              <span className="text-xs font-black ml-2" style={{ color: src.color }}>{src.convRate}%</span>
                            </div>
                            <div className="h-1.5 rounded-full" style={{ background: '#F0F0F0' }}>
                              <div className="h-1.5 rounded-full" style={{ width: `${src.convRate}%`, background: src.color }} />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Monthly trend */}
                <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 mb-6">
                  <div className="flex items-center justify-between mb-6">
                    <div>
                      <h2 className="text-base font-black" style={{ color: '#1C1C1E' }}>Тренд по источникам (6 месяцев)</h2>
                      <p className="text-xs font-medium mt-0.5" style={{ color: '#999999' }}>Выручка каждого источника по месяцам</p>
                    </div>
                    <div className="flex flex-wrap gap-3">
                      {TRAFFIC_SOURCES.map(src => (
                        <div key={src.key} className="flex items-center gap-1.5 text-xs font-bold" style={{ color: src.color }}>
                          <div className="w-2.5 h-2.5 rounded-full" style={{ background: src.color }} />
                          {src.label}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-end gap-3 h-44">
                    {trendMonths.map((m, i) => (
                      <div key={i} className="flex-1 flex flex-col items-center gap-2">
                        <div className="w-full flex items-end gap-0.5 h-36">
                          {TRAFFIC_SOURCES.map(src => (
                            <div key={src.key} className="flex-1 rounded-t-sm transition-all"
                              style={{ height: `${(m.data[src.key] / maxTrend) * 100}%`, background: src.color, minHeight: m.data[src.key] > 0 ? 3 : 0, opacity: 0.85 }}
                              title={`${src.label}: ${fmt3(m.data[src.key])} ₽`}
                            />
                          ))}
                        </div>
                        <span className="text-[10px] font-bold uppercase" style={{ color: i === 5 ? '#1C1C1E' : '#999999' }}>{m.label}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Projects table */}
                <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
                  <div className="flex items-center justify-between px-6 py-5 border-b border-gray-50">
                    <h2 className="text-base font-black" style={{ color: '#1C1C1E' }}>Проекты по источникам</h2>
                    <div className="flex items-center gap-2">
                      {unknownProjects.length > 0 && (
                        <span className="text-xs font-semibold px-3 py-1 rounded-full" style={{ background: '#F6F7F8', color: '#999999' }}>{unknownProjects.length} без источника</span>
                      )}
                      <span className="text-xs font-semibold px-3 py-1 rounded-full" style={{ background: '#F6F7F8', color: '#999999' }}>{tProjects.length} всего</span>
                    </div>
                  </div>

                  {tProjects.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16">
                      <div className="w-16 h-16 rounded-3xl flex items-center justify-center mb-4" style={{ background: '#F6F7F8' }}>
                        <TrendingUp className="w-8 h-8" style={{ color: '#CCCCCC' }} />
                      </div>
                      <p className="font-bold text-sm" style={{ color: '#999999' }}>Нет проектов за выбранный период</p>
                    </div>
                  ) : (
                    <div>
                      {TRAFFIC_SOURCES.filter(src => tProjects.some(p => p.source === src.key)).map(src => {
                        const ps = tProjects.filter(p => p.source === src.key);
                        return (
                          <div key={src.key}>
                            <div className="flex items-center gap-3 px-6 py-3 border-b border-gray-50" style={{ background: src.bg }}>
                              <src.Icon className="w-4 h-4" style={{ color: src.color }} />
                              <span className="text-xs font-black uppercase tracking-widest" style={{ color: src.color }}>{src.label}</span>
                              <span className="text-xs font-semibold px-2 py-0.5 rounded-full ml-auto" style={{ background: src.color + '20', color: src.color }}>
                                {ps.length} пр. · {fmtShort(ps.reduce((s,p)=>s+(p.price||0),0))} ₽
                              </span>
                            </div>
                            {ps.map(p => {
                              const cost = projectPayrollCost(p);
                              const profit = p.price - cost - Math.round(p.price * 0.13);
                              const teamLbl = projectTeamNames(p, employees);
                              return (
                                <div key={p.id} className="flex items-center gap-4 px-6 py-3.5 hover:bg-gray-50/50 transition-colors border-b border-gray-50/50">
                                  <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: src.bg }}>
                                    <Briefcase className="w-4 h-4" style={{ color: src.color }} />
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <div className="font-bold text-sm truncate" style={{ color: '#1C1C1E' }}>{p.title}</div>
                                    <div className="text-xs font-medium mt-0.5" style={{ color: '#999999' }}>
                                      {format(new Date(p.createdAt), 'd MMM yyyy', { locale: ru })}
                                      {teamLbl ? ` · ${teamLbl}` : ''}
                                    </div>
                                  </div>
                                  <div className="text-right flex-shrink-0">
                                    <div className="text-sm font-black" style={{ color: '#1C1C1E' }}>{fmt3(p.price)} ₽</div>
                                    <div className="text-xs" style={{ color: '#999999' }}>выручка</div>
                                  </div>
                                  <div className="text-right flex-shrink-0 w-24">
                                    <div className="text-sm font-black" style={{ color: profit >= 0 ? '#00B956' : '#F52222' }}>{profit >= 0 ? '+' : ''}{fmt3(profit)} ₽</div>
                                    <div className="text-[10px] uppercase" style={{ color: '#999999' }}>прибыль</div>
                                  </div>
                                  <span className="text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wide flex-shrink-0"
                                    style={p.status === 'completed' ? { background: '#E8F9F0', color: '#00B956' } : p.status === 'overdue' ? { background: '#FEF0F0', color: '#F52222' } : { background: '#EEF2FF', color: '#6366F1' }}>
                                    {p.status === 'completed' ? 'Завершён' : p.status === 'overdue' ? 'Просрочен' : 'Активен'}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })}
                      {unknownProjects.length > 0 && (
                        <div>
                          <div className="flex items-center gap-3 px-6 py-3 border-b border-gray-50" style={{ background: '#F6F7F8' }}>
                            <AlertCircle className="w-4 h-4" style={{ color: '#999999' }} />
                            <span className="text-xs font-black uppercase tracking-widest" style={{ color: '#999999' }}>Источник не указан</span>
                            <span className="text-xs font-semibold px-2 py-0.5 rounded-full ml-auto" style={{ background: '#E5E7EB', color: '#6B7280' }}>
                              {unknownProjects.length} пр.
                            </span>
                          </div>
                          {unknownProjects.map(p => (
                            <div key={p.id} className="flex items-center gap-4 px-6 py-3.5 hover:bg-gray-50/50 transition-colors border-b border-gray-50/50">
                              <div className="w-9 h-9 rounded-xl bg-gray-100 flex items-center justify-center flex-shrink-0">
                                <Briefcase className="w-4 h-4 text-gray-400" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="font-bold text-sm truncate" style={{ color: '#1C1C1E' }}>{p.title}</div>
                                <div className="text-xs font-medium mt-0.5" style={{ color: '#999999' }}>{format(new Date(p.createdAt), 'd MMM yyyy', { locale: ru })}</div>
                              </div>
                              <div className="text-right"><div className="text-sm font-black text-gray-700">{fmt3(p.price)} ₽</div></div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

              </div>
            </div>
          );
        })() : null}
      </main>

      {/* Debug Overlay */}
      {debugLog.length > 0 && (
        <div className="fixed bottom-4 right-4 bg-red-900/90 text-white p-6 rounded-3xl shadow-2xl z-50 max-w-lg border border-red-500/30 backdrop-blur-md">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-red-500 rounded-xl flex items-center justify-center">
                <AlertCircle className="w-5 h-5" />
              </div>
              <h4 className="font-black uppercase tracking-widest text-xs">Runtime Errors</h4>
            </div>
            <button 
              onClick={() => setDebugLog([])}
              className="p-2 hover:bg-white/10 rounded-xl transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="space-y-3 max-h-[300px] overflow-y-auto pr-2 custom-scrollbar">
            {debugLog.map((log, idx) => (
              <div key={idx} className="bg-black/20 p-3 rounded-xl border border-white/5 font-mono text-[10px] leading-relaxed break-all">
                {log}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
