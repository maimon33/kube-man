"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { type AuditEvent, type Member, type PermissionInfo, type Role, type User, api, can } from "./api";

function initials(name: string) { return name.split(/[\s@.]+/).filter(Boolean).map((part) => part[0]).join("").slice(0, 2).toUpperCase(); }

function ago(timestamp: number | null) {
  if (!timestamp) return "Never";
  const seconds = Math.max(0, Date.now() / 1000 - timestamp);
  if (seconds < 90) return "Just now";
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 129600) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(timestamp * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Loads members, roles and the permission catalog the current user may see. */
export function useAccess(user: User) {
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [catalog, setCatalog] = useState<PermissionInfo[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [permissions, people, roleList] = await Promise.all([
      api<{ permissions: PermissionInfo[] }>("/api/permissions"),
      can(user, "users:view") ? api<{ users: Member[] }>("/api/users") : Promise.resolve({ users: [] }),
      can(user, "users:view") ? api<{ roles: Role[] }>("/api/roles") : Promise.resolve({ roles: [] }),
    ]);
    return { catalog: permissions.permissions, members: people.users, roles: roleList.roles };
  }, [user]);

  const apply = useCallback((data: Awaited<ReturnType<typeof load>>) => {
    setCatalog(data.catalog); setMembers(data.members); setRoles(data.roles); setError("");
  }, []);
  const fail = useCallback((failure: unknown) => setError(failure instanceof Error ? failure.message : "Could not load access data"), []);
  const reload = useCallback(() => load().then(apply, fail), [load, apply, fail]);

  useEffect(() => { load().then(apply, fail); }, [load, apply, fail]);
  return { members, roles, catalog, error, reload, setMembers, setRoles };
}

type Access = ReturnType<typeof useAccess>;

export function UsersPanel({ user, access, notify, invite }: { user: User; access: Access; notify: (message: string) => void; invite: () => void }) {
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState("");
  const manage = can(user, "users:manage");
  const shown = access.members.filter((member) => `${member.name} ${member.email}`.toLowerCase().includes(query.toLowerCase()));

  async function change(member: Member, body: { roleId?: string; status?: string }, message: string) {
    setBusyId(member.id);
    try {
      const result = await api<{ users: Member[] }>(`/api/users/${member.id}`, { method: "PATCH", body });
      access.setMembers(result.users); void access.reload(); notify(message);
    } catch (failure) { notify(failure instanceof Error ? failure.message : "Update failed"); }
    setBusyId("");
  }

  async function remove(member: Member) {
    if (!window.confirm(`Remove ${member.email}? They will lose access immediately.`)) return;
    setBusyId(member.id);
    try {
      const result = await api<{ users: Member[] }>(`/api/users/${member.id}`, { method: "DELETE" });
      access.setMembers(result.users); void access.reload(); notify(`${member.email} removed`);
    } catch (failure) { notify(failure instanceof Error ? failure.message : "Remove failed"); }
    setBusyId("");
  }

  const active = access.members.filter((member) => member.status === "active").length;
  return <details className="admin-card admin-fold" open><summary><div><strong>Users & access</strong><span>Members, their role, and account status</span></div><b>{access.members.length} member{access.members.length === 1 ? "" : "s"} · {active} active</b></summary>
    <div className="admin-card-body">
      <div className="section-actions"><input className="admin-search" placeholder="Search members…" value={query} onChange={(event) => setQuery(event.target.value)} />{manage && <button className="secondary" onClick={invite}>Invite member</button>}</div>
      {access.error && <div className="access-error">{access.error}</div>}
      <div className="members-table"><div className="member-row access header"><span>User</span><span>Role</span><span>Status</span><span>Last sign-in</span><span /></div>
        {shown.map((member) => <div className="member-row access" key={member.id}>
          <div className="member"><div className="avatar">{initials(member.name)}</div><div><strong>{member.name}{member.isOwner && <em className="owner-tag">owner</em>}</strong><span>{member.email}</span></div></div>
          {manage && !member.isOwner && member.id !== user.id
            ? <select className="role-select" value={member.roleId} disabled={busyId === member.id} onChange={(event) => change(member, { roleId: event.target.value }, `${member.email} is now ${access.roles.find((role) => role.id === event.target.value)?.name ?? "updated"}`)}>{access.roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select>
            : <span className={`role ${member.roleId === "admin" ? "admin" : ""}`}>{member.roleName}</span>}
          <span className={`member-status ${member.status}`}>{member.status === "invited" ? "Invited" : member.status === "active" ? "Active" : "Disabled"}</span>
          <span>{ago(member.lastLoginAt)}</span>
          <span className="row-actions">{manage && !member.isOwner && member.id !== user.id && <>
            <button className="tiny-btn" disabled={busyId === member.id} onClick={() => change(member, { status: member.status === "disabled" ? "active" : "disabled" }, member.status === "disabled" ? `${member.email} enabled` : `${member.email} disabled`)}>{member.status === "disabled" ? "Enable" : "Disable"}</button>
            <button className="tiny-btn danger" disabled={busyId === member.id} onClick={() => remove(member)}>Remove</button></>}</span>
        </div>)}
        {!shown.length && <div className="access-empty">{access.members.length ? "No members match your search." : "No members yet."}</div>}
      </div>
    </div></details>;
}

export function RolesPanel({ user, access, notify }: { user: User; access: Access; notify: (message: string) => void }) {
  const [editing, setEditing] = useState<Role | "new" | null>(null);
  const manage = can(user, "roles:manage");
  const groups = useMemo(() => [...new Set(access.catalog.map((item) => item.group))], [access.catalog]);

  async function remove(role: Role) {
    if (!window.confirm(`Delete the role “${role.name}”?`)) return;
    try {
      const result = await api<{ roles: Role[] }>(`/api/roles/${role.id}`, { method: "DELETE" });
      access.setRoles(result.roles); notify(`${role.name} deleted`);
    } catch (failure) { notify(failure instanceof Error ? failure.message : "Delete failed"); }
  }

  return <details className="admin-card admin-fold"><summary><div><strong>Roles & permissions</strong><span>What each role is allowed to do. Built-in roles are fixed; create custom roles for anything else</span></div><b>{access.roles.length} roles</b></summary>
    <div className="admin-card-body">
      {manage && <div className="section-actions"><span className="access-hint">Permissions are enforced on every request, so changes apply to signed-in users immediately.</span><button className="secondary" onClick={() => setEditing("new")}>Create role</button></div>}
      <div className="role-list">{access.roles.map((role) => <div className="role-card" key={role.id}>
        <div className="role-card-head"><div><strong>{role.name}</strong>{role.isSystem && <em className="owner-tag">built-in</em>}<span>{role.description || "No description"}</span></div><b>{role.userCount} user{role.userCount === 1 ? "" : "s"}</b></div>
        <div className="perm-chips">{role.permissions.length ? role.permissions.map((permission) => <code key={permission}>{permission}</code>) : <span className="access-hint">No permissions</span>}</div>
        {manage && !role.isSystem && <div className="role-card-actions"><button className="tiny-btn" onClick={() => setEditing(role)}>Edit</button><button className="tiny-btn danger" onClick={() => remove(role)}>Delete</button></div>}
      </div>)}</div>
    </div>
    {editing && <RoleModal role={editing === "new" ? null : editing} catalog={access.catalog} groups={groups} close={() => setEditing(null)} saved={(roles, message) => { access.setRoles(roles); setEditing(null); notify(message); }} />}
  </details>;
}

function RoleModal({ role, catalog, groups, close, saved }: { role: Role | null; catalog: PermissionInfo[]; groups: string[]; close: () => void; saved: (roles: Role[], message: string) => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = { name: String(form.get("name") ?? ""), description: String(form.get("description") ?? ""), permissions: [...selected] };
    setBusy(true); setError("");
    try {
      const result = await api<{ roles: Role[] }>(role ? `/api/roles/${role.id}` : "/api/roles", { method: role ? "PATCH" : "POST", body });
      saved(result.roles, role ? `${body.name || role.name} updated` : `${body.name} created`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not save role"); setBusy(false); }
  }

  function toggle(id: string) {
    setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}><form className="modal modal-wide" role="dialog" aria-modal="true" aria-label={role ? "Edit role" : "Create role"} onSubmit={submit}>
    <div className="modal-head"><div><h2>{role ? `Edit ${role.name}` : "Create a role"}</h2><p>Choose exactly what members with this role can do.</p></div><button type="button" className="close" onClick={close}>×</button></div>
    <div className="modal-body">
      <div className="field-grid"><div className="field"><label>Role name</label><input name="name" required defaultValue={role?.name ?? ""} maxLength={60} placeholder="e.g. On-call engineer" /></div><div className="field"><label>Description</label><input name="description" defaultValue={role?.description ?? ""} maxLength={200} placeholder="Optional" /></div></div>
      {groups.map((group) => <fieldset className="perm-group" key={group}><legend>{group}</legend>{catalog.filter((item) => item.group === group).map((item) => <label className="check-row" key={item.id}><input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} /><span><strong>{item.id}</strong><small>{item.description}</small></span></label>)}</fieldset>)}
      {selected.has("terminal:use") && <div className="discovery-note"><strong>Terminal access is broad</strong><span>The shell uses the mounted kubeconfig and AWS profile, so it can do whatever those credentials allow regardless of the other permissions.</span></div>}
      {error && <div className="modal-error">{error}</div>}
    </div>
    <div className="modal-foot"><button type="button" className="secondary" onClick={close} disabled={busy}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy ? "Saving…" : role ? "Save changes" : "Create role"}</button></div>
  </form></div>;
}

export function InviteModal({ access, close, done }: { access: Access; close: () => void; done: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    setBusy(true); setError("");
    try {
      const result = await api<{ users: Member[] }>("/api/users", { method: "POST", body: { email, roleId: form.get("roleId") } });
      access.setMembers(result.users); void access.reload(); done(`${email} can now sign in with Google`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not add member"); setBusy(false); }
  }

  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}><form className="modal" role="dialog" aria-modal="true" aria-label="Invite a member" onSubmit={submit}>
    <div className="modal-head"><div><h2>Invite a member</h2><p>They sign in with the Google account for this email. No email is sent yet, so share the KubeMan address with them.</p></div><button type="button" className="close" onClick={close}>×</button></div>
    <div className="modal-body"><div className="field"><label>Google account email</label><input name="email" type="email" required placeholder="operator@company.com" autoComplete="off" /></div>
      <div className="field"><label>Role</label><select name="roleId" defaultValue="viewer">{access.roles.map((role) => <option key={role.id} value={role.id}>{role.name}{role.description ? ` — ${role.description}` : ""}</option>)}</select></div>
      {error && <div className="modal-error">{error}</div>}</div>
    <div className="modal-foot"><button type="button" className="secondary" onClick={close} disabled={busy}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy ? "Adding…" : "Add member"}</button></div>
  </form></div>;
}

const ACTION_LABELS: Record<string, string> = {
  "login": "Signed in", "login.denied": "Sign-in denied", "system.initialized": "System initialized",
  "user.invited": "Invited member", "user.autoprovisioned": "Auto-created member", "user.role_changed": "Changed role",
  "user.status_changed": "Changed status", "user.removed": "Removed member",
  "role.created": "Created role", "role.updated": "Updated role", "role.deleted": "Deleted role",
};

export function AuditPanel() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState("");
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    if (!opened) return;
    api<{ events: AuditEvent[] }>("/api/audit?limit=100").then((result) => setEvents(result.events)).catch((failure: Error) => setError(failure.message));
  }, [opened]);

  return <details className="admin-card admin-fold" onToggle={(event) => event.currentTarget.open && setOpened(true)}><summary><div><strong>Audit log</strong><span>Sign-ins, membership and role changes</span></div><b>Latest {events.length || ""}</b></summary>
    <div className="admin-card-body">{error && <div className="access-error">{error}</div>}
      <div className="audit-list">{events.map((event) => <div className="audit-row" key={event.id}><time>{new Date(event.at * 1000).toLocaleString()}</time><strong>{ACTION_LABELS[event.action] ?? event.action}</strong><span>{event.target || "—"}</span><small>by {event.actor || "system"}{event.detail ? ` · ${Object.entries(event.detail).map(([key, value]) => `${key}: ${String(value)}`).join(", ")}` : ""}</small></div>)}
        {opened && !events.length && !error && <div className="access-empty">No events yet.</div>}</div>
    </div></details>;
}
