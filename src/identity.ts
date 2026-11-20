// The defaults that tell one installed copy of egg from another.
// scripts/copy-for-checks.mjs rewrites this file in a test copy, so a check
// never shares rooms or thread titles with the egg a person is using.

/** Where each room's directory goes, unless the Rooms directory setting says otherwise. */
export const DEFAULT_ROOMS_DIR = "~/egg";
/** The start of every thread title egg gives, unless the setting says otherwise. */
export const DEFAULT_TITLE_PREFIX = "egg";
/**
 * The key that, with Control and Option (Alt), opens egg's page from anywhere
 * in bb. Two installed plugins asking for the same default leave both
 * unbound, so a test copy gets another key.
 */
export const DEFAULT_OPEN_KEY = "e";
