"use client";

import { FormEvent, useMemo, useState } from "react";

type User = { name: string; email: string; isAdmin: boolean };

const resources = [
  ["api-gateway-7d8c9", "Pod", "Running", "142m", "34%"],
  ["payments-api-6fb4d", "Pod", "Running", "86m", "18%"],
  ["orders-api-79cc8", "Pod", "Running", "231m", "52%"],
  ["redis-primary-0", "Pod", "Running", "74m", "27%"],
  ["checkout-worker-5c8b", "Pod", "Running", "118m", "41%"],
];

const events = [
  ["10:42:18", "ok", "Scaled deployment/orders-api", "Replicas changed from 4 to 6 · autoscaler"],
  ["10:41:03", "warn", "BackOff restarting container", "payments-api-6fb4d · retry 3"],
  ["10:38:51", "ok", "Pulled image successfully", "checkout-worker · v2.8.1"],
  ["10:37:12", "error", "Readiness probe failed", "inventory-api · HTTP 503"],
  ["10:34:40", "ok", "Created pod", "orders-api-79cc8 · node ip-10-0-4-21"],
];

const members = [
  ["Alex Morgan", "alex@acme.dev", "Admin", "All clusters", "Just now"],
  ["Maya Chen", "maya@acme.dev", "Operator", "Production", "18 min ago"],
  ["Sam Rivera", "sam@acme.dev", "Viewer", "Staging", "Yesterday"],
  ["Noah Williams", "noah@acme.dev", "Operator", "3 clusters", "Aug 5"],
];

export default function ConsoleApp({ user }: { user: User }) {
  const [section, setSection] = useState<"workspace" | "admin">("workspace");
  const [layout, setLayout] = useState<2 | 3 | 4>(4);
  const [resourceScope, setResourceScope] = useState("Workloads");
  const [eventFilter, setEventFilter] = useState("All");
  const [selectedNode, setSelectedNode] = useState("service");
  const [terminalLines, setTerminalLines] = useState<string[]>([]);
  const [command, setCommand] = useState("");
  const [modal, setModal] = useState<null | "cluster" | "invite">(null);
  const [toast, setToast] = useState("");
  const filteredEvents = useMemo(() => eventFilter === "All" ? events : events.filter((event) => event[1] === eventFilter.toLowerCase()), [eventFilter]);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }

  function runCommand(event: FormEvent) {
    event.preventDefault();
    if (!command.trim()) return;
    setTerminalLines((lines) => [...lines.slice(-4), `$ ${command}`, command.includes("get") ? "NAME                 READY   STATUS    AGE" : "Command queued in production-us-east-1"]);
    setCommand("");
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><div className="brand-mark">KM</div><span>KubeMan</span></div>
        <button className="cluster-select" onClick={() => setModal("cluster")} aria-label="Switch cluster">
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}><i className="cluster-dot" /><strong>production-us-east-1</strong></span><span>⌄</span>
        </button>
        <div className="top-actions">
          <button className="icon-btn command-trigger" onClick={() => notify("Command palette ready — try the terminal below")}>⌕&nbsp; Search or run <span className="key">⌘ K</span></button>
          <button className="icon-btn" aria-label="Notifications" onClick={() => setEventFilter("warn")}>◔</button>
          <button className="icon-btn" aria-label="Help" onClick={() => notify("KubeMan help center will open here")}>?</button>
          <div className="avatar" title={user.email}>{user.name.split(" ").map((part) => part[0]).join("").slice(0, 2)}</div>
        </div>
      </header>

      <nav className="rail" aria-label="Primary navigation">
        <button className={`rail-btn ${section === "workspace" ? "active" : ""}`} onClick={() => setSection("workspace")} aria-label="Workspace">⌂</button>
        <button className="rail-btn" onClick={() => { setSection("workspace"); notify("Resource explorer selected"); }} aria-label="Resources">▦</button>
        <button className="rail-btn" onClick={() => { setSection("workspace"); setLayout(2); }} aria-label="Terminal">›_</button>
        <button className="rail-btn" onClick={() => { setSection("workspace"); setLayout(3); }} aria-label="Topology">⌘</button>
        <button className="rail-btn" onClick={() => { setSection("workspace"); setEventFilter("All"); }} aria-label="History">◷</button>
        <div className="rail-spacer" />
        {user.isAdmin && <button className={`rail-btn ${section === "admin" ? "active" : ""}`} onClick={() => setSection("admin")} aria-label="Administration">⚙</button>}
      </nav>

      <aside className="context">
        <div className="context-head"><h2 className="context-title">Clusters</h2><button className="add-btn" onClick={() => setModal("cluster")} aria-label="Add cluster">+</button></div>
        <input className="context-search" placeholder="Filter clusters…" aria-label="Filter clusters" />
        <div className="nav-group">
          <div className="group-label">Connected</div>
          <button className="nav-row active"><i className="tree-line" />production-us-east-1<span className="count">24</span></button>
          <button className="nav-row"><i className="tree-line" />staging-eu-west-1<span className="count">12</span></button>
          <button className="nav-row"><i className="tree-line warn" />dev-platform<span className="count">8</span></button>
        </div>
        <div className="nav-group">
          <div className="group-label">Saved views</div>
          <button className="nav-row">☆ Critical workloads<span className="count">6</span></button>
          <button className="nav-row">☆ Payments stack<span className="count">9</span></button>
          <button className="nav-row">☆ Cost watch<span className="count">4</span></button>
        </div>
        <div className="nav-group">
          <div className="group-label">Namespaces</div>
          <button className="nav-row active">All namespaces<span className="count">16</span></button>
          <button className="nav-row">commerce</button><button className="nav-row">payments</button><button className="nav-row">platform</button>
        </div>
        <div className="context-user"><div className="user-card"><div className="avatar">{user.name.split(" ").map((p) => p[0]).join("").slice(0,2)}</div><div className="user-meta"><strong>{user.name}</strong><span>{user.isAdmin ? "Workspace admin" : "Operator"}</span></div></div></div>
      </aside>

      <main className="main">
        {section === "workspace" ? (
          <>
            <div className="workspace-bar"><span className="crumb">Clusters / <strong>production-us-east-1</strong></span><span className="health"><i className="cluster-dot" /> Healthy · 24 nodes</span><div className="layout-controls" aria-label="Pane layout"><button className={`layout-btn ${layout === 2 ? "active" : ""}`} onClick={() => setLayout(2)}>Ⅱ</button><button className={`layout-btn ${layout === 3 ? "active" : ""}`} onClick={() => setLayout(3)}>Ⅲ</button><button className={`layout-btn ${layout === 4 ? "active" : ""}`} onClick={() => setLayout(4)}>▦</button></div></div>
            <div className={`workspace-grid layout-${layout}`}>
              <section className="pane">
                <div className="pane-head"><span className="pane-title">Kubernetes</span><span className="pane-subtitle">commerce</span><div className="pane-actions"><div className="segmented">{["Workloads", "Network", "Config"].map((scope) => <button key={scope} className={resourceScope === scope ? "active" : ""} onClick={() => setResourceScope(scope)}>{scope}</button>)}</div><button className="tiny-btn" onClick={() => notify("Resource list refreshed")}>↻</button><button className="tiny-btn">•••</button></div></div>
                <div className="resource-summary"><div className="summary-item"><strong>42</strong><span>Pods</span></div><div className="summary-item"><strong>18</strong><span>Deployments</span></div><div className="summary-item"><strong>12</strong><span>Services</span></div><div className="summary-item"><strong>99.8%</strong><span>Healthy</span></div></div>
                <div className="resource-table"><div className="table-head"><span>Name</span><span>Status</span><span>CPU</span><span>Age</span></div>{resources.map(([name, kind, status, cpu, percent]) => <div className="table-row" key={name}><div className="resource-name"><span className="kind">{kind[0]}</span>{name}</div><span className="status-ok">{status}</span><span>{cpu}<div className="cpu-bar"><span style={{ width: percent }} /></div></span><span>{name.includes("redis") ? "12d" : "4h"}</span></div>)}</div>
              </section>

              <section className="pane terminal-pane">
                <div className="pane-head"><span className="pane-title">Terminal</span><span className="pane-subtitle">bash · production</span><div className="pane-actions"><button className="tiny-btn" onClick={() => setTerminalLines([])}>⌫</button><button className="tiny-btn">＋</button><button className="tiny-btn">•••</button></div></div>
                <div className="terminal-tabs"><button className="term-tab active">kubectl</button><button className="term-tab">helm</button><button className="term-tab">ops-shell</button></div>
                <div className="terminal"><div className="term-line"><span className="prompt">alex@kubeman</span><span className="term-muted">:commerce $ </span><span className="cmd">kubectl get pods -o wide</span></div><div className="term-line term-muted">NAME                 READY   STATUS    RESTARTS   NODE</div><div className="term-line"><span className="term-cyan">api-gateway-7d8c9</span>   1/1     Running   0          ip-10-0-4-21</div><div className="term-line"><span className="term-cyan">payments-api-6fb4d</span>  1/1     Running   1          ip-10-0-7-14</div><div className="term-line"><span className="term-cyan">orders-api-79cc8</span>    1/1     Running   0          ip-10-0-4-21</div><div className="term-line"><span className="prompt">alex@kubeman</span><span className="term-muted">:commerce $ </span><span className="cmd">helm list</span></div><div className="term-line"><span className="term-amber">commerce-stack</span>   commerce   12   deployed   2.8.1</div>{terminalLines.map((line, i) => <div key={i} className={line.startsWith("$") ? "term-line cmd" : "term-line term-muted"}>{line}</div>)}<form className="terminal-input" onSubmit={runCommand}><span className="prompt">alex@kubeman</span><span className="term-muted">:commerce $</span><input value={command} onChange={(e) => setCommand(e.target.value)} aria-label="Terminal command" autoComplete="off" /></form></div>
              </section>

              <section className="pane">
                <div className="pane-head"><span className="pane-title">Resource flow</span><span className="pane-subtitle">Live traffic · 30s</span><div className="pane-actions"><button className="tiny-btn" onClick={() => notify("Flow graph centered")}>◎</button><button className="tiny-btn">＋</button><button className="tiny-btn">−</button></div></div>
                <div className="flow-canvas"><div className="flow-inner"><div className="flow-edge edge-1"/><div className="flow-edge edge-2"/><div className="flow-edge edge-3"/><div className="flow-edge edge-4"/><span className="traffic-pill pill-1">1.2k r/s</span><span className="traffic-pill pill-2">820 r/s</span><span className="traffic-pill pill-3">390 r/s</span>{[["ingress","public-ingress","Ingress","IN"],["service","api-gateway","Service","SVC"],["api-a","orders-api","Deployment","D"],["api-b","payments-api","Deployment","D"],["db","orders-db","StatefulSet","ST"]].map(([cls,name,type,icon]) => <button key={cls} className={`flow-node ${cls} ${selectedNode === cls ? "active" : ""}`} onClick={() => setSelectedNode(cls)}><strong>{name}</strong><span>{type}</span><i className="node-icon">{icon}</i></button>)}</div></div>
              </section>

              <section className="pane">
                <div className="pane-head"><span className="pane-title">Events & history</span><span className="pane-subtitle">128 in the last hour</span><div className="pane-actions"><button className="tiny-btn" onClick={() => notify("Event stream paused")}>Ⅱ</button><button className="tiny-btn">⇩</button></div></div>
                <div className="event-filters">{["All", "Warn", "Error"].map((filter) => <button key={filter} className={`filter-chip ${eventFilter === filter ? "active" : ""}`} onClick={() => setEventFilter(filter)}>{filter}</button>)}</div><div className="event-list">{filteredEvents.map(([time,type,title,detail]) => <div className="event" key={time}><span className="event-time">{time}</span><i className={`event-dot ${type}`} /><div className="event-text"><strong>{title}</strong><span>{detail}</span></div></div>)}</div>
              </section>
            </div>
          </>
        ) : (
          <AdminView onInvite={() => setModal("invite")} />
        )}
      </main>
      {modal && <Modal type={modal} close={() => setModal(null)} submit={() => { setModal(null); notify(modal === "invite" ? "Invitation queued" : "Cluster connection saved"); }} />}
      {toast && <div className="toast">✓&nbsp;&nbsp;{toast}</div>}
    </div>
  );
}

function AdminView({ onInvite }: { onInvite: () => void }) {
  return <div className="admin-page"><div className="admin-titlebar"><div><h1>Workspace administration</h1><p>Manage members, access boundaries and saved cluster connections.</p></div><button className="primary" onClick={onInvite}>+ Invite member</button></div><div className="stat-grid"><div className="stat-card"><span>Active members</span><strong>24</strong></div><div className="stat-card"><span>Connected clusters</span><strong>8</strong></div><div className="stat-card"><span>Saved profiles</span><strong>31</strong></div><div className="stat-card"><span>Audit events · 7d</span><strong>1,284</strong></div></div><div className="admin-card"><div className="admin-card-head"><strong>Members</strong><span>24 people with workspace access</span></div><div className="members-table"><div className="member-row header"><span>User</span><span>Role</span><span>Access</span><span>Last active</span><span/></div>{members.map(([name,email,role,access,last]) => <div className="member-row" key={email}><div className="member"><div className="avatar">{name.split(" ").map((part) => part[0]).join("")}</div><div><strong>{name}</strong><span>{email}</span></div></div><span className={`role ${role === "Admin" ? "admin" : ""}`}>{role}</span><span>{access}</span><span>{last}</span><button className="tiny-btn">•••</button></div>)}</div></div></div>;
}

function Modal({ type, close, submit }: { type: "cluster" | "invite"; close: () => void; submit: () => void }) {
  const invite = type === "invite";
  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}><div className="modal" role="dialog" aria-modal="true" aria-label={invite ? "Invite member" : "Connect cluster"}><div className="modal-head"><div><h2>{invite ? "Invite a member" : "Connect a cluster"}</h2><p>{invite ? "Grant workspace access with a controlled role." : "Kubeconfig secrets are encrypted and never shown after saving."}</p></div><button className="close" onClick={close}>×</button></div><div className="modal-body">{invite ? <><div className="field"><label>Email address</label><input placeholder="operator@company.com" /></div><div className="field"><label>Role</label><select defaultValue="Operator"><option>Operator</option><option>Viewer</option><option>Admin</option></select></div><div className="field"><label>Cluster access</label><select defaultValue="Selected clusters"><option>Selected clusters</option><option>All clusters</option><option>Staging only</option></select></div></> : <><div className="field"><label>Connection name</label><input defaultValue="production-us-east-1" /></div><div className="dropzone"><strong>Choose kubeconfig file</strong>or drop it here · YAML up to 1 MB</div><div className="field"><label>Credential profile</label><select defaultValue="Use kubeconfig credentials"><option>Use kubeconfig credentials</option><option>AWS IAM role</option><option>Existing workspace secret</option></select></div></>} </div><div className="modal-foot"><button className="secondary" onClick={close}>Cancel</button><button className="primary" onClick={submit}>{invite ? "Send invitation" : "Save connection"}</button></div></div></div>;
}
