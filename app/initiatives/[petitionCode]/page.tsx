import { redirect } from "next/navigation";

export default async function LegacyInitiativeRedirect({ params }: { params: Promise<{ petitionCode: string }> }) {
  const { petitionCode } = await params;
  redirect(`/reports/initiatives/${encodeURIComponent(petitionCode)}`);
}
