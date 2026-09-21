"use client";

import { type CSSProperties, type DragEvent as ReactDragEvent, type FormEvent, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useState } from "react";

import { ADMIN_PERMISSIONS, type User, api, can } from "./api";
import { AuditPanel, InviteModal, RolesPanel, UsersPanel, useAccess } from "./AccessAdmin";

type ModalType = "credential" | "bastion";
type PaneId = "resources" | "terminal" | "flow" | "events";
type AwsCredentialInput = { profile: string; region: string; roleArn: string; accessKeyId: string; secretAccessKey: string; sessionToken: string };
type AwsCluster = {
  name: string; region: string; status: string; version: string; platformVersion: string;
  endpoint: string; endpointIps: string[]; assignedRoleArn: string; assignedRoleName: string;
  clusterServiceRoleArn: string; accountId: string; endpointPublicAccess: boolean;
  endpointPrivateAccess: boolean; publicAccessCidrs: string[]; discoveredAt: string;
  vpc: { VpcId?: string; CidrBlock?: string; IsDefault?: boolean };
  subnets: { SubnetId?: string; AvailabilityZone?: string; CidrBlock?: string; AvailableIpAddressCount?: number; MapPublicIpOnLaunch?: boolean }[];
  securityGroups: { GroupId?: string; GroupName?: string; Description?: string; VpcId?: string }[];
  networkConfig: { ipFamily?: string; serviceIpv4Cidr?: string; serviceIpv6Cidr?: string };
};

const tileCatalog: { id: PaneId; name: string; description: string; icon: string; permission: string }[] = [
  { id: "resources", name: "Kubernetes resources", description: "Workloads, services, and health", icon: "K8", permission: "resources:view" },
  { id: "terminal", name: "Live terminal", description: "Bash, kubectl, Helm, and AWS", icon: ">_", permission: "terminal:use" },
  { id: "flow", name: "Resource flow", description: "Topology and live traffic paths", icon: "⌘", permission: "resources:view" },
  { id: "events", name: "Events & history", description: "Warnings, changes, and audit trail", icon: "◷", permission: "events:view" },
];

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

const credentials = [
  ["production-eks", "AWS IAM role", "1234 5678 9012", "Healthy", "Aug 2, 2026"],
  ["staging-eks", "Access key", "2345 6789 0123", "Rotate soon", "May 18, 2026"],
  ["billing-readonly", "AWS IAM role", "1234 5678 9012", "Healthy", "Jul 29, 2026"],
];

const exampleCluster = "production-us-east-1";

export default function ConsoleApp({ user }: { user: User }) {
  const [section, setSection] = useState<"workspace" | "admin">("workspace");
  const [chosenTiles, setVisibleTiles] = useState<PaneId[]>(["resources", "terminal", "flow", "events"]);
  // Tiles the signed-in user has no permission for are never shown or loaded.
  const visibleTiles = useMemo(() => chosenTiles.filter((id) => can(user, tileCatalog.find((tile) => tile.id === id)?.permission ?? "")), [chosenTiles, user]);
  const [splitDirection, setSplitDirection] = useState<"vertical" | "horizontal">("vertical");
  const [splitX, setSplitX] = useState(54);
  const [splitY, setSplitY] = useState(50);
  const [collapsed, setCollapsed] = useState<Set<PaneId>>(new Set());
  const [resourceScope, setResourceScope] = useState("Workloads");
  const [eventFilter, setEventFilter] = useState("All");
  const [selectedNode, setSelectedNode] = useState("service");
  const [selectedCluster, setSelectedCluster] = useState(exampleCluster);
  const [awsClusters, setAwsClusters] = useState<AwsCluster[]>([]);
  const [shellBaseUrl, setShellBaseUrl] = useState("");
  const [shellRevision, setShellRevision] = useState(0);
  const [palette, setPalette] = useState("forest");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [tileMenuOpen, setTileMenuOpen] = useState(false);
  const [draggedTile, setDraggedTile] = useState<PaneId | null>(null);
  const [modal, setModal] = useState<ModalType | null>(null);
  const [toast, setToast] = useState("");

  const filteredEvents = useMemo(
    () => eventFilter === "All" ? events : events.filter((event) => event[1] === eventFilter.toLowerCase()),
    [eventFilter],
  );

  useEffect(() => {
    const savedPalette = window.localStorage.getItem("kubeman-palette");
    if (savedPalette) setPalette(savedPalette);
    const savedTileOrder = window.localStorage.getItem("kubeman-tile-order");
    if (savedTileOrder) {
      try {
        const order = JSON.parse(savedTileOrder) as PaneId[];
        if (order.length && order.every((tile) => tileCatalog.some((item) => item.id === tile))) setVisibleTiles(order);
      } catch { /* Ignore malformed device-local layout preferences. */ }
    }
    if (can(user, "terminal:use")) setShellBaseUrl("/_km/shell/");
    if (can(user, "clusters:view")) {
      api<{ clusters?: AwsCluster[] }>("/_km/aws/clusters")
        .then((data) => {
          const discovered = data.clusters ?? [];
          setAwsClusters(discovered);
          if (discovered.length) setSelectedCluster(discovered[0].name);
        })
        .catch(() => undefined);
    }
  }, [user]);

  const clusterNames = awsClusters.length ? awsClusters.map((cluster) => cluster.name) : [exampleCluster];
  const selectedClusterDetails = awsClusters.find((cluster) => cluster.name === selectedCluster);

  const shellUrl = useMemo(() => shellBaseUrl
    ? `${shellBaseUrl}?arg=${encodeURIComponent(selectedCluster)}&r=${shellRevision}`
    : "", [selectedCluster, shellBaseUrl, shellRevision]);

  async function signOut() {
    try { await api("/logout", { method: "POST" }); } catch { /* Session may already be gone. */ }
    window.location.assign("/");
  }

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }

  function choosePalette(nextPalette: string) {
    setPalette(nextPalette);
    window.localStorage.setItem("kubeman-palette", nextPalette);
    setPaletteOpen(false);
    notify(`${nextPalette[0].toUpperCase()}${nextPalette.slice(1)} palette applied`);
  }

  function togglePane(id: PaneId) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function addTile(id: PaneId) {
    setVisibleTiles((current) => {
      const next = current.includes(id) ? current : [...current, id];
      window.localStorage.setItem("kubeman-tile-order", JSON.stringify(next));
      return next;
    });
    setCollapsed((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    setTileMenuOpen(false);
    notify(`${tileCatalog.find((tile) => tile.id === id)?.name ?? "Tile"} added`);
  }

  function removeTile(id: PaneId) {
    setVisibleTiles((current) => {
      const next = current.filter((tile) => tile !== id);
      window.localStorage.setItem("kubeman-tile-order", JSON.stringify(next));
      return next;
    });
    notify("Tile removed — restore it from Add tile");
  }

  function reorderTile(source: PaneId, target: PaneId) {
    if (source === target) return;
    setVisibleTiles((current) => {
      const from = current.indexOf(source);
      const to = current.indexOf(target);
      if (from < 0 || to < 0) return current;
      const next = [...current];
      next.splice(from, 1);
      next.splice(to, 0, source);
      window.localStorage.setItem("kubeman-tile-order", JSON.stringify(next));
      return next;
    });
    notify(`${tileCatalog.find((tile) => tile.id === source)?.name ?? "Tile"} moved`);
  }

  function moveTile(id: PaneId, change: -1 | 1) {
    const index = visibleTiles.indexOf(id);
    const target = visibleTiles[index + change];
    if (target) reorderTile(id, target);
  }

  function startResize(axis: "x" | "y", event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    const grid = event.currentTarget.parentElement;
    if (!grid) return;
    const rect = grid.getBoundingClientRect();
    document.body.classList.add("is-resizing");
    const move = (pointer: PointerEvent) => {
      const value = axis === "x"
        ? ((pointer.clientX - rect.left) / rect.width) * 100
        : ((pointer.clientY - rect.top) / rect.height) * 100;
      const clamped = Math.max(22, Math.min(78, value));
      if (axis === "x") setSplitX(clamped); else setSplitY(clamped);
    };
    const stop = () => {
      document.body.classList.remove("is-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  async function modalDone(input?: AwsCredentialInput) {
    if (modal === "credential" && input) {
      const result = await api<{ clusters?: AwsCluster[] }>("/_km/aws/discover", { method: "POST", body: input });
      const discovered = result.clusters ?? [];
      setAwsClusters(discovered);
      if (discovered.length) {
        setSelectedCluster(discovered[0].name);
        setShellRevision((revision) => revision + 1);
      }
      setModal(null);
      notify(discovered.length ? `${discovered.length} EKS cluster${discovered.length === 1 ? "" : "s"} discovered` : "AWS connected — no EKS clusters found in this scope");
      return;
    }
    setModal(null);
    notify("Bastion tunnel profile saved");
  }

  if (section === "admin") {
    return (
      <div className="admin-app" data-palette={palette}>
        <AdminHeader signOut={signOut} user={user} palette={palette} paletteOpen={paletteOpen} setPaletteOpen={setPaletteOpen} choosePalette={choosePalette} onBack={() => setSection("workspace")} />
        <AdminView user={user} cluster={selectedCluster} clusters={awsClusters} onCredential={() => setModal("credential")} onBastion={() => setModal("bastion")} notify={notify} />
        {modal && <Modal type={modal} close={() => setModal(null)} submit={modalDone} />}
        {toast && <div className="toast">✓&nbsp;&nbsp;{toast}</div>}
      </div>
    );
  }

  const gridStyle = { "--split-x": `${splitX}%`, "--split-y": `${splitY}%` } as CSSProperties;
  const layout = Math.max(1, visibleTiles.length);
  const movementProps = (id: PaneId) => ({
    position: visibleTiles.indexOf(id), total: visibleTiles.length, dragging: draggedTile === id,
    move: moveTile,
    dragStart: (event: ReactDragEvent<HTMLElement>) => {
      setDraggedTile(id);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", id);
    },
    dragEnd: () => setDraggedTile(null),
    drop: () => {
      if (draggedTile) reorderTile(draggedTile, id);
      setDraggedTile(null);
    },
  });

  return (
    <div className="app" data-palette={palette}>
      <header className="topbar">
        <div className="brand"><div className="brand-mark">KM</div><span>KubeMan</span></div>
        <label className="cluster-select" aria-label="Current cluster">
          <i className="cluster-dot" />
          <select value={selectedCluster} onChange={(event) => {
            setSelectedCluster(event.target.value);
            setShellRevision((revision) => revision + 1);
            notify(`Dashboard and terminal switched to ${event.target.value}`);
          }}>
            {clusterNames.map((cluster) => {
              const details = awsClusters.find((item) => item.name === cluster);
              return <option key={cluster} value={cluster}>{cluster}{details ? ` — ${details.assignedRoleName}` : ""}</option>;
            })}
          </select>
          <span className="only-cluster">{clusterNames.length} cluster{clusterNames.length === 1 ? "" : "s"}</span>
        </label>
        <div className="top-actions">
          <button className="icon-btn command-trigger" onClick={() => notify("Command palette ready — try the terminal below")}>⌕&nbsp; Search or run <span className="key">⌘ K</span></button>
          <PaletteControl palette={palette} open={paletteOpen} setOpen={setPaletteOpen} choose={choosePalette} />
          <button className="icon-btn" aria-label="Notifications" onClick={() => setEventFilter("Warn")}>◔</button>
          <button className="icon-btn" aria-label="Help" onClick={() => notify("KubeMan help center will open here")}>?</button>
          <div className="avatar" title={user.email}>{initials(user.name)}</div>
          {ADMIN_PERMISSIONS.some((permission) => can(user, permission)) && <button className="admin-entry" onClick={() => setSection("admin")}>Admin</button>}<button className="admin-entry" onClick={signOut}>Sign out</button>
        </div>
      </header>

      <main className="main">
        <div className="workspace-bar">
          <span className="crumb"><strong>Operations workspace</strong></span>
          <span className="health"><i className="cluster-dot" /> {selectedClusterDetails?.status === "ACTIVE" || !selectedClusterDetails ? "Healthy" : selectedClusterDetails.status} {selectedClusterDetails ? `· EKS ${selectedClusterDetails.version}` : "· 24 nodes"}</span>
          <span className="role-context" title={selectedClusterDetails?.assignedRoleArn ?? "Connect AWS credentials to discover the assigned role"}>Role: {selectedClusterDetails?.assignedRoleName ?? "not discovered"}</span>
          <div className="workspace-tools">
            <div className="widget-picker">
              <button className="add-widget" aria-expanded={tileMenuOpen} onClick={() => setTileMenuOpen((open) => !open)}>＋ Add tile</button>
              {tileMenuOpen && <div className="widget-menu"><div className="widget-menu-head"><strong>Add to workspace</strong><span>{visibleTiles.length} of {tileCatalog.filter((tile) => can(user, tile.permission)).length} active</span></div>{tileCatalog.map((tile) => {
                const active = visibleTiles.includes(tile.id);
                return <button key={tile.id} disabled={active || !can(user, tile.permission)} title={can(user, tile.permission) ? undefined : "Your role does not include this tile"} onClick={() => addTile(tile.id)}><span className="widget-icon">{tile.icon}</span><span><strong>{tile.name}</strong><small>{tile.description}</small></span><b>{active ? "Added" : can(user, tile.permission) ? "+" : "🔒"}</b></button>;
              })}</div>}
            </div>
            {layout === 2 && <div className="layout-controls" aria-label="Split direction">
            <button
              title={`Change to ${splitDirection === "vertical" ? "horizontal" : "vertical"} split`}
              aria-label={`Change to ${splitDirection === "vertical" ? "horizontal" : "vertical"} split`}
              className={`layout-btn direction-toggle ${layout === 2 ? "active" : ""}`}
              onClick={() => {
                setSplitDirection((direction) => direction === "vertical" ? "horizontal" : "vertical");
              }}
            >{splitDirection === "vertical" ? "Ⅱ" : "＝"}</button>
            </div>}
          </div>
        </div>

        <div className={`workspace-grid layout-${layout} split-${splitDirection}`} style={gridStyle}>
          {visibleTiles.includes("resources") &&
          <Pane {...movementProps("resources")} id="resources" title="Kubernetes" subtitle={selectedCluster} collapsed={collapsed.has("resources")} toggle={togglePane} remove={removeTile} actions={<><div className="segmented">{["Workloads", "Network", "AWS infra"].map((scope) => <button key={scope} className={resourceScope === scope ? "active" : ""} onClick={() => setResourceScope(scope)}>{scope}</button>)}</div><button className="tiny-btn" onClick={() => notify(`Resources refreshed for ${selectedCluster}`)}>↻</button></>}>
            {resourceScope === "AWS infra" ? <AwsInfrastructure cluster={selectedClusterDetails} openAdmin={() => setSection("admin")} /> : <>
              <div className="resource-summary"><div className="summary-item"><strong>42</strong><span>Pods</span></div><div className="summary-item"><strong>18</strong><span>Deployments</span></div><div className="summary-item"><strong>12</strong><span>Services</span></div><div className="summary-item"><strong>99.8%</strong><span>Healthy</span></div></div>
              <div className="resource-table"><div className="table-head"><span>Name</span><span>Status</span><span>CPU</span><span>Age</span></div>{resources.map(([name, kind, status, cpu, percent]) => <div className="table-row" key={name}><div className="resource-name"><span className="kind">{kind[0]}</span>{name}</div><span className="status-ok">{status}</span><span>{cpu}<div className="cpu-bar"><span style={{ width: percent }} /></div></span><span>{name.includes("redis") ? "12d" : "4h"}</span></div>)}</div>
            </>}
          </Pane>}

          {visibleTiles.includes("terminal") &&
          <Pane {...movementProps("terminal")} id="terminal" title="Terminal" subtitle={<><i className="live-dot" /> live · {selectedCluster}</>} terminal collapsed={collapsed.has("terminal")} toggle={togglePane} remove={removeTile} actions={<><span className="shell-badge">non-root</span><button className="tiny-btn" onClick={() => setShellRevision((revision) => revision + 1)}>↻</button></>}>
            <div className="terminal-tabs"><span className="term-tab active">bash</span><span className="term-tool">kubectl</span><span className="term-tool">helm</span><span className="term-tool">aws</span></div>
            <div className="terminal-live">{shellUrl ? <iframe className="terminal-frame" src={shellUrl} title="KubeMan live Bash terminal" allow="clipboard-read; clipboard-write" /> : <div className="terminal-loading">Connecting to shell…</div>}</div>
          </Pane>}

          {visibleTiles.includes("flow") &&
          <Pane {...movementProps("flow")} id="flow" title="Resource flow" subtitle="Live traffic · 30s" collapsed={collapsed.has("flow")} toggle={togglePane} remove={removeTile} actions={<><button className="tiny-btn" onClick={() => notify("Flow graph centered")}>◎</button><button className="tiny-btn">＋</button><button className="tiny-btn">−</button></>}>
            <div className="flow-canvas"><div className="flow-inner"><div className="flow-edge edge-1"/><div className="flow-edge edge-2"/><div className="flow-edge edge-3"/><div className="flow-edge edge-4"/><span className="traffic-pill pill-1">1.2k r/s</span><span className="traffic-pill pill-2">820 r/s</span><span className="traffic-pill pill-3">390 r/s</span>{[["ingress","public-ingress","Ingress","IN"],["service","api-gateway","Service","SVC"],["api-a","orders-api","Deployment","D"],["api-b","payments-api","Deployment","D"],["db","orders-db","StatefulSet","ST"]].map(([cls,name,type,icon]) => <button key={cls} className={`flow-node ${cls} ${selectedNode === cls ? "active" : ""}`} onClick={() => setSelectedNode(cls)}><strong>{name}</strong><span>{type}</span><i className="node-icon">{icon}</i></button>)}</div></div>
          </Pane>}

          {visibleTiles.includes("events") &&
          <Pane {...movementProps("events")} id="events" title="Events & history" subtitle="128 in the last hour" collapsed={collapsed.has("events")} toggle={togglePane} remove={removeTile} actions={<><button className="tiny-btn" onClick={() => notify("Event stream paused")}>Ⅱ</button><button className="tiny-btn">⇩</button></>}>
            <div className="event-filters">{["All", "Warn", "Error"].map((filter) => <button key={filter} className={`filter-chip ${eventFilter === filter ? "active" : ""}`} onClick={() => setEventFilter(filter)}>{filter}</button>)}</div><div className="event-list">{filteredEvents.map(([time,type,title,detail]) => <div className="event" key={time}><span className="event-time">{time}</span><i className={`event-dot ${type}`} /><div className="event-text"><strong>{title}</strong><span>{detail}</span></div></div>)}</div>
          </Pane>}

          {visibleTiles.length === 0 && <div className="empty-workspace"><span>＋</span><h2>Your workspace is empty</h2><p>Add a Kubernetes, terminal, flow, or events tile to begin.</p><button className="primary" onClick={() => setTileMenuOpen(true)}>Add your first tile</button></div>}

          {(layout > 2 || (layout === 2 && splitDirection === "vertical")) && <button className="resize-handle resize-x" aria-label="Resize columns" onPointerDown={(event) => startResize("x", event)}><span /></button>}
          {(layout === 4 || layout === 3 || (layout === 2 && splitDirection === "horizontal")) && <button className={`resize-handle resize-y ${layout === 3 ? "right-only" : ""}`} aria-label="Resize rows" onPointerDown={(event) => startResize("y", event)}><span /></button>}
        </div>
      </main>

      {modal && <Modal type={modal} close={() => setModal(null)} submit={modalDone} />}
      {toast && <div className="toast">✓&nbsp;&nbsp;{toast}</div>}
    </div>
  );
}

function Pane({ id, title, subtitle, collapsed, toggle, remove, actions, terminal, children, position, total, dragging, move, dragStart, dragEnd, drop }: { id: PaneId; title: string; subtitle: React.ReactNode; collapsed: boolean; toggle: (id: PaneId) => void; remove: (id: PaneId) => void; actions: React.ReactNode; terminal?: boolean; children: React.ReactNode; position: number; total: number; dragging: boolean; move: (id: PaneId, change: -1 | 1) => void; dragStart: (event: ReactDragEvent<HTMLElement>) => void; dragEnd: () => void; drop: () => void }) {
  return <section style={{ order: position }} className={`pane pane-position-${position} ${terminal ? "terminal-pane" : ""} ${collapsed ? "pane-collapsed" : ""} ${dragging ? "pane-dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => { event.preventDefault(); drop(); }}><div className="pane-head"><span className="tile-drag" draggable onDragStart={dragStart} onDragEnd={dragEnd} role="button" tabIndex={0} aria-label={`Drag ${title} tile to a new position`} title="Drag to move tile">⠿</span><button className="pane-fold" onClick={() => toggle(id)} aria-label={`${collapsed ? "Expand" : "Collapse"} ${title}`}>{collapsed ? "›" : "⌄"}</button><span className="pane-title">{title}</span><span className="pane-subtitle">{subtitle}</span><div className="pane-actions"><span className="tile-move-controls"><button disabled={position <= 0} onClick={() => move(id, -1)} aria-label={`Move ${title} to previous position`} title="Move to previous position">←</button><button disabled={position >= total - 1} onClick={() => move(id, 1)} aria-label={`Move ${title} to next position`} title="Move to next position">→</button></span>{actions}<button className="tiny-btn pane-remove" onClick={() => remove(id)} aria-label={`Remove ${title} tile`}>×</button></div></div><div className="pane-content">{children}</div></section>;
}

function PaletteControl({ palette, open, setOpen, choose }: { palette: string; open: boolean; setOpen: (open: boolean) => void; choose: (palette: string) => void }) {
  return <div className="palette-wrap"><button className="icon-btn palette-trigger" aria-label="Change color palette" aria-expanded={open} onClick={() => setOpen(!open)}><span className={`palette-swatch ${palette}`} /></button>{open && <div className="palette-menu" role="menu">{[["forest", "Forest"], ["ocean", "Ocean"], ["ember", "Ember"], ["violet", "Violet"]].map(([value, label]) => <button key={value} role="menuitem" className={palette === value ? "active" : ""} onClick={() => choose(value)}><span className={`palette-swatch ${value}`} /><span>{label}</span>{palette === value && <b>✓</b>}</button>)}</div>}</div>;
}

function AdminHeader({ user, palette, paletteOpen, setPaletteOpen, choosePalette, onBack, signOut }: { user: User; signOut: () => void; palette: string; paletteOpen: boolean; setPaletteOpen: (open: boolean) => void; choosePalette: (palette: string) => void; onBack: () => void }) {
  return <header className="admin-topbar"><div className="brand"><div className="brand-mark">KM</div><span>KubeMan</span></div><span className="admin-divider"/><strong className="admin-product">Administration</strong><div className="top-actions"><PaletteControl palette={palette} open={paletteOpen} setOpen={setPaletteOpen} choose={choosePalette}/><div className="avatar" title={user.email}>{initials(user.name)}</div><button className="secondary back-console" onClick={signOut}>Sign out</button><button className="secondary back-console" onClick={onBack}>← Kubernetes console</button></div></header>;
}

function AwsInfrastructure({ cluster, openAdmin }: { cluster?: AwsCluster; openAdmin: () => void }) {
  if (!cluster) return <div className="infra-empty"><span>AWS</span><strong>No AWS infrastructure discovered yet</strong><p>Add an AWS profile or credentials in Administration to pull EKS, VPC, subnet, endpoint IP, security group, and role details.</p><button className="primary" onClick={openAdmin}>Open AWS credentials</button></div>;
  return <div className="infra-view">
    <div className="infra-identity"><div><span>Authenticated role</span><strong title={cluster.assignedRoleArn}>{cluster.assignedRoleName}</strong><small>{cluster.assignedRoleArn}</small></div><b>{cluster.accountId} · {cluster.region}</b></div>
    <div className="infra-summary"><InfraMetric label="VPC" value={cluster.vpc.VpcId || "—"} detail={cluster.vpc.CidrBlock || "CIDR unavailable"}/><InfraMetric label="Subnets" value={String(cluster.subnets.length)} detail={`${new Set(cluster.subnets.map((subnet) => subnet.AvailabilityZone)).size} availability zones`}/><InfraMetric label="Endpoint IPs" value={String(cluster.endpointIps.length)} detail={cluster.endpointPrivateAccess ? "Private access enabled" : "Public endpoint"}/><InfraMetric label="Security groups" value={String(cluster.securityGroups.length)} detail={`Service CIDR ${cluster.networkConfig.serviceIpv4Cidr || cluster.networkConfig.serviceIpv6Cidr || "—"}`}/></div>
    <div className="infra-columns"><section><h4>Subnets</h4>{cluster.subnets.map((subnet) => <div className="infra-row" key={subnet.SubnetId}><div><strong>{subnet.SubnetId}</strong><span>{subnet.AvailabilityZone} · {subnet.CidrBlock}</span></div><b>{subnet.AvailableIpAddressCount?.toLocaleString() ?? "—"} IPs</b></div>)}</section><section><h4>Security groups & endpoint</h4>{cluster.securityGroups.map((group) => <div className="infra-row" key={group.GroupId}><div><strong>{group.GroupName || group.GroupId}</strong><span>{group.GroupId} · {group.Description}</span></div></div>)}<div className="endpoint-card"><strong>{cluster.endpointPrivateAccess ? "Private" : "Public"} Kubernetes API</strong><span>{cluster.endpoint}</span><small>{cluster.endpointIps.join(" · ") || "Endpoint IPs resolve inside the connected network"}</small></div></section></div>
  </div>;
}

function InfraMetric({ label, value, detail }: { label: string; value: string; detail: string }) { return <div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>; }

function AdminView({ user, cluster, clusters, onCredential, onBastion, notify }: { user: User; cluster: string; clusters: AwsCluster[]; onCredential: () => void; onBastion: () => void; notify: (message: string) => void }) {
  const access = useAccess(user);
  const [inviteOpen, setInviteOpen] = useState(false);
  const canCredentials = can(user, "credentials:manage");
  const canClusters = can(user, "clusters:manage");
  const admins = access.members.filter((member) => member.roleId === "admin" && member.status === "active").length;
  return <main className="admin-page admin-standalone"><div className="admin-titlebar"><div><span className="admin-kicker">Organization controls</span><h1>Workspace administration</h1><p>Identity, credentials, retention, and storage—separate from day-to-day cluster operations.</p></div>{can(user, "users:manage") && <button className="primary" onClick={() => setInviteOpen(true)}>+ Invite member</button>}</div><div className="stat-grid admin-stats"><div className="stat-card"><span>Active members</span><strong>{can(user, "users:view") ? access.members.filter((member) => member.status === "active").length : "—"}</strong><small>{can(user, "users:view") ? `${admins} administrator${admins === 1 ? "" : "s"} · ${access.members.filter((member) => member.status === "invited").length} invited` : "Not permitted to view"}</small></div><div className="stat-card"><span>Discovered EKS clusters</span><strong>{clusters.length}</strong><small>{clusters.length ? `${new Set(clusters.map((item) => item.accountId)).size} AWS account${new Set(clusters.map((item) => item.accountId)).size === 1 ? "" : "s"}` : "Connect AWS to discover"}</small></div><div className="stat-card"><span>Encrypted storage</span><strong>2.4 GB</strong><small>Healthy</small></div><div className="stat-card"><span>Audit retention</span><strong>90 days</strong><small>1,284 events</small></div></div><div className="admin-sections">
    {can(user, "users:view") && <UsersPanel user={user} access={access} notify={notify} invite={() => setInviteOpen(true)} />}
    {can(user, "users:view") && <RolesPanel user={user} access={access} notify={notify} />}
    {can(user, "audit:view") && <AuditPanel />}
    <details className="admin-card admin-fold" open><summary><div><strong>AWS credential vault & EKS discovery</strong><span>Connect a mounted profile or temporary credentials, then pull clusters and infrastructure</span></div><b>{clusters.length ? `${clusters.length} clusters` : "Not connected"}</b></summary><div className="admin-card-body"><div className="vault-notice"><span>◆</span><div><strong>Discover without storing raw secret values</strong><p>Access keys are used only for the discovery request. Cluster details and the assigned role are saved persistently.</p></div>{canCredentials && <button className="primary" onClick={onCredential}>{clusters.length ? "Refresh discovery" : "+ Connect & discover"}</button>}</div>{clusters.length ? <div className="discovered-clusters">{clusters.map((item) => <div className="discovered-cluster" key={`${item.region}:${item.name}`}><div className="credential-icon">EKS</div><div><strong>{item.name}</strong><span>{item.region} · Kubernetes {item.version} · {item.vpc.VpcId}</span><small title={item.assignedRoleArn}>Role: {item.assignedRoleName}</small></div><em className="healthy">{item.status}</em></div>)}</div> : <div className="credential-grid">{credentials.slice(0, 1).map(([name,type,account,status,rotated]) => <div className="credential-card muted-card" key={name}><div className="credential-icon">AWS</div><div><strong>Example: {name}</strong><span>{type} · account {account}</span><small>Connect credentials to replace this example</small></div><em className="healthy">{status}</em><button className="tiny-btn">•••</button></div>)}</div>}</div></details>
    <details className="admin-card admin-fold"><summary><div><strong>EKS connectivity</strong><span>Bastion and AWS Systems Manager tunnels for private Kubernetes API endpoints</span></div><b>No tunnel configured</b></summary><div className="admin-card-body"><div className="bastion-layout"><div className="bastion-visual"><span className="bastion-node">KM</span><i/><span className="bastion-node gateway">SSH</span><i/><span className="bastion-node eks">EKS</span></div><div className="bastion-copy"><strong>Connect {cluster} through a private path</strong><p>Create an SSH local-forward or Session Manager tunnel. KubeMan keeps the key or AWS profile as an encrypted reference and applies the EKS TLS server name automatically.</p><div className="bastion-features"><span>✓ SSH bastion</span><span>✓ SSM Session Manager</span><span>✓ Automatic reconnect</span><span>✓ Health checks</span></div></div><div className="bastion-actions">{canClusters && <button className="primary" onClick={onBastion}>+ Add bastion tunnel</button>}<button className="secondary" onClick={() => notify("No tunnel profile to test yet")}>Test connection</button></div></div></div></details>
    <details className="admin-card admin-fold"><summary><div><strong>Storage & persistence</strong><span>Application state, terminal homes, kubeconfigs, backups, and retention</span></div><b>All systems healthy</b></summary><div className="admin-card-body"><div className="storage-grid"><StorageRow name="Workspace database" detail="Users, roles, saved views, and audit metadata" value="48 MB" status="Encrypted"/><StorageRow name="Terminal home volumes" detail="Shell profiles, history, and user workspace files" value="1.8 GB" status="Persistent"/><StorageRow name="Kubeconfig references" detail="Read-only mounts and encrypted connection metadata" value="8 files" status="Protected"/><StorageRow name="Audit archive" detail="Immutable activity records · 90-day retention" value="612 MB" status="Backed up"/></div><div className="storage-foot"><span>Last backup completed today at 03:20 · next scheduled in 15 hours</span><button className="secondary" onClick={() => notify("Storage integrity check queued")}>Run integrity check</button></div></div></details>
  </div>{inviteOpen && <InviteModal access={access} close={() => setInviteOpen(false)} done={(message) => { setInviteOpen(false); notify(message); }} />}</main>;
}

function StorageRow({ name, detail, value, status }: { name: string; detail: string; value: string; status: string }) {
  return <div className="storage-row"><span className="storage-icon">▤</span><div><strong>{name}</strong><span>{detail}</span></div><b>{value}</b><em>{status}</em><button className="tiny-btn">•••</button></div>;
}

function Modal({ type, close, submit }: { type: ModalType; close: () => void; submit: (input?: AwsCredentialInput) => Promise<void> | void }) {
  const bastion = type === "bastion";
  const credential = type === "credential";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const title = bastion ? "Add bastion tunnel" : "Add AWS credentials";
  const description = bastion ? "Create a protected route to the private EKS Kubernetes API." : "Validate AWS access, discover EKS clusters, and save their infrastructure and assigned role.";
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const input = credential ? {
      profile: String(form.get("profile") ?? ""), region: String(form.get("region") ?? "us-east-1"),
      roleArn: String(form.get("roleArn") ?? ""), accessKeyId: String(form.get("accessKeyId") ?? ""),
      secretAccessKey: String(form.get("secretAccessKey") ?? ""), sessionToken: String(form.get("sessionToken") ?? ""),
    } : undefined;
    setBusy(true); setError("");
    try { await submit(input); } catch (failure) { setError(failure instanceof Error ? failure.message : "Request failed"); setBusy(false); }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}><form className={`modal ${bastion || credential ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} onSubmit={handleSubmit}><div className="modal-head"><div><h2>{title}</h2><p>{description}</p></div><button type="button" className="close" onClick={close}>×</button></div><div className="modal-body">{bastion ? <><div className="field-grid"><Field label="Tunnel name"><input defaultValue="production-eks-bastion"/></Field><Field label="Tunnel method"><select defaultValue="SSH local forward"><option>SSH local forward</option><option>AWS SSM Session Manager</option></select></Field></div><Field label="Private EKS endpoint"><input placeholder="https://ABCDEF.gr7.us-east-1.eks.amazonaws.com"/></Field><div className="field-grid"><Field label="Bastion host"><input placeholder="bastion.internal.example.com"/></Field><Field label="SSH port"><input defaultValue="22" inputMode="numeric"/></Field></div><div className="field-grid"><Field label="SSH user"><input defaultValue="ec2-user"/></Field><Field label="Authentication reference"><select defaultValue="Mounted SSH agent"><option>Mounted SSH agent</option><option>Encrypted private key</option><option>AWS credential profile</option></select></Field></div><div className="field-grid"><Field label="Local port"><input defaultValue="6443" inputMode="numeric"/></Field><Field label="TLS server name"><input placeholder="ABCDEF.gr7.us-east-1.eks.amazonaws.com"/></Field></div><label className="check-row"><input type="checkbox" defaultChecked/><span>Automatically reconnect and health-check this tunnel</span></label></> : <><div className="discovery-note"><strong>Use a mounted profile or temporary access keys</strong><span>Leave access keys empty to use the selected profile from your Mac. Raw keys are never written to disk.</span></div><div className="field-grid"><Field label="Mounted AWS profile"><input name="profile" defaultValue="default" placeholder="default" autoComplete="off"/></Field><Field label="Region"><input name="region" defaultValue="us-east-1" placeholder="us-east-1 or all" autoComplete="off"/></Field></div><Field label="Assume role ARN (optional)"><input name="roleArn" placeholder="arn:aws:iam::123456789012:role/KubeMan" autoComplete="off"/></Field><div className="field-grid"><Field label="Access key ID (optional)"><input name="accessKeyId" autoComplete="off"/></Field><Field label="Secret access key (optional)"><input name="secretAccessKey" type="password" autoComplete="new-password"/></Field></div><Field label="Session token (optional)"><input name="sessionToken" type="password" autoComplete="new-password"/></Field></>}{error && <div className="modal-error">{error}</div>}</div><div className="modal-foot"><button type="button" className="secondary" onClick={close} disabled={busy}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy ? "Discovering AWS…" : bastion ? "Validate & save tunnel" : "Connect & discover clusters"}</button></div></form></div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="field"><label>{label}</label>{children}</div>; }
function initials(name: string) { return name.split(" ").map((part) => part[0]).join("").slice(0, 2); }
