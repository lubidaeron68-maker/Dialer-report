import { useState, useCallback, useMemo, useRef } from 'react';
import {
  LayoutDashboard,
  Upload,
  BarChart3,
  Table2,
  AlertCircle,
  RefreshCw,
  Sparkles,
  Files,
  Trash2,
} from 'lucide-react';
import { FileUpload } from './components/FileUpload';
import { KPICards } from './components/KPICards';
import { SummaryStrip } from './components/SummaryStrip';
import {
  AgentPerformanceChart,
  ContactTypeChart,
  CompanyBreakdownChart,
  DepartmentChart,
  ClientPTPChart,
  CallDurationChart,
  AgentPTPAmountChart,
} from './components/Charts';
import { HourlyComparisonCharts } from './components/HourlyComparisonCharts';
import { DataTable } from './components/DataTable';
import { ThemeToggle } from './components/ThemeToggle';
import { BrandLogo } from './components/BrandLogo';
import { DatasetTabs } from './components/DatasetTabs';
import { CompareView } from './components/CompareView';
import { useTheme } from './hooks/useTheme';
import { parseExcelFile } from './utils/excelParser';
import { processData } from './utils/dataProcessor';
import { generateSampleData } from './utils/sampleData';
import {
  estimateRecordHeap,
  stringPool,
  TOTAL_HEAP_BUDGET_BYTES,
  MAX_SINGLE_FILE_BYTES,
  formatBytes,
} from './utils/memory';
import type { DashboardData, CollectionRecord, ParseProgress, Dataset } from './types';
import { cn } from './utils/cn';

const DATASET_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6', '#f97316', '#14b8a6'];
const MAX_DATASETS = 8;

function makeId(): string {
  return `ds-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatUploadedLabel(d: Date): string {
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function getDateRangeLabel(records: CollectionRecord[]): string {
  const dates = records.map((r) => r.date).filter(Boolean).sort();
  if (dates.length === 0) return '';
  const min = dates[0];
  const max = dates[dates.length - 1];
  const fmtDay = (s: string) => {
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  if (min === max) {
    const d = new Date(min);
    if (isNaN(d.getTime())) return min;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  const maxDate = new Date(max);
  const year = isNaN(maxDate.getTime()) ? '' : `, ${maxDate.getFullYear()}`;
  return `${fmtDay(min)} → ${fmtDay(max)}${year}`;
}

/** Drop all heap references of a dataset so the browser can reclaim them. */
function freeDataset(ds: Dataset): void {
  try {
    ds.data.records.length = 0;
    ds.data.agentPerformance.length = 0;
    ds.data.companyBreakdown.length = 0;
    ds.data.contactTypeStats.length = 0;
    ds.data.departmentStats.length = 0;
    ds.data.ptpStatusStats.length = 0;
    ds.data.callDurationBuckets.length = 0;
    ds.data.companies.length = 0;
    ds.data.departments.length = 0;
    ds.data.agents.length = 0;
  } catch {
    /* best-effort */
  }
  stringPool.release();
}

export default function App() {
  const { isDark, toggleTheme } = useTheme();
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [activeDatasetId, setActiveDatasetId] = useState<string | null>(null);
  const [isCompareMode, setIsCompareMode] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<ParseProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'analytics' | 'records'>('overview');
  const [analyticsDepts, setAnalyticsDepts] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const totalHeap = useMemo(
    () => datasets.reduce((sum, d) => sum + d.heapBytes, 0),
    [datasets]
  );
  const totalRows = useMemo(() => datasets.reduce((sum, d) => sum + d.rowCount, 0), [datasets]);

  const activeDataset: Dataset | null = useMemo(() => {
    if (datasets.length === 0) return null;
    return datasets.find((d) => d.id === activeDatasetId) ?? datasets[0];
  }, [datasets, activeDatasetId]);

  const memoizedData: DashboardData | null = activeDataset?.data ?? null;
  const fileName = activeDataset?.fileName ?? null;
  const loadStats = activeDataset ? { rowCount: activeDataset.rowCount, durationMs: activeDataset.durationMs } : null;
  const isUploadView = datasets.length === 0;

  // Re-compute complete analytics dataset when department filter is applied
  const filteredAnalyticsData: DashboardData | null = useMemo(() => {
    if (!memoizedData) return null;
    if (analyticsDepts.length === 0 || analyticsDepts.length === memoizedData.departments.length) {
      return memoizedData;
    }
    const deptSet = new Set(analyticsDepts);
    const filteredRecords = memoizedData.records.filter((r) => deptSet.has(r.department));
    return processData(filteredRecords);
  }, [memoizedData, analyticsDepts]);

  const buildDataset = useCallback(
    (records: CollectionRecord[], name: string, sourceBytes: number, durationMs: number, colorIndex: number): Dataset => {
      const processed = processData(records);
      const now = new Date();
      stringPool.retain();
      return {
        id: makeId(),
        fileName: name,
        uploadedAt: now.toISOString(),
        uploadedLabel: formatUploadedLabel(now),
        data: processed,
        rowCount: records.length,
        durationMs,
        color: DATASET_COLORS[colorIndex % DATASET_COLORS.length],
        dateRangeLabel: getDateRangeLabel(records),
        heapBytes: estimateRecordHeap(records.length),
        sourceBytes,
      };
    },
    []
  );

  const handleFilesUpload = useCallback(
    async (files: File[]) => {
      if (isLoading) return;
      if (datasets.length + files.length > MAX_DATASETS) {
        setError(`You can load up to ${MAX_DATASETS} files at a time. Remove a tab to add more.`);
        setTimeout(() => setError(null), 6000);
        return;
      }
      setIsLoading(true);
      setError(null);
      setNotice(null);

      let working = [...datasets];
      const evicted: string[] = [];
      const failures: string[] = [];
      let lastAddedId: string | null = null;

      const makeRoom = (neededBytes: number): boolean => {
        while (working.reduce((s, d) => s + d.heapBytes, 0) + neededBytes > TOTAL_HEAP_BUDGET_BYTES) {
          // Prefer evicting the oldest dataset that is NOT open in a tab
          const candidate =
            working.find((d) => d.id !== activeDatasetId) ??
            (working.length > 0 && working[0].id !== lastAddedId ? working[0] : undefined);
          if (!candidate || working.length === 0) return false;
          evicted.push(candidate.fileName);
          freeDataset(candidate);
          working = working.filter((d) => d.id !== candidate.id);
        }
        return true;
      };

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const tag = files.length > 1 ? `[${i + 1}/${files.length}] ${file.name}` : file.name;

        if (file.size > MAX_SINGLE_FILE_BYTES) {
          failures.push(`${file.name}: exceeds 60 MB single-file cap (${formatBytes(file.size)})`);
          continue;
        }

        setProgress({ stage: 'reading', percent: 5, message: `Starting ${tag}...` });
        const startTime = performance.now();
        try {
          const records = await parseExcelFile(file, (p) => {
            setProgress({
              ...p,
              message: files.length > 1 ? `${tag}: ${p.message}` : p.message,
            });
          });
          if (records.length === 0) {
            failures.push(`${file.name}: no records found`);
            continue;
          }
          const durationMs = Math.round(performance.now() - startTime);

          // Evict oldest inactive files until there is budget for this file
          const heapNeeded = estimateRecordHeap(records.length);
          if (!makeRoom(heapNeeded)) {
            failures.push(`${file.name}: not enough memory budget (${formatBytes(heapNeeded)} needed)`);
            continue;
          }

          const ds = buildDataset(records, file.name, file.size, durationMs, working.length);
          working = [...working, ds];
          lastAddedId = ds.id;
        } catch (err) {
          console.error(err);
          failures.push(`${file.name}: ${err instanceof Error ? err.message : 'failed to parse'}`);
        }
      }

      if (evicted.length > 0) {
        setNotice(
          `Memory budget applied: removed ${evicted.length} old file${evicted.length === 1 ? '' : 's'} (${evicted
            .map((n) => `"${n}"`)
            .join(', ')}) to keep the dashboard stable.`
        );
        setTimeout(() => setNotice(null), 10000);
      }

      const added = working.filter((d) => !datasets.some((o) => o.id === d.id));
      if (added.length > 0) {
        setDatasets(working);
        setActiveDatasetId(lastAddedId ?? added[0].id ?? working[working.length - 1]?.id ?? null);
        setIsCompareMode(false);
        setActiveTab('overview');
      } else if (working.length !== datasets.length) {
        setDatasets(working);
      }

      if (failures.length > 0) {
        setError(
          added.length === 0
            ? `Failed to load file(s). ${failures.join(' | ')}`
            : `Loaded ${added.length} file(s), but: ${failures.join(' | ')}`
        );
        setTimeout(() => setError(null), 10000);
      }
      setIsLoading(false);
      setProgress(null);
    },
    [isLoading, datasets, activeDatasetId, buildDataset]
  );

  const handleFileUpload = useCallback(
    (file: File) => {
      void handleFilesUpload([file]);
    },
    [handleFilesUpload]
  );

  const handleLoadSample = useCallback(() => {
    if (isLoading) return;
    if (datasets.length >= MAX_DATASETS) {
      setError(`You can load up to ${MAX_DATASETS} files at a time. Remove a tab to add more.`);
      setTimeout(() => setError(null), 6000);
      return;
    }
    const n = datasets.length + 1;
    const sampleRecords = generateSampleData(250);
    const ds = buildDataset(sampleRecords, `Sample Data ${n} (Demo)`, 60_000, 45, datasets.length);
    setDatasets((prev) => [...prev, ds]);
    setActiveDatasetId(ds.id);
    setIsCompareMode(false);
    setActiveTab('overview');
    setError(null);
  }, [isLoading, datasets.length, buildDataset]);

  const handleRemoveDataset = useCallback(
    (id: string) => {
      setDatasets((prev) => {
        const removed = prev.find((d) => d.id === id);
        if (removed) freeDataset(removed);
        const next = prev.filter((d) => d.id !== id);
        if (next.length < 2) setIsCompareMode(false);
        if (activeDatasetId === id) {
          setActiveDatasetId(next[0]?.id ?? null);
        }
        return next;
      });
    },
    [activeDatasetId]
  );

  const handleClear = useCallback(() => {
    datasets.forEach(freeDataset);
    setDatasets([]);
    setActiveDatasetId(null);
    setAnalyticsDepts([]);
    setIsCompareMode(false);
    setError(null);
    setProgress(null);
    setActiveTab('overview');
  }, [datasets]);

  const handleError = useCallback((err: string) => {
    setError(err);
    setTimeout(() => setError(null), 5000);
  }, []);

  const handleAddClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleDashboardFilesChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) void handleFilesUpload(files);
      e.target.value = '';
    },
    [handleFilesUpload]
  );

  const handleSelectDataset = useCallback((id: string) => {
    setActiveDatasetId(id);
    setAnalyticsDepts([]);
    setIsCompareMode(false);
  }, []);

  const handleSelectCompare = useCallback(() => {
    if (datasets.length >= 2) setIsCompareMode(true);
  }, [datasets.length]);

  // ============================ UPLOAD VIEW ============================
  if (isUploadView) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-indigo-50 transition-colors duration-200 dark:from-slate-950 dark:via-slate-900 dark:to-indigo-950/40">
        <header className="border-b border-slate-200 bg-white/80 backdrop-blur-sm transition-colors duration-200 dark:border-slate-800 dark:bg-slate-900/80">
          <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <BrandLogo />
                <div>
                  <h1 className="bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 bg-clip-text text-xl font-black tracking-wide text-transparent drop-shadow-[0_0_8px_rgba(34,211,238,0.35)]">
                    Fis Report
                  </h1>
                  <p className="text-sm text-slate-500 dark:text-slate-400">Upload your Excel files to get started</p>
                </div>
              </div>
              <ThemeToggle isDark={isDark} onToggle={toggleTheme} />
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:px-8">
          <div className="mb-10 text-center">
            <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-indigo-50 px-4 py-1.5 text-sm font-semibold text-indigo-700 ring-1 ring-indigo-100 dark:bg-indigo-950/60 dark:text-indigo-300 dark:ring-indigo-800">
              <Sparkles className="h-4 w-4" />
              Multi-File 12-Hour Analytics + Compare
            </div>
            <h2 className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white sm:text-4xl">
              Dump Your Collections Files
            </h2>
            <p className="mt-4 text-lg text-slate-600 dark:text-slate-300">
              Drop <span className="font-bold text-indigo-600 dark:text-indigo-400">one or many</span> Excel files at
              once — each file gets its own uniquely-dated tab. Built-in memory budget keeps the dashboard stable up
              to <span className="font-bold">50 MB+</span> of files.
            </p>
          </div>

          {error && (
            <div className="mb-6 flex items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/50 dark:text-rose-300">
              <AlertCircle className="h-5 w-5 flex-shrink-0" />
              <p className="text-sm font-medium">{error}</p>
            </div>
          )}
          {notice && (
            <div className="mb-6 flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/50 dark:text-amber-300">
              <AlertCircle className="h-5 w-5 flex-shrink-0" />
              <p className="text-sm font-medium">{notice}</p>
            </div>
          )}

          <div className="rounded-2xl bg-white p-6 shadow-lg ring-1 ring-slate-200 transition-colors duration-200 dark:bg-slate-900/95 dark:ring-slate-800">
            <FileUpload
              onFileLoad={handleFileUpload}
              onFilesLoad={handleFilesUpload}
              onError={handleError}
              isLoading={isLoading}
              progress={progress}
              fileName={null}
              onClear={handleClear}
              onLoadSample={handleLoadSample}
            />
          </div>

          <div className="mt-8 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200 transition-colors duration-200 dark:bg-slate-900/95 dark:ring-slate-800">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Expected Excel Columns (28 Fields)
              </h3>
              <span className="text-xs text-indigo-600 dark:text-indigo-400 font-medium">
                Auto-Converts "21-10-2026 22:01:10" to 12-Hour Format
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
              {[
                'Company name', 'Agreement id', 'Credit assignment date', 'Department',
                'Initial DPD', 'Actual DPD', 'Agent login', 'Agent name',
                'Action type', 'Contact type', 'Action result', 'Overdue reason',
                'Date', 'Execution dtime (12-Hr)', 'Dialed phone', 'Requested payment channel',
                'PTP status', 'PTP due date', 'PTP amount', 'PTP paid amount',
                'Payment plan summary', 'Payment plan status', 'Payment plan target amount', 'Payment plan paid amount',
                'Payment plan not paid amount', 'Agents note', 'Call duration, minutes', 'Additional action',
              ].map((col) => (
                <div
                  key={col}
                  className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 transition-colors dark:bg-slate-800/60"
                >
                  <div className="h-1.5 w-1.5 rounded-full bg-indigo-500 dark:bg-indigo-400" />
                  <span className="truncate text-xs font-medium text-slate-700 dark:text-slate-300">{col}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {[
              { icon: Files, title: 'Multi-File Tabs', desc: 'Dump many files — each gets a dated tab + color' },
              { icon: BarChart3, title: 'A-vs-B Compare', desc: 'KPI deltas, charts & agent face-off per file' },
              { icon: Upload, title: '60MB Crash-Safe Engine', desc: 'Memory budget + string interning + live auto-purge' },
            ].map((feature) => (
              <div
                key={feature.title}
                className="rounded-xl bg-white p-4 text-center shadow-sm ring-1 ring-slate-200 transition-colors duration-200 dark:bg-slate-900/95 dark:ring-slate-800"
              >
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50 dark:bg-indigo-950/60">
                  <feature.icon className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
                </div>
                <h4 className="text-sm font-bold text-slate-900 dark:text-white">{feature.title}</h4>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{feature.desc}</p>
              </div>
            ))}
          </div>
        </main>
      </div>
    );
  }

  // ============================ DASHBOARD VIEW ============================
  return (
    <div className="min-h-screen bg-slate-100 transition-colors duration-200 dark:bg-slate-950">
      <header className="sticky top-0 z-50 border-b border-slate-200 bg-white/90 backdrop-blur-sm transition-colors duration-200 dark:border-slate-800 dark:bg-slate-900/90">
        <div className="mx-auto max-w-[1600px] px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="flex items-center gap-3">
              <BrandLogo />
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 bg-clip-text text-lg font-black tracking-wide text-transparent drop-shadow-[0_0_8px_rgba(34,211,238,0.35)]">
                    Fis Report
                  </h1>
                  {loadStats && !isCompareMode && (
                    <span className="hidden items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-300 sm:inline-flex">
                      <Sparkles className="h-3 w-3" />
                      {loadStats.rowCount.toLocaleString()} rows in {(loadStats.durationMs / 1000).toFixed(1)}s
                    </span>
                  )}
                  {isCompareMode && (
                    <span className="hidden items-center gap-1 rounded-full bg-gradient-to-r from-indigo-600 to-pink-600 px-2 py-0.5 text-[11px] font-bold text-white sm:inline-flex">
                      Compare mode
                    </span>
                  )}
                </div>
                <p className="max-w-[200px] truncate text-xs text-slate-500 dark:text-slate-400 sm:max-w-none">
                  {isCompareMode
                    ? `${datasets.length} files loaded — comparing two`
                    : `${fileName} • ${formatBytes(totalHeap)} across ${datasets.length} file${datasets.length === 1 ? '' : 's'}`}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <ThemeToggle isDark={isDark} onToggle={toggleTheme} />

              <button
                onClick={handleClear}
                title="Remove all loaded files"
                className="flex items-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3 py-2 text-sm font-semibold text-rose-600 transition-colors hover:bg-rose-50 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300 dark:hover:bg-rose-950/70"
              >
                <Trash2 className="h-4 w-4" />
                <span className="hidden xl:inline">Clear All</span>
              </button>

              <button
                onClick={handleAddClick}
                disabled={isLoading}
                className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700/80"
              >
                <Upload className="h-4 w-4" />
                <span className="hidden sm:inline">Dump Files</span>
              </button>

              <button
                onClick={handleLoadSample}
                disabled={isLoading}
                className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-700 disabled:opacity-50 dark:bg-indigo-500 dark:hover:bg-indigo-600"
              >
                <RefreshCw className="h-4 w-4" />
                <span className="hidden sm:inline">Add Sample</span>
              </button>
            </div>
          </div>
        </div>
        {/* Hidden multi-file input for dumping more files from the dashboard */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          multiple
          className="hidden"
          onChange={handleDashboardFilesChange}
        />
      </header>

      {/* File tab bar: one uniquely-dated tab per dumped Excel file + Compare tab */}
      <DatasetTabs
        datasets={datasets}
        activeId={activeDataset?.id ?? null}
        isCompareMode={isCompareMode}
        onSelect={handleSelectDataset}
        onSelectCompare={handleSelectCompare}
        onRemove={handleRemoveDataset}
        onAdd={handleAddClick}
        isLoading={isLoading}
        progress={progress}
        totalHeapBytes={totalHeap}
        heapBudgetBytes={TOTAL_HEAP_BUDGET_BYTES}
        totalRows={totalRows}
      />

      {/* View tabs (hidden in compare mode) */}
      {!isCompareMode && (
        <div className="border-b border-slate-200 bg-white transition-colors duration-200 dark:border-slate-800 dark:bg-slate-900">
          <div className="mx-auto max-w-[1600px] px-4 sm:px-6 lg:px-8">
            <nav className="flex gap-1">
              {[
                { id: 'overview' as const, label: 'Overview', icon: LayoutDashboard },
                { id: 'analytics' as const, label: 'Analytics (12-Hour Hourly)', icon: BarChart3 },
                { id: 'records' as const, label: 'Records', icon: Table2 },
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-semibold transition-colors',
                    activeTab === tab.id
                      ? 'border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400'
                      : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                  )}
                >
                  <tab.icon className="h-4 w-4" />
                  {tab.label}
                </button>
              ))}
            </nav>
          </div>
        </div>
      )}

      <main className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8">
        {error && (
          <div className="mb-6 flex items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/50 dark:text-rose-300">
            <AlertCircle className="h-5 w-5 flex-shrink-0" />
            <p className="text-sm font-medium">{error}</p>
          </div>
        )}
        {notice && (
          <div className="mb-6 flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/50 dark:text-amber-300">
            <AlertCircle className="h-5 w-5 flex-shrink-0" />
            <p className="text-sm font-medium">{notice}</p>
          </div>
        )}

        {isCompareMode ? (
          <CompareView key={`compare-${datasets.map((d) => d.id).join('-')}`} datasets={datasets} isDark={isDark} />
        ) : (
          <>
            {activeTab === 'overview' && memoizedData && activeDataset && (
              <div className="space-y-6">
                <SummaryStrip data={memoizedData} fileName={fileName || undefined} />
                <KPICards kpi={memoizedData.kpi} />
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                  <CompanyBreakdownChart data={memoizedData.companyBreakdown} isDark={isDark} />
                  <ContactTypeChart data={memoizedData.contactTypeStats} isDark={isDark} />
                </div>
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                  <ClientPTPChart data={memoizedData.clientPtpStats} isDark={isDark} />
                  <CallDurationChart data={memoizedData.callDurationBuckets} isDark={isDark} />
                </div>
              </div>
            )}

            {activeTab === 'analytics' && memoizedData && filteredAnalyticsData && activeDataset && (
              <div className="space-y-6">
                <HourlyComparisonCharts
                  key={activeDataset.id}
                  records={memoizedData.records}
                  departments={memoizedData.departments}
                  isDark={isDark}
                  defaultKpi={memoizedData.kpi}
                  selectedDepts={analyticsDepts}
                  onSelectedDeptsChange={setAnalyticsDepts}
                />

                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                  <AgentPerformanceChart data={filteredAnalyticsData.agentPerformance} isDark={isDark} />
                  <AgentPTPAmountChart data={filteredAnalyticsData.agentPerformance} isDark={isDark} />
                </div>
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                  <DepartmentChart data={filteredAnalyticsData.departmentStats} isDark={isDark} />
                  <ContactTypeChart data={filteredAnalyticsData.contactTypeStats} isDark={isDark} />
                </div>
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                  <CompanyBreakdownChart data={filteredAnalyticsData.companyBreakdown} isDark={isDark} />
                  <ClientPTPChart data={filteredAnalyticsData.clientPtpStats} isDark={isDark} />
                </div>
                <CallDurationChart data={filteredAnalyticsData.callDurationBuckets} isDark={isDark} />
              </div>
            )}

            {activeTab === 'records' && memoizedData && activeDataset && (
              <DataTable
                key={activeDataset.id}
                records={memoizedData.records}
                companies={memoizedData.companies}
                departments={memoizedData.departments}
                agents={memoizedData.agents}
              />
            )}
          </>
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white py-4 transition-colors duration-200 dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto max-w-[1600px] px-4 text-center text-sm text-slate-500 dark:text-slate-400 sm:px-6 lg:px-8">
          Fis Report • {datasets.length} file{datasets.length === 1 ? '' : 's'} •{' '}
          {totalRows.toLocaleString()} records total • Heap {formatBytes(totalHeap)} /{' '}
          {formatBytes(TOTAL_HEAP_BUDGET_BYTES)} • 12-Hour Format Active
        </div>
      </footer>
    </div>
  );
}
