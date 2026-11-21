import { handle } from "@/lib/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function go(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  return handle(req, path);
}

export const GET = go;
export const POST = go;
export const PATCH = go;
export const DELETE = go;
