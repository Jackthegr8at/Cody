import { NextResponse } from "next/server";
import { getRequestUser } from "@/lib/auth/guard";
import { canAccessSession } from "@/lib/auth/session-owners";
import { resolveSessionPath } from "@/lib/session-reader";
import { isSidebarSessionPath } from "@/lib/session-reader";
import { unlinkSync } from "fs";

/** DELETE /api/sidebar-chats/[id] - Delete a sidebar chat session.
 * Only the session owner can delete it. */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = getRequestUser(req);

  if (!canAccessSession(id, user)) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Resolve the session path - must be a sidebar session
  const filePath = await resolveSessionPath(id);
  if (!filePath || !isSidebarSessionPath(filePath)) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  try {
    unlinkSync(filePath);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to delete session" },
      { status: 500 }
    );
  }
}
