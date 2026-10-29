import { handleChatRequest, withTenant } from "@/src/server";

export const POST = withTenant(async (req: Request) => {
	return handleChatRequest(req);
});
