import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  Cpu,
  Flame,
  Gauge,
  HardDrive,
  Loader2,
  RefreshCw,
  Server,
  Thermometer,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import { fetchWorkerStats, fetchWorkers, isWorkersMockMode } from '../lib/workersApi';
import { STATS_PERIODS, type StatsPeriod, type WorkerLive, type WorkerStats } from '../lib/workersTypes';

function formatWatts(w: number) {
  if (w >= 1000) return `${(w / 1000).toFixed(1)} кВт`;
  return `${Math.round(w)} Вт`;
}

function formatWh(wh: number) {
  if (wh >= 1000) return `${(wh / 1000).toFixed(1)} кВт·ч`;
  return `${Math.round(wh)} Вт·ч`;
}

function formatHashrate(mh?: number) {
  if (mh == null) return '—';
  if (mh >= 1000) return `${(mh / 1000).toFixed(2)} GH/s`;
  return `${mh.toFixed(1)} MH/s`;
}

function tempTone(t: number) {
  if (t >= 80) return { text: 'text-rose-400', bar: 'bg-rose-500', ring: 'ring-rose-500/30' };
  if (t >= 70) return { text: 'text-amber-400', bar: 'bg-amber-500', ring: 'ring-amber-500/30' };
  return { text: 'text-cyan-400', bar: 'bg-cyan-500', ring: 'ring-cyan-500/30' };
}

function statusMeta(status: WorkerLive['status']) {
  switch (status) {
    case 'online':
      return { label: 'Онлайн', color: 'bg-emerald-400', text: 'text-emerald-300', Icon: Wifi };
    case 'idle':
      return { label: 'Простой', color: 'bg-sky-400', text: 'text-sky-300', Icon: Activity };
    case 'warning':
      return { label: 'Внимание', color: 'bg-amber-400', text: 'text-amber-300', Icon: Flame };
    default:
      return { label: 'Офлайн', color: 'bg-slate-500', text: 'text-slate-400', Icon: WifiOff };
  }
}

function PowerChart({ stats }: { stats: WorkerStats }) {
  const max = Math.max(
    1,
    ...stats.points.map((p) => Math.max(p.powerUsWh, p.powerOthersWh)),
  );
  const h = 160;
  const gap = stats.granularity === 'hour' ? 4 : 8;
  const n = stats.points.length;
  const barW = Math.max(6, Math.min(28, Math.floor((640 - gap * (n - 1)) / n)));

  return (
    <div className="w-full overflow-x-auto">
      <div className="min-w-[520px]">
        <div className="flex items-end gap-1 sm:gap-2" style={{ height: h }}>
          {stats.points.map((p) => {
            const usH = (p.powerUsWh / max) * (h - 8);
            const otH = (p.powerOthersWh / max) * (h - 8);
            return (
              <div key={p.at} className="flex flex-1 flex-col items-center justify-end gap-1" title={`${p.label}: мы ${p.powerUsWh}, др. ${p.powerOthersWh}`}>
                <div className="flex items-end gap-0.5" style={{ height: h - 8 }}>
                  <div
                    className="rounded-t-md bg-gradient-to-t from-cyan-600 to-cyan-300 shadow-[0_0_12px_rgba(34,211,238,0.35)] transition-all"
                    style={{ width: barW / 2, height: Math.max(2, usH) }}
                  />
                  <div
                    className="rounded-t-md bg-gradient-to-t from-violet-700/80 to-fuchsia-400/70 opacity-90 transition-all"
                    style={{ width: barW / 2, height: Math.max(2, otH) }}
                  />
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex gap-1 sm:gap-2 border-t border-white/5 pt-2">
          {stats.points.map((p, i) => {
            const show =
              stats.granularity === 'hour'
                ? i % Math.ceil(n / 8) === 0 || i === n - 1
                : true;
            return (
              <div key={p.at} className="flex-1 text-center">
                <span className={`font-mono text-[10px] text-slate-500 ${show ? '' : 'invisible'}`}>
                  {p.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function TempSparkline({ stats }: { stats: WorkerStats }) {
  const temps = stats.points.map((p) => p.avgTempC);
  const min = Math.min(...temps) - 2;
  const max = Math.max(...temps) + 2;
  const w = 320;
  const h = 56;
  const pts = temps
    .map((t, i) => {
      const x = (i / Math.max(1, temps.length - 1)) * w;
      const y = h - ((t - min) / (max - min || 1)) * h;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-14 w-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id="tempFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(251,146,60)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="rgb(251,146,60)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon
        points={`0,${h} ${pts} ${w},${h}`}
        fill="url(#tempFill)"
      />
      <polyline
        points={pts}
        fill="none"
        stroke="rgb(251,146,60)"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function WorkerCard({
  worker,
  onOpen,
}: {
  worker: WorkerLive;
  onOpen: () => void;
}) {
  const st = statusMeta(worker.status);
  const temp = tempTone(worker.temperatureC);
  const total = worker.powerUsW + worker.powerOthersW;
  const usPct = total > 0 ? (worker.powerUsW / total) * 100 : 0;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative w-full overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-slate-900/90 to-slate-950 p-5 text-left shadow-xl shadow-black/40 transition hover:-translate-y-0.5 hover:border-cyan-400/30 hover:shadow-cyan-500/10"
    >
      <div className="pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full bg-cyan-500/10 blur-2xl transition group-hover:bg-cyan-400/20" />

      <div className="relative flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-500/10 ring-1 ring-cyan-400/20">
            <Server className="h-6 w-6 text-cyan-300" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-semibold tracking-tight text-white">{worker.name}</h3>
              <span className={`inline-flex items-center gap-1.5 rounded-full bg-white/5 px-2 py-0.5 text-[11px] font-medium ${st.text}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${st.color} ${worker.status === 'online' ? 'animate-pulse' : ''}`} />
                {st.label}
              </span>
            </div>
            <p className="mt-0.5 font-mono text-xs text-slate-500">{worker.id}</p>
            {worker.host && (
              <p className="mt-1 flex items-center gap-1 text-xs text-slate-400">
                <HardDrive className="h-3 w-3" /> {worker.host}
              </p>
            )}
          </div>
        </div>
        <st.Icon className={`h-5 w-5 ${st.text} opacity-70`} />
      </div>

      <div className="relative mt-5 grid grid-cols-3 gap-3">
        <div className={`rounded-2xl bg-black/30 p-3 ring-1 ${temp.ring}`}>
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-slate-500">
            <Thermometer className="h-3.5 w-3.5" /> Temp
          </div>
          <p className={`mt-1 font-mono text-xl font-semibold tabular-nums ${temp.text}`}>
            {worker.status === 'offline' ? '—' : `${worker.temperatureC}°`}
          </p>
        </div>
        <div className="rounded-2xl bg-black/30 p-3 ring-1 ring-cyan-500/20">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-slate-500">
            <Zap className="h-3.5 w-3.5" /> Наши
          </div>
          <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-cyan-300">
            {worker.status === 'offline' ? '—' : formatWatts(worker.powerUsW)}
          </p>
        </div>
        <div className="rounded-2xl bg-black/30 p-3 ring-1 ring-fuchsia-500/15">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-slate-500">
            <Gauge className="h-3.5 w-3.5" /> Чужие
          </div>
          <p className={`mt-1 font-mono text-xl font-semibold tabular-nums text-fuchsia-300/90`}>
            {worker.status === 'offline' ? '—' : formatWatts(worker.powerOthersW)}
          </p>
        </div>
      </div>

      {worker.status !== 'offline' && (
        <>
          <div className="relative mt-3 grid grid-cols-2 gap-3">
            <div className="rounded-2xl bg-black/20 px-3 py-2 ring-1 ring-white/5">
              <p className="text-[10px] uppercase tracking-wider text-slate-500">Hashrate</p>
              <p className="font-mono text-sm font-semibold text-emerald-300">{formatHashrate(worker.hashrateMh)}</p>
            </div>
            <div className="rounded-2xl bg-black/20 px-3 py-2 ring-1 ring-white/5">
              <p className="text-[10px] uppercase tracking-wider text-slate-500">Shares</p>
              <p className="font-mono text-sm font-semibold text-slate-200">
                {worker.sharesFound ?? 0}
                <span className="text-slate-500"> / </span>
                <span className="text-rose-400/80">{worker.sharesRejected ?? 0}</span>
              </p>
            </div>
          </div>
          <div className="relative mt-4">
            <div className="mb-1.5 flex justify-between text-[11px] text-slate-500">
              <span>GPU util → наша доля</span>
              <span className="font-mono text-cyan-400/80">{Math.round(worker.utilPct ?? usPct)}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-white/5">
              <div
                className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-teal-300"
                style={{ width: `${Math.min(100, worker.utilPct ?? usPct)}%` }}
              />
            </div>
          </div>
        </>
      )}
    </button>
  );
}

function WorkerDetail({
  worker,
  onBack,
}: {
  worker: WorkerLive;
  onBack: () => void;
}) {
  const [period, setPeriod] = useState<StatsPeriod>('today');
  const [stats, setStats] = useState<WorkerStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchWorkerStats(worker.id, period)
      .then((data) => {
        if (!cancelled) setStats(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Ошибка загрузки');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [worker.id, period]);

  const st = statusMeta(worker.status);
  const temp = tempTone(worker.temperatureC);
  const periodMeta = STATS_PERIODS.find((p) => p.id === period);

  return (
    <div className="mx-auto max-w-5xl">
      <button
        type="button"
        onClick={onBack}
        className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-300 transition hover:border-cyan-400/30 hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" /> К списку воркеров
      </button>

      <div className="overflow-hidden rounded-[2rem] border border-white/10 bg-gradient-to-br from-slate-900 to-slate-950 p-6 sm:p-8 shadow-2xl">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-cyan-500/15 ring-1 ring-cyan-400/30">
              <Cpu className="h-8 w-8 text-cyan-300" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">{worker.name}</h2>
                <span className={`inline-flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1 text-xs font-medium ${st.text}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${st.color}`} />
                  {st.label}
                </span>
              </div>
              <p className="mt-1 font-mono text-sm text-slate-500">{worker.id}</p>
              <p className="mt-2 text-sm text-slate-400">
                {worker.hw?.gpu ? `${worker.hw.gpu}` : 'GPU —'}
                {worker.hw?.ram_gb != null ? ` · ${worker.hw.ram_gb} GB RAM` : ''}
                {' · '}
                обновлено{' '}
                {new Date(worker.lastSeenAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
            <div className="rounded-2xl bg-black/40 px-3 py-3 ring-1 ring-white/5">
              <p className="text-[10px] uppercase tracking-wider text-slate-500">Temp</p>
              <p className={`font-mono text-lg font-semibold ${temp.text}`}>
                {worker.temperatureC}°C
              </p>
            </div>
            <div className="rounded-2xl bg-black/40 px-3 py-3 ring-1 ring-white/5">
              <p className="text-[10px] uppercase tracking-wider text-slate-500">Hashrate</p>
              <p className="font-mono text-lg font-semibold text-emerald-300">{formatHashrate(worker.hashrateMh)}</p>
            </div>
            <div className="rounded-2xl bg-black/40 px-3 py-3 ring-1 ring-white/5">
              <p className="text-[10px] uppercase tracking-wider text-slate-500">Наши</p>
              <p className="font-mono text-lg font-semibold text-cyan-300">{formatWatts(worker.powerUsW)}</p>
            </div>
            <div className="rounded-2xl bg-black/40 px-3 py-3 ring-1 ring-white/5">
              <p className="text-[10px] uppercase tracking-wider text-slate-500">Чужие</p>
              <p className="font-mono text-lg font-semibold text-fuchsia-300">{formatWatts(worker.powerOthersW)}</p>
            </div>
          </div>
        </div>

        <div className="mt-8 flex flex-wrap gap-2">
          {STATS_PERIODS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPeriod(p.id)}
              className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                period === p.id
                  ? 'bg-cyan-500 text-slate-950 shadow-lg shadow-cyan-500/25'
                  : 'bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="mt-6 rounded-3xl border border-white/5 bg-black/25 p-5 sm:p-6">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-white">Потребление</h3>
              <p className="text-sm text-slate-500">
                {periodMeta?.granularity === 'hour' ? 'Разбивка по часам' : 'Разбивка по дням'}
              </p>
            </div>
            <div className="flex flex-wrap gap-4 text-xs">
              <span className="inline-flex items-center gap-1.5 text-cyan-300">
                <span className="h-2 w-2 rounded-sm bg-cyan-400" /> Наша мощность
              </span>
              <span className="inline-flex items-center gap-1.5 text-fuchsia-300">
                <span className="h-2 w-2 rounded-sm bg-fuchsia-400" /> Чужая мощность
              </span>
            </div>
          </div>

          {loading ? (
            <div className="flex h-40 items-center justify-center text-slate-500">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Загрузка статистики…
            </div>
          ) : error ? (
            <p className="py-10 text-center text-rose-400">{error}</p>
          ) : stats ? (
            <>
              <PowerChart stats={stats} />
              <div className="mt-6 grid gap-3 sm:grid-cols-4">
                <div className="rounded-2xl bg-white/[0.03] p-4">
                  <p className="text-xs text-slate-500">Наши (сумма)</p>
                  <p className="mt-1 font-mono text-lg font-semibold text-cyan-300">{formatWh(stats.totals.powerUsWh)}</p>
                </div>
                <div className="rounded-2xl bg-white/[0.03] p-4">
                  <p className="text-xs text-slate-500">Чужие (сумма)</p>
                  <p className="mt-1 font-mono text-lg font-semibold text-fuchsia-300">{formatWh(stats.totals.powerOthersWh)}</p>
                </div>
                <div className="rounded-2xl bg-white/[0.03] p-4">
                  <p className="text-xs text-slate-500">Средняя t°</p>
                  <p className="mt-1 font-mono text-lg font-semibold text-amber-300">{stats.totals.avgTempC}°C</p>
                </div>
                <div className="rounded-2xl bg-white/[0.03] p-4">
                  <p className="text-xs text-slate-500">Ср. hashrate</p>
                  <p className="mt-1 font-mono text-lg font-semibold text-emerald-300">
                    {formatHashrate(stats.totals.avgHashrateMh)}
                  </p>
                </div>
              </div>
              <div className="mt-6">
                <p className="mb-2 text-xs uppercase tracking-wider text-slate-500">Температура</p>
                <TempSparkline stats={stats} />
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function WorkersPage() {
  const [workers, setWorkers] = useState<WorkerLive[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async (soft = false) => {
    if (soft) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const data = await fetchWorkers();
      setWorkers(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить воркеров');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(true), 30_000);
    return () => clearInterval(t);
  }, []);

  const selected = useMemo(
    () => workers.find((w) => w.id === selectedId) ?? null,
    [workers, selectedId],
  );

  const onlineCount = workers.filter((w) => w.status === 'online' || w.status === 'idle').length;
  const totalUs = workers.reduce((s, w) => s + (w.status === 'offline' ? 0 : w.powerUsW), 0);
  const totalOthers = workers.reduce((s, w) => s + (w.status === 'offline' ? 0 : w.powerOthersW), 0);

  return (
    <div className="workers-page min-h-screen bg-[#070B12] text-slate-100">
      <div
        className="pointer-events-none fixed inset-0 opacity-40"
        style={{
          backgroundImage:
            'radial-gradient(ellipse 80% 50% at 20% -10%, rgba(34,211,238,0.18), transparent), radial-gradient(ellipse 60% 40% at 90% 10%, rgba(168,85,247,0.12), transparent), linear-gradient(rgba(148,163,184,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.04) 1px, transparent 1px)',
          backgroundSize: 'auto, auto, 48px 48px, 48px 48px',
        }}
      />

      <div className="relative mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        <header className="mb-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="mb-2 inline-flex items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-500/10 px-3 py-1 text-xs font-medium text-cyan-300">
              <Activity className="h-3.5 w-3.5" />
              Worker Fleet
              {isWorkersMockMode() && (
                <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] text-amber-300">demo</span>
              )}
            </p>
            <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">Воркеры</h1>
            <p className="mt-2 max-w-xl text-sm text-slate-400 sm:text-base">
              Агенты шлют register + heartbeat. Здесь live-метрики и статистика по периодам.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={refreshing}
            className="inline-flex items-center justify-center gap-2 self-start rounded-2xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-slate-200 transition hover:border-cyan-400/40 hover:bg-cyan-500/10 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            Обновить
          </button>
        </header>

        {!selected && (
          <div className="mb-8 grid gap-3 sm:grid-cols-3">
            <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
              <div className="flex items-center gap-2 text-slate-500">
                <Wifi className="h-4 w-4 text-emerald-400" /> В сети
              </div>
              <p className="mt-2 font-mono text-3xl font-semibold text-white">
                {onlineCount}
                <span className="text-lg text-slate-600">/{workers.length}</span>
              </p>
            </div>
            <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
              <div className="flex items-center gap-2 text-slate-500">
                <Zap className="h-4 w-4 text-cyan-400" /> Наша мощность
              </div>
              <p className="mt-2 font-mono text-3xl font-semibold text-cyan-300">{formatWatts(totalUs)}</p>
            </div>
            <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
              <div className="flex items-center gap-2 text-slate-500">
                <Gauge className="h-4 w-4 text-fuchsia-400" /> Чужая мощность
              </div>
              <p className="mt-2 font-mono text-3xl font-semibold text-fuchsia-300">{formatWatts(totalOthers)}</p>
            </div>
          </div>
        )}

        {loading && !workers.length ? (
          <div className="flex h-64 items-center justify-center text-slate-500">
            <Loader2 className="mr-2 h-6 w-6 animate-spin text-cyan-400" />
            Загрузка воркеров…
          </div>
        ) : error && !workers.length ? (
          <div className="rounded-3xl border border-rose-500/30 bg-rose-500/10 p-8 text-center text-rose-300">
            {error}
          </div>
        ) : selected ? (
          <WorkerDetail worker={selected} onBack={() => setSelectedId(null)} />
        ) : workers.length === 0 ? (
          <div className="rounded-[2rem] border border-dashed border-white/15 bg-white/[0.02] p-10 text-center">
            <Server className="mx-auto h-10 w-10 text-slate-600" />
            <h2 className="mt-4 text-lg font-semibold text-white">Пока нет агентов</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
              Бот должен один раз вызвать <span className="font-mono text-cyan-400/80">POST /api/v1/register</span>,
              затем слать <span className="font-mono text-cyan-400/80">heartbeat</span> каждые ~30с.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {workers.map((w) => (
              <WorkerCard key={w.id} worker={w} onOpen={() => setSelectedId(w.id)} />
            ))}
          </div>
        )}

        <footer className="mt-12 border-t border-white/5 pt-6 text-center text-xs text-slate-600">
          {isWorkersMockMode() ? 'Демо-режим (VITE_WORKERS_USE_MOCK=1)' : 'Live · /api/v1/agents'}
          {' · '}
          <a href="/" className="text-slate-500 underline-offset-2 hover:text-cyan-400 hover:underline">
            ← CRM
          </a>
        </footer>
      </div>
    </div>
  );
}
