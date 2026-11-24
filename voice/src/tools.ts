// Function-calling tools the LLM can use. API tools proxy to the Node API; transfer/end act on the call.
export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: { type: "object"; properties: Record<string, unknown>; required: string[] } };
}

const def = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ToolDef => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

const str = (description?: string) => (description ? { type: "string", description } : { type: "string" });

export const TOOLS = {
  check_availability: def("check_availability",
    "Find open appointment times. Call with no date to get the next available times, or with a date (YYYY-MM-DD) for that day.", {
      date: str("Day in YYYY-MM-DD (clinic local). Omit for the soonest openings."),
      partOfDay: { type: "string", enum: ["morning", "afternoon", "evening", "any"], description: "Caller's preference." },
      serviceId: str("serviceId from the services list, if known."),
      providerId: str("providerId if the caller asked for a specific dentist."),
    }),
  book_appointment: def("book_appointment", "Book an appointment after the caller clearly confirmed the day and time.", {
    startAt: str("Exact startAt value returned by check_availability."),
    firstName: str(), lastName: str(), serviceId: str(), providerId: str(),
    reason: str("Reason for visit in a few words, e.g. 'cleaning', 'tooth pain'."),
    smsConsent: { type: "boolean", description: "True if the caller agreed to text reminders." },
    callConsent: { type: "boolean", description: "True only if the caller said yes to calls about their visit, including automated calls." },
    dateOfBirth: str("New patients: date of birth as YYYY-MM-DD."),
    insurance: str("New patients, optional: insurance carrier and the member's name as said, e.g. 'Delta Dental, member Jane Doe'. Never ask for member ID or SSN."),
    callbackPhone: str("Only if caller ID is unavailable: their 10 digit phone number."),
  }, ["startAt", "firstName"]),
  verify_caller: def("verify_caller",
    "Identity check. Required before you share, confirm, change or cancel any existing appointment. Pass the first name, and the date of birth (YYYY-MM-DD) or last name if the tool asks for it.",
    { firstName: str(), lastName: str(), dateOfBirth: str("YYYY-MM-DD") }, ["firstName"]),
  find_my_appointments: def("find_my_appointments", "List the verified caller's upcoming appointments. Only works after verify_caller returned verified true."),
  save_date_of_birth: def("save_date_of_birth", "After verify_caller returned askDobForRecords true, ask for their date of birth and save it here.",
    { dateOfBirth: str("YYYY-MM-DD") }, ["dateOfBirth"]),
  opt_out_calls: def("opt_out_calls", "The person asked not to be called again (e.g. 'stop calling me', 'take me off your list'). Call this, confirm, and end politely."),
  reschedule_appointment: def("reschedule_appointment", "Move one of the caller's appointments (from find_my_appointments) to a new time from check_availability.",
    { appointmentId: str(), newStartAt: str() }, ["appointmentId", "newStartAt"]),
  cancel_appointment: def("cancel_appointment", "Cancel one of the caller's appointments after they confirmed. Offer to reschedule first.", { appointmentId: str() }, ["appointmentId"]),
  confirm_appointment: def("confirm_appointment", "Mark the caller's appointment as confirmed when they say they will be there.", { appointmentId: str() }, ["appointmentId"]),
  save_inquiry: def("save_inquiry", "Save a sales inquiry or callback request so the clinic team follows up.", {
    name: str("Caller's name."),
    interest: str("What they want, briefly, e.g. 'Invisalign price', 'accepts Cigna?', 'call back about bill'."),
    callbackPhone: str("Only if different from the number they are calling from."),
  }, ["interest"]),
  save_feedback: def("save_feedback", "Save the patient's rating (1-5) and comment about their visit.",
    { rating: { type: "integer", minimum: 1, maximum: 5 }, comment: str() }),
  transfer_to_staff: def("transfer_to_staff", "Transfer the caller to a human at the clinic. Tell the caller you're transferring them first.", { reason: str() }),
  end_call: def("end_call", "Hang up after you have said goodbye."),
} as const;

export type ToolName = keyof typeof TOOLS;

/** Tools that just proxy to the API's /internal/tools/:name */
export const API_TOOLS = new Set<ToolName>([
  "check_availability", "book_appointment", "verify_caller", "find_my_appointments", "save_date_of_birth",
  "reschedule_appointment", "cancel_appointment", "confirm_appointment", "save_inquiry", "save_feedback", "opt_out_calls",
]);

export function toolsFor(purpose: string, canTransfer: boolean): ToolDef[] {
  const common: ToolName[] = ["check_availability", "book_appointment", "opt_out_calls", "end_call"];
  let extra: ToolName[];
  if (purpose === "RECEPTION") {
    extra = ["verify_caller", "find_my_appointments", "save_date_of_birth", "reschedule_appointment", "cancel_appointment", "confirm_appointment", "save_inquiry"];
    if (canTransfer) extra.push("transfer_to_staff");
  } else if (purpose === "FEEDBACK") {
    extra = ["save_feedback", "save_inquiry"];
  } else {
    extra = ["save_inquiry"];
  }
  return [...common, ...extra].map((n) => TOOLS[n]);
}
