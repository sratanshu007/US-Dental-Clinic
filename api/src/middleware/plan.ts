// Plan gating: features not in the clinic's plan return 403 with code PLAN_UPGRADE (the apps show an upgrade card).
import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/http";
import { planOf, type PlanInfo } from "../services/plans";
import { getClinic } from "../services/scheduling";
import { clinicScope } from "./auth";

type Feature = "crm" | "feedback" | "noShowCalls" | "pmsSync";
const LABEL: Record<Feature, string> = { crm: "The CRM", feedback: "Feedback calls", noShowCalls: "No-show rebooking", pmsSync: "Open Dental sync" };

export const requireFeature = (feature: Feature) => (req: Request, _res: Response, next: NextFunction) => {
  getClinic(clinicScope(req)).then((c) => {
    const p: PlanInfo = planOf(c);
    if (!p[feature]) return next(new HttpError(403, `${LABEL[feature]} is included in the Growth and Pro plans.`, { code: "PLAN_UPGRADE", feature, plan: c.plan }));
    next();
  }, next);
};

/** What the apps need to show the right menus, badges and banners. */
export function planView(c: { plan: string; billingStatus: string; minutesIncluded: number | null }) {
  const p = planOf(c as never);
  return {
    plan: c.plan, name: p.name, billingStatus: c.billingStatus,
    features: { crm: p.crm, feedback: p.feedback, noShowCalls: p.noShowCalls, pmsSync: p.pmsSync, allHours: p.allHours },
    limits: { minutes: c.minutesIncluded ?? p.minutes, dentists: p.maxProviders, extraNumbers: p.maxExtraNumbers },
  };
}
