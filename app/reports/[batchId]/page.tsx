import { redirect } from "next/navigation";

export default async function LegacyBatchReportRedirect({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  redirect(`/reports/batches/${encodeURIComponent(batchId)}`);
}
