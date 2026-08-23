"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, KeyRound, Loader2, ReceiptText, Save, Store as StoreIcon } from "lucide-react";
import Link from "next/link";
import { usePosStore } from "@/store/usePosStore";
import {
  changeAdminAccount,
  fetchSettings,
  fetchTaxSettings,
  updateSettings,
  updateTaxSettings,
} from "@/lib/settingsClient";

interface SettingsForm {
  name: string;
  ownerName: string;
  email: string;
  phone: string;
  logoUrl: string;
  address: string;
  receiptHeader: string;
  receiptFooter: string;
  loyaltyEnabled: boolean;
  pointsPerSpend: string;
  pointValue: string;
  taxPercent: string;
  taxNumber: string;
  receiptShowTaxNumber: boolean;
  receiptShowCashierTime: boolean;
  receiptShowBarcodeQr: boolean;
  receiptCompactSpacing: boolean;
}

const EMPTY: SettingsForm = {
  name: "",
  ownerName: "",
  email: "",
  phone: "",
  logoUrl: "",
  address: "",
  receiptHeader: "",
  receiptFooter: "",
  loyaltyEnabled: true,
  pointsPerSpend: "1",
  pointValue: "0.01",
  taxPercent: "16",
  taxNumber: "",
  receiptShowTaxNumber: true,
  receiptShowCashierTime: true,
  receiptShowBarcodeQr: true,
  receiptCompactSpacing: false,
};

function Input({
  label,
  value,
  onChange,
  placeholder = "",
  dir = "rtl",
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  dir?: "rtl" | "ltr";
  type?: string;
}) {
  return (
    <label className="block text-sm font-bold text-muted">
      {label}
      <input
        type={type}
        dir={dir}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-xl border border-border bg-surface-muted px-4 py-2.5 text-sm font-bold text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
      />
    </label>
  );
}

/**
 * Store-owner settings. Reads + writes ONLY the caller's own store row
 * (every Supabase query is scoped with `.eq("id", storeId)` and enforced by
 * RLS). Requires the admin cashier role.
 */
export default function AdminSettingsPage() {
  const currentStore = usePosStore((s) => s.currentStore);
  const setCurrentStore = usePosStore((s) => s.setCurrentStore);
  const adminSession = usePosStore((s) => s.adminSession);
  const setAdminSessionEmail = usePosStore((s) => s.setAdminSessionEmail);

  const [form, setForm] = useState<SettingsForm>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const [currentPassword, setCurrentPassword] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [savingCred, setSavingCred] = useState(false);
  const [credSaved, setCredSaved] = useState(false);
  const [credError, setCredError] = useState("");

  const [istdTaxNumber, setIstdTaxNumber] = useState("");
  const [istdClientId, setIstdClientId] = useState("");
  const [istdClientSecret, setIstdClientSecret] = useState("");
  const [istdSecretMasked, setIstdSecretMasked] = useState("");
  const [istdConfigured, setIstdConfigured] = useState(false);
  const [savingIstd, setSavingIstd] = useState(false);
  const [istdSaved, setIstdSaved] = useState(false);
  const [istdError, setIstdError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchSettings()
      .then((s) => {
        if (cancelled) return;
        setForm({
          name: s.name,
          ownerName: s.ownerName,
          email: s.email,
          phone: s.phone,
          logoUrl: s.logoUrl,
          address: s.address,
          receiptHeader: s.receiptHeader,
          receiptFooter: s.receiptFooter,
          loyaltyEnabled: s.loyaltyEnabled,
          pointsPerSpend: String(s.pointsPerSpend),
          pointValue: String(s.pointValue),
          taxPercent: String(s.taxPercent),
          taxNumber: s.taxNumber,
          receiptShowTaxNumber: s.receiptShowTaxNumber,
          receiptShowCashierTime: s.receiptShowCashierTime,
          receiptShowBarcodeQr: s.receiptShowBarcodeQr,
          receiptCompactSpacing: s.receiptCompactSpacing,
        });
      })
      .catch(() => {
        /* offline: fall back to the persisted store context */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    fetchTaxSettings()
      .then((t) => {
        if (cancelled) return;
        setIstdTaxNumber(t.taxNumber);
        setIstdClientId(t.istdClientId);
        setIstdSecretMasked(t.istdSecretMasked);
        setIstdConfigured(t.configured);
      })
      .catch(() => {
        /* offline: leave the JoFotara section empty */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Adjust-on-render: seed the form from the login context whenever the store
  // changes, preserving anything the user has already typed.
  const [seededStoreId, setSeededStoreId] = useState<string | null>(null);
  if (currentStore && seededStoreId !== currentStore.id) {
    setSeededStoreId(currentStore.id);
    setForm((prev) => ({
      name: prev.name || currentStore.name,
      ownerName: prev.ownerName || currentStore.ownerName,
      email: prev.email || currentStore.email,
      phone: prev.phone || currentStore.phone,
      logoUrl: prev.logoUrl || currentStore.logoUrl || "",
      address: prev.address || currentStore.address || "",
      receiptHeader: prev.receiptHeader || currentStore.receiptHeader || "",
      receiptFooter: prev.receiptFooter || currentStore.receiptFooter || "",
      loyaltyEnabled: prev.loyaltyEnabled ?? currentStore.loyaltyEnabled ?? true,
      pointsPerSpend:
        prev.pointsPerSpend ||
        (currentStore.pointsPerSpend != null ? String(currentStore.pointsPerSpend) : "1"),
      pointValue:
        prev.pointValue || (currentStore.pointValue != null ? String(currentStore.pointValue) : "0.01"),
      taxPercent:
        prev.taxPercent ||
        (currentStore.taxPercent != null ? String(currentStore.taxPercent) : "16"),
      taxNumber: prev.taxNumber || currentStore.taxNumber || "",
      receiptShowTaxNumber: prev.receiptShowTaxNumber ?? currentStore.receiptShowTaxNumber ?? true,
      receiptShowCashierTime:
        prev.receiptShowCashierTime ?? currentStore.receiptShowCashierTime ?? true,
      receiptShowBarcodeQr: prev.receiptShowBarcodeQr ?? currentStore.receiptShowBarcodeQr ?? true,
      receiptCompactSpacing:
        prev.receiptCompactSpacing ?? currentStore.receiptCompactSpacing ?? false,
    }));
  }

  const save = async () => {
    if (!form.name.trim()) {
      setError("اسم المتجر مطلوب");
      return;
    }
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const data = await updateSettings({
        name: form.name.trim(),
        ownerName: form.ownerName,
        email: form.email,
        phone: form.phone,
        logoUrl: form.logoUrl,
        address: form.address,
        receiptHeader: form.receiptHeader,
        receiptFooter: form.receiptFooter,
        loyaltyEnabled: form.loyaltyEnabled,
        pointsPerSpend: parseFloat(form.pointsPerSpend) || 1,
        pointValue: parseFloat(form.pointValue) || 0.01,
        taxPercent: parseFloat(form.taxPercent) || 0,
        taxNumber: form.taxNumber.trim(),
        receiptShowTaxNumber: form.receiptShowTaxNumber,
        receiptShowCashierTime: form.receiptShowCashierTime,
        receiptShowBarcodeQr: form.receiptShowBarcodeQr,
        receiptCompactSpacing: form.receiptCompactSpacing,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 4000);
      setForm({
        name: data.name,
        ownerName: data.ownerName,
        email: data.email,
        phone: data.phone,
        logoUrl: data.logoUrl,
        address: data.address,
        receiptHeader: data.receiptHeader,
        receiptFooter: data.receiptFooter,
        loyaltyEnabled: data.loyaltyEnabled !== false,
        pointsPerSpend: data.pointsPerSpend != null ? String(data.pointsPerSpend) : "1",
        pointValue: data.pointValue != null ? String(data.pointValue) : "0.01",
        taxPercent: data.taxPercent != null ? String(data.taxPercent) : "16",
        taxNumber: data.taxNumber ?? "",
        receiptShowTaxNumber: data.receiptShowTaxNumber !== false,
        receiptShowCashierTime: data.receiptShowCashierTime !== false,
        receiptShowBarcodeQr: data.receiptShowBarcodeQr !== false,
        receiptCompactSpacing: data.receiptCompactSpacing === true,
      });
      // Mirror into the live store context so receipts update instantly.
      if (currentStore) {
        setCurrentStore({ ...currentStore, ...data, subscriptionStatus: currentStore.subscriptionStatus });
      }
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "تعذر الاتصال بالخادم");
    } finally {
      setSaving(false);
    }
  };

  const saveIstd = async () => {
    if (!istdTaxNumber.trim() || !istdClientId.trim()) {
      setIstdError("الرقم الضريبي و client_id مطلوبان");
      return;
    }
    if (istdClientId.trim() && !istdClientSecret.trim() && !istdSecretMasked) {
      setIstdError("أدخل secret_key لتفعيل JoFotara (يُحفظ مشفّراً في الخادم)");
      return;
    }
    setSavingIstd(true);
    setIstdError("");
    setIstdSaved(false);
    try {
      const data = await updateTaxSettings({
        tax_number: istdTaxNumber.trim(),
        istd_client_id: istdClientId.trim(),
        istd_client_secret: istdClientSecret.trim(),
      });
      setIstdTaxNumber(data.taxNumber);
      setIstdClientId(data.istdClientId);
      setIstdSecretMasked(data.istdSecretMasked);
      setIstdClientSecret("");
      setIstdConfigured(data.configured === true);
      // Mirror the fiscal number onto the receipt QR immediately.
      if (data.taxNumber && currentStore) {
        setCurrentStore({ ...currentStore, taxNumber: data.taxNumber });
      }
      setIstdSaved(true);
      setTimeout(() => setIstdSaved(false), 4000);
    } catch (err) {
      setIstdError(err instanceof Error && err.message ? err.message : "تعذر الاتصال بالخادم");
    } finally {
      setSavingIstd(false);
    }
  };

  const saveCredentials = async () => {
    if (!currentPassword) {
      setCredError("كلمة المرور الحالية مطلوبة");
      return;
    }
    if (!newEmail && !newPassword) {
      setCredError("أدخل بريداً إلكترونياً جديداً أو كلمة مرور جديدة");
      return;
    }
    if (newPassword && newPassword.length < 8) {
      setCredError("كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل");
      return;
    }
    if (newEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      setCredError("البريد الإلكتروني الجديد غير صالح");
      return;
    }
    const sessionEmail = adminSession?.email ?? "";
    if (!sessionEmail) {
      setCredError("لا توجد جلسة أدمن نشطة");
      return;
    }
    setSavingCred(true);
    setCredError("");
    setCredSaved(false);
    try {
      const data = await changeAdminAccount({
        current_password: currentPassword,
        new_email: newEmail.trim(),
        new_password: newPassword,
      });
      const changedEmail = data.email?.toLowerCase() ?? "";
      if (changedEmail && changedEmail !== sessionEmail) {
        setAdminSessionEmail(changedEmail);
        setForm((prev) => ({ ...prev, email: changedEmail }));
      }
      setCurrentPassword("");
      setNewEmail("");
      setNewPassword("");
      setCredSaved(true);
      setTimeout(() => setCredSaved(false), 4000);
    } catch (err) {
      setCredError(err instanceof Error && err.message ? err.message : "تعذر الاتصال بالخادم");
    } finally {
      setSavingCred(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-black text-foreground">
          <StoreIcon className="h-6 w-6 text-primary" />
          إعدادات المتجر
        </h1>
        <p className="mt-1 text-sm font-semibold text-muted">
          بيانات الهوية والعلامة التجارية التي تظهر على إيصالات الطباعة الحراري.
        </p>
      </header>

      {loading ? (
        <p className="flex items-center justify-center gap-2 rounded-2xl border border-border bg-surface p-10 text-sm font-bold text-muted">
          <Loader2 className="h-5 w-5 animate-spin" />
          جارٍ التحميل…
        </p>
      ) : (
        <>
          <section className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
            <h2 className="text-sm font-black text-foreground">معلومات المتجر</h2>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <Input label="اسم المتجر *" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
              <Input label="اسم المالك" value={form.ownerName} onChange={(v) => setForm({ ...form, ownerName: v })} />
              <Input label="البريد الإلكتروني" value={form.email} onChange={(v) => setForm({ ...form, email: v })} />
              <Input label="رقم الهاتف" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
            </div>
          </section>

          <section className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
            <h2 className="flex items-center gap-2 text-sm font-black text-foreground">
              <KeyRound className="h-4 w-4 text-primary" />
              بيانات الدخول (مدير المتجر)
            </h2>
            <p className="mt-1 text-sm font-semibold text-muted">
              غيّر البريد أو كلمة المرور المستخدمة في الدخول إلى لوحة المتجر. كلمة المرور
              الحالية مطلوبة دائماً، والجلسة الحالية تُحدَّث تلقائياً عند تغيير البريد.
            </p>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <Input
                label="كلمة المرور الحالية *"
                value={currentPassword}
                onChange={setCurrentPassword}
                dir="ltr"
                type="password"
                placeholder="••••••••"
              />
              <Input
                label="البريد الإلكتروني الجديد (اختياري)"
                value={newEmail}
                onChange={setNewEmail}
                dir="ltr"
                placeholder="admin@new-mail.com"
              />
              <Input
                label="كلمة المرور الجديدة (اختياري، 8 أحرف على الأقل)"
                value={newPassword}
                onChange={setNewPassword}
                dir="ltr"
                type="password"
                placeholder="••••••••"
              />
            </div>
            <div className="mt-4 flex items-center gap-3">
              {credSaved && (
                <span className="flex items-center gap-1.5 text-sm font-black text-success">
                  <CheckCircle2 className="h-4 w-4" />
                  تم تحديث بيانات الدخول
                </span>
              )}
              {credError && <span className="text-sm font-bold text-destructive">{credError}</span>}
            </div>
            <button
              type="button"
              onClick={() => void saveCredentials()}
              disabled={savingCred}
              className="mt-3 flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-black text-primary-foreground shadow-sm transition hover:bg-primary-hover active:scale-[0.98] disabled:opacity-40"
            >
              {savingCred ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              تحديث بيانات الدخول
            </button>
          </section>

          <section className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
            <h2 className="text-sm font-black text-foreground">العلامة التجارية على الإيصال</h2>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <Input
                label="رابط الشعار (URL)"
                value={form.logoUrl}
                onChange={(v) => setForm({ ...form, logoUrl: v })}
                dir="ltr"
                placeholder="https://…"
              />
              <Input label="العنوان" value={form.address} onChange={(v) => setForm({ ...form, address: v })} />
              <div className="md:col-span-2">
                <label className="block text-sm font-bold text-muted">
                  رسالة أعلى الإيصال
                  <textarea
                    value={form.receiptHeader}
                    onChange={(e) => setForm({ ...form, receiptHeader: e.target.value })}
                    rows={2}
                    className="mt-1 w-full resize-none rounded-xl border border-border bg-surface-muted px-4 py-2.5 text-sm font-bold text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
                  />
                </label>
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-bold text-muted">
                  رسالة أسفل الإيصال
                  <textarea
                    value={form.receiptFooter}
                    onChange={(e) => setForm({ ...form, receiptFooter: e.target.value })}
                    rows={2}
                    className="mt-1 w-full resize-none rounded-xl border border-border bg-surface-muted px-4 py-2.5 text-sm font-bold text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
                  />
                </label>
              </div>
            </div>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
              <div><h3 className="text-sm font-black text-foreground">تصميم الفاتورة</h3><p className="mt-0.5 text-xs font-semibold text-muted">ترتيب العناصر والمقاس والباركود وQR تُدار من استوديو الطباعة.</p></div>
              <Link href="/admin/print-studio" className="flex h-10 items-center rounded-lg bg-primary px-4 text-sm font-black text-primary-foreground">فتح استوديو الطباعة</Link>
            </div>
          </section>

          <section className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
            <h2 className="text-sm font-black text-foreground">نقاط الولاء</h2>
            <p className="mt-1 text-sm font-semibold text-muted">
              يربح الزبون نقاطاً عند الدفع النقدي على كل فاتورة، ويستبدلها بخصم من رصيده.
            </p>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <label className="flex items-center gap-3 rounded-xl border border-border bg-surface-muted px-4 py-3 text-sm font-bold text-foreground">
                <input
                  type="checkbox"
                  checked={form.loyaltyEnabled}
                  onChange={(e) => setForm({ ...form, loyaltyEnabled: e.target.checked })}
                  className="h-5 w-5 accent-primary"
                />
                تفعيل نقاط الولاء
              </label>
              <Input
                label="عملة لكل نقطة (افتراضي 1)"
                value={form.pointsPerSpend}
                onChange={(v) => setForm({ ...form, pointsPerSpend: v })}
                dir="ltr"
              />
              <Input
                label="قيمة النقطة عند الاستبدال (افتراضي 0.01)"
                value={form.pointValue}
                onChange={(v) => setForm({ ...form, pointValue: v })}
                dir="ltr"
              />
            </div>
          </section>

          <section className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
            <h2 className="text-sm font-black text-foreground">الضريبة (فيسكالي)</h2>
            <p className="mt-1 text-sm font-semibold text-muted">
              نسبة الضريبة المضافة ورقمها الضريبي تظهر على الإيصال وتُشفر داخل رمز QR
              (الاسم • الرقم الضريبي • الوقت • الإجمالي • قيمة الضريبة). اجعل النسبة 0 لإخفاء
              تفصيل الضريبة والرمز تماماً.
            </p>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <Input
                label="نسبة الضريبة % (0 = بدون ضريبة)"
                value={form.taxPercent}
                onChange={(v) => setForm({ ...form, taxPercent: v })}
                dir="ltr"
              />
              <Input
                label="الرقم الضريبي"
                value={form.taxNumber}
                onChange={(v) => setForm({ ...form, taxNumber: v })}
                dir="ltr"
                placeholder="311122233300003"
              />
            </div>
          </section>

          <section className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
            <h2 className="flex items-center gap-2 text-sm font-black text-foreground">
              <ReceiptText className="h-4 w-4 text-primary" />
              الفواتير الإلكترونية (JoFotara / ISTD)
            </h2>
            <p className="mt-1 text-sm font-semibold text-muted">
              ربط المتجر بمنصة ISTD الأردنية لإصدار فواتير إلكترونية مدمجة بالرمز الضريبي
              QR. تُخزَّن البيانات داخل قاعدة البيانات لهذا المتجر فقط (لا تُقرأ من ملفات
              البيئة)، ولا تظهر بيانات JoFotara كاملة بعد الحفظ.
            </p>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <Input
                label="الرقم الضريبي (TIN)"
                value={istdTaxNumber}
                onChange={(v) => setIstdTaxNumber(v)}
                dir="ltr"
                placeholder="15 رقماً"
              />
              <Input
                label="JoFotara client_id"
                value={istdClientId}
                onChange={(v) => setIstdClientId(v)}
                dir="ltr"
                placeholder="issuer_device id"
              />
              <div className="md:col-span-2">
                <label className="block text-sm font-bold text-muted">
                  JoFotara secret_key
                  <input
                    dir="ltr"
                    type="password"
                    value={istdClientSecret}
                    placeholder={istdSecretMasked ? `${istdSecretMasked} (اتركه فارغاً للإبقاء عليه)` : "••••••••••••"}
                    onChange={(e) => setIstdClientSecret(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-border bg-surface-muted px-4 py-2.5 text-sm font-bold text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
                  />
                </label>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {istdConfigured && (
                <span className="flex items-center gap-1.5 text-sm font-black text-success">
                  <CheckCircle2 className="h-4 w-4" />
                  مفعّلة
                </span>
              )}
              {istdSaved && (
                <span className="flex items-center gap-1.5 text-sm font-black text-success">
                  <CheckCircle2 className="h-4 w-4" />
                  تم حفظ بيانات الفوترة
                </span>
              )}
              {istdError && <span className="text-sm font-bold text-destructive">{istdError}</span>}
            </div>
            <button
              type="button"
              onClick={() => void saveIstd()}
              disabled={savingIstd}
              className="mt-3 flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-black text-primary-foreground shadow-sm transition hover:bg-primary-hover active:scale-[0.98] disabled:opacity-40"
            >
              {savingIstd ? <Loader2 className="h-4 w-4 animate-spin" /> : <ReceiptText className="h-4 w-4" />}
              حفظ بيانات الفوترة الإلكترونية
            </button>
          </section>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {saved && (
                <span className="flex items-center gap-1.5 text-sm font-black text-success">
                  <CheckCircle2 className="h-4 w-4" />
                  تم الحفظ
                </span>
              )}
              {error && <span className="text-sm font-bold text-destructive">{error}</span>}
            </div>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="flex items-center gap-2 rounded-xl bg-success px-6 py-3 text-sm font-black text-success-foreground shadow-sm transition hover:bg-success-hover active:scale-[0.98] disabled:opacity-40"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              حفظ الإعدادات
            </button>
          </div>
        </>
      )}
    </div>
  );
}
