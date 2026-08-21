"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  Camera,
  CheckCircle,
  CircleAlert,
  Loader,
  LogOut,
  PackagePlus,
  Plus,
  RefreshCw,
  ScanBarcode,
  Trash,
} from "lucide-react";
import BarcodeScanner from "@/components/mobile/BarcodeScanner";

interface CategoryOption {
  id: string;
  name: string;
}

interface SupplierOption {
  id: string;
  name: string;
}

interface CategoryReferenceItem {
  id: string;
  name: string;
}

interface SupplierReferenceItem {
  id: string;
  name: string;
}

function parsePrice(value: string): number {
  const raw = value.trim().replace(/[،]/g, ".");
  const n = Number(raw);
  return Number.isFinite(n) ? n : Number.NaN;
}

function normalizeBarcode(value: string): string {
  return value.trim().replace(/\s+/g, "");
}

/**
 * Camera-driven product creation for the mobile page. Scans one or more
 * barcodes for the product, collects name + prices + category + supplier, and
 * POSTs the same payload shape as the back-office catalog form to
 * /api/catalog/products (authorized for the narrow `catalog.add` capability).
 */
export default function AddProductForm({
  storeName,
  cashierLabel,
  storeTaxPercent,
  onLogout,
}: {
  storeName: string;
  cashierLabel: string;
  storeTaxPercent: number;
  onLogout: () => void;
}) {
  const storeTax = Number.isFinite(storeTaxPercent) ? storeTaxPercent : 16;
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [wholesale, setWholesale] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [barcodes, setBarcodes] = useState<string[]>([]);
  const [manualBarcode, setManualBarcode] = useState("");
  const [scanOpen, setScanOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<{ name: string; barcodes: string[] } | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/catalog/references?type=category", { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { items?: CategoryReferenceItem[] } | null) => {
        if (!active || !data?.items) return;
        const sorted = [...data.items].sort((a, b) => a.name.localeCompare(b.name, "ar"));
        setCategories(sorted.map((item) => ({ id: item.id, name: item.name })));
      })
      .catch(() => {
        // The dropdown is optional — the form still works without categories.
      });
    void fetch("/api/catalog/references?type=supplier", { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { items?: SupplierReferenceItem[] } | null) => {
        if (!active || !data?.items) return;
        const sorted = [...data.items].sort((a, b) => a.name.localeCompare(b.name, "ar"));
        setSuppliers(sorted.map((item) => ({ id: item.id, name: item.name })));
      })
      .catch(() => {
        // The dropdown is optional — the form still works without suppliers.
      });
    return () => {
      active = false;
    };
  }, []);

  const handleDetected = useCallback((barcode: string) => {
    setBarcodes((previous) => (previous.includes(barcode) ? previous : [...previous, barcode]));
    setScanOpen(false);
  }, []);

  const addManualBarcode = () => {
    const barcode = normalizeBarcode(manualBarcode);
    setManualBarcode("");
    if (!barcode) return;
    setBarcodes((previous) => (previous.includes(barcode) ? previous : [...previous, barcode]));
  };

  const removeBarcode = (barcode: string) => {
    setBarcodes((previous) => previous.filter((item) => item !== barcode));
  };

  const resetForm = () => {
    setName("");
    setPrice("");
    setCost("");
    setWholesale("");
    setCategoryId("");
    setSupplierId("");
    setBarcodes([]);
    setScanOpen(false);
    setError("");
    setSaved(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");

    const productName = name.trim();
    if (!productName) {
      setError("أدخل اسم المنتج");
      return;
    }
    if (barcodes.length === 0) {
      setError("امسح باركود المنتج بالكاميرا أو أدخله يدوياً أولاً");
      return;
    }
    const priceValue = parsePrice(price);
    const costValue = parsePrice(cost);
    const wholesaleValue = parsePrice(wholesale);
    if (!Number.isFinite(priceValue) || priceValue < 0) {
      setError("أدخل سعر بيع صحيحاً");
      return;
    }
    if (!Number.isFinite(costValue) || costValue < 0) {
      setError("أدخل سعر التكلفة صحيحاً");
      return;
    }
    if (!Number.isFinite(wholesaleValue) || wholesaleValue < 0) {
      setError("أدخل سعر الجملة صحيحاً");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/catalog/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          name: productName,
          categoryId,
          category: "",
          brandId: "",
          brand: "",
          supplierId,
          supplier: "",
          baseUnit: "حبة",
          stock: 0,
          taxPercent: storeTax,
          taxIncluded: true,
          isActive: true,
          showInPos: true,
          isSellable: true,
          isPurchasable: true,
          allowPriceChange: false,
          reorderLevel: 0,
          variants: barcodes.map((barcode, index) => ({
            barcode,
            variantLabel: "",
            costPrice: costValue,
            price: priceValue,
            wholesalePrice: wholesaleValue,
            isDefaultSale: index === 0,
          })),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.status === 401 || response.status === 403) {
        setError("انتهت الجلسة — سجّل الدخول مجدداً");
        onLogout();
        return;
      }
      if (!response.ok) {
        setError(data.error ?? "تعذر حفظ المنتج");
        return;
      }
      setSaved({ name: productName, barcodes: [...barcodes] });
    } catch {
      setError("تعذر الاتصال بالخادم — تحقق من اتصالك وحاول مجدداً");
    } finally {
      setBusy(false);
    }
  };

  if (saved) {
    return (
      <div dir="rtl" className="flex min-h-screen items-center justify-center bg-gray-100 p-6">
        <div className="w-full max-w-sm rounded-3xl bg-white p-8 text-center shadow-xl">
          <CheckCircle className="mx-auto h-14 w-14 text-success" />
          <h2 className="mt-4 text-xl font-black text-foreground">تم حفظ المنتج</h2>
          <p className="mt-2 text-sm font-bold text-muted">{saved.name}</p>
          <p className="mt-1 text-xs font-semibold text-muted-foreground">
            الباركود: {saved.barcodes.join("، ")}
          </p>
          <button
            type="button"
            onClick={resetForm}
            className="mt-6 flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-primary text-base font-black text-primary-foreground shadow-sm transition hover:bg-primary-hover active:scale-[0.98]"
          >
            <PackagePlus className="h-5 w-5" />
            إضافة منتج آخر
          </button>
        </div>
      </div>
    );
  }

  return (
    <div dir="rtl" className="min-h-screen bg-gray-100">
      <header className="sticky top-0 z-10 border-b border-border bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-md items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 flex-col">
            <p className="truncate text-sm font-black text-foreground">{storeName}</p>
            <p className="truncate text-xs font-semibold text-muted">
              {cashierLabel}
            </p>
          </div>
          <button
            type="button"
            onClick={onLogout}
            aria-label="تسجيل الخروج"
            className="flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-destructive/10 px-3 text-sm font-black text-destructive transition hover:bg-destructive/20"
          >
            <LogOut className="h-4 w-4" />
            خروج
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-md px-4 py-5">
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm font-bold text-destructive">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={submit} className="space-y-4">
          <section className="rounded-2xl border border-border bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="flex items-center gap-1.5 text-sm font-black text-foreground">
                <ScanBarcode className="h-4 w-4 text-primary" />
                الباركود
              </h3>
              {!scanOpen && (
                <button
                  type="button"
                  onClick={() => setScanOpen(true)}
                  className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-primary px-3 text-sm font-black text-primary-foreground transition hover:bg-primary-hover"
                >
                  <Camera className="h-4 w-4" />
                  مسح بالكاميرا
                </button>
              )}
            </div>

            {scanOpen && (
              <BarcodeScanner
                enabled={scanOpen}
                onDetected={handleDetected}
                onRequestClose={() => setScanOpen(false)}
              />
            )}

            {barcodes.length > 0 && (
              <ul className="mt-3 space-y-2">
                {barcodes.map((barcode) => (
                  <li
                    key={barcode}
                    className="flex items-center justify-between gap-2 rounded-xl border border-border bg-surface-muted px-3 py-2.5"
                  >
                    <span dir="ltr" className="font-mono text-sm font-bold text-foreground">
                      {barcode}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeBarcode(barcode)}
                      aria-label={`حذف الباركود ${barcode}`}
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-3 flex gap-2">
              <input
                type="text"
                inputMode="numeric"
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                value={manualBarcode}
                onChange={(event) => setManualBarcode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addManualBarcode();
                  }
                }}
                placeholder="أو أدخل الباركود يدوياً…"
                className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-surface-muted px-3 font-mono text-sm font-bold text-foreground outline-none transition focus:border-primary"
              />
              <button
                type="button"
                onClick={addManualBarcode}
                className="flex h-11 shrink-0 items-center justify-center gap-1 rounded-xl border border-border bg-white px-3 text-sm font-black text-foreground transition hover:bg-surface-muted"
              >
                <Plus className="h-4 w-4" />
                إضافة
              </button>
            </div>
          </section>

          <section className="space-y-4 rounded-2xl border border-border bg-white p-4 shadow-sm">
            <div>
              <label htmlFor="product-name" className="mb-1.5 block text-sm font-black text-foreground">
                اسم المنتج *
              </label>
              <input
                id="product-name"
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="مثال: حليب كامل الدسم 1 لتر"
                disabled={busy}
                className="h-12 w-full rounded-xl border border-border bg-surface-muted px-3 text-base font-bold text-foreground outline-none transition focus:border-primary disabled:opacity-40"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="product-price" className="mb-1.5 block text-sm font-black text-foreground">
                  سعر البيع *
                </label>
                <input
                  id="product-price"
                  type="text"
                  inputMode="decimal"
                  dir="ltr"
                  value={price}
                  onChange={(event) => setPrice(event.target.value)}
                  placeholder="0.00"
                  disabled={busy}
                  className="h-12 w-full rounded-xl border border-border bg-surface-muted px-3 text-right font-mono text-base font-bold text-foreground outline-none transition focus:border-primary disabled:opacity-40"
                />
              </div>
              <div>
                <label htmlFor="product-cost" className="mb-1.5 block text-sm font-black text-foreground">
                  التكلفة
                </label>
                <input
                  id="product-cost"
                  type="text"
                  inputMode="decimal"
                  dir="ltr"
                  value={cost}
                  onChange={(event) => setCost(event.target.value)}
                  placeholder="0.00"
                  disabled={busy}
                  className="h-12 w-full rounded-xl border border-border bg-surface-muted px-3 text-right font-mono text-base font-bold text-foreground outline-none transition focus:border-primary disabled:opacity-40"
                />
              </div>
            </div>

            <div>
              <label htmlFor="product-wholesale" className="mb-1.5 block text-sm font-black text-foreground">
                سعر الجملة
              </label>
              <input
                id="product-wholesale"
                type="text"
                inputMode="decimal"
                dir="ltr"
                value={wholesale}
                onChange={(event) => setWholesale(event.target.value)}
                placeholder="0.00"
                disabled={busy}
                className="h-12 w-full rounded-xl border border-border bg-surface-muted px-3 text-right font-mono text-base font-bold text-foreground outline-none transition focus:border-primary disabled:opacity-40"
              />
            </div>

            <div>
              <label htmlFor="product-category" className="mb-1.5 block text-sm font-black text-foreground">
                التصنيف
              </label>
              <select
                id="product-category"
                value={categoryId}
                onChange={(event) => setCategoryId(event.target.value)}
                disabled={busy}
                className="h-12 w-full rounded-xl border border-border bg-surface-muted px-3 text-base font-bold text-foreground outline-none transition focus:border-primary disabled:opacity-40"
              >
                <option value="">بدون تصنيف</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="product-supplier" className="mb-1.5 block text-sm font-black text-foreground">
                المورد
              </label>
              <select
                id="product-supplier"
                value={supplierId}
                onChange={(event) => setSupplierId(event.target.value)}
                disabled={busy}
                className="h-12 w-full rounded-xl border border-border bg-surface-muted px-3 text-base font-bold text-foreground outline-none transition focus:border-primary disabled:opacity-40"
              >
                <option value="">بدون مورد</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </select>
            </div>
          </section>

          <button
            type="submit"
            disabled={busy}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-success text-lg font-black text-success-foreground shadow-sm transition hover:bg-success-hover active:scale-[0.98] disabled:opacity-40"
          >
            {busy ? <Loader className="h-5 w-5 animate-spin" /> : <CheckCircle className="h-5 w-5" />}
            {busy ? "جارٍ الحفظ…" : "حفظ المنتج"}
          </button>

          {barcodes.length > 0 && (
            <button
              type="button"
              onClick={resetForm}
              disabled={busy}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-destructive/10 text-sm font-black text-destructive transition hover:bg-destructive/20 disabled:opacity-40"
            >
              <RefreshCw className="h-4 w-4" />
              مسح النموذج
            </button>
          )}
        </form>
      </main>
    </div>
  );
}
