import type {
  ApprovalDecision,
  ChatApprovalRequest,
  ChatPermissionMode,
  JsonObject,
  PermissionModeDefinition,
  PermissionProfileSummary,
} from "./codex-chat-types.mts";
import { recordValue, stringValue } from "./codex-service-utils.mts";

export const DEFAULT_PERMISSION_MODE_ID = "read-only";

export const APPROVAL_DECISIONS = new Set<ApprovalDecision>([
  "accept",
  "acceptForSession",
  "decline",
]);

export const APPROVAL_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

/** @type {PermissionModeDefinition[]} */
const BUILT_IN_PERMISSION_MODES: PermissionModeDefinition[] = [
  {
    id: DEFAULT_PERMISSION_MODE_ID,
    profileId: ":read-only",
    label: "Read only",
    description:
      "Inspect the workspace without changing files or using unrestricted access.",
    access: "Read only",
    dangerous: false,
  },
  {
    id: "ask-for-approval",
    profileId: ":workspace",
    label: "Ask for approval",
    description:
      "Edit inside the workspace and ask before crossing its boundary.",
    access: "Ask for approval",
    dangerous: false,
  },
  {
    id: "approve-for-me",
    profileId: ":workspace",
    label: "Approve for me",
    description:
      "Edit inside the workspace and send boundary requests to automatic review.",
    access: "Approve for me",
    dangerous: false,
  },
  {
    id: "full-access",
    profileId: ":danger-full-access",
    label: "Full access",
    description:
      "Allow unrestricted file, command, and network access without approval.",
    access: "Full access",
    dangerous: true,
  },
];

/**
 * @param {PermissionModeDefinition} definition
 * @param {boolean} allowed
 * @returns {ChatPermissionMode}
 */
function permissionModeFromDefinition(
  definition: PermissionModeDefinition,
  allowed: boolean,
): ChatPermissionMode {
  return {
    id: definition.id,
    profileId: definition.profileId,
    label: definition.label,
    description: definition.description,
    access: definition.access,
    allowed,
    dangerous: definition.dangerous,
  };
}

/**
 * @param {unknown} value
 * @returns {ChatPermissionMode[]}
 */
export function permissionModesFromListResponse(
  value: unknown,
): ChatPermissionMode[] {
  const response = recordValue(value);
  if (!response || !Array.isArray(response.data)) {
    throw new Error("The Codex permission profile response format is invalid.");
  }
  /** @type {PermissionProfileSummary[]} */
  const profiles: PermissionProfileSummary[] = [];
  for (const value of response.data) {
    const profile = recordValue(value);
    const id = stringValue(profile?.id)?.trim();
    if (!profile || !id) continue;
    profiles.push({
      id,
      description: stringValue(profile.description)?.trim() || null,
      allowed: profile.allowed === true,
    });
  }
  const profilesById = new Map(
    profiles.map((profile) => [profile.id, profile]),
  );
  /** @type {ChatPermissionMode[]} */
  const builtInModes: ChatPermissionMode[] = BUILT_IN_PERMISSION_MODES.map(
    (mode) =>
      permissionModeFromDefinition(
        mode,
        profilesById.get(mode.profileId)?.allowed === true,
      ),
  );
  const builtInProfileIds = new Set(
    BUILT_IN_PERMISSION_MODES.map((mode) => mode.profileId),
  );
  /** @type {ChatPermissionMode[]} */
  const customModes: ChatPermissionMode[] = profiles
    .filter((profile) => !builtInProfileIds.has(profile.id))
    .map((profile) => {
      const label = profile.id.replace(/^:/, "") || profile.id;
      return {
        id: `custom:${profile.id}`,
        profileId: profile.id,
        label,
        description:
          profile.description ?? "Use this custom Codex permission profile.",
        access: label,
        allowed: profile.allowed,
        dangerous: false,
      };
    });
  return [...builtInModes, ...customModes];
}

/** @returns {ChatPermissionMode} */
export function defaultPermissionMode(): ChatPermissionMode {
  const mode = BUILT_IN_PERMISSION_MODES.find(
    (candidate) => candidate.id === DEFAULT_PERMISSION_MODE_ID,
  );
  if (!mode) throw new Error("The default permission mode is unavailable.");
  return permissionModeFromDefinition(mode, true);
}

/**
 * @param {ChatPermissionMode} mode
 * @returns {JsonObject}
 */
export function permissionModeSettings(mode: ChatPermissionMode): JsonObject {
  if (mode.id === DEFAULT_PERMISSION_MODE_ID) {
    return {
      permissions: mode.profileId,
      approvalPolicy: "never",
      approvalsReviewer: "user",
    };
  }
  if (mode.id === "ask-for-approval") {
    return {
      permissions: mode.profileId,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    };
  }
  if (mode.id === "approve-for-me") {
    return {
      permissions: mode.profileId,
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    };
  }
  if (mode.id === "full-access") {
    return {
      permissions: mode.profileId,
      approvalPolicy: "never",
      approvalsReviewer: "user",
    };
  }
  return { permissions: mode.profileId };
}

/**
 * @param {string} method
 * @param {JsonObject} params
 * @returns {{ kind: ChatApprovalRequest['kind'], title: string, detail: string }}
 */
export function approvalPresentation(
  method: string,
  params: JsonObject,
): { kind: ChatApprovalRequest["kind"]; title: string; detail: string } {
  const reason = stringValue(params.reason)?.trim();
  if (method === "item/commandExecution/requestApproval") {
    return {
      kind: "command",
      title: "Command approval",
      detail:
        stringValue(params.command)?.trim() ||
        reason ||
        "Codex requested permission to run a command.",
    };
  }
  if (method === "item/fileChange/requestApproval") {
    return {
      kind: "fileChange",
      title: "File change approval",
      detail:
        reason ||
        stringValue(params.grantRoot)?.trim() ||
        "Codex requested additional write access.",
    };
  }
  return {
    kind: "permissions",
    title: "Additional access",
    detail:
      reason || "Codex requested additional workspace or network permissions.",
  };
}

/**
 * @param {JsonObject} params
 * @returns {JsonObject}
 */
function grantedPermissions(params: JsonObject): JsonObject {
  const requested = recordValue(params.permissions);
  /** @type {JsonObject} */
  const granted: JsonObject = {};
  if (requested && recordValue(requested.network))
    granted.network = requested.network;
  if (requested && recordValue(requested.fileSystem))
    granted.fileSystem = requested.fileSystem;
  return granted;
}

/**
 * @param {string} method
 * @param {JsonObject} params
 * @param {'accept' | 'acceptForSession' | 'decline'} decision
 * @returns {JsonObject}
 */
export function approvalResponse(
  method: string,
  params: JsonObject,
  decision: "accept" | "acceptForSession" | "decline",
): JsonObject {
  if (method !== "item/permissions/requestApproval") return { decision };
  return {
    permissions: decision === "decline" ? {} : grantedPermissions(params),
    scope: decision === "acceptForSession" ? "session" : "turn",
  };
}
