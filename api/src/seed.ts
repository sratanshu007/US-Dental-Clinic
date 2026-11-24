// Creates a super admin and a demo clinic. Run: npm run seed
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, pool, schema } from "./db";
import { DEFAULT_HOURS } from "./routes/admin";
import { createLead } from "./services/crm";

async function main() {
  const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? "admin@deificdigital.com").toLowerCase();
  const adminPass = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe-Admin-2026";
  const ownerEmail = "owner@demo-dental.com";
  const ownerPass = process.env.SEED_OWNER_PASSWORD ?? "ChangeMe-Owner-2026";

  if (!(await db.query.users.findFirst({ where: eq(schema.users.email, adminEmail) }))) {
    await db.insert(schema.users).values({
      email: adminEmail, name: "Deific Admin", role: "SUPER_ADMIN", passwordHash: await bcrypt.hash(adminPass, 12),
    });
    console.log(`Super admin: ${adminEmail} / ${adminPass}`);
  }

  const demoNumber = process.env.SEED_CLINIC_NUMBER ?? "+12105550100";
  let clinic = await db.query.clinics.findFirst({ where: eq(schema.clinics.aiPhoneNumber, demoNumber) });
  if (!clinic) {
    [clinic] = await db.insert(schema.clinics).values({
      name: "Demo Family Dental",
      aiPhoneNumber: demoNumber,
      transferNumber: "+12105550199",
      timezone: "America/Chicago",
      address: "123 Main St, San Antonio, TX",
      businessHours: DEFAULT_HOURS,
      aiExtraInstructions:
        "We accept most PPO insurance including Delta Dental, Cigna, Aetna and MetLife. We do not accept Medicaid. " +
        "New patient special: exam, X-rays and cleaning for $99 without insurance. Free parking behind the building.",
    }).returning();
    await db.insert(schema.providers).values([
      { clinicId: clinic.id, name: "Dr. Maria Lopez", title: "Dentist" },
      { clinicId: clinic.id, name: "Dr. James Carter", title: "Dentist" },
    ]);
    await db.insert(schema.services).values([
      { clinicId: clinic.id, name: "New patient exam & cleaning", durationMin: 60 },
      { clinicId: clinic.id, name: "Cleaning", durationMin: 45 },
      { clinicId: clinic.id, name: "Emergency / tooth pain", durationMin: 30 },
      { clinicId: clinic.id, name: "Consultation", durationMin: 30 },
    ]);
    const [owner] = await db.insert(schema.users).values({
      clinicId: clinic.id, email: ownerEmail, name: "Demo Owner", role: "CLINIC_OWNER", passwordHash: await bcrypt.hash(ownerPass, 12),
    }).returning();
    // Sample CRM contacts so the pipeline isn't empty on first login (delete before real use)
    const samples: [string, string, string, "NEW" | "CONTACTED" | "APPT" | "PLAN" | "WON", number, string[]][] = [
      ["Rachel Adams", "+12105550161", "Invisalign price & payment plans", "NEW", 4800, ["Invisalign"]],
      ["Tom Becker", "+12105550145", "Do you accept Cigna PPO?", "NEW", 250, ["Insurance"]],
      ["Nina Patel", "+12105550113", "Teeth whitening cost", "CONTACTED", 450, ["Whitening"]],
      ["Omar Haddad", "+12105550158", "Dental implant consultation", "APPT", 3800, ["Implants"]],
      ["Grace Kim", "+12105550137", "Full Invisalign treatment", "PLAN", 5200, ["Invisalign"]],
      ["Sofia Rossi", "+12105550115", "Invisalign", "WON", 4500, ["Invisalign"]],
    ];
    for (const [name, phone, interest, stage, value, tags] of samples) {
      await createLead({
        clinicId: clinic.id, name, phone, interest, stage, value, tags, ownerId: owner.id, source: stage === "NEW" ? "AI call" : "Website",
        actor: "Seed", task: stage === "WON" ? undefined : { title: `Follow up: ${interest}`, dueInMinutes: 120 },
      });
    }
    console.log(`Demo clinic owner: ${ownerEmail} / ${ownerPass}  (AI number ${demoNumber})`);
  }
  console.log("Seed complete. Change these passwords and turn on 2FA before real use.");
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
