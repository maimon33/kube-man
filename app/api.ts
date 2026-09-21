export type User = {
  id?: string; name: string; email: string; roleId?: string; isOwner?: boolean;
  isAdmin: boolean; permissions: string[];
};

export type Member = {
  id: string; email: string; name: string; roleId: string; roleName: string;
  status: "invited" | "active" | "disabled"; isOwner: boolean; createdAt: number; lastLoginAt: number | null;
};

export type Role = {
  id: string; name: string; description: string; isSystem: boolean; permissions: string[]; userCount: number;
};

export type PermissionInfo = { id: string; group: string; description: string };
export type AuditEvent = { id: number; at: number; actor: string | null; action: string; target: string | null; detail: Record<string, unknown> | null };

/** Permissions that make the Administration area useful to a user. */
export const ADMIN_PERMISSIONS = ["users:view", "users:manage", "roles:manage", "audit:view", "credentials:manage", "clusters:manage", "settings:manage"];

export const can = (user: User, permission: string) => user.permissions.includes(permission);

/**
 * Same-origin call to the identity service or AWS discovery via the gateway.
 * The custom header is required by the server for state-changing requests.
 */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-KubeMan-Request": "1" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let data: { error?: string } = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* Non-JSON error page from a proxy. */ }
  if (response.status === 401) window.location.reload();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}
