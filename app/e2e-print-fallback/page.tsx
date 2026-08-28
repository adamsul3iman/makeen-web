import { notFound } from "next/navigation";
import PrintFallbackHarness from "./PrintFallbackHarness";

export default function PrintFallbackPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <PrintFallbackHarness />;
}
