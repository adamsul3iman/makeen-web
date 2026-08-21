"use client";

import { Download, Monitor, Shield, Zap, Wifi, WifiOff, Clock } from "lucide-react";
import Logo from "@/components/shared/Logo";

const DOWNLOAD_URL =
  "https://github.com/adamsul3iman/makeen-pos/releases/latest/download/MAKEEN-Setup.exe";

const features = [
  { icon: Zap, label: "سرعة فائقة", desc: "تشغيل فوري بدون انتظار — مبني على أحدث تقنيات سطح المكتب" },
  { icon: WifiOff, label: "يعمل بدون إنترنت", desc: "نظام ذاكرة محلية يحفظ بياناتك حتى انقطاع الاتصال" },
  { icon: Wifi, label: "مزامنة تلقائية", desc: "يعود للعمل عبر الشبكة ويُزامن البيانات تلقائياً" },
  { icon: Shield, label: "آمن وموثوق", desc: "تحديثات تلقائية عبر الإنترنت وحماية كاملة للبيانات" },
];

export default function DownloadPage() {
  return (
    <div dir="rtl" className="flex min-h-screen flex-col bg-background">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <Logo className="h-9 w-9" />
            <span className="text-lg font-black text-foreground">MAKEEN</span>
          </div>
          <a
            href="/login"
            className="rounded-lg bg-surface-muted px-4 py-2 text-sm font-bold text-muted transition hover:bg-border hover:text-foreground"
          >
            تسجيل الدخول
          </a>
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center px-6 py-16">
        <div className="w-full max-w-3xl space-y-16">
          {/* Hero */}
          <section className="space-y-6 text-center">
            <Logo className="mx-auto h-24 w-24" />
            <div className="space-y-3">
              <h1 className="text-3xl font-black text-foreground sm:text-4xl">
                مكين — نظام نقاط البيع لسطح المكتب
              </h1>
              <p className="mx-auto max-w-lg text-base font-semibold text-muted-foreground sm:text-lg">
                نظام نقاط بيع احترافي يعمل بدون إنترنت ويعود للعمل تلقائياً.
                <br className="hidden sm:block" />
                مصمم للسرعة والموثوقية في بيئات البيع المباشر.
              </p>
            </div>

            <div className="flex justify-center">
              <a
                href={DOWNLOAD_URL}
                download
                className="inline-flex h-14 items-center gap-3 rounded-xl bg-primary px-8 text-lg font-black text-primary-foreground shadow-card transition hover:bg-primary-hover hover:shadow-elevated active:scale-[0.98]"
              >
                <Download className="h-5 w-5" />
                تنزيل INSTALLER (.exe)
              </a>
            </div>

            <p className="text-xs font-semibold text-muted-foreground">
              الإصدار الأحدث متاح على GitHub — يتم التحديث تلقائياً بعد التثبيت
            </p>
          </section>

          {/* Features */}
          <section>
            <h2 className="mb-6 text-center text-lg font-black text-foreground">لماذا مكين؟</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {features.map((f) => (
                <div
                  key={f.label}
                  className="flex gap-4 rounded-2xl border border-border bg-surface p-5 shadow-card"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft">
                    <f.icon className="h-5 w-5 text-primary" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-black text-foreground">{f.label}</p>
                    <p className="text-xs font-semibold leading-relaxed text-muted-foreground">
                      {f.desc}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* System Requirements */}
          <section>
            <h2 className="mb-6 text-center text-lg font-black text-foreground">
              متطلبات النظام
            </h2>
            <div className="mx-auto max-w-md rounded-2xl border border-border bg-surface p-6 shadow-card">
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <Monitor className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-bold text-foreground">نظام التشغيل</p>
                    <p className="text-xs font-semibold text-muted-foreground">
                      Windows 10 أو Windows 11 (64-bit)
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Clock className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-bold text-foreground">مساحة التخزين</p>
                    <p className="text-xs font-semibold text-muted-foreground">
                      300 ميغابايت متاحة على الأقل
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Shield className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-bold text-foreground">صلاحيات التثبيت</p>
                    <p className="text-xs font-semibold text-muted-foreground">
                      يتطلب صلاحيات مسؤول (Administrator)
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </main>

      <footer className="border-t border-border bg-surface py-6 text-center">
        <p className="text-xs font-semibold text-muted-foreground">
          © {new Date().getFullYear()} MAKEEN Software — جميع الحقوق محفوظة
        </p>
      </footer>
    </div>
  );
}
