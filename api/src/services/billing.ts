// Billing: monthly minutes per clinic, usage alerts, Stripe subscriptions and overage invoicing.
//
// Two ways to bill a clinic:
//  * Stripe (billingStatus ACTIVE/PAST_DUE): owner pays by card through Stripe Checkout; overage minutes are
//    added to the next invoice automatically.
//  * Manual (TRIAL/MANUAL): founding clinics or invoice by bank transfer. Usage is still tracked and
//    shown, so you can invoice overage yourself.
//
// Stripe never receives patient data: only the clinic's business name, billing email and minute counts.
import Stripe from "stripe";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { config } from "../config";
import { db, schema } from "../db";
import type { Clinic } from "../db/schema";
import { alert } from "../lib/alerts";
import { audit } from "../lib/audit";
import { badRequest } from "../lib/http";
import { notifyClinic } from "./notify";
import { includedMinutes, PLANS, type Plan } from "./plans";

let client: Stripe | null = null;
export function stripe(): Stripe {
  if (!config.stripe.secretKey) throw badRequest("Stripe is not configured (STRIPE_SECRET_KEY)");
  client ??= new Stripe(config.stripe.secretKey);
  return client;
}

export const periodOf = (clinic: Pick<Clinic, "timezone">, at = DateTime.now()) => at.setZone(clinic.timezone).toFormat("yyyy-LL");

/** Billable minutes in a month: every connected call, rounded up per call (how carriers bill). */
export async function minutesUsed(clinic: Clinic, period: string): Promise<number> {
  const start = DateTime.fromFormat(period, "yyyy-LL", { zone: clinic.timezone }).startOf("month");
  const end = start.plus({ months: 1 });
  const [row] = await db
    .select({ m: sql<number>`coalesce(sum(ceil(coalesce(${schema.calls.durationSec}, 0) / 60.0)), 0)::int` })
    .from(schema.calls)
    .where(and(eq(schema.calls.clinicId, clinic.id), gte(schema.calls.startedAt, start.toJSDate()), lt(schema.calls.startedAt, end.toJSDate())));
  return Number(row?.m ?? 0);
}

export async function usageSummary(clinic: Clinic, period = periodOf(clinic)) {
  const minutes = await minutesUsed(clinic, period);
  const included = includedMinutes(clinic);
  const overage = Math.max(0, minutes - included);
  return {
    period, minutes, includedMinutes: included, overageMinutes: overage,
    overageCents: overage * clinic.overageCentsPerMin, percentUsed: included ? Math.round((minutes / included) * 100) : 0,
    plan: clinic.plan, planName: PLANS[clinic.plan as Plan].name, billingStatus: clinic.billingStatus,
  };
}

/** Job (hourly): 80% usage alert, and close last month: record usage and bill overage on Stripe. */
export async function billingJob(): Promise<void> {
  const clinics = await db.query.clinics.findMany({ where: eq(schema.clinics.active, true) });
  for (const clinic of clinics) {
    try {
      const u = await usageSummary(clinic);
      if (u.percentUsed >= 80 && clinic.usageAlertPeriod !== u.period) {
        await db.update(schema.clinics).set({ usageAlertPeriod: u.period }).where(eq(schema.clinics.id, clinic.id));
        await notifyClinic(clinic.id, "USAGE", `${u.percentUsed}% of monthly minutes used`,
          `${u.minutes} of ${u.includedMinutes} minutes used this month. Extra minutes are $${(clinic.overageCentsPerMin / 100).toFixed(2)} each.`, "/settings");
      }
      await closePeriod(clinic, periodOf(clinic, DateTime.now().minus({ months: 1 })));
    } catch (e) {
      await alert(`billing:${clinic.id}`, `Billing job failed for clinic ${clinic.id}: ${(e as Error).message}`);
    }
  }
}

export async function closePeriod(clinic: Clinic, period: string) {
  const existing = await db.query.usagePeriods.findFirst({
    where: and(eq(schema.usagePeriods.clinicId, clinic.id), eq(schema.usagePeriods.period, period)),
  });
  if (existing?.invoicedAt) return existing;
  const u = await usageSummary(clinic, period);
  const values = {
    clinicId: clinic.id, period, minutes: u.minutes, includedMinutes: u.includedMinutes,
    overageMinutes: u.overageMinutes, overageCents: u.overageCents,
  };
  const [row] = existing
    ? await db.update(schema.usagePeriods).set(values).where(eq(schema.usagePeriods.id, existing.id)).returning()
    : await db.insert(schema.usagePeriods).values(values).returning();

  const onStripe = clinic.stripeCustomerId && ["ACTIVE", "PAST_DUE"].includes(clinic.billingStatus);
  if (!onStripe || !config.stripe.secretKey) return row; // manual billing: shown in admin, invoice yourself
  if (u.overageCents > 0) {
    // Lands on the customer's next subscription invoice. Idempotency key stops double billing on retries.
    const item = await stripe().invoiceItems.create(
      {
        customer: clinic.stripeCustomerId!, currency: "usd", amount: u.overageCents,
        description: `Extra call minutes ${period}: ${u.overageMinutes} min × $${(clinic.overageCentsPerMin / 100).toFixed(2)}`,
        metadata: { clinicId: clinic.id, period },
      },
      { idempotencyKey: `overage-${clinic.id}-${period}` },
    );
    await db.update(schema.usagePeriods).set({ stripeInvoiceItemId: item.id }).where(eq(schema.usagePeriods.id, row.id));
  }
  const [done] = await db.update(schema.usagePeriods).set({ invoicedAt: new Date() }).where(eq(schema.usagePeriods.id, row.id)).returning();
  return done;
}

/** Checkout link the owner opens to start the subscription (+ one-time setup fee unless waived). */
export async function createCheckout(clinic: Clinic, opts: { plan: Plan; setup: "STANDARD" | "PREMIUM" | "NONE"; email?: string }) {
  const price = config.stripe.prices[opts.plan];
  if (!price) throw badRequest(`Stripe price for ${opts.plan} is not configured`);
  const s = stripe();
  let customer = clinic.stripeCustomerId;
  if (!customer) {
    const c = await s.customers.create({
      name: clinic.name, email: opts.email ?? clinic.billingEmail ?? undefined, metadata: { clinicId: clinic.id },
    });
    customer = c.id;
    await db.update(schema.clinics).set({ stripeCustomerId: customer }).where(eq(schema.clinics.id, clinic.id));
  }
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [{ price, quantity: 1 }];
  if (opts.setup !== "NONE") {
    const setupPrice = opts.setup === "PREMIUM" ? config.stripe.prices.SETUP_PREMIUM : config.stripe.prices.SETUP_STANDARD;
    if (!setupPrice) throw badRequest("Stripe setup-fee price is not configured");
    lineItems.push({ price: setupPrice, quantity: 1 }); // one-time price: charged on the first invoice only
  }
  const session = await s.checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: lineItems,
    success_url: `${config.webAppUrl}/settings?billing=success`,
    cancel_url: `${config.webAppUrl}/settings?billing=cancelled`,
    subscription_data: { metadata: { clinicId: clinic.id, plan: opts.plan } },
    metadata: { clinicId: clinic.id, plan: opts.plan },
    billing_address_collection: "required",
  });
  await audit(null, { action: "BILLING_CHECKOUT_CREATED", entity: "clinic", entityId: clinic.id, clinicId: clinic.id, meta: { plan: opts.plan, setup: opts.setup } }, "system");
  return { url: session.url };
}

/** Stripe customer portal: update card, download invoices, cancel. */
export async function createPortal(clinic: Clinic) {
  if (!clinic.stripeCustomerId) throw badRequest("No Stripe customer for this clinic yet");
  const p = await stripe().billingPortal.sessions.create({ customer: clinic.stripeCustomerId, return_url: `${config.webAppUrl}/settings` });
  return { url: p.url };
}

const STATUS: Record<string, "ACTIVE" | "PAST_DUE" | "CANCELED"> = {
  active: "ACTIVE", trialing: "ACTIVE", past_due: "PAST_DUE", unpaid: "PAST_DUE", incomplete: "PAST_DUE",
  canceled: "CANCELED", incomplete_expired: "CANCELED",
};

/** Verified Stripe webhook → keep plan and billing status in sync. */
export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object as Stripe.Checkout.Session;
      const clinicId = s.metadata?.clinicId;
      if (!clinicId) return;
      const plan = (s.metadata?.plan as Plan | undefined) ?? undefined;
      await db.update(schema.clinics).set({
        stripeCustomerId: typeof s.customer === "string" ? s.customer : s.customer?.id,
        stripeSubscriptionId: typeof s.subscription === "string" ? s.subscription : s.subscription?.id,
        billingStatus: "ACTIVE",
        ...(plan && PLANS[plan] ? { plan } : {}),
      }).where(eq(schema.clinics.id, clinicId));
      await audit(null, { action: "BILLING_ACTIVATED", entity: "clinic", entityId: clinicId, clinicId }, "stripe");
      return;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const clinicId = sub.metadata?.clinicId;
      if (!clinicId) return;
      const status = event.type === "customer.subscription.deleted" ? "CANCELED" : STATUS[sub.status] ?? "PAST_DUE";
      const plan = sub.metadata?.plan as Plan | undefined;
      await db.update(schema.clinics).set({
        billingStatus: status, stripeSubscriptionId: sub.id, ...(plan && PLANS[plan] ? { plan } : {}),
      }).where(eq(schema.clinics.id, clinicId));
      await audit(null, { action: `BILLING_${status}`, entity: "clinic", entityId: clinicId, clinicId }, "stripe");
      if (status === "PAST_DUE") {
        await notifyClinic(clinicId, "BILLING", "Payment failed", "Please update your card to keep the AI receptionist running.", "/settings");
      }
      if (status === "CANCELED") await alert(`cancel:${clinicId}`, `Clinic ${clinicId} subscription canceled — AI line is now off.`, 1);
      return;
    }
    case "invoice.payment_failed": {
      const inv = event.data.object as Stripe.Invoice;
      const customer = typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
      if (!customer) return;
      await db.update(schema.clinics).set({ billingStatus: "PAST_DUE" }).where(and(eq(schema.clinics.stripeCustomerId, customer), eq(schema.clinics.billingStatus, "ACTIVE")));
      await alert(`payfail:${customer}`, `Invoice payment failed for Stripe customer ${customer}.`, 60);
      return;
    }
    default:
      return;
  }
}
