import { createReferralCommission } from "@/lib/partner-referrals/create-referral-commission";
import { CommissionStatus, CommissionType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const PROGRAM_ID = "prog_referral_threshold";
const REFERRED_PARTNER_ID = "pn_referred";
const REFERRER_PARTNER_ID = "pn_referrer";
const THRESHOLD_CENTS = 50_000;
const BONUS_CENTS = 10_000;

const EARNED_STATUSES = [
  CommissionStatus.pending,
  CommissionStatus.processed,
  CommissionStatus.paid,
] as const;

const UNEARNED_STATUSES = [
  CommissionStatus.refunded,
  CommissionStatus.fraud,
  CommissionStatus.duplicate,
  CommissionStatus.canceled,
  CommissionStatus.hold,
] as const;

const mocks = vi.hoisted(() => ({
  programEnrollmentFindUnique: vi.fn(),
  commissionAggregate: vi.fn(),
  commissionFindUnique: vi.fn(),
  commissionCreate: vi.fn(),
  programFindUniqueOrThrow: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    programEnrollment: {
      findUnique: mocks.programEnrollmentFindUnique,
    },
    commission: {
      aggregate: mocks.commissionAggregate,
      findUnique: mocks.commissionFindUnique,
      create: mocks.commissionCreate,
    },
    program: {
      findUniqueOrThrow: mocks.programFindUniqueOrThrow,
    },
  },
}));

vi.mock("@/lib/zod/schemas/commissions", () => ({
  CommissionWebhookSchema: {
    parse: (data: unknown) => data,
  },
}));

vi.mock("@/lib/partners/constuct-webhook-partner", () => ({
  constructWebhookPartner: vi.fn().mockReturnValue({ id: "pn_referrer" }),
}));

vi.mock("@/lib/webhook/publish", () => ({
  sendWorkspaceWebhook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/postback/send-partner-postback", () => ({
  sendPartnerPostback: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/api/partners/sync-total-commissions", () => ({
  syncTotalCommissions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/api/partners/notify-partner-commission", () => ({
  notifyPartnerCommission: vi.fn().mockResolvedValue(undefined),
}));

type SaleCommission = {
  partnerId: string;
  programId: string;
  type: CommissionType;
  status: CommissionStatus;
  earnings: number;
};

let saleCommissions: SaleCommission[] = [];

function sale({
  status,
  earnings,
}: {
  status: CommissionStatus;
  earnings: number;
}): SaleCommission {
  return {
    partnerId: REFERRED_PARTNER_ID,
    programId: PROGRAM_ID,
    type: CommissionType.sale,
    status,
    earnings,
  };
}

function referrerEnrollment() {
  return {
    partner: { id: REFERRER_PARTNER_ID },
    links: [],
    partnerGroup: null,
    referralReward: {
      id: "rw_referral",
      amountInCents: BONUS_CENTS,
      amountInPercentage: null,
      maxDuration: null,
      config: {
        trigger: "commissionThreshold",
        commissionsThresholdInCents: THRESHOLD_CENTS,
      },
    },
  };
}

describe("createReferralCommission commissionThreshold", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saleCommissions = [];

    mocks.programEnrollmentFindUnique.mockImplementation(
      async ({
        where,
      }: {
        where: { partnerId_programId: { partnerId: string } };
      }) => {
        const { partnerId } = where.partnerId_programId;

        if (partnerId === REFERRED_PARTNER_ID) {
          return {
            programId: PROGRAM_ID,
            partnerId,
            status: "approved",
            applicationEvent: {
              referredByPartnerId: REFERRER_PARTNER_ID,
            },
          };
        }

        if (partnerId === REFERRER_PARTNER_ID) {
          return referrerEnrollment();
        }

        return null;
      },
    );

    mocks.commissionAggregate.mockImplementation(
      async ({
        where,
      }: {
        where: {
          partnerId?: string;
          programId?: string;
          type?: CommissionType | "sale";
          status?: { in?: CommissionStatus[] };
        };
      }) => {
        const earnings = saleCommissions
          .filter((commission) => {
            if (where.partnerId && commission.partnerId !== where.partnerId) {
              return false;
            }
            if (where.programId && commission.programId !== where.programId) {
              return false;
            }
            if (where.type && commission.type !== where.type) {
              return false;
            }
            if (
              where.status?.in &&
              !where.status.in.includes(commission.status)
            ) {
              return false;
            }
            return true;
          })
          .reduce((total, commission) => total + commission.earnings, 0);

        return {
          _sum: { earnings },
        };
      },
    );

    mocks.commissionFindUnique.mockResolvedValue(null);
    mocks.commissionCreate.mockImplementation(async ({ data }) => ({
      id: data.id,
      ...data,
      status: CommissionStatus.pending,
    }));
    mocks.programFindUniqueOrThrow.mockResolvedValue({
      id: PROGRAM_ID,
      name: "Acme",
      slug: "acme",
      logo: null,
      supportEmail: null,
      environment: "production",
      groups: [{ id: "grp_default" }],
      workspace: {
        id: "ws_acme",
        name: "Acme",
        slug: "acme",
        webhookEnabled: false,
      },
    });
  });

  it("ignores refunded, fraud, duplicate, canceled, and held commissions", async () => {
    saleCommissions = [
      sale({ status: CommissionStatus.paid, earnings: 10_000 }),
      ...UNEARNED_STATUSES.map((status) =>
        sale({ status, earnings: THRESHOLD_CENTS }),
      ),
    ];

    const commission = await createReferralCommission({
      partnerId: REFERRED_PARTNER_ID,
      programId: PROGRAM_ID,
    });

    expect(commission).toBeNull();
    expect(mocks.commissionCreate).not.toHaveBeenCalled();
    expect(mocks.commissionAggregate).toHaveBeenCalledWith({
      where: {
        partnerId: REFERRED_PARTNER_ID,
        programId: PROGRAM_ID,
        type: "sale",
        status: { in: [...EARNED_STATUSES] },
      },
      _sum: { earnings: true },
    });
  });

  it("pays the bonus once pending, processed, and paid sales reach the threshold", async () => {
    saleCommissions = [
      sale({ status: CommissionStatus.pending, earnings: 20_000 }),
      sale({ status: CommissionStatus.processed, earnings: 20_000 }),
      sale({ status: CommissionStatus.paid, earnings: 10_000 }),
      ...UNEARNED_STATUSES.map((status) =>
        sale({ status, earnings: THRESHOLD_CENTS }),
      ),
    ];

    const commission = await createReferralCommission({
      partnerId: REFERRED_PARTNER_ID,
      programId: PROGRAM_ID,
    });

    expect(commission).toEqual(
      expect.objectContaining({
        type: CommissionType.referral,
        earnings: BONUS_CENTS,
        partnerId: REFERRER_PARTNER_ID,
        sourcePartnerId: REFERRED_PARTNER_ID,
        invoiceId: `referral:commissionThreshold:${REFERRED_PARTNER_ID}`,
      }),
    );
    expect(mocks.commissionCreate).toHaveBeenCalledOnce();
  });
});
