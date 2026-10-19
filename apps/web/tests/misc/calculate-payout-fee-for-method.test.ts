import { CARD_PAYOUT_HARD_COST_RATE } from "@/lib/constants/payouts";
import { calculatePayoutFeeForMethod } from "@/lib/stripe/payment-methods";
import { describe, expect, it } from "vitest";

describe("calculatePayoutFeeForMethod", () => {
  it.each(["us_bank_account", "acss_debit", "sepa_debit"] as const)(
    "returns 0 for %s when the workspace fee is 0",
    (paymentMethod) => {
      expect(
        calculatePayoutFeeForMethod({
          paymentMethod,
          payoutFee: 0,
        }),
      ).toBe(0);
    },
  );

  it("returns a normal direct debit fee unchanged", () => {
    expect(
      calculatePayoutFeeForMethod({
        paymentMethod: "us_bank_account",
        payoutFee: 0.03,
      }),
    ).toBe(0.03);
  });

  it.each(["card", "link"] as const)(
    "adds the card hard cost for %s, including when the workspace fee is 0",
    (paymentMethod) => {
      expect(
        calculatePayoutFeeForMethod({
          paymentMethod,
          payoutFee: 0,
        }),
      ).toBe(CARD_PAYOUT_HARD_COST_RATE);

      expect(
        calculatePayoutFeeForMethod({
          paymentMethod,
          payoutFee: 0.03,
        }),
      ).toBe(0.03 + CARD_PAYOUT_HARD_COST_RATE);
    },
  );

  it.each([undefined, null])(
    "returns null when the fee is missing (%s)",
    (payoutFee) => {
      expect(
        calculatePayoutFeeForMethod({
          paymentMethod: "us_bank_account",
          payoutFee,
        }),
      ).toBeNull();
    },
  );
});
