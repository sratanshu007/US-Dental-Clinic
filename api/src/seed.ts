// Creates or updates a super admin and a demo clinic from environment variables.
// Run: npm run seed
import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import { db, pool, schema } from "./db";
import { DEFAULT_HOURS } from "./routes/admin";
import { createLead } from "./services/crm";
import { config } from "./config";

async function main() {
  const adminEmail = config.adminEmail;
  const adminPass = config.adminPassword;
  const ownerEmail = config.ownerEmail;
  const ownerPass = config.ownerPassword;
  const clinicName = config.clinicName;
  const clinicPhone = config.clinicPhone;
  const transferPhone = config.clinicTransferPhone;
  const clinicTimezone = config.clinicTimezone;
  const clinicAddress = config.clinicAddress;

  // 1. Super Admin (create if missing, update credentials if changed in env)
  const existingAdmin =
    (await db.query.users.findFirst({ where: eq(schema.users.email, adminEmail) })) ??
    (await db.query.users.findFirst({ where: eq(schema.users.role, "SUPER_ADMIN") }));

  const hashedAdminPass = await bcrypt.hash(adminPass, 12);

  if (!existingAdmin) {
    await db.insert(schema.users).values({
      email: adminEmail,
      name: process.env.ADMIN_NAME ?? "Super Admin",
      role: "SUPER_ADMIN",
      passwordHash: hashedAdminPass,
    });
    console.log(`[seed] Created Super admin: ${adminEmail}`);
  } else {
    await db.update(schema.users)
      .set({
        email: adminEmail,
        passwordHash: hashedAdminPass,
      })
      .where(eq(schema.users.id, existingAdmin.id));
    console.log(`[seed] Synchronized Super admin: ${adminEmail}`);
  }

  // 2. Clinic (create if missing, update details from env)
  let clinic = await db.query.clinics.findFirst({
    where: eq(schema.clinics.aiPhoneNumber, clinicPhone),
  }) ?? await db.query.clinics.findFirst();

  if (!clinic) {
    [clinic] = await db.insert(schema.clinics).values({
      name: clinicName,
      aiPhoneNumber: clinicPhone,
      transferNumber: transferPhone,
      timezone: clinicTimezone,
      address: clinicAddress,
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
    console.log(`[seed] Created clinic: ${clinicName} (${clinicPhone})`);
  } else {
    await db.update(schema.clinics)
      .set({
        name: clinicName,
        aiPhoneNumber: clinicPhone,
        transferNumber: transferPhone,
        timezone: clinicTimezone,
        address: clinicAddress,
      })
      .where(eq(schema.clinics.id, clinic.id));
    console.log(`[seed] Synchronized clinic: ${clinicName}`);
  }

  // 3. Clinic Owner (create if missing, update credentials if changed in env)
  const existingOwner =
    (await db.query.users.findFirst({ where: eq(schema.users.email, ownerEmail) })) ??
    (await db.query.users.findFirst({
      where: and(eq(schema.users.clinicId, clinic.id), eq(schema.users.role, "CLINIC_OWNER")),
    }));

  const hashedOwnerPass = await bcrypt.hash(ownerPass, 12);

  let owner = existingOwner;
  if (!existingOwner) {
    [owner] = await db.insert(schema.users).values({
      clinicId: clinic.id,
      email: ownerEmail,
      name: process.env.OWNER_NAME ?? "Clinic Owner",
      role: "CLINIC_OWNER",
      passwordHash: hashedOwnerPass,
    }).returning();
    console.log(`[seed] Created Clinic owner: ${ownerEmail}`);

    // Optional initial sample CRM contacts if SEED_SAMPLE_DATA=true
    if (process.env.SEED_SAMPLE_DATA === "true") {
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
      console.log(`[seed] Inserted initial sample CRM contacts`);
    }
  } else {
    await db.update(schema.users)
      .set({
        email: ownerEmail,
        passwordHash: hashedOwnerPass,
        clinicId: clinic.id,
      })
      .where(eq(schema.users.id, existingOwner.id));
    console.log(`[seed] Synchronized Clinic owner: ${ownerEmail}`);
  }

  console.log("\n========================================================");
  console.log("Credentials synchronized from environment variables (.env):");
  console.log(`- Super Admin : ${adminEmail} (password: ${adminPass})`);
  console.log(`- Clinic Owner: ${ownerEmail} (password: ${ownerPass})`);
  console.log(`- Clinic Name : ${clinicName} (${clinicPhone})`);
  console.log("========================================================\n");
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
