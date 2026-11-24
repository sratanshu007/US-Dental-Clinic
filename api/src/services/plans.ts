// Plans: what each subscription includes. Prices are in USD cents and match the Pricing Sheet.
import type { Clinic } from "../db/schema";

export type Plan = "STARTER" | "GROWTH" | "PRO";

export interface PlanInfo {
  name: string;
  priceCents: number;
  minutes: number;
  maxProviders: number | null; // null = unlimited
  maxExtraNumbers: number;
  allHours: boolean; // false = after-hours + overflow forwarding only (set on the clinic's phone line)
  noShowCalls: boolean;
  feedback: boolean;
  crm: boolean;
  pmsSync: boolean;
}

export const PLANS: Record<Plan, PlanInfo> = {
  STARTER: {
    name: "Starter", priceCents: 29900, minutes: 1000, maxProviders: 3, maxExtraNumbers: 0,
    allHours: false, noShowCalls: false, feedback: false, crm: false, pmsSync: false,
  },
  GROWTH: {
    name: "Growth", priceCents: 49900, minutes: 2000, maxProviders: 6, maxExtraNumbers: 0,
    allHours: true, noShowCalls: true, feedback: true, crm: true, pmsSync: true,
  },
  PRO: {
    name: "Pro", priceCents: 79900, minutes: 4000, maxProviders: null, maxExtraNumbers: 5,
    allHours: true, noShowCalls: true, feedback: true, crm: true, pmsSync: true,
  },
};

export const SETUP_FEES = { STANDARD: 49900, PREMIUM: 99900 } as const;

export function planOf(clinic: Pick<Clinic, "plan">): PlanInfo {
  return PLANS[clinic.plan as Plan] ?? PLANS.GROWTH;
}

export function includedMinutes(clinic: Pick<Clinic, "plan" | "minutesIncluded">): number {
  return clinic.minutesIncluded ?? planOf(clinic).minutes;
}

/** The AI answers only when billing is in good standing (PAST_DUE keeps working while the owner fixes the card). */
export function billingAllowsService(clinic: Pick<Clinic, "billingStatus">): boolean {
  return clinic.billingStatus !== "CANCELED";
}

export function features(clinic: Pick<Clinic, "plan">) {
  const p = planOf(clinic);
  return { noShowCalls: p.noShowCalls, feedback: p.feedback, crm: p.crm, pmsSync: p.pmsSync };
}
