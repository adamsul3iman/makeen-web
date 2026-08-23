"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Ban,
  Building2,
  CheckCircle2,
  Copy,
  Loader2,
  Lock,
  LogOut,
  Plus,
  ShieldCheck,
  Store,
  Trash2,
  UserRound,
} from "lucide-react";
import {
  createStore as createStoreRequest,
  deleteStore as deleteStoreRequest,
  fetchStores,
  updateStoreStatus,
  type SuperAdminStore,
} from "@/lib/superAdminClient";

const SUPER_PIN_STORAGE_KEY = "pos-super-admin-pin";

type AdminStore = SuperAdminStore;

const EMPTY_FORM = { name: "", owner_name: "", email: "", phone: "", password: "", code: "" };

async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Clipboard API unavailable (non-secure context) — fall through.
    }
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

function StoreCode({
  code,
  copied,
  onCopy,
  large = false,
}: {
  code: string;
  copied: boolean;
  onCopy: () => void;
  large?: boolean;
}) {
  if (!code) {
    return <span className="text-muted">—</span>;
  }
  return (
    <div className="flex items-center gap-2">
      <span
        dir="ltr"
        className={`inline-flex items-center justify-center rounded-lg bg-slate-900 font-mono font-black tracking-widest text-white ${
          large ? "px-4 py-2 text-xl" : "px-2.5 py-1 text-sm"
        }`}
      >
        {code}
      </span>
      <button
        type="button"
        onClick={onCopy}
        title="نسخ كود المتجر"
        aria-label="نسخ كود المتجر"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border text-muted transition hover:bg-surface-muted hover:text-foreground"
      >
        {copied ? <CheckCircle2 className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}

/**
 * Platform-owner console. Nothing renders until the Super Admin PIN (7777)
 * validates against the provisioning API — the gate is enforced server-side
 * on every list/create/suspend call, not just in this UI.
 */
export default function SuperAdminPage() {
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);

  const [stores, setStores] = useState<AdminStore[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const [formError, setFormError] = useState("");

  const [toggling, setToggling] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [createdStore, setCreatedStore] = useState<AdminStore | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copyCode = useCallback(async (store: AdminStore) => {
    const ok = await copyText(store.code);
    if (!ok) return;
    setCopiedId(store.id);
    window.setTimeout(() => setCopiedId((prev) => (prev === store.id ? null : prev)), 1500);
  }, []);

  const loadStores = useCallback(async () => {
    setLoading(true);
    setListError("");
    try {
      const data = await fetchStores();
      setStores(Array.isArray(data) ? data : []);
    } catch {
      setListError("تعذر الاتصال بالخادم");
      setStores([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Restore a previously verified PIN for the session.
  useEffect(() => {
    const saved = sessionStorage.getItem(SUPER_PIN_STORAGE_KEY);
    if (!saved) return;
    let cancelled = false;
    void Promise.resolve()
      .then(() => loadStores())
      .then(() => {
        if (cancelled) return;
        setPin(saved);
        setAuthorized(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loadStores]);

  const unlock = async () => {
    const code = pin.trim();
    if (code.length === 0) {
      setPinError("أدخل رمز مدير النظام");
      return;
    }
    setBusy(true);
    setPinError("");
    try {
      await fetchStores();
      sessionStorage.setItem(SUPER_PIN_STORAGE_KEY, code);
      setAuthorized(true);
      void loadStores();
    } catch {
      setPinError("رمز PIN غير صحيح");
    } finally {
      setBusy(false);
    }
  };

  const lock = () => {
    sessionStorage.removeItem(SUPER_PIN_STORAGE_KEY);
    setAuthorized(false);
    setPin("");
    setStores([]);
  };

  const toggleStatus = async (store: AdminStore) => {
    const next = store.subscriptionStatus === "active" ? "suspended" : "active";
    setToggling(store.id);
    try {
      await updateStoreStatus(store.id, next);
      setStores((prev) =>
        prev.map((s) => (s.id === store.id ? { ...s, subscriptionStatus: next } : s)),
      );
    } catch (err) {
      setListError(
        err instanceof Error && err.message ? err.message : "تعذر تحديث حالة المتجر",
      );
    } finally {
      setToggling(null);
    }
  };

  const deleteStore = async () => {
    const id = confirmDeleteId;
    if (!id) return;
    setDeleting(id);
    setListError("");
    try {
      await deleteStoreRequest(id);
      setStores((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setListError(err instanceof Error && err.message ? err.message : "تعذر حذف المتجر");
    } finally {
      setDeleting(null);
      setConfirmDeleteId(null);
    }
  };

  const createStore = async () => {
    if (creatingRef.current) return;
    if (!form.name.trim()) {
      setFormError("اسم المتجر مطلوب");
      return;
    }
    if (form.password.trim().length < 8) {
      setFormError("كلمة المرور يجب أن تكون 8 أحرف على الأقل");
      return;
    }
    const storeCode = form.code.trim().toUpperCase();
    if (storeCode && !/^[A-Z0-9]{4,12}$/.test(storeCode)) {
      setFormError("كود المتجر يجب أن يتكون من 4-12 حرفاً/رقماً إنجليزياً فقط");
      return;
    }
    creatingRef.current = true;
    setCreating(true);
    setFormError("");
    try {
      const created = await createStoreRequest({ ...form, code: storeCode });
      setStores((prev) => [created, ...prev]);
      setCreatedStore(created);
      setForm(EMPTY_FORM);
      setCreateOpen(false);
    } catch (err) {
      setFormError(err instanceof Error && err.message ? err.message : "تعذر إنشاء المتجر");
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  if (!authorized) {
    return (
      <div dir="rtl" lang="ar" className="flex min-h-screen items-center justify-center bg-slate-950 p-6">
        <div className="w-full max-w-sm rounded-3xl bg-white p-8 shadow-2xl">
          <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-2xl bg-slate-900 text-sky-400">
            <ShieldCheck className="h-9 w-9" />
          </div>
          <h1 className="text-center text-2xl font-black text-foreground">مدير النظام</h1>
          <p className="mt-1 flex items-center justify-center gap-1.5 text-center text-sm font-semibold text-muted">
            <Lock className="h-3.5 w-3.5" />
            أدخل رمز الوصول لإدارة المنصة
          </p>

          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={4}
            autoFocus
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && void unlock()}
            placeholder="••••"
            className="mt-6 w-full rounded-xl border border-border bg-surface-muted px-4 py-3 text-center text-3xl font-black tracking-[0.5em] text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
          />
          <p className="mt-2 h-5 text-center text-sm font-bold text-destructive" aria-live="polite">
            {pinError}
          </p>
          <button
            type="button"
            onClick={() => void unlock()}
            disabled={busy}
            className="mt-2 flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-slate-900 text-lg font-black text-white transition hover:bg-slate-800 active:scale-[0.98] disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Lock className="h-5 w-5" />}
            دخول
          </button>
        </div>
      </div>
    );
  }

  const activeCount = stores.filter((s) => s.subscriptionStatus === "active").length;
  const suspendedCount = stores.length - activeCount;

  return (
    <div dir="rtl" lang="ar" className="min-h-screen bg-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-800 bg-slate-900 px-6 py-4">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-slate-800 text-sky-400">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div>
              <p className="text-base font-black text-white">MAKEEN</p>
              <p className="text-xs text-slate-400">لوحة مدير النظام — إدارة المتاجر والاشتراكات</p>
            </div>
          </div>
          <button
            type="button"
            onClick={lock}
            className="flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-2 text-sm font-bold text-slate-300 transition hover:bg-slate-700 hover:text-white"
          >
            <LogOut className="h-4 w-4" />
            قفل
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black text-foreground">المتاجر</h1>
            <p className="mt-1 text-sm font-semibold text-muted">
              كل المتاجر المستأجرة على المنصة — إنشاء متاجر جديدة وإدارة الاشتراكات.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setFormError("");
              setCreateOpen((v) => !v);
            }}
            className="flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-black text-white transition hover:bg-slate-800"
          >
            {createOpen ? <Lock className="h-4 w-4 rotate-45" /> : <Plus className="h-4 w-4" />}
            {createOpen ? "إلغاء" : "متجر جديد"}
          </button>
        </div>

        {/* Summary cards */}
        <div className="mt-6 grid grid-cols-3 gap-4">
          <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
            <p className="text-xs font-bold text-muted">إجمالي المتاجر</p>
            <p className="mt-2 text-3xl font-black tabular-nums text-foreground">{stores.length}</p>
          </div>
          <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
            <p className="flex items-center gap-1 text-xs font-bold text-muted">
              <CheckCircle2 className="h-3.5 w-3.5 text-success" />
              نشط
            </p>
            <p className="mt-2 text-3xl font-black tabular-nums text-success">{activeCount}</p>
          </div>
          <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
            <p className="flex items-center gap-1 text-xs font-bold text-muted">
              <Ban className="h-3.5 w-3.5 text-destructive" />
              موقوف
            </p>
            <p className="mt-2 text-3xl font-black tabular-nums text-destructive">{suspendedCount}</p>
          </div>
        </div>

        {/* Newly created store — surface the login code immediately */}
        {createdStore && (
          <div className="mt-6 rounded-2xl border border-success/30 bg-success/5 p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-black text-foreground">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
                  تم إنشاء «{createdStore.name}»
                </p>
                <p className="mt-1 text-xs font-semibold text-muted">
                  هذا هو كود المتجر — امنحه للموظفين، يكتبونه في شاشة تسجيل الدخول (كود
                  المتجر) لتسجيل الدخول.
                </p>
              </div>
              <StoreCode
                code={createdStore.code}
                copied={copiedId === createdStore.id}
                onCopy={() => void copyCode(createdStore)}
                large
              />
            </div>
          </div>
        )}

        {createOpen && (
          <section className="mt-6 rounded-2xl border border-border bg-surface p-6 shadow-sm">
            <h2 className="flex items-center gap-2 text-sm font-black text-foreground">
              <Building2 className="h-4 w-4 text-muted" />
              توفير متجر جديد
            </h2>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <label className="block text-sm font-bold text-muted">
                اسم المتجر *
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="mt-1 w-full rounded-xl border border-border bg-surface-muted px-4 py-2.5 text-sm font-bold text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
                />
              </label>
              <label className="block text-sm font-bold text-muted">
                اسم المالك
                <input
                  value={form.owner_name}
                  onChange={(e) => setForm({ ...form, owner_name: e.target.value })}
                  className="mt-1 w-full rounded-xl border border-border bg-surface-muted px-4 py-2.5 text-sm font-bold text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
                />
              </label>
              <label className="block text-sm font-bold text-muted">
                البريد الإلكتروني
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className="mt-1 w-full rounded-xl border border-border bg-surface-muted px-4 py-2.5 text-sm font-bold text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
                />
              </label>
              <label className="block text-sm font-bold text-muted">
                الهاتف
                <input
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  className="mt-1 w-full rounded-xl border border-border bg-surface-muted px-4 py-2.5 text-sm font-bold text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
                />
              </label>
              <label className="block text-sm font-bold text-muted">
                كود المتجر (اختياري)
                <input
                  value={form.code}
                  onChange={(e) =>
                    setForm({ ...form, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })
                  }
                  placeholder="مثال: BURJ أو AMMAN1"
                  dir="ltr"
                  maxLength={12}
                  className="mt-1 w-full rounded-xl border border-border bg-surface-muted px-4 py-2.5 text-sm font-bold text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
                />
              </label>
              <label className="block text-sm font-bold text-muted">
                كلمة مرور المالك *
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder="8 أحرف على الأقل"
                  className="mt-1 w-full rounded-xl border border-border bg-surface-muted px-4 py-2.5 text-sm font-bold text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
                />
              </label>
            </div>
            <p className="mt-3 text-xs font-semibold text-muted">
              سينشأ المتجر بكلمة مرور المالك التي أدخلتها — احفظها، لن تظهر مرة أخرى بعد
              الإنشاء، وسيتمكن المالك من تغييرها لاحقاً من حساب البريد/الإدارة.
            </p>
            <p className="mt-1.5 text-xs font-semibold text-muted">
              كود المتجر هو ما يكتبه الكاشير وأمين المخزون في شاشة تسجيل الدخول — اتركه
              فارغاً لتوليد كود تلقائي من 6 أحرف، أو اختر كوداً مخصصاً (4-12 حرفاً/رقماً).
            </p>
            <div className="mt-4 flex items-center justify-between">
              <p className="text-sm font-bold text-destructive">{formError}</p>
              <button
                type="button"
                onClick={() => void createStore()}
                disabled={creating}
                className="flex items-center gap-2 rounded-xl bg-success px-5 py-2.5 text-sm font-black text-success-foreground transition hover:bg-success-hover disabled:opacity-40"
              >
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                إنشاء
              </button>
            </div>
          </section>
        )}

        {/* Store list */}
        <section className="mt-6 overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
          {listError && (
            <p className="border-b border-border bg-destructive/5 px-5 py-3 text-sm font-bold text-destructive">
              {listError}
            </p>
          )}
          {loading ? (
            <p className="flex items-center justify-center gap-2 px-5 py-12 text-sm font-bold text-muted">
              <Loader2 className="h-5 w-5 animate-spin" />
              جارٍ التحميل…
            </p>
          ) : stores.length === 0 ? (
            <p className="px-5 py-12 text-center text-sm font-bold text-muted">لا توجد متاجر بعد</p>
          ) : (
            <div className="scrollbar-hidden overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-right text-xs font-bold text-muted">
                    <th className="px-5 py-3">المتجر</th>
                    <th className="px-5 py-3">كود المتجر</th>
                    <th className="px-5 py-3">المالك</th>
                    <th className="px-5 py-3">التواصل</th>
                    <th className="px-5 py-3">الحالة</th>
                    <th className="px-5 py-3">الإجراء</th>
                  </tr>
                </thead>
                <tbody>
                  {stores.map((s) => (
                    <tr key={s.id} className="border-b border-border/60 text-right">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2.5">
                          <span className="grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-slate-600">
                            <Store className="h-5 w-5" />
                          </span>
                          <span className="font-black text-foreground">{s.name}</span>
                        </div>
                      </td>
                      <td className="px-5 py-3">
                        <StoreCode
                          code={s.code}
                          copied={copiedId === s.id}
                          onCopy={() => void copyCode(s)}
                        />
                      </td>
                      <td className="px-5 py-3 text-muted">{s.ownerName || "—"}</td>
                      <td className="px-5 py-3 text-muted">
                        <p>{s.phone || "—"}</p>
                        <p className="text-xs">{s.email || ""}</p>
                      </td>
                      <td className="px-5 py-3">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-black ${
                            s.subscriptionStatus === "active"
                              ? "bg-success/10 text-success"
                              : "bg-destructive/10 text-destructive"
                          }`}
                        >
                          {s.subscriptionStatus === "active" ? (
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          ) : (
                            <Ban className="h-3.5 w-3.5" />
                          )}
                          {s.subscriptionStatus === "active" ? "نشط" : "موقوف"}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => void toggleStatus(s)}
                            disabled={toggling === s.id}
                            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-black transition disabled:opacity-40 ${
                              s.subscriptionStatus === "active"
                                ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
                                : "bg-success/10 text-success hover:bg-success/20"
                            }`}
                          >
                            {toggling === s.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : s.subscriptionStatus === "active" ? (
                              <Ban className="h-3.5 w-3.5" />
                            ) : (
                              <CheckCircle2 className="h-3.5 w-3.5" />
                            )}
                            {s.subscriptionStatus === "active" ? "إيقاف" : "تفعيل"}
                          </button>
                          {confirmDeleteId === s.id ? (
                            <span className="flex items-center gap-1.5">
                              <span className="text-xs font-black text-destructive">حذف نهائي؟</span>
                              <button
                                type="button"
                                onClick={() => void deleteStore()}
                                disabled={deleting === s.id}
                                className="rounded-lg bg-destructive px-2.5 py-1.5 text-xs font-black text-white transition hover:bg-destructive/90 disabled:opacity-40"
                              >
                                {deleting === s.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  "تأكيد"
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                                disabled={deleting === s.id}
                                className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-black text-muted transition hover:bg-surface-muted disabled:opacity-40"
                              >
                                إلغاء
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(s.id)}
                              disabled={deleting === s.id}
                              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-black text-destructive transition hover:bg-destructive/10 disabled:opacity-40"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              حذف
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <p className="mt-6 flex items-center gap-1.5 text-xs font-semibold text-muted">
          <UserRound className="h-3.5 w-3.5" />
          الإيقاف يمنع تسجيل الدخول فوراً للمتجر المعني دون حذف أي بيانات. الحذف يزيل المتجر
          وكل بياناته نهائياً (الكاشيرات، الكتالوج، الفروع، العملاء، المعاملات…).
        </p>
      </main>
    </div>
  );
}
