/**
 * /api/custom-provider — the admin-managed custom OpenAI-compatible endpoint
 * (upstream port 6). GET status (admins: full, others: {configured});
 * POST connect/edit (probes GET <base>/models); PATCH pins, rates, pricing;
 * DELETE disconnect. Mutations are admin-only, same-origin JSON, If-Match.
 * Wire shapes and error codes: src/server/custom-provider-http.ts.
 */
import { customProviderGet, customProviderMutation, withTenant } from "@/src/server";

export const dynamic = "force-dynamic";

export const GET = withTenant(customProviderGet);
export const POST = withTenant(customProviderMutation);
export const PATCH = withTenant(customProviderMutation);
export const DELETE = withTenant(customProviderMutation);
