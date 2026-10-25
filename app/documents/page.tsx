import { DocumentsLibrary } from "@/components/documents-library";
import { documents } from "@/src/server";

// The library is mutable data on disk: read it per navigation.
export const dynamic = "force-dynamic";

export default function DocumentsPage() {
	return <DocumentsLibrary initial={documents.list()} />;
}
