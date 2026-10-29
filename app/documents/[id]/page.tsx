import { notFound } from "next/navigation";
import { DocumentReader } from "@/components/document-reader";
import { documents, withPageTenant } from "@/src/server";

export const dynamic = "force-dynamic";

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return withPageTenant(() => {
		const found = documents.get(id);
		if (!found) notFound();
		return <DocumentReader meta={found.meta} markdown={found.markdown} />;
	});
}
