/** PUT UserPolicy → 204. Sets the policy new users get. 400 invalid_policy with a detail. */
import { putDefaultsPolicy, requireAdmin, withTenant } from "@/src/server";

export const dynamic = "force-dynamic";

export const PUT = withTenant(async (req: Request) => requireAdmin() ?? (await putDefaultsPolicy(await req.json().catch(() => null))));
