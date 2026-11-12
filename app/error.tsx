"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/** A route segment threw. The shell (sidebar, settings) stays; only the page
 *  area shows this. */
export default function RouteError({ error, retry }: { error: unknown; retry: () => void }) {
	useEffect(() => {
		console.error(error);
	}, [error]);
	return (
		<div role="alert" data-testid="route-error" className="mx-auto flex max-w-md flex-col items-start gap-3 p-6 font-ui text-sm">
			<h2 className="font-medium">Something went wrong.</h2>
			<p className="text-muted-foreground">This page could not be displayed. Your data is safe.</p>
			<Button type="button" variant="outline" onClick={() => retry()}>
				Try again
			</Button>
		</div>
	);
}
