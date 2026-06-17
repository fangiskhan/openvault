import { redirect } from "next/navigation";
import { authEnabled, isAuthed } from "@/lib/auth";
import AppShell from "@/components/AppShell";

export default async function Home() {
  if (authEnabled() && !(await isAuthed())) redirect("/login");
  return <AppShell />;
}
