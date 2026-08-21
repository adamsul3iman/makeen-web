import type { Metadata } from "next";
import MobileAddProduct from "@/components/mobile/MobileAddProduct";

export const metadata: Metadata = {
  title: "إضافة منتج — المسح بالكاميرا",
};

/**
 * Mobile camera product-add page. No search params / auth server code: the
 * session gate and capability probe run on the client (see MobileAddProduct).
 */
export default function MobileAddProductPage() {
  return <MobileAddProduct />;
}
