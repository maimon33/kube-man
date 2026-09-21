import type { Metadata } from "next";
import BootstrapGate from "./BootstrapGate";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "KubeMan Console",
  description: "A unified Kubernetes operations workspace for clusters, commands, traffic and events.",
};

export default function Home() {
  return <BootstrapGate />;
}
