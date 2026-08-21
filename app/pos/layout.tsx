import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "نقطة بيع MAKEEN",
  description: "نظام نقاط البيع MAKEEN (مَكِين)",
};

export default function PosLayoutRoute({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
