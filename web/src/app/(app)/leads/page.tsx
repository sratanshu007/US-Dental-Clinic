import { redirect } from "next/navigation";

// Inquiries moved into the CRM.
export default function Leads() {
  redirect("/crm");
}
