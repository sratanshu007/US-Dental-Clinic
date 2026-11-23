// Appointment texts. In LINK mode the text carries no appointment details, only a secure link.
import type { Appointment, Clinic, Patient } from "../db/schema";
import { speakable } from "../lib/time";
import { createPatientLink } from "./patientLinks";

export async function bookedText(clinic: Clinic, patient: Patient, appt: Appointment): Promise<string> {
  if (clinic.smsStyle === "LINK") {
    const url = await createPatientLink(clinic, patient, appt, "BOOKED");
    return `${clinic.name}: your appointment is booked. View details: ${url}`;
  }
  return `${clinic.name}: your appointment is set for ${speakable(appt.startAt, clinic.timezone)}.`;
}

export async function reminderText(clinic: Clinic, patient: Patient, appt: Appointment): Promise<string> {
  const confirmAsk = appt.status === "CONFIRMED" ? "" : " Reply C to confirm or R to reschedule.";
  if (clinic.smsStyle === "LINK") {
    const url = await createPatientLink(clinic, patient, appt, "REMINDER");
    return `${clinic.name}: you have an upcoming appointment. View details: ${url}${confirmAsk}`;
  }
  return `${clinic.name} reminder: your appointment is ${speakable(appt.startAt, clinic.timezone)}.${confirmAsk}`;
}
