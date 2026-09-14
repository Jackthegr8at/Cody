import { NextResponse } from "next/server";
import { getRequestUser } from "@/lib/auth/guard";
import { canAccessSession } from "@/lib/auth/session-owners";
import { getSidebarChatsDir } from "@/lib/omp/paths";
import { readSessionHeaderSync } from "@/lib/omp/session-files";
import { existsSync, readdirSync, statSync } from "fs";
import path from "path";

interface SidebarChatInfo {
  id: string;
  title: string;
  updatedAt: string;
}

/** GET /api/sidebar-chats - List sidebar chats for the current workspace.
 * Searches <agentDir>/cody-sidebar-chats/** for session files and returns
 * their id, title (from first user message), and updatedAt (from file mtime). */
export async function GET(req: Request) {
  const user = getRequestUser(req);
  const sidebarRoot = getSidebarChatsDir();
  
  // Sidebar root may not exist yet (new install), so return empty list gracefully
  if (!existsSync(sidebarRoot)) {
    return NextResponse.json([]);
  }

  const result: SidebarChatInfo[] = [];
  try {
    // Scan <sidebarRoot>/*/ for workspace slug directories
    const workspaceDirs = readdirSync(sidebarRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const workspaceDir of workspaceDirs) {
      const workspacePath = path.join(sidebarRoot, workspaceDir);
      const sessionFiles = readdirSync(workspacePath, { withFileTypes: true })
        .filter((f) => f.isFile() && f.name.endsWith(".jsonl"))
        .map((f) => path.join(workspacePath, f.name));

      for (const filePath of sessionFiles) {
        try {
          const header = readSessionHeaderSync(filePath);
          if (!header) continue;

          const sessionId = header.id;
          // Access control: only return sessions this user owns
          if (!canAccessSession(sessionId, user)) continue;

          const stat = statSync(filePath);
          result.push({
            id: sessionId,
            title: header.title || "(New chat)",
            updatedAt: new Date(stat.mtime).toISOString(),
          });
        } catch {
          // Malformed or unreadable session file, skip it
        }
      }
    }
  } catch {
    // Sidebar tree scan failed, return empty list
  }

  return NextResponse.json(result);
}
