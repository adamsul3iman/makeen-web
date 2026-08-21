"use client";

import { Package, Tag, Layers, TrendingUp, Hash } from "lucide-react";

interface ProductInsightCardProps {
  productName: string;
  categoryName?: string;
  brandName?: string;
  currentStock?: number;
  costPrice?: number;
  reorderLevel?: number;
}

export function hasInsightData(props: Omit<ProductInsightCardProps, "productName">): boolean {
  return (
    props.categoryName != null ||
    props.brandName != null ||
    props.currentStock != null ||
    props.costPrice != null ||
    props.reorderLevel != null
  );
}

export default function ProductInsightCard({
  categoryName,
  brandName,
  currentStock,
  costPrice,
  reorderLevel,
}: ProductInsightCardProps) {
  if (!hasInsightData({ categoryName, brandName, currentStock, costPrice, reorderLevel })) {
    return null;
  }

  const stockColor =
    currentStock == null
      ? "text-muted-foreground"
      : currentStock === 0
        ? "text-red-500"
        : reorderLevel != null && currentStock <= reorderLevel
          ? "text-amber-500"
          : "text-green-500";

  return (
    <div className="rounded-xl border border-border bg-surface-muted p-3">
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        {categoryName && (
          <div className="flex items-center gap-1.5">
            <Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="text-xs font-black text-foreground">التصنيف</span>
            <span className="text-xs font-bold text-muted-foreground truncate">{categoryName}</span>
          </div>
        )}

        {brandName && (
          <div className="flex items-center gap-1.5">
            <Tag className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="text-xs font-black text-foreground">العلامة</span>
            <span className="text-xs font-bold text-muted-foreground truncate">{brandName}</span>
          </div>
        )}

        {currentStock != null && (
          <div className="flex items-center gap-1.5">
            <Package className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="text-xs font-black text-foreground">المخزون الحالي</span>
            <span className={`text-xs font-bold ${stockColor}`}>{currentStock}</span>
          </div>
        )}

        {costPrice != null && (
          <div className="flex items-center gap-1.5">
            <TrendingUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="text-xs font-black text-foreground">سعر التكلفة</span>
            <span className="text-xs font-bold text-muted-foreground font-mono">
              {costPrice.toFixed(2)}
            </span>
          </div>
        )}

        {reorderLevel != null && reorderLevel > 0 && (
          <div className="flex items-center gap-1.5">
            <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="text-xs font-black text-foreground">الحد الأدنى</span>
            <span className="text-xs font-bold text-muted-foreground">{reorderLevel}</span>
          </div>
        )}

        {reorderLevel != null && reorderLevel === 0 && (
          <div className="flex items-center gap-1.5">
            <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="text-xs font-black text-foreground">الحد الأدنى</span>
            <span className="text-xs font-bold text-gray-400">0</span>
          </div>
        )}
      </div>
    </div>
  );
}
