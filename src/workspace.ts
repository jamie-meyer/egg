// Where the room thread works: a copy of the room's folder, never the folder
// itself unless the person said so. Pure, so the choice and its fallbacks
// are tested without bb.

export type WorkspaceSetting = "auto" | "clone" | "worktree" | "in-place";
export type WorkspaceKind = "clone" | "worktree" | "in-place";

export const WORKSPACE_SETTINGS: readonly WorkspaceSetting[] = ["auto", "clone", "worktree", "in-place"];

export function workspaceSetting(value: unknown): WorkspaceSetting {
  return WORKSPACE_SETTINGS.includes(value as WorkspaceSetting) ? (value as WorkspaceSetting) : "auto";
}

/** What egg knows about the folder and bb before it tries anything. */
export interface WorkspaceFacts {
  /** The id of the copy-on-write provider (a setting, default cow-clone). */
  cloneProviderId: string;
  /** bb lists that provider. It can still fail at spawn. */
  cloneListed: boolean;
  /** The folder is the top of a git repository. */
  isGitRepo: boolean;
  /** Its .git is a file: a linked worktree, which a clone refuses. */
  gitIsFile: boolean;
  /** The folder is a bb project's checkout (or a bb environment of one), so bb can make a worktree of it. */
  projectCheckout: boolean;
}

/** One way to try, or why it is not available. */
export type Candidate = { kind: WorkspaceKind; ok: true } | { kind: WorkspaceKind; ok: false; why: string };

/** The ways to try, in order, for a setting. `auto` never includes in place. */
export function workspaceCandidates(setting: WorkspaceSetting, facts: WorkspaceFacts): Candidate[] {
  const clone = (): Candidate => {
    if (!facts.cloneListed) return { kind: "clone", ok: false, why: `bb has no environment provider "${facts.cloneProviderId}" (it comes with a plugin that may not be installed)` };
    if (facts.gitIsFile) return { kind: "clone", ok: false, why: "the folder's .git is a file (a linked worktree), which a copy-on-write clone refuses" };
    return { kind: "clone", ok: true };
  };
  const worktree = (): Candidate => {
    if (!facts.isGitRepo) return { kind: "worktree", ok: false, why: "the folder is not the top of a git repository" };
    if (!facts.projectCheckout) return { kind: "worktree", ok: false, why: "the folder is not a bb project's checkout, so bb cannot make a worktree of it" };
    return { kind: "worktree", ok: true };
  };
  switch (setting) {
    case "clone":
      return [clone()];
    case "worktree":
      return [worktree()];
    case "in-place":
      return [{ kind: "in-place", ok: true }];
    default:
      return [clone(), worktree()];
  }
}

/** The notebook line when nothing could be used. */
export function noWorkspaceLine(setting: WorkspaceSetting, tried: readonly { kind: WorkspaceKind; why: string }[]): string {
  const why = tried.map((t) => `${t.kind}: ${t.why}`).join("; ");
  const ask =
    setting === "auto"
      ? "Work mode needs a copy-on-write clone or a git worktree of the folder, or the Workspace setting set to in-place (the room thread would then work in the folder itself)."
      : `The Workspace setting is ${setting}, and that is not available here. Set it to auto, or to in-place to let the room thread work in the folder itself.`;
  return `No room thread: ${why}. ${ask}`.slice(0, 1000);
}

export function workspaceWords(kind: WorkspaceKind): string {
  if (kind === "clone") return "a copy-on-write clone of";
  if (kind === "worktree") return "a git worktree of";
  return "the folder itself:";
}
