"use client";

import { useEffect, useState } from "react";
import { LogOutIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";

interface Account {
	name: string;
	isAdmin: boolean;
	signOutUrl: string;
}

/** "Signed in as …" + Sign out (multi-user design: switching users). Renders
 *  nothing in single-user mode (/api/me answers {account: null}) or when the
 *  read fails. Sign out is a full navigation: oauth2-proxy clears its cookie,
 *  then Keycloak ends its session, so the next visit asks for a login. */
export function AccountLine() {
	const [account, setAccount] = useState<Account | null>(null);
	useEffect(() => {
		let live = true;
		fetch("/api/me")
			.then((r) => (r.ok ? r.json() : null))
			.then((body: { account: Account | null } | null) => {
				if (live) setAccount(body?.account ?? null);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);
	if (!account) return null;
	return (
		<div className="flex w-full items-center justify-between gap-2 px-2 pt-1 text-xs text-muted-foreground" data-testid="account-line">
			<span className="truncate" title={account.isAdmin ? "Admin" : undefined}>
				Signed in as <span className="text-foreground">{account.name}</span>
			</span>
			<Hint label="Sign out (switch user)" side="right">
				<a
					href={account.signOutUrl}
					data-testid="sign-out"
					className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 uppercase tracking-wider transition-colors hover:bg-accent hover:text-foreground"
				>
					<LogOutIcon className="size-3" />
					Sign out
				</a>
			</Hint>
		</div>
	);
}
