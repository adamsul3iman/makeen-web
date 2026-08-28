"use client";

import { useCallback, useRef, useState } from "react";
import {
  Download,
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import { getSupabaseBrowser, isSupabaseBrowserConfigured } from "@/lib/supabaseBrowser";
import { getTenantStoreId } from "@/lib/tenantClient";
import { exportCatalogToExcel, importCatalogExcel } from "@/lib/excelCatalog";
import type { ImportSummary } from "@/lib/excelCatalog";
import { PageHeader } from "@/components/ui/Card";

export default function CatalogExcelPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [status, setStatus] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const requireClient = useCallback(() => {
    const sb = getSupabaseBrowser();
    if (!sb || !isSupabaseBrowserConfigured()) {
      setStatus({ tone: "error", message: "قاعدة البيانات غير مهيأة أو غير متصلة" });
      return null;
    }
    const sid = getTenantStoreId();
    if (!sid) {
      setStatus({ tone: "error", message: "لم يتم تحديد المتجر — سجّل الدخول أولاً" });
      return null;
    }
    return { sb, sid };
  }, []);

  const handleExport = async () => {
    const ctx = requireClient();
    if (!ctx) return;
    setBusy("export");
    setStatus(null);
    setSummary(null);
    try {
      const blob = await exportCatalogToExcel(ctx.sb, ctx.sid);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `catalog-${ctx.sid.slice(0, 8)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus({ tone: "success", message: "تم تصدير الكتالوج بنجاح" });
    } catch (err) {
      setStatus({ tone: "error", message: err instanceof Error ? err.message : "تعذر تصدير الكتالوج" });
    } finally {
      setBusy(null);
    }
  };

  const handleFileChosen = async (file: File | null) => {
    if (!file) return;
    const ctx = requireClient();
    if (!ctx) return;
    setBusy("import");
    setStatus(null);
    setSummary(null);
    setProgress(null);
    try {
      const result = await importCatalogExcel(ctx.sb, ctx.sid, file, (done, total) =>
        setProgress({ done, total }),
      );
      setSummary(result);
      const errorCount = result.errors.length;
      setStatus({
        tone: errorCount > 0 ? "error" : "success",
        message:
          errorCount > 0
            ? `اكتمل الاستيراد مع ${errorCount} خطأ`
            : `تم استيراد ${result.parsedRows} صف بنجاح`,
      });
    } catch (err) {
      setStatus({ tone: "error", message: err instanceof Error ? err.message : "تعذر استيراد الملف" });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const errorLabel = (count: number) => (count === 1 ? "خطأ واحد" : `${count} أخطاء`);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title="استيراد وتصدير الكتالوج (إكسل)"
        subtitle="نسخة احتياطية كاملة وتبادل هرمي: المنتجات والمتغيرات والوحدات والفئات والعلامات."
      />

      {status && (
        <div
          className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm font-bold ${
            status.tone === "success"
              ? "border-success/30 bg-success/10 text-success"
              : "border-destructive/30 bg-destructive/10 text-destructive"
          }`}
        >
          {status.tone === "success" ? (
            <CheckCircle2 className="h-5 w-5 shrink-0" />
          ) : (
            <AlertTriangle className="h-5 w-5 shrink-0" />
          )}
          <span className="flex-1">{status.message}</span>
          <button type="button" onClick={() => setStatus(null)} className="text-xs opacity-70 hover:opacity-100">
            إغلاق
          </button>
        </div>
      )}

      {progress && (
        <p className="text-xs font-bold text-muted">
          جاري المعالجة… {progress.done}/{progress.total}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {/* Export */}
        <section className="rounded-2xl border border-border bg-surface p-5">
          <div className="flex items-center gap-2 text-base font-black">
            <Download className="h-5 w-5 text-primary" />
            تصدير الكتالوج
          </div>
          <p className="mt-2 text-xs font-semibold text-muted">
            ينزّل ملف إكسل كاملاً للمتجر الحالي: صف واحد لكل وحدة (صف لكل متغير × وحدة)،
            مع الفئات والفئات المتعددة والضريبة والأسعار والمخزون. يشمل كل الصفوف حتى فوق حد
            1000 صف لكل طلب.
          </p>
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={busy !== null}
            className="mt-4 inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-black text-primary-foreground disabled:opacity-50"
          >
            {busy === "export" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
            {busy === "export" ? "جارٍ الإنشاء…" : "تصدير"}
          </button>
        </section>

        {/* Import */}
        <section className="rounded-2xl border border-border bg-surface p-5">
          <div className="flex items-center gap-2 text-base font-black">
            <Upload className="h-5 w-5 text-primary" />
            استيراد الكتالوج
          </div>
          <p className="mt-2 text-xs font-semibold text-muted">
            يُحدّث المنتجات والمتغيرات والوحدات المطابقة (بالباركود / الاسم) ويُنشئ الجديد
            تراتبياً. المخزون يُطبق للمفاتيح الجديدة فقط (إعادة الاستيراد لا تضاعف الرصيد).
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              void handleFileChosen(e.target.files?.[0] ?? null);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy !== null}
            className="mt-4 inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-black text-primary-foreground disabled:opacity-50"
          >
            {busy === "import" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {busy === "import" ? "جارٍ الاستيراد…" : "اختيار ملف واستيراده"}
          </button>
        </section>
      </div>

      {summary && (
        <section className="rounded-2xl border border-border bg-surface p-5">
          <h3 className="text-base font-black">ملخص الاستيراد</h3>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div className="rounded-lg bg-surface-muted p-3">
              <dt className="text-[11px] font-bold text-muted">صفوف</dt>
              <dd className="text-base font-black tabular-nums">{summary.parsedRows}</dd>
            </div>
            <div className="rounded-lg bg-surface-muted p-3">
              <dt className="text-[11px] font-bold text-muted">منتجات جديدة</dt>
              <dd className="text-base font-black tabular-nums">{summary.productsCreated}</dd>
            </div>
            <div className="rounded-lg bg-surface-muted p-3">
              <dt className="text-[11px] font-bold text-muted">منتجات محدثة</dt>
              <dd className="text-base font-black tabular-nums">{summary.productsUpdated}</dd>
            </div>
            <div className="rounded-lg bg-surface-muted p-3">
              <dt className="text-[11px] font-bold text-muted">متغيرات جديدة</dt>
              <dd className="text-base font-black tabular-nums">{summary.variantsCreated}</dd>
            </div>
            <div className="rounded-lg bg-surface-muted p-3">
              <dt className="text-[11px] font-bold text-muted">متغيرات محدثة</dt>
              <dd className="text-base font-black tabular-nums">{summary.variantsUpdated}</dd>
            </div>
            <div className="rounded-lg bg-surface-muted p-3">
              <dt className="text-[11px] font-bold text-muted">وحدات جديدة</dt>
              <dd className="text-base font-black tabular-nums">{summary.unitsCreated}</dd>
            </div>
            <div className="rounded-lg bg-surface-muted p-3">
              <dt className="text-[11px] font-bold text-muted">وحدات محدثة</dt>
              <dd className="text-base font-black tabular-nums">{summary.unitsUpdated}</dd>
            </div>
            <div className="rounded-lg bg-surface-muted p-3">
              <dt className="text-[11px] font-bold text-muted">فئات جديدة</dt>
              <dd className="text-base font-black tabular-nums">{summary.categoriesCreated}</dd>
            </div>
          </dl>

          {summary.errors.length > 0 && (
            <div className="mt-4">
              <h4 className="flex items-center gap-2 text-sm font-black text-destructive">
                <AlertTriangle className="h-4 w-4" /> {errorLabel(summary.errors.length)}
              </h4>
              <ul className="mt-2 max-h-48 space-y-1 overflow-auto rounded-lg bg-destructive/5 p-3 text-xs font-semibold text-destructive">
                {summary.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <p className="text-[11px] font-semibold text-muted">
        ملاحظة: يؤثر الاستيراد فوراً على الكتالوج ويُزامَن عبر الأجهزة. لا يحذف أي منتج أو متغير
        موجود — يحدّث أو يُنشئ فقط.
      </p>
    </div>
  );
}
