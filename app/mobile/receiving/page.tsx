import type { Metadata } from "next";
import MobileReceiving from "@/components/mobile/MobileReceiving";

export const metadata: Metadata = {
  title: "استلام بضاعة — مسح ذكي",
};

/**
 * Mobile goods-in / smart receiving page. No server auth code: the session
 * gate and capability probe run on the client (see MobileReceiving), and the
 * commit path is protected server-side by the receiving capability gate on
 * the sync mirror.
 */
export default function MobileReceivingPage() {
  return <MobileReceiving />;
}
