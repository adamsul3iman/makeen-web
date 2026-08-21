const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface SplitPortions {
  cash: number;
  visa: number;
}

export interface PaymentBuckets {
  cash: number;
  visa: number;
  cliq: number;
  debt: number;
}

/**
 * SPLIT buckets for a (possibly negative) invoice. The cash bucket is the
 * cash given at checkout / handed back on a return; the card bucket absorbs
 * the remainder.
 *
 * The old derivation dumped a SPLIT return entirely into cash
 * (`cashAmount = total`, `visaAmount = 0`): reversing a 60 cash / 40 visa
 * sale of -100 incorrectly posted -100 to the drawer and nothing to card.
 * Taking the sign from the total and the magnitude from `amountPaid` reverses
 * the same buckets the original sale used.
 */
export function splitPaymentPortions(total: number, amountPaid: number): SplitPortions {
  const sign = total < 0 ? -1 : 1;
  const cash = round2(sign * Math.min(Math.abs(amountPaid), Math.abs(total)));
  return { cash, visa: round2(total - cash) };
}

export function derivePaymentBuckets(
  paymentMethod: string,
  total: number,
  amountPaid: number,
): PaymentBuckets {
  switch ((paymentMethod ?? "").toUpperCase()) {
    case "VISA":
      return { cash: 0, visa: total, cliq: 0, debt: 0 };
    case "CLIQ":
      return { cash: 0, visa: 0, cliq: total, debt: 0 };
    case "DEBT":
      return { cash: 0, visa: 0, cliq: 0, debt: total };
    case "SPLIT": {
      const { cash, visa } = splitPaymentPortions(total, amountPaid);
      return { cash, visa, cliq: 0, debt: 0 };
    }
    case "CASH":
    default:
      return { cash: total, visa: 0, cliq: 0, debt: 0 };
  }
}
