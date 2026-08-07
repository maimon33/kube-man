import type { Metadata } from "next";
import { getChatGPTUser } from "./chatgpt-auth";
import ConsoleApp from "./ConsoleApp";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "KubeMan Console",
  description: "A unified Kubernetes operations workspace for clusters, commands, traffic and events.",
};

export default async function Home() {
  const user = await getChatGPTUser();
  return (
    <ConsoleApp
      user={{
        name: user?.fullName ?? "Alex Morgan",
        email: user?.email ?? "alex@acme.dev",
        isAdmin: true,
      }}
    />
  );
}
