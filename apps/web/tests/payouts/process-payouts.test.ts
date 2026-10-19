import { ProgramPayoutMode, WorkspaceEnvironment } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { processPayouts } from "../../app/(ee)/api/cron/payouts/process/process-payouts";

const PAYOUT_AMOUNT = 10000; // $100.00

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  groupBy: vi.fn(),
  invoiceUpdate: vi.fn(),
  projectUpdate: vi.fn(),
  publishJSON: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    payout: {
      updateMany: mocks.updateMany,
      groupBy: mocks.groupBy,
    },
    invoice: {
      update: mocks.invoiceUpdate,
    },
    project: {
      update: mocks.projectUpdate,
    },
  },
}));

vi.mock("@/lib/cron", () => ({
  qstash: {
    publishJSON: mocks.publishJSON,
  },
}));

vi.mock("@dub/email", () => ({
  sendEmail: mocks.sendEmail,
}));

vi.mock("@dub/email/templates/program-payout-thank-you", () => ({
  default: () => null,
}));

function payoutArgs(payoutFee: number | null | undefined) {
  return {
    workspace: {
      id: "ws_test",
      slug: "acme",
      stripeId: "cus_test",
      plan: "business",
      invoicePrefix: "ACME",
      payoutsUsage: 0,
      payoutsLimit: 1_000_000,
      payoutFee: payoutFee as number,
      payoutFeeWaiverLimit: 0,
      payoutFeeWaiverUsage: 0,
      webhookEnabled: false,
      environment: WorkspaceEnvironment.sandbox,
    },
    program: {
      id: "prog_test",
      name: "Acme",
      logo: null,
      url: "https://acme.test",
      minPayoutAmount: 0,
      supportEmail: null,
      environment: WorkspaceEnvironment.sandbox,
      payoutMode: ProgramPayoutMode.internal,
    },
    invoice: {
      id: "inv_test",
      paymentMethod: "ach" as const,
    },
    userId: "user_test",
    paymentMethodId: "pm_test",
  };
}

describe("processPayouts payout fee", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.groupBy.mockResolvedValue([
      { mode: "internal", _sum: { amount: PAYOUT_AMOUNT } },
    ]);
    mocks.invoiceUpdate.mockResolvedValue({});
    mocks.projectUpdate.mockResolvedValue({
      users: [{ user: { email: "owner@acme.test" } }],
    });
    mocks.publishJSON.mockResolvedValue({ messageId: "msg_test" });
    mocks.sendEmail.mockResolvedValue({ id: "email_test" });
  });

  it("continues when the payout fee is 0 and records no fee", async () => {
    await processPayouts(payoutArgs(0));

    expect(mocks.invoiceUpdate).toHaveBeenCalledWith({
      where: { id: "inv_test" },
      data: {
        amount: PAYOUT_AMOUNT,
        externalAmount: 0,
        fee: 0,
        total: PAYOUT_AMOUNT,
      },
    });
    expect(mocks.publishJSON).toHaveBeenCalled();
  });

  it("continues when the payout fee is a normal percentage", async () => {
    await processPayouts(payoutArgs(0.03));

    expect(mocks.invoiceUpdate).toHaveBeenCalledWith({
      where: { id: "inv_test" },
      data: {
        amount: PAYOUT_AMOUNT,
        externalAmount: 0,
        fee: 300, // 3% of $100.00
        total: PAYOUT_AMOUNT + 300,
      },
    });
  });

  it.each([undefined, null])(
    "throws when the payout fee is missing (%s)",
    async (payoutFee) => {
      await expect(processPayouts(payoutArgs(payoutFee))).rejects.toThrow(
        "Failed to calculate payout fee.",
      );

      expect(mocks.invoiceUpdate).not.toHaveBeenCalled();
      expect(mocks.publishJSON).not.toHaveBeenCalled();
    },
  );
});
