import { DocumentsLibrary } from "@/components/documents-library";
import { documents, withPageTenant } from "@/src/server";

// The library is mutable data on disk: read it per navigation.
export const dynamic = "force-dynamic";

export default async function DocumentsPage() {
	return withPageTenant(() => <DocumentsLibrary initial={documents.list()} />);
}
