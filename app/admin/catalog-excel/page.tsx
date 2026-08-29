"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Sparkles,
  ShieldAlert,
  X,
} from "lucide-react";
import { getSupabaseBrowser, isSupabaseBrowserConfigured } from "@/lib/supabaseBrowser";
import { getTenantStoreId } from "@/lib/tenantClient";
import {
  exportCatalogToExcel,
  importCatalogGroups,
  exportCatalogTemplate,
  previewCatalogImport,
  type ExportFilters,
  type DryRunResult,
  type ImportSummary,
} from "@/lib/excelCatalog";
import { PageHeader } from "@/components/ui/Card";
import { ModalShell } from "@/components/ui/ModalShell";
import { Button } from "@/components/ui/Button";
import EntityCombobox, { type EntityOption } from "@/components/shared/EntityCombobox";

const STATUS_OPTIONS: EntityOption[] = [
  { id: "all", name: "الكل" },
  { id: "active", name: "نشط" },
  { id: "inactive", name: "موقوف" },
];

/** Translate raw/technical errors into clear, friendly Arabic messages. */
function friendlyError(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const combined = raw.toLowerCase();

  // Network / connectivity failures (browser fetch, Node fetch, DNS).
  if (
    /failed to fetch|fetch failed|networkerror|network error|econnrefused|econnreset|enotfound|getaddrinfo|socket hang up|load failed/.test(
      combined,
    )
  ) {
    return "عذراً، تعذر الاتصال بالخادم. يرجى التحقق من اتصال الإنترنت والمحاولة مرة أخرى.";
  }

  // Database / PostgREST errors: UUID syntax and generic database failures.
  if (
    /invalid input syntax for type uuid|invalid input syntax|postgres|postgrest|relation .* does not exist|duplicate key|unique constraint|violates foreign key/.test(
      combined,
    )
  ) {
    return "حدث خطأ في قاعدة البيانات أثناء معالجة الطلب. تأكد من سلامة ملف الإكسل (عدم تكرار الباركود أو الأصناف) ثم أعد المحاولة.";
  }

  // Timeouts.
  if (/timeout|timed out|abort/.test(combined)) {
    return "استغرق الطلب وقتاً أطول من المتوقع. يرجى المحاولة مرة أخرى.";
  }

  return raw && raw !== "null" ? raw : fallback;
}

export default function CatalogExcelPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<"export" | "import" | "template" | "preview" | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [status, setStatus] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [dragging, setDragging] = useState(false);

  // Export filters
  const [filters, setFilters] = useState<ExportFilters>({});
  const [categories, setCategories] = useState<EntityOption[]>([]);
  const [brands, setBrands] = useState<EntityOption[]>([]);

  // Dry-run preview
  const [preview, setPreview] = useState<DryRunResult | null>(null);
  const [previewFile, setPreviewFile] = useState<File | null>(null);

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

  // Load categories + brands for the export filter dropdowns.
  useEffect(() => {
    const sb = getSupabaseBrowser();
    const storeId = isSupabaseBrowserConfigured() ? getTenantStoreId() : null;
    if (!sb || !storeId) return;
    let cancelled = false;
    (async () => {
      const [catRes, brandRes] = await Promise.all([
        sb.from("categories").select("id,name").eq("store_id", storeId).order("name"),
        sb.from("product_brands").select("id,name").eq("store_id", storeId).order("name"),
      ]);
      if (cancelled) return;
      setCategories(((catRes.data ?? []) as Array<{ id: string; name: string }>).map((c) => ({ id: c.id, name: c.name })));
      setBrands(((brandRes.data ?? []) as Array<{ id: string; name: string }>).map((b) => ({ id: b.id, name: b.name })));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const downloadBlob = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  const handleExport = async () => {
    const ctx = requireClient();
    if (!ctx) return;
    setBusy("export");
    setStatus(null);
    setSummary(null);
    try {
      const activeFilters: ExportFilters = {
        brandId: filters.brandId || null,
        categoryId: filters.categoryId || null,
        status: filters.status || null,
      };
      const blob = await exportCatalogToExcel(ctx.sb, ctx.sid, activeFilters);
      downloadBlob(blob, `catalog-${ctx.sid.slice(0, 8)}.xlsx`);
      setStatus({ tone: "success", message: "تم تصدير الكتالوج بنجاح" });
    } catch (err) {
      setStatus({ tone: "error", message: friendlyError(err, "تعذر تصدير الكتالوج") });
    } finally {
      setBusy(null);
    }
  };

  const handleTemplate = async () => {
    const ctx = requireClient();
    if (!ctx) return;
    setBusy("template");
    setStatus(null);
    setSummary(null);
    try {
      const blob = await exportCatalogTemplate(ctx.sid);
      downloadBlob(blob, `catalog-template.xlsx`);
      setStatus({ tone: "success", message: "تم تنزيل القالب الفارغ" });
    } catch (err) {
      setStatus({ tone: "error", message: friendlyError(err, "تعذر تنزيل القالب") });
    } finally {
      setBusy(null);
    }
  };

  // Dry-run: parse + classify WITHOUT writing to the DB.
  const runPreview = async (file: File) => {
    const ctx = requireClient();
    if (!ctx) return;
    setBusy("preview");
    setStatus(null);
    setSummary(null);
    setPreviewFile(file);
    setPreview(null);
    try {
      const result = await previewCatalogImport(ctx.sb, ctx.sid, file, (done, total) =>
        setProgress({ done, total }),
      );
      setPreview(result);
      setProgress(null);
      // Unlock the modal — the preview stays open based on `preview` state,
      // not the `busy` state.
      setBusy(null);
    } catch (err) {
      setProgress(null);
      setStatus({ tone: "error", message: friendlyError(err, "تعذر قراءة الملف") });
      setBusy(null);
    }
  };

  const handleFileDropped = useCallback(
    (file: File | null) => {
      if (!file) return;
      void runPreview(file);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Confirm: actually write the parsed (previewed) groups to the DB.
  const confirmImport = async () => {
    const ctx = requireClient();
    if (!ctx || !preview) return;
    setBusy("import");
    setStatus(null);
    setSummary(null);
    setProgress(null);
    try {
      const result = await importCatalogGroups(ctx.sb, ctx.sid, preview.groups, (done, total) =>
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
      setPreview(null);
      setPreviewFile(null);
    } catch (err) {
      setStatus({ tone: "error", message: friendlyError(err, "تعذر استيراد الملف") });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const errorLabel = (count: number) => (count === 1 ? "خطأ واحد" : `${count} أخطاء`);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="استيراد وتصدير الكتالوج (إكسل)"
        subtitle="مزامنة كاملة وآمنة: منتجات ومتغيرات ووحدات وفئات وعلامات. معاينة قبل الحفظ وحماية من الكتابة الفوقية."
      />

      {status && (
        <div
          role="alert"
          className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm font-semibold shadow-sm ${
            status.tone === "success"
              ? "border-success/30 bg-success/10 text-success"
              : "border-destructive/30 bg-destructive/10 text-destructive"
          }`}
        >
          <span className="mt-0.5 shrink-0">
            {status.tone === "success" ? (
              <CheckCircle2 className="h-5 w-5" />
            ) : (
              <AlertTriangle className="h-5 w-5" />
            )}
          </span>
          <span className="flex-1 leading-relaxed">{status.message}</span>
          <button
            type="button"
            onClick={() => setStatus(null)}
            aria-label="إغلاق الرسالة"
            className={`shrink-0 rounded-md p-1.5 transition-colors ${
              status.tone === "success"
                ? "text-success hover:bg-success/15"
                : "text-destructive hover:bg-destructive/15"
            }`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {progress && (
        <p className="text-xs font-bold text-muted">
          جاري المعالجة… {progress.done}/{progress.total}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── Step 1 (right): Export / Template ─────────────────────────── */}
        <section className="order-2 rounded-2xl border border-border bg-surface p-5 lg:order-1">
          <div className="flex items-center gap-2 text-base font-black">
            <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-black text-primary">1</span>
            تصدير الكتالوج
          </div>
          <p className="mt-2 text-xs font-semibold text-muted">
            صف لكل وحدة (متغير × وحدة) مع معرفات خفية لحفظ آمن خالٍ من التكرار. يشمل كل
            الصفوف حتى فوق حد 1000 صف لكل طلب.
          </p>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="flex min-w-36 flex-1 flex-col gap-1.5">
              <span className="text-xs font-black text-muted">التصنيف</span>
              <EntityCombobox
                id="filter-category"
                value={filters.categoryId ?? ""}
                options={categories}
                placeholder="كل التصنيفات"
                emptyLabel="لا توجد تصنيفات"
                size="sm"
                onChange={(id) => setFilters((f) => ({ ...f, categoryId: id || null }))}
              />
            </div>
            <div className="flex min-w-36 flex-1 flex-col gap-1.5">
              <span className="text-xs font-black text-muted">العلامة</span>
              <EntityCombobox
                id="filter-brand"
                value={filters.brandId ?? ""}
                options={brands}
                placeholder="كل العلامات"
                emptyLabel="لا توجد علامات"
                size="sm"
                onChange={(id) => setFilters((f) => ({ ...f, brandId: id || null }))}
              />
            </div>
            <div className="flex min-w-36 flex-1 flex-col gap-1.5">
              <span className="text-xs font-black text-muted">الحالة</span>
              <EntityCombobox
                id="filter-status"
                value={filters.status ?? "all"}
                options={STATUS_OPTIONS}
                placeholder="اختر الحالة"
                emptyLabel="لا توجد حالات"
                size="sm"
                onChange={(id) => setFilters((f) => ({ ...f, status: (id || "all") as ExportFilters["status"] }))}
              />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-3">
            <Button onClick={() => void handleExport()} disabled={busy !== null} className="gap-2">
              {busy === "export" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {busy === "export" ? "جارٍ الإنشاء…" : "تصدير"}
            </Button>
            <Button variant="outline" onClick={() => void handleTemplate()} disabled={busy !== null} className="gap-2">
              {busy === "template" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
              {busy === "template" ? "جارٍ الإنشاء…" : "تنزيل قالب فارغ"}
            </Button>
          </div>
        </section>

        {/* ── Step 2 (left): Import / Drag & Drop ───────────────────────── */}
        <section className="order-1 rounded-2xl border border-border bg-surface p-5 lg:order-2">
          <div className="flex items-center gap-2 text-base font-black">
            <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-black text-primary">2</span>
            استيراد الكتالوج
          </div>
          <p className="mt-2 text-xs font-semibold text-muted">
            أسقط الملف هنا. تُعرَض معاينة قبل الحفظ: ما الجديد وما المُحدَّث وما الأخطاء.
            الخلايا الفارغة لا تمسح القيم الموجودة، والرصيد يُطبَّق للمفاتيح الجديدة فقط.
          </p>

          <div
            ref={dropRef}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              handleFileDropped(e.dataTransfer.files?.[0] ?? null);
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`mt-4 flex min-h-[220px] cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-6 text-center transition-colors ${
              dragging
                ? "border-primary bg-primary/10"
                : "border-border bg-surface-muted/40 hover:border-primary/60 hover:bg-surface-muted"
            }`}
          >
            <Upload className="h-10 w-10 text-primary" />
            <div className="text-sm font-black">اسحب ملف الإكسل وأفلته هنا</div>
            <div className="text-xs font-semibold text-muted">
              أو انقر للاختيار — صيغ .xlsx / .xls
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              handleFileDropped(e.target.files?.[0] ?? null);
              e.target.value = "";
            }}
          />
        </section>
      </div>

      {/* ── Dry-run preview modal ──────────────────────────────────────── */}
      <ModalShell
        open={preview !== null}
        title="معاينة الاستيراد"
        description={previewFile ? `الملف: ${previewFile.name}` : undefined}
        icon={<Sparkles className="h-5 w-5 text-primary" />}
        size="lg"
        onClose={() => {
          if (busy !== "import") {
            setPreview(null);
            setPreviewFile(null);
          }
        }}
        dismissible={busy !== "import"}
        showClose
        footer={
          <div className="flex items-center justify-end gap-3">
            <Button
              variant="outline"
              onClick={() => {
                setPreview(null);
                setPreviewFile(null);
              }}
              disabled={busy === "import"}
            >
              إلغاء
            </Button>
            <Button
              variant="default"
              onClick={() => void confirmImport()}
              disabled={busy === "import" || (preview?.productsToCreate ?? 0) + (preview?.productsToUpdate ?? 0) === 0}
              className="gap-2"
            >
              {busy === "import" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {busy === "import" ? "جارٍ الحفظ…" : "تأكيد والحفظ"}
            </Button>
          </div>
        }
      >
        {preview && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="flex items-center gap-3 rounded-xl border border-success/30 bg-success/10 p-3">
                <div className="text-2xl font-black text-success">🟢</div>
                <div>
                  <div className="text-lg font-black tabular-nums">{preview.productsToCreate}</div>
                  <div className="text-[11px] font-bold text-muted">منتجات جديدة</div>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-xl border border-warning/30 bg-warning/10 p-3">
                <div className="text-2xl font-black text-warning">🟡</div>
                <div>
                  <div className="text-lg font-black tabular-nums">{preview.productsToUpdate}</div>
                  <div className="text-[11px] font-bold text-muted">منتجات مُحدَّثة</div>
                </div>
              </div>
              <div className="col-span-2 flex items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3 sm:col-span-1">
                <div className="text-2xl font-black text-destructive">🔴</div>
                <div>
                  <div className="text-lg font-black tabular-nums">{preview.errors.length}</div>
                  <div className="text-[11px] font-bold text-muted">مشاكل / أخطاء</div>
                </div>
              </div>
            </div>

            {preview.errors.length > 0 ? (
              <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-3">
                <h4 className="flex items-center gap-2 text-sm font-black text-destructive">
                  <ShieldAlert className="h-4 w-4" /> {errorLabel(preview.errors.length)}
                </h4>
                <ul className="mt-2 max-h-40 space-y-1 overflow-auto text-xs font-semibold text-destructive">
                  {preview.errors.map((e, i) => (
                    <li key={i} className="flex items-start gap-1.5">
                      <X className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{e}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11px] font-semibold text-muted">
                  الصفوف المصحفة والأخطاء تُتجاهل عند الحفظ؛ لا تُنشئ شيئاً خاطئاً.
                </p>
              </div>
            ) : (
              <p className="flex items-center gap-2 text-xs font-semibold text-muted">
                <CheckCircle2 className="h-4 w-4 text-success" />
                لا توجد مشاكل — الملف جاهز للحفظ.
              </p>
            )}

            <div className="rounded-xl bg-surface-muted/50 p-3 text-[11px] font-semibold leading-relaxed text-muted">
              عند الحفظ: يُطابق بالمعرّفات الخفية أولاً (ProductID / VariantID / UnitID) ثم
              بالاسم / الباركود. الخلايا الفارغة تُترك كما هي في قاعدة البيانات. الرصيد
              (Stock) يُطبَّق كرصيد افتتاحي للمفاتيح الجديدة فقط ولا يُضاعف عند إعادة الاستيراد.
            </div>
          </div>
        )}
      </ModalShell>

      {/* ── Import summary (after confirm) ─────────────────────────────── */}
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
